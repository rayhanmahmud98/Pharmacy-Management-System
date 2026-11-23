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
process.env.NODE_ENV = 'test';

const testLicenseKeys = crypto.generateKeyPairSync('ed25519');
const testPubPem = testLicenseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
process.env.MEDINEST_TEST_LICENSE_PUBKEY_PEM = testPubPem;

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
const {
  getCurrentLicenseStatus,
  installLicenseFile,
  verifySignedLicense,
  canonicalLicensePayload,
} = await import('./licensing.ts');
const { listMedicines, upsertMedicineUnit, changeBatchStatus, reconcileInventoryLedger } = await import(
  './services/inventoryService.ts'
);
const {
  createPurchase,
  createPurchaseReturn,
  reversePurchase,
} = await import('./services/purchaseService.ts');
const { completeSale, createSalesReturn } = await import('./services/salesService.ts');
const {
  closeCashSession,
  createExpense,
  getActiveCashSessionId,
  getCashSessionSummary,
  recordPartyPayment,
  reversePayment,
} = await import('./services/financeService.ts');
const {
  createVerifiedBackup,
  parseAndValidateExcelImport,
  executeExcelImport,
  restoreFromBackup,
} = await import('./services/backupService.ts');
const { getComprehensiveReport } = await import('./services/reportService.ts');
const { buildApiRouter } = await import('./routes.ts');

function signTestLicense(payload: {
  licenseId: string;
  customerId: string;
  pharmacyName: string;
  licenseType: 'TRIAL' | 'TIME_LIMITED' | 'LIFETIME';
  issueDate: string;
  expiryDate: string | null;
  deviceFingerprint: string;
}) {
  const signatureBase64 = crypto
    .sign(null, Buffer.from(canonicalLicensePayload(payload), 'utf8'), testLicenseKeys.privateKey)
    .toString('base64');
  return { payload, signatureBase64 };
}

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('licensing starts UNLICENSED_READONLY on clean seed, rejects invalid/expired installs, and activates only on valid Ed25519 signature', () => {
  const db = getDb();
  seedDatabaseIfEmpty();

  // Issue 3: seed must NOT create license.json or license_public.pem
  assert.equal(fs.existsSync(path.join(tmpDir, 'license.json')), false);
  assert.equal(fs.existsSync(path.join(tmpDir, 'license_public.pem')), false);

  const initial = getCurrentLicenseStatus();
  assert.equal(initial.status, 'UNLICENSED_READONLY');
  assert.equal(initial.writable, false);

  // Tampered signature must fail
  const validPayload = {
    licenseId: 'LIC-TEST-ACTIVE',
    customerId: 'CUST-TEST',
    pharmacyName: 'MediNest Test Pharmacy',
    licenseType: 'LIFETIME' as const,
    issueDate: '2026-01-01',
    expiryDate: null,
    deviceFingerprint: '*',
  };
  const validSigned = signTestLicense(validPayload);
  assert.throws(
    () =>
      installLicenseFile({
        payload: { ...validPayload, pharmacyName: 'Tampered Pharmacy' },
        signatureBase64: validSigned.signatureBase64,
      }),
    /Invalid license|signature/i
  );

  // Expired license must NOT be persisted as writable
  const expiredSigned = signTestLicense({
    ...validPayload,
    licenseId: 'LIC-TEST-EXP',
    licenseType: 'TIME_LIMITED',
    issueDate: '2020-01-01',
    expiryDate: '2021-01-01',
  });
  assert.throws(() => installLicenseFile(expiredSigned), /expired/i);
  assert.equal(getCurrentLicenseStatus().writable, false);

  // Even an arbitrary public key placed on disk must be ignored
  const rogueKeys = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(
    path.join(tmpDir, 'license_public.pem'),
    rogueKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    'utf8'
  );
  const rogueSig = crypto
    .sign(null, Buffer.from(canonicalLicensePayload(validPayload), 'utf8'), rogueKeys.privateKey)
    .toString('base64');
  assert.throws(
    () => installLicenseFile({ payload: validPayload, signatureBase64: rogueSig }),
    /signature verification failed/i
  );
  fs.unlinkSync(path.join(tmpDir, 'license_public.pem'));

  // Valid vendor-signed license activates write operations
  const activated = installLicenseFile(validSigned);
  assert.equal(activated.status, 'ACTIVE');
  assert.equal(activated.writable, true);

  // Seeded accounts start with must_change_password = 1 (Issue 2)
  const adminFlag = db.prepare("SELECT must_change_password FROM users WHERE username = 'admin'").get() as {
    must_change_password: number;
  };
  assert.equal(adminFlag.must_change_password, 1);
});

