import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as XLSX from 'xlsx';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medinest-test-'));
process.env.PHARMACY_DATA_DIR = tmpDir;

const { getDb, closeDb, generateDocNumber, withTransaction } = await import('./db.ts');
const { seedDatabaseIfEmpty } = await import('./seed.ts');
const {
  resolveSessionMiddleware,
  checkLoginRateLimit,
  clearLoginAttempts,
  getUserEffectivePermissions,
  loadAuthUserById,
  recordFailedLoginAttempt,
} = await import('./auth.ts');
const { verifyAuditChain } = await import('./audit.ts');
const { getCurrentLicenseStatus, verifySignedLicense, canonicalLicensePayload } = await import('./licensing.ts');
const { listMedicines, upsertMedicineUnit, reconcileInventoryLedger } = await import('./services/inventoryService.ts');
const { createPurchase, createPurchaseReturn, reversePurchase } = await import('./services/purchaseService.ts');
const { completeSale, createSalesReturn } = await import('./services/salesService.ts');
const { closeCashSession, createExpense, getActiveCashSessionId, getCashSessionSummary } = await import('./services/financeService.ts');
const { createVerifiedBackup, parseAndValidateExcelImport, executeExcelImport } = await import('./services/backupService.ts');
const { getComprehensiveReport } = await import('./services/reportService.ts');
const { buildApiRouter } = await import('./routes.ts');

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('full pharmacy end-to-end transaction integrity, FEFO, intra-invoice batch deduction, returns, and backup', async () => {
  const db = getDb();
  seedDatabaseIfEmpty();

  const adminRow = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const admin = loadAuthUserById(adminRow.id)!;
  assert.ok(admin);

  const cashierRow = db.prepare("SELECT id FROM users WHERE username = 'cashier'").get() as { id: string };
  const cashierPerms = getUserEffectivePermissions(cashierRow.id);
  // Cashier has individual ALLOW override for sales.return but no sales.reverse
  assert.equal(cashierPerms['sales.return'], true);
  assert.equal(cashierPerms['sales.reverse'], false);

  // 1. Verify Napa Extend has manual 12-tablet Strip and 120-tablet Box, and two batches (near-expiry NEX-26A=144 and NEX-26B=360)
  const meds = listMedicines('Napa Extend');
  assert.equal(meds.length, 1);
  const napa = meds[0] as Record<string, unknown>;
  const units = napa.units as Array<{ id: string; unit_name: string; conversion_to_base: string }>;
  const stripUnit = units.find((u) => u.unit_name === 'Strip')!;
  const boxUnit = units.find((u) => u.unit_name === 'Box')!;
  assert.equal(Number(stripUnit.conversion_to_base), 12);
  assert.equal(Number(boxUnit.conversion_to_base), 120);

  // 2. Multi-line same-medicine sale tests intra-invoice FEFO batch deduction tracking without double-allocation!
  // Line 1: 11 Strips (132 tabs) -> takes 132 from NEX-26A (leaves 12 in NEX-26A)
  // Line 2: 2 Strips (24 tabs) -> takes remaining 12 from NEX-26A + 12 from NEX-26B
  // Split payment: Cash 200.00 + bKash 112.00 = 312.00
  const beforeCashId = getActiveCashSessionId()!;
  const beforeCash = Number(getCashSessionSummary(beforeCashId)!.totals.expectedCash);

  const saleRes = completeSale(admin, {
    payments: [
      { method: 'CASH', amount: '200.00' },
      { method: 'BKASH', amount: '112.00', referenceNo: 'TXN998811' },
    ],
    lines: [
      {
        medicineId: String(napa.id),
        unitId: stripUnit.id,
        quantityInput: '11',
        unitPrice: '24.00',
      },
      {
        medicineId: String(napa.id),
        unitId: stripUnit.id,
        quantityInput: '2',
        unitPrice: '24.00',
      },
    ],
  });
  assert.equal(saleRes.netTotal, '312.00');
  // COGS = 144 * 1.45 (208.80) + 12 * 1.50 (18.00) = 226.80
  assert.equal(saleRes.totalCogs, '226.80');

  // Cash drawer must increase ONLY by 200.00 (not 312.00 bKash!)
  const afterCash = Number(getCashSessionSummary(beforeCashId)!.totals.expectedCash);
  assert.equal((afterCash - beforeCash).toFixed(2), '200.00');

  // 3. Edit Napa Extend Strip conversion from 12 to 15 -> historical sale line snapshot MUST stay 12!
  upsertMedicineUnit(admin, String(napa.id), {
    unitId: stripUnit.id,
    unitName: 'Strip',
    conversionToBase: '15',
    allowPurchase: true,
    allowSale: true,
    isActive: true,
  });
  const histLines = db.prepare('SELECT conversion_ratio_snapshot, qty_base FROM sale_lines WHERE sale_id = ?').all(saleRes.saleId) as Array<{
    conversion_ratio_snapshot: string;
    qty_base: string;
  }>;
  assert.equal(histLines.length, 2);
  assert.equal(Number(histLines[0].conversion_ratio_snapshot), 12);
  assert.equal(Number(histLines[0].qty_base) + Number(histLines[1].qty_base), 156);

  // 4. Sales Return with QUARANTINE disposition: must NOT return to sellable stock!
  const slRow = db.prepare('SELECT id FROM sale_lines WHERE sale_id = ? ORDER BY gross_total DESC LIMIT 1').get(saleRes.saleId) as { id: string };
  const retRes = createSalesReturn(admin, {
    saleId: saleRes.saleId,
    settlementType: 'CASH_REFUND',
    reason: 'Customer opened blister pack; quarantined for inspection',
    lines: [{ saleLineId: slRow.id, qtyBase: '12', disposition: 'QUARANTINE' }],
  });
  assert.equal(retRes.totalRefundValue, '24.00');

  // Verify ledger reconciliation is 100% healthy
  const recon = reconcileInventoryLedger();
  assert.equal(recon.healthy, true);
  assert.equal(recon.discrepancyCount, 0);

  // 5. Purchase receiving + purchase return + over-return / reversal-after-return guards
  const sup = db.prepare("SELECT id FROM suppliers WHERE code = 'SUP-001'").get() as { id: string };
  const purRes = createPurchase(admin, {
    supplierId: sup.id,
    supplierInvoiceNo: 'SUP-INV-771',
    status: 'RECEIVED',
    paidAmount: '100.00',
    paymentMethod: 'BANK',
    lines: [
      {
        medicineId: String(napa.id),
        unitId: boxUnit.id,
        batchNumber: 'NEX-27C',
        expiryDate: '2028-12-31',
        quantityInput: '1',
        unitCost: '175.00',
        sellingPricePerBase: '2.00',
      },
    ],
  });
  const purLine = db.prepare('SELECT id FROM purchase_lines WHERE purchase_id = ?').get(purRes.purchaseId) as { id: string };
  createPurchaseReturn(admin, {
    purchaseId: purRes.purchaseId,
    settlementType: 'SUPPLIER_CREDIT',
    reason: 'Damaged outer carton',
    lines: [{ purchaseLineId: purLine.id, qtyBase: '12' }],
  });

  // Guard 1: Over-return beyond remaining 108 base units must fail
  assert.throws(
    () =>
      createPurchaseReturn(admin, {
        purchaseId: purRes.purchaseId,
        settlementType: 'SUPPLIER_CREDIT',
        reason: 'Excess return attempt',
        lines: [{ purchaseLineId: purLine.id, qtyBase: '109' }],
      }),
    /exceeds remaining returnable purchased quantity/
  );

  // Guard 2: Cannot reverse purchase after purchase returns exist
  assert.throws(
    () => reversePurchase(admin, purRes.purchaseId, 'Attempt reverse after return'),
    /already has partial\/full purchase returns/
  );

  // 6. Cash expense & Net Profit report verification
  const expCat = db.prepare('SELECT id FROM expense_categories LIMIT 1').get() as { id: string };
  createExpense(admin, {
    categoryId: expCat.id,
    name: 'Generator Fuel',
    amount: '100.00',
    paymentMethod: 'CASH',
  });
  const rep = getComprehensiveReport({});
  assert.equal(rep.profitSummary.totalExpenses, '100.00');
  assert.equal(
    (Number(rep.profitSummary.grossProfit) - Number(rep.profitSummary.totalExpenses)).toFixed(2),
    rep.profitSummary.netProfit
  );

  const summaryNow = getCashSessionSummary(beforeCashId)!;
  const expCash = Number(summaryNow.totals.expectedCash);
  const closeRes = closeCashSession(admin, beforeCashId, {
    actualCash: (expCash - 10).toFixed(2),
    varianceReason: 'Coin rounding difference',
  });
  assert.equal(closeRes.variance, '-10.00');

  // 7. Verify Audit Log hash chain & WAL-safe SQLite backup
  const chain = verifyAuditChain(db);
  assert.equal(chain.valid, true);
  assert.ok(chain.totalEntries >= 5);

  const bkp = await createVerifiedBackup(admin, 'MANUAL');
  assert.equal(bkp.integrityCheck, 'ok');
  assert.ok(bkp.sizeBytes > 0);
});