test('full pharmacy end-to-end transaction integrity, FEFO, intra-invoice batch deduction, returns, and backup', async () => {
  const db = getDb();

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

  // Issue 4: Duplicate saleLineId entries in one return totaling > remaining (12) must be rejected
  assert.throws(
    () =>
      createSalesReturn(admin, {
        saleId: saleRes.saleId,
        settlementType: 'CASH_REFUND',
        reason: 'Duplicate line over-return exploit attempt',
        lines: [
          { saleLineId: slRow.id, qtyBase: '7', disposition: 'RESTOCK_SELLABLE' },
          { saleLineId: slRow.id, qtyBase: '7', disposition: 'RESTOCK_SELLABLE' },
        ],
      }),
    /exceeds remaining returnable/i
  );

  // Verify ledger reconciliation is 100% healthy
  const recon = reconcileInventoryLedger();
  assert.equal(recon.healthy, true);
  assert.equal(recon.discrepancyCount, 0);

  // 5. Purchase receiving + purchase return + duplicate line / over-return / reversal-after-return guards
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

  // Issue 5: Duplicate purchaseLineId entries totaling > purchased quantity must be rejected
  assert.throws(
    () =>
      createPurchaseReturn(admin, {
        purchaseId: purRes.purchaseId,
        settlementType: 'SUPPLIER_CREDIT',
        reason: 'Duplicate purchase return line attempt',
        lines: [
          { purchaseLineId: purLine.id, qtyBase: '70' },
          { purchaseLineId: purLine.id, qtyBase: '70' },
        ],
      }),
    /exceeds remaining returnable/i
  );

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

  // Reopen cash session for subsequent return/payment tests
  const { openCashSession } = await import('./services/financeService.ts');
  openCashSession(admin, '500.00', 'Reopened for return and payment tests');

  // 7. Verify Audit Log hash chain & WAL-safe SQLite backup
  const chain = verifyAuditChain(db);
  assert.equal(chain.valid, true);
  assert.ok(chain.totalEntries >= 5);

  const bkp = await createVerifiedBackup(admin, 'MANUAL');
  assert.equal(bkp.integrityCheck, 'ok');
  assert.ok(bkp.sizeBytes > 0);
});

test('Issues 6 & 7: Invoice-level discount return valuation, cash refund cap, and customer credit due reconciliation', () => {
  const db = getDb();
  const adminRow = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const admin = loadAuthUserById(adminRow.id)!;

  const med = listMedicines('Napa Extend')[0] as unknown as {
    id: string;
    units: Array<{ id: string; is_base: number; allow_sale: number }>;
  };
  const baseUnit = med.units.find((u) => u.is_base === 1)!;

  // Create customer for credit due reconciliation tests
  const custId = crypto.randomUUID();
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, advance_balance, credit_limit, notes, is_active, created_at, updated_at)
     VALUES (?, 'CUST-TEST67', 'Discount Return Customer', '01700000001', '', '0.00', '0.00', '0.00', '10000.00', '', 1, ?, ?)`
  ).run(custId, ts, ts);

  // Sale with 2 lines @ 100.00 each, invoiceDiscount = 20.00 -> netTotal = 180.00, paid = 50.00 CASH, due = 130.00
  const sale = completeSale(admin, {
    customerId: custId,
    invoiceDiscount: '20.00',
    payments: [{ method: 'CASH', amount: '50.00' }],
    lines: [
      { medicineId: med.id, unitId: baseUnit.id, quantityInput: '50', unitPrice: '2.00' },
      { medicineId: med.id, unitId: baseUnit.id, quantityInput: '50', unitPrice: '2.00' },
    ],
  });
  assert.equal(sale.netTotal, '180.00');
  assert.equal(sale.dueAmount, '130.00');

  const lines = db
    .prepare('SELECT id, effective_line_total FROM sale_lines WHERE sale_id = ? ORDER BY id ASC')
    .all(sale.saleId) as Array<{ id: string; effective_line_total: string }>;
  assert.equal(lines[0].effective_line_total, '90.00');
  assert.equal(lines[1].effective_line_total, '90.00');

  // Cash refund exceeding sale.paid_amount (50.00) MUST fail!
  assert.throws(
    () =>
      createSalesReturn(admin, {
        saleId: sale.saleId,
        settlementType: 'CASH_REFUND',
        reason: 'Over-cash refund attempt',
        lines: [{ saleLineId: lines[0].id, qtyBase: '50', disposition: 'RESTOCK_SELLABLE' }],
      }),
    /exceeds remaining paid amount/i
  );

  // Customer credit return of Line 1 (90.00 effective) reduces sale.due_amount from 130.00 to 40.00 and cust.current_balance from 130.00 to 40.00
  const ret1 = createSalesReturn(admin, {
    saleId: sale.saleId,
    settlementType: 'CUSTOMER_CREDIT',
    reason: 'Returned half invoice on credit',
    lines: [{ saleLineId: lines[0].id, qtyBase: '50', disposition: 'RESTOCK_SELLABLE' }],
  });
  assert.equal(ret1.totalRefundValue, '90.00');
  assert.equal(ret1.dueSettled, '90.00');
  assert.equal(ret1.advanceCreated, '0.00');

  const saleAfter1 = db.prepare('SELECT due_amount FROM sales WHERE id = ?').get(sale.saleId) as { due_amount: string };
  const custAfter1 = db.prepare('SELECT current_balance, advance_balance FROM customers WHERE id = ?').get(custId) as {
    current_balance: string;
    advance_balance: string;
  };
  assert.equal(saleAfter1.due_amount, '40.00');
  assert.equal(custAfter1.current_balance, '40.00');
  assert.equal(custAfter1.advance_balance, '0.00');

  // Second customer credit return of Line 2 (90.00 effective) settles remaining 40.00 due and places 50.00 into customer advance_balance!
  const ret2 = createSalesReturn(admin, {
    saleId: sale.saleId,
    settlementType: 'CUSTOMER_CREDIT',
    reason: 'Returned second half invoice on credit',
    lines: [{ saleLineId: lines[1].id, qtyBase: '50', disposition: 'RESTOCK_SELLABLE' }],
  });
  assert.equal(ret2.totalRefundValue, '90.00');
  assert.equal(ret2.dueSettled, '40.00');
  assert.equal(ret2.advanceCreated, '50.00');

  const saleAfter2 = db.prepare('SELECT due_amount FROM sales WHERE id = ?').get(sale.saleId) as { due_amount: string };
  const custAfter2 = db.prepare('SELECT current_balance, advance_balance FROM customers WHERE id = ?').get(custId) as {
    current_balance: string;
    advance_balance: string;
  };
  assert.equal(saleAfter2.due_amount, '0.00');
  assert.equal(custAfter2.current_balance, '0.00');
  assert.equal(custAfter2.advance_balance, '50.00');
});

test('Issues 8 & 9: Supplier return due reconciliation and weighted-average cost on shared batch receiving', () => {
  const db = getDb();
  const adminRow = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const admin = loadAuthUserById(adminRow.id)!;

  const med = listMedicines('Napa Extend')[0] as unknown as {
    id: string;
    units: Array<{ id: string; unit_name: string; is_base: number }>;
  };
  const boxUnit = med.units.find((u) => u.unit_name === 'Box')!; // 120 base units per Box

  const supId = crypto.randomUUID();
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO suppliers (id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes, opening_balance, current_balance, advance_balance, notes, is_active, created_at, updated_at)
     VALUES (?, 'SUP-TEST89', 'WAC & Credit Supplier', 'Manager', '01800000001', '', 30, '', '0.00', '0.00', '0.00', '', 1, ?, ?)`
  ).run(supId, ts, ts);

  // Receive 1 Box (120 base units) @ 240.00 = 2.00/base into WAC-BATCH-1 (paid 50.00, due 190.00)
  const p1 = createPurchase(admin, {
    supplierId: supId,
    supplierInvoiceNo: 'WAC-INV-1',
    status: 'RECEIVED',
    paidAmount: '50.00',
    paymentMethod: 'BANK',
    lines: [
      {
        medicineId: med.id,
        unitId: boxUnit.id,
        batchNumber: 'WAC-BATCH-1',
        expiryDate: '2029-05-01',
        quantityInput: '1',
        unitCost: '240.00',
        sellingPricePerBase: '3.50',
      },
    ],
  });

  // Receive another 1 Box (120 base units) into the SAME (medicine, batch, expiry) @ 480.00 = 4.00/base
  // Expected Weighted Average Cost: (120*2.00 + 120*4.00) / 240 = 3.000000
  const p2 = createPurchase(admin, {
    supplierId: supId,
    supplierInvoiceNo: 'WAC-INV-2',
    status: 'RECEIVED',
    paidAmount: '0.00',
    paymentMethod: 'BANK',
    lines: [
      {
        medicineId: med.id,
        unitId: boxUnit.id,
        batchNumber: 'WAC-BATCH-1',
        expiryDate: '2029-05-01',
        quantityInput: '1',
        unitCost: '480.00',
        sellingPricePerBase: '3.50',
      },
    ],
  });

  const batch = db
    .prepare("SELECT id, current_qty_base, purchase_cost_per_base FROM batches WHERE medicine_id = ? AND batch_number = 'WAC-BATCH-1'")
    .get(med.id) as { id: string; current_qty_base: string; purchase_cost_per_base: string };
  assert.equal(batch.current_qty_base, '240.000000');
  assert.equal(batch.purchase_cost_per_base, '3.000000');

  // Cannot receive into a QUARANTINED batch
  const qPur = createPurchase(admin, {
    supplierId: supId,
    status: 'RECEIVED',
    paidAmount: '0.00',
    lines: [
      {
        medicineId: med.id,
        unitId: boxUnit.id,
        batchNumber: 'Q-BATCH-LOCK',
        expiryDate: '2029-06-01',
        quantityInput: '1',
        unitCost: '240.00',
        sellingPricePerBase: '3.00',
      },
    ],
  });
  const qBatch = db
    .prepare("SELECT id FROM batches WHERE medicine_id = ? AND batch_number = 'Q-BATCH-LOCK'")
    .get(med.id) as { id: string };
  changeBatchStatus(admin, qBatch.id, 'QUARANTINED', 'Hold for QA');
  assert.throws(
    () =>
      createPurchase(admin, {
        supplierId: supId,
        status: 'RECEIVED',
        paidAmount: '0.00',
        lines: [
          {
            medicineId: med.id,
            unitId: boxUnit.id,
            batchNumber: 'Q-BATCH-LOCK',
            expiryDate: '2029-06-01',
            quantityInput: '1',
            unitCost: '240.00',
            sellingPricePerBase: '3.00',
          },
        ],
      }),
    /Cannot receive stock into batch/i
  );

  // Issue 8: Purchase return with BANK_REFUND cannot exceed purchase.paid_amount (50.00 on p1)
  const p1Line = db.prepare('SELECT id FROM purchase_lines WHERE purchase_id = ?').get(p1.purchaseId) as { id: string };
  assert.throws(
    () =>
      createPurchaseReturn(admin, {
        purchaseId: p1.purchaseId,
        settlementType: 'BANK_REFUND',
        reason: 'Over-refund attempt',
        lines: [{ purchaseLineId: p1Line.id, qtyBase: '40' }], // 80.00 > paid 50.00
      }),
    /exceeds remaining paid amount/i
  );

  // SUPPLIER_CREDIT return on p2 (due 480.00) reduces p2.due_amount and supplier balance cleanly
  const p2Line = db.prepare('SELECT id FROM purchase_lines WHERE purchase_id = ?').get(p2.purchaseId) as { id: string };
  const pr = createPurchaseReturn(admin, {
    purchaseId: p2.purchaseId,
    settlementType: 'SUPPLIER_CREDIT',
    reason: 'Partial batch return',
    lines: [{ purchaseLineId: p2Line.id, qtyBase: '25' }], // 100.00
  });
  assert.equal(pr.dueSettled, '100.00');
  assert.equal(pr.advanceCreated, '0.00');
  const p2Row = db.prepare('SELECT due_amount FROM purchases WHERE id = ?').get(p2.purchaseId) as { due_amount: string };
  assert.equal(p2Row.due_amount, '380.00');

  // Consume qPur just to silence unused variable lint if needed
  assert.ok(qPur.purchaseId);
});