test('atomic doc_sequences prevent collisions across sequential calls', () => {
  const nums = new Set<string>();
  withTransaction((tx) => {
    for (let i = 0; i < 15; i++) {
      nums.add(generateDocNumber(tx, 'INVTEST', 'sales', 'invoice_number'));
    }
  });
  assert.equal(nums.size, 15);
  assert.equal(Array.from(nums).every((n) => n.startsWith('INVTEST-')), true);
});

test('6-decimal Excel import validation rejects excess precision and duplicate barcodes, persists valid rows', () => {
  const db = getDb();
  const adminRow = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const admin = loadAuthUserById(adminRow.id)!;

  const wb = XLSX.utils.book_new();
  const rows = [
    {
      medicine_code: 'MED-9001',
      barcode: '9990001112223',
      brand_name: 'PreciseDrop',
      generic_name: 'Xylometazoline',
      strength: '0.1%',
      dosage_form: 'Drops',
      category: 'ENT',
      manufacturer: 'MediLab',
      storage_info: 'Shelf E1',
      base_unit: 'ml',
      secondary_unit: 'Drop',
      secondary_conversion: '0.050000',
      min_stock_level: '12.500000',
      rx_required: 'NO',
      opening_batch_number: 'PD-01',
      opening_expiry_date: '2029-12-31',
      opening_qty_base: '100.123456',
      cost_per_base: '1.234567',
      selling_price_per_base: '2.50',
    },
    {
      medicine_code: 'MED-9002',
      barcode: '9990001112223', // duplicate barcode + 7 decimals
      brand_name: 'BadPrec',
      generic_name: 'Test',
      strength: '1mg',
      base_unit: 'Tablet',
      opening_batch_number: 'BP-01',
      opening_expiry_date: '2029-12-31',
      opening_qty_base: '10.1234567',
      cost_per_base: '1.00',
      selling_price_per_base: '2.00',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const preview = parseAndValidateExcelImport(buf);
  assert.equal(preview.length, 2);
  assert.equal(preview[0].errors.length, 0);
  assert.ok(preview[1].errors.some((e) => e.includes('Duplicate barcode')));
  assert.ok(preview[1].errors.some((e) => e.includes('more than 6 decimal places')));

  const result = executeExcelImport(admin, [preview[0]]);
  assert.equal(result.createdMeds, 1);
  assert.equal(result.addedBatches, 1);

  const insertedMed = db
    .prepare("SELECT medicine_code, barcode, storage_info, min_stock_level FROM medicines WHERE barcode = '9990001112223'")
    .get() as { medicine_code: string; barcode: string; storage_info: string; min_stock_level: string };
  assert.equal(insertedMed.medicine_code, 'MED-9001');
  assert.equal(insertedMed.storage_info, 'Shelf E1');
  assert.equal(insertedMed.min_stock_level, '12.500000');
});

test('login rate limiting locks after 5 failures and resets on clear', () => {
  const user = 'ratetest';
  const ip = '127.0.0.55';
  clearLoginAttempts(user, ip);
  for (let i = 0; i < 4; i++) {
    const r = recordFailedLoginAttempt(user, ip);
    assert.equal(r.locked, false);
  }
  const fifth = recordFailedLoginAttempt(user, ip);
  assert.equal(fifth.locked, true);
  const check = checkLoginRateLimit(user, ip);
  assert.equal(check.blocked, true);
  clearLoginAttempts(user, ip);
  assert.equal(checkLoginRateLimit(user, ip).blocked, false);
});

test('Ed25519 license detects UTC clock rollback across restarts', () => {
  const db = getDb();
  const status = getCurrentLicenseStatus();
  assert.equal(status.status, 'ACTIVE');

  // Generate ephemeral keypair and signed license, push license_state clock into future to simulate rollback
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = {
    licenseId: 'LIC-TEST-RB',
    customerId: 'CUST-1',
    pharmacyName: 'MediNest Test',
    licenseType: 'LIFETIME' as const,
    issueDate: '2026-01-01',
    expiryDate: null,
    deviceFingerprint: '*',
  };
  const sig = crypto
    .sign(null, Buffer.from(canonicalLicensePayload(payload), 'utf8'), privateKey)
    .toString('base64');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  db.prepare(
    `INSERT INTO license_state (id, last_verified_utc, updated_at) VALUES (1, '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
     ON CONFLICT(id) DO UPDATE SET last_verified_utc = '2099-01-01T00:00:00.000Z'`
  ).run();

  const rollbackCheck = verifySignedLicense({ payload, signatureBase64: sig }, pubPem);
  assert.equal(rollbackCheck.status, 'INVALID_READONLY');
  assert.equal(rollbackCheck.writable, false);
  assert.match(rollbackCheck.message, /clock rollback/i);

  // Restore valid timestamp
  db.prepare('DELETE FROM license_state WHERE id = 1').run();
});

test('HTTP idempotency prevents duplicate expense posting and returns 409 on payload mismatch', async () => {
  const db = getDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);
  app.use('/api', buildApiRouter());

  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Sign in as admin
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
    });
    assert.equal(loginRes.status, 200);
    const cookieHeader = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
    const expCat = db.prepare('SELECT id FROM expense_categories LIMIT 1').get() as { id: string };
    const idempKey = `test-idemp-${Date.now()}`;

    // First post -> 201
    const r1 = await fetch(`${baseUrl}/api/expenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'MediNest',
        'Idempotency-Key': idempKey,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ categoryId: expCat.id, name: 'Idempotent Courier', amount: '25.00', paymentMethod: 'BANK' }),
    });
    assert.equal(r1.status, 201);
    const body1 = (await r1.json()) as { expenseNumber: string };

    // Replay identical request -> 201 with exact same expenseNumber
    const r2 = await fetch(`${baseUrl}/api/expenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'MediNest',
        'Idempotency-Key': idempKey,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ categoryId: expCat.id, name: 'Idempotent Courier', amount: '25.00', paymentMethod: 'BANK' }),
    });
    assert.equal(r2.status, 201);
    const body2 = (await r2.json()) as { expenseNumber: string };
    assert.equal(body1.expenseNumber, body2.expenseNumber);

    // Different payload with same idempotency key -> 409 Conflict
    const r3 = await fetch(`${baseUrl}/api/expenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'MediNest',
        'Idempotency-Key': idempKey,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ categoryId: expCat.id, name: 'Different Expense', amount: '99.00', paymentMethod: 'BANK' }),
    });
    assert.equal(r3.status, 409);
  } finally {
    server.close();
  }
});

test('Audit hash chain detects post-write tampering', async () => {
  const { DatabaseSync, backup } = await import('node:sqlite');
  const db = getDb();
  const validBefore = verifyAuditChain(db);
  assert.equal(validBefore.valid, true);

  const clonePath = path.join(tmpDir, 'audit-tamper-clone.sqlite');
  await backup(db, clonePath);
  const cloneDb = new DatabaseSync(clonePath);
  try {
    const first = cloneDb.prepare('SELECT seq FROM audit_logs ORDER BY seq ASC LIMIT 1').get() as { seq: number };
    cloneDb.prepare("UPDATE audit_logs SET reason = 'TAMPERED' WHERE seq = ?").run(first.seq);
    const broken = verifyAuditChain(cloneDb);
    assert.equal(broken.valid, false);
    assert.equal(broken.brokenAtSeq, first.seq);
  } finally {
    cloneDb.close();
  }
});