test('Issue 10: Customer & supplier advance payments, FIFO invoice allocation, invoice advance application, and reversal guard', () => {
  const db = getDb();
  const adminRow = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const admin = loadAuthUserById(adminRow.id)!;

  const med = listMedicines('Napa Extend')[0] as unknown as {
    id: string;
    units: Array<{ id: string; unit_name: string; is_base: number }>;
  };
  const baseUnit = med.units.find((u) => u.is_base === 1)!;
  const boxUnit = med.units.find((u) => u.unit_name === 'Box')!;

  // Ensure plenty of sellable stock exists for the 3 sales in this test
  const sup = db.prepare("SELECT id FROM suppliers WHERE code = 'SUP-001'").get() as { id: string };
  createPurchase(admin, {
    supplierId: sup.id,
    status: 'RECEIVED',
    paidAmount: '0.00',
    lines: [
      {
        medicineId: med.id,
        unitId: boxUnit.id,
        batchNumber: 'ADV-STOCK-1',
        expiryDate: '2029-12-01',
        quantityInput: '5',
        unitCost: '150.00',
        sellingPricePerBase: '2.00',
      },
    ],
  });

  const custId = crypto.randomUUID();
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, advance_balance, credit_limit, notes, is_active, created_at, updated_at)
     VALUES (?, 'CUST-TEST10', 'Advance Credit Customer', '01700000010', '', '0.00', '0.00', '0.00', '5000.00', '', 1, ?, ?)`
  ).run(custId, ts, ts);

  // Create two credit invoices: 300.00 and 200.00 (total due = 500.00)
  const s1 = completeSale(admin, {
    customerId: custId,
    payments: [],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '150', unitPrice: '2.00' }],
  });
  const s2 = completeSale(admin, {
    customerId: custId,
    payments: [],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '100', unitPrice: '2.00' }],
  });

  // Payment of 700.00 accounts for 300.00 + 200.00 + 200.00 advance credit!
  const payRes = recordPartyPayment(admin, {
    partyType: 'CUSTOMER',
    partyId: custId,
    method: 'BANK',
    amount: '700.00',
    referenceNo: 'ADV-700',
  });
  assert.equal(payRes.allocatedToDocs, '500.00');
  assert.equal(payRes.advanceAdded, '200.00');

  const custMid = db.prepare('SELECT current_balance, advance_balance FROM customers WHERE id = ?').get(custId) as {
    current_balance: string;
    advance_balance: string;
  };
  assert.equal(custMid.current_balance, '0.00');
  assert.equal(custMid.advance_balance, '200.00');
  const s1After = db.prepare('SELECT due_amount FROM sales WHERE id = ?').get(s1.saleId) as { due_amount: string };
  const s2After = db.prepare('SELECT due_amount FROM sales WHERE id = ?').get(s2.saleId) as { due_amount: string };
  assert.equal(s1After.due_amount, '0.00');
  assert.equal(s2After.due_amount, '0.00');

  // New sale of 250.00 on credit automatically consumes 200.00 advance credit -> net due 50.00!
  const s3 = completeSale(admin, {
    customerId: custId,
    payments: [],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '125', unitPrice: '2.00' }],
  });
  assert.equal(s3.advanceApplied, '200.00');
  assert.equal(s3.dueAmount, '50.00');

  // Reversing PAY-700 must be blocked because its 200.00 advance was already consumed on s3!
  assert.throws(
    () => reversePayment(admin, payRes.paymentId, 'Should fail after advance consumed'),
    /advance credit.*already been consumed/i
  );

  // Payment that hasn't had its advance consumed reverses cleanly (restoring both due and advance_balance)
  const pay2 = recordPartyPayment(admin, {
    partyType: 'CUSTOMER',
    partyId: custId,
    method: 'BANK',
    amount: '150.00', // pays remaining 50.00 on s3 + 100.00 advance
  });
  assert.equal(pay2.allocatedToDocs, '50.00');
  assert.equal(pay2.advanceAdded, '100.00');
  reversePayment(admin, pay2.paymentId, 'Entered wrong bank ref');
  const custFinal = db.prepare('SELECT current_balance, advance_balance FROM customers WHERE id = ?').get(custId) as {
    current_balance: string;
    advance_balance: string;
  };
  assert.equal(custFinal.current_balance, '50.00');
  assert.equal(custFinal.advance_balance, '0.00');
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

test('Issues 2 & 11: Forced password change API gating, concurrent atomic HTTP idempotency, and retry after failure', async () => {
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
    // Sign in as admin (who still has must_change_password = 1)
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
    });
    assert.equal(loginRes.status, 200);
    const cookieHeader = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

    // Issue 2: Protected operational routes MUST return 403 until password is updated!
    const blockedGet = await fetch(`${baseUrl}/api/medicines`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(blockedGet.status, 403);
    const blockedBody = (await blockedGet.json()) as { code?: string };
    assert.equal(blockedBody.code, 'PASSWORD_CHANGE_REQUIRED');

    // Reusing default password on forced change must be rejected
    const samePwRes = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: cookieHeader },
      body: JSON.stringify({ newPassword: 'Admin@123' }),
    });
    assert.equal(samePwRes.status, 400);

    // Changing to a strong new password unlocks access
    const changePwRes = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: cookieHeader },
      body: JSON.stringify({ newPassword: 'Admin@NewStrong99!' }),
    });
    assert.equal(changePwRes.status, 200);

    const allowedGet = await fetch(`${baseUrl}/api/medicines`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(allowedGet.status, 200);

    const expCat = db.prepare('SELECT id FROM expense_categories LIMIT 1').get() as { id: string };
    const idempKey = `test-idemp-${Date.now()}`;

    // Concurrent simultaneous duplicate submissions -> ONLY ONE expense row created!
    const payload = { categoryId: expCat.id, name: 'Idempotent Courier', amount: '25.00', paymentMethod: 'BANK' };
    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/expenses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'Idempotency-Key': idempKey,
          Cookie: cookieHeader,
        },
        body: JSON.stringify(payload),
      }),
      fetch(`${baseUrl}/api/expenses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'Idempotency-Key': idempKey,
          Cookie: cookieHeader,
        },
        body: JSON.stringify({ paymentMethod: 'BANK', amount: '25.00', name: 'Idempotent Courier', categoryId: expCat.id }), // reordered keys
      }),
    ]);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    const body1 = (await r1.json()) as { expenseNumber: string };
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

    // Failed transaction with an idempotency key must NOT store key, allowing valid retry on same key
    const failKey = `test-fail-retry-${Date.now()}`;
    const rFail = await fetch(`${baseUrl}/api/expenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'MediNest',
        'Idempotency-Key': failKey,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ categoryId: expCat.id, name: 'Fail Then Succeed', amount: '-10.00', paymentMethod: 'BANK' }),
    });
    assert.equal(rFail.status, 400);
    const rRetry = await fetch(`${baseUrl}/api/expenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'MediNest',
        'Idempotency-Key': failKey,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ categoryId: expCat.id, name: 'Fail Then Succeed', amount: '15.00', paymentMethod: 'BANK' }),
    });
    assert.equal(rRetry.status, 201);
  } finally {
    server.close();
  }
});

test('Issue 12: Backup restore verifies SHA-256 checksum, blocks tampered/missing backups, creates pre-restore snapshot, and audits outcomes', async () => {
  const db = getDb();
  const adminRow = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  const admin = loadAuthUserById(adminRow.id)!;

  const cleanBkp = await createVerifiedBackup(admin, 'MANUAL');
  const rec = db.prepare('SELECT id, file_path FROM backup_records WHERE id = ?').get(cleanBkp.id) as {
    id: string;
    file_path: string;
  };

  // Copy clean backup to restore later, then tamper with the tracked backup file!
  const cleanCopyBytes = fs.readFileSync(rec.file_path);
  fs.writeFileSync(rec.file_path, Buffer.concat([cleanCopyBytes, Buffer.from('TAMPER')]));

  await assert.rejects(() => restoreFromBackup(admin, rec.id), /SHA-256 checksum mismatch/i);
  const failAudit = db
    .prepare("SELECT status, reason FROM audit_logs WHERE action = 'RESTORE_BACKUP' ORDER BY seq DESC LIMIT 1")
    .get() as { status: string; reason: string };
  assert.equal(failAudit.status, 'FAILURE');
  assert.match(failAudit.reason, /SHA-256/i);

  // Restore original bytes so hash matches again, create a marker record after backup, then restore from backup
  fs.writeFileSync(rec.file_path, cleanCopyBytes);
  const markerCatId = crypto.randomUUID();
  db.prepare('INSERT INTO expense_categories (id, name) VALUES (?, ?)').run(markerCatId, 'Post-Backup Temp Cat');

  const restored = await restoreFromBackup(admin, rec.id);
  assert.equal(restored.integrity, 'ok');
  assert.equal(restored.sha256, cleanBkp.sha256);
  assert.ok(restored.preRestoreBackup.includes('pre_restore'));

  // Database state reverted to before markerCatId was added, with PRE_RESTORE audit logged
  const dbAfter = getDb();
  const markerGone = dbAfter.prepare('SELECT id FROM expense_categories WHERE id = ?').get(markerCatId);
  assert.equal(markerGone, undefined);
  const successAudit = dbAfter
    .prepare("SELECT status FROM audit_logs WHERE action = 'RESTORE_BACKUP' ORDER BY seq DESC LIMIT 1")
    .get() as { status: string };
  assert.equal(successAudit.status, 'SUCCESS');
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
