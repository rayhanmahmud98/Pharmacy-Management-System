import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import pg from 'pg';
import * as XLSX from 'xlsx';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medinest-pg-test-'));
process.env.PHARMACY_DATA_DIR = tmpDir;
process.env.NODE_ENV = 'test';

// Create an isolated ephemeral PostgreSQL database for this test suite
delete process.env.DATABASE_URL;
const basePgHost = process.env.PGHOST || '127.0.0.1';
const basePgPort = Number(process.env.PGPORT || 5432);
const basePgUser = process.env.PGUSER || 'postgres';
const basePgPassword = process.env.PGPASSWORD ?? '';
const testDbName = `medinest_test_${process.pid}_${Date.now()}`;
const migTestDbName = `medinest_mig_${process.pid}_${Date.now()}`;

async function withAdminPgClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    host: basePgHost,
    port: basePgPort,
    database: 'postgres',
    user: basePgUser,
    password: basePgPassword,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

await withAdminPgClient(async (client) => {
  await client.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${testDbName}"`);
});

process.env.PGDATABASE = testDbName;

const {
  getDb,
  closeDb,
  generateDocNumber,
  withTransaction,
} = await import('./db.ts');
const { seedDatabaseIfEmpty } = await import('./seed.ts');
const {
  resolveSessionMiddleware,
  checkLoginRateLimit,
  clearLoginAttempts,
  getUserEffectivePermissions,
  hashPassword,
  loadAuthUserById,
  recordFailedLoginAttempt,
} = await import('./auth.ts');
const { verifyAuditChain } = await import('./audit.ts');
const {
  listMedicines,
  createMedicine,
  upsertMedicineUnit,
  changeBatchStatus,
  reconcileInventoryLedger,
} = await import('./services/inventoryService.ts');
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
  openCashSession,
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
const { migrateSqliteToPostgres } = await import('../tools/migrate_sqlite_to_pg.ts');

test.after(async () => {
  await closeDb();
  await withAdminPgClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
    await client.query(`DROP DATABASE IF EXISTS "${migTestDbName}" WITH (FORCE)`);
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('clean PostgreSQL seed boots license-free, excludes license_state/admin.license, preserves drug_license_no, and keeps must_change_password', async () => {
  const db = await getDb();
  await seedDatabaseIfEmpty();

  assert.equal(fs.existsSync(path.join(tmpDir, 'license.json')), false);
  assert.equal(fs.existsSync(path.join(tmpDir, 'license_public.pem')), false);
  assert.equal(fs.existsSync(path.join(tmpDir, '.license_clock_state.json')), false);
  assert.equal(fs.existsSync(path.join(tmpDir, '.device_installation_id')), false);

  const licTable = await db.queryOne("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'license_state'");
  assert.equal(licTable, undefined);

  const licPerm = await db.queryOne("SELECT code FROM permissions WHERE code = 'admin.license'");
  assert.equal(licPerm, undefined);

  const settings = await db.queryOne<{ pharmacy_name: string; drug_license_no: string }>(
    'SELECT pharmacy_name, drug_license_no FROM pharmacy_settings WHERE id = 1'
  );
  assert.ok(settings && settings.pharmacy_name.length > 0);
  assert.ok(settings && settings.drug_license_no.length > 0);

  const adminFlag = await db.queryOne<{ must_change_password: boolean }>(
    "SELECT must_change_password FROM users WHERE username = 'admin'"
  );
  assert.equal(adminFlag?.must_change_password, true);
});

test('full pharmacy end-to-end transaction integrity, FEFO, intra-invoice batch deduction, returns, and PostgreSQL backup', async () => {
  const db = await getDb();

  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;
  assert.ok(admin);

  const cashierRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'cashier'"))!;
  const cashierPerms = await getUserEffectivePermissions(cashierRow.id);
  assert.equal(cashierPerms['sales.return'], true);
  assert.equal(cashierPerms['sales.reverse'], false);

  const meds = await listMedicines('Napa Extend');
  assert.equal(meds.length, 1);
  const napa = meds[0] as Record<string, unknown>;
  const units = napa.units as Array<{ id: string; unit_name: string; conversion_to_base: string }>;
  const stripUnit = units.find((u) => u.unit_name === 'Strip')!;
  const boxUnit = units.find((u) => u.unit_name === 'Box')!;
  assert.equal(Number(stripUnit.conversion_to_base), 12);
  assert.equal(Number(boxUnit.conversion_to_base), 120);

  const beforeCashId = (await getActiveCashSessionId())!;
  const beforeCash = Number((await getCashSessionSummary(beforeCashId))!.totals.expectedCash);

  const saleRes = await completeSale(admin, {
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
  assert.equal(saleRes.totalCogs, '226.80');

  const afterCash = Number((await getCashSessionSummary(beforeCashId))!.totals.expectedCash);
  assert.equal((afterCash - beforeCash).toFixed(2), '200.00');

  // Edit unit conversion -> historical sale line snapshot MUST stay 12!
  await upsertMedicineUnit(admin, String(napa.id), {
    unitId: stripUnit.id,
    unitName: 'Strip',
    conversionToBase: '15',
    allowPurchase: true,
    allowSale: true,
    isActive: true,
  });
  const histLines = await db.query<{ conversion_ratio_snapshot: string; qty_base: string }>(
    'SELECT conversion_ratio_snapshot, qty_base FROM sale_lines WHERE sale_id = $1',
    [saleRes.saleId]
  );
  assert.equal(histLines.length, 2);
  assert.equal(Number(histLines[0].conversion_ratio_snapshot), 12);
  assert.equal(Number(histLines[0].qty_base) + Number(histLines[1].qty_base), 156);

  // Sales Return with QUARANTINE disposition (pick the 2-strip / 24-base-unit line)
  const slRow = (await db.queryOne<{ id: string }>(
    'SELECT id FROM sale_lines WHERE sale_id = $1 ORDER BY gross_total ASC LIMIT 1',
    [saleRes.saleId]
  ))!;
  const retRes = await createSalesReturn(admin, {
    saleId: saleRes.saleId,
    settlementType: 'CASH_REFUND',
    reason: 'Customer opened blister pack; quarantined for inspection',
    lines: [{ saleLineId: slRow.id, qtyBase: '12', disposition: 'QUARANTINE' }],
  });
  assert.equal(retRes.totalRefundValue, '24.00');

  // Duplicate saleLineId entries exceeding remaining returnable must reject
  await assert.rejects(
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

  const recon = await reconcileInventoryLedger();
  assert.equal(recon.healthy, true);
  assert.equal(recon.discrepancyCount, 0);

  // Purchase receiving + purchase return + guards
  const sup = (await db.queryOne<{ id: string }>("SELECT id FROM suppliers WHERE code = 'SUP-001'"))!;
  const purRes = await createPurchase(admin, {
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
  const purLine = (await db.queryOne<{ id: string }>('SELECT id FROM purchase_lines WHERE purchase_id = $1', [
    purRes.purchaseId,
  ]))!;

  await assert.rejects(
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

  await createPurchaseReturn(admin, {
    purchaseId: purRes.purchaseId,
    settlementType: 'SUPPLIER_CREDIT',
    reason: 'Damaged outer carton',
    lines: [{ purchaseLineId: purLine.id, qtyBase: '12' }],
  });

  await assert.rejects(
    () =>
      createPurchaseReturn(admin, {
        purchaseId: purRes.purchaseId,
        settlementType: 'SUPPLIER_CREDIT',
        reason: 'Excess return attempt',
        lines: [{ purchaseLineId: purLine.id, qtyBase: '109' }],
      }),
    /exceeds remaining returnable purchased quantity/
  );

  await assert.rejects(
    () => reversePurchase(admin, purRes.purchaseId, 'Attempt reverse after return'),
    /already has partial\/full purchase returns/
  );

  // Cash expense & Net Profit report verification
  const expCat = (await db.queryOne<{ id: string }>('SELECT id FROM expense_categories LIMIT 1'))!;
  await createExpense(admin, {
    categoryId: expCat.id,
    name: 'Generator Fuel',
    amount: '100.00',
    paymentMethod: 'CASH',
  });
  const rep = await getComprehensiveReport({});
  assert.equal(rep.profitSummary.totalExpenses, '100.00');
  assert.equal(
    (Number(rep.profitSummary.grossProfit) - Number(rep.profitSummary.totalExpenses)).toFixed(2),
    rep.profitSummary.netProfit
  );

  const summaryNow = (await getCashSessionSummary(beforeCashId))!;
  const expCash = Number(summaryNow.totals.expectedCash);
  const closeRes = await closeCashSession(admin, beforeCashId, {
    actualCash: (expCash - 10).toFixed(2),
    varianceReason: 'Coin rounding difference',
  });
  assert.equal(closeRes.variance, '-10.00');

  await openCashSession(admin, '500.00', 'Reopened for return and payment tests');

  // Verify Audit Log hash chain & pg_dump verified backup
  const chain = await verifyAuditChain(db);
  assert.equal(chain.valid, true);
  assert.ok(chain.totalEntries >= 5);

  const bkp = await createVerifiedBackup(admin, 'MANUAL');
  assert.match(bkp.integrityCheck, /pg_restore TOC verified/i);
  assert.ok(bkp.sizeBytes > 0);
});

test('Invoice-level discount return valuation, cash refund cap, and customer credit due reconciliation', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

  const med = (await listMedicines('Napa Extend'))[0] as unknown as {
    id: string;
    units: Array<{ id: string; is_base: boolean; allow_sale: boolean }>;
  };
  const baseUnit = med.units.find((u) => Boolean(u.is_base))!;

  const custId = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.execute(
    `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, advance_balance, credit_limit, notes, is_active, created_at, updated_at)
     VALUES ($1, 'CUST-TEST67', 'Discount Return Customer', '01700000001', '', '0.00', '0.00', '0.00', '10000.00', '', TRUE, $2, $3)`,
    [custId, ts, ts]
  );

  const sale = await completeSale(admin, {
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

  const lines = await db.query<{ id: string; effective_line_total: string }>(
    'SELECT id, effective_line_total FROM sale_lines WHERE sale_id = $1 ORDER BY id ASC',
    [sale.saleId]
  );
  assert.equal(lines[0].effective_line_total, '90.00');
  assert.equal(lines[1].effective_line_total, '90.00');

  await assert.rejects(
    () =>
      createSalesReturn(admin, {
        saleId: sale.saleId,
        settlementType: 'CASH_REFUND',
        reason: 'Over-cash refund attempt',
        lines: [{ saleLineId: lines[0].id, qtyBase: '50', disposition: 'RESTOCK_SELLABLE' }],
      }),
    /exceeds remaining paid amount/i
  );

  const ret1 = await createSalesReturn(admin, {
    saleId: sale.saleId,
    settlementType: 'CUSTOMER_CREDIT',
    reason: 'Returned half invoice on credit',
    lines: [{ saleLineId: lines[0].id, qtyBase: '50', disposition: 'RESTOCK_SELLABLE' }],
  });
  assert.equal(ret1.totalRefundValue, '90.00');
  assert.equal(ret1.dueSettled, '90.00');
  assert.equal(ret1.advanceCreated, '0.00');

  const saleAfter1 = (await db.queryOne<{ due_amount: string }>('SELECT due_amount FROM sales WHERE id = $1', [
    sale.saleId,
  ]))!;
  const custAfter1 = (await db.queryOne<{ current_balance: string; advance_balance: string }>(
    'SELECT current_balance, advance_balance FROM customers WHERE id = $1',
    [custId]
  ))!;
  assert.equal(saleAfter1.due_amount, '40.00');
  assert.equal(custAfter1.current_balance, '40.00');
  assert.equal(custAfter1.advance_balance, '0.00');

  const ret2 = await createSalesReturn(admin, {
    saleId: sale.saleId,
    settlementType: 'CUSTOMER_CREDIT',
    reason: 'Returned second half invoice on credit',
    lines: [{ saleLineId: lines[1].id, qtyBase: '50', disposition: 'RESTOCK_SELLABLE' }],
  });
  assert.equal(ret2.totalRefundValue, '90.00');
  assert.equal(ret2.dueSettled, '40.00');
  assert.equal(ret2.advanceCreated, '50.00');

  const saleAfter2 = (await db.queryOne<{ due_amount: string }>('SELECT due_amount FROM sales WHERE id = $1', [
    sale.saleId,
  ]))!;
  const custAfter2 = (await db.queryOne<{ current_balance: string; advance_balance: string }>(
    'SELECT current_balance, advance_balance FROM customers WHERE id = $1',
    [custId]
  ))!;
  assert.equal(saleAfter2.due_amount, '0.00');
  assert.equal(custAfter2.current_balance, '0.00');
  assert.equal(custAfter2.advance_balance, '50.00');
});

test('Supplier return due reconciliation and weighted-average cost on shared batch receiving', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

  const med = (await listMedicines('Napa Extend'))[0] as unknown as {
    id: string;
    units: Array<{ id: string; unit_name: string; is_base: boolean }>;
  };
  const boxUnit = med.units.find((u) => u.unit_name === 'Box')!;

  const supId = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.execute(
    `INSERT INTO suppliers (id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes, opening_balance, current_balance, advance_balance, notes, is_active, created_at, updated_at)
     VALUES ($1, 'SUP-TEST89', 'WAC & Credit Supplier', 'Manager', '01800000001', '', 30, '', '0.00', '0.00', '0.00', '', TRUE, $2, $3)`,
    [supId, ts, ts]
  );

  const p1 = await createPurchase(admin, {
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

  const p2 = await createPurchase(admin, {
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

  const batch = (await db.queryOne<{ id: string; current_qty_base: string; purchase_cost_per_base: string }>(
    "SELECT id, current_qty_base, purchase_cost_per_base FROM batches WHERE medicine_id = $1 AND batch_number = 'WAC-BATCH-1'",
    [med.id]
  ))!;
  assert.equal(batch.current_qty_base, '240.000000');
  assert.equal(batch.purchase_cost_per_base, '3.000000');

  const qPur = await createPurchase(admin, {
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
  const qBatch = (await db.queryOne<{ id: string }>(
    "SELECT id FROM batches WHERE medicine_id = $1 AND batch_number = 'Q-BATCH-LOCK'",
    [med.id]
  ))!;
  await changeBatchStatus(admin, qBatch.id, 'QUARANTINED', 'Hold for QA');
  await assert.rejects(
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

  const p1Line = (await db.queryOne<{ id: string }>('SELECT id FROM purchase_lines WHERE purchase_id = $1', [
    p1.purchaseId,
  ]))!;
  await assert.rejects(
    () =>
      createPurchaseReturn(admin, {
        purchaseId: p1.purchaseId,
        settlementType: 'BANK_REFUND',
        reason: 'Over-refund attempt',
        lines: [{ purchaseLineId: p1Line.id, qtyBase: '40' }],
      }),
    /exceeds remaining paid amount/i
  );

  const p2Line = (await db.queryOne<{ id: string }>('SELECT id FROM purchase_lines WHERE purchase_id = $1', [
    p2.purchaseId,
  ]))!;
  const pr = await createPurchaseReturn(admin, {
    purchaseId: p2.purchaseId,
    settlementType: 'SUPPLIER_CREDIT',
    reason: 'Partial batch return',
    lines: [{ purchaseLineId: p2Line.id, qtyBase: '25' }],
  });
  assert.equal(pr.dueSettled, '100.00');
  assert.equal(pr.advanceCreated, '0.00');
  const p2Row = (await db.queryOne<{ due_amount: string }>('SELECT due_amount FROM purchases WHERE id = $1', [
    p2.purchaseId,
  ]))!;
  assert.equal(p2Row.due_amount, '380.00');
  assert.ok(qPur.purchaseId);
});

test('Customer & supplier advance payments, FIFO invoice allocation, invoice advance application, and reversal guard', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

  const med = (await listMedicines('Napa Extend'))[0] as unknown as {
    id: string;
    units: Array<{ id: string; unit_name: string; is_base: boolean }>;
  };
  const baseUnit = med.units.find((u) => Boolean(u.is_base))!;
  const boxUnit = med.units.find((u) => u.unit_name === 'Box')!;

  const sup = (await db.queryOne<{ id: string }>("SELECT id FROM suppliers WHERE code = 'SUP-001'"))!;
  await createPurchase(admin, {
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
  await db.execute(
    `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, advance_balance, credit_limit, notes, is_active, created_at, updated_at)
     VALUES ($1, 'CUST-TEST10', 'Advance Credit Customer', '01700000010', '', '0.00', '0.00', '0.00', '5000.00', '', TRUE, $2, $3)`,
    [custId, ts, ts]
  );

  const s1 = await completeSale(admin, {
    customerId: custId,
    payments: [],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '150', unitPrice: '2.00' }],
  });
  const s2 = await completeSale(admin, {
    customerId: custId,
    payments: [],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '100', unitPrice: '2.00' }],
  });

  const payRes = await recordPartyPayment(admin, {
    partyType: 'CUSTOMER',
    partyId: custId,
    method: 'BANK',
    amount: '700.00',
    referenceNo: 'ADV-700',
  });
  assert.equal(payRes.allocatedToDocs, '500.00');
  assert.equal(payRes.advanceAdded, '200.00');

  const custMid = (await db.queryOne<{ current_balance: string; advance_balance: string }>(
    'SELECT current_balance, advance_balance FROM customers WHERE id = $1',
    [custId]
  ))!;
  assert.equal(custMid.current_balance, '0.00');
  assert.equal(custMid.advance_balance, '200.00');
  const s1After = (await db.queryOne<{ due_amount: string }>('SELECT due_amount FROM sales WHERE id = $1', [
    s1.saleId,
  ]))!;
  const s2After = (await db.queryOne<{ due_amount: string }>('SELECT due_amount FROM sales WHERE id = $1', [
    s2.saleId,
  ]))!;
  assert.equal(s1After.due_amount, '0.00');
  assert.equal(s2After.due_amount, '0.00');

  const s3 = await completeSale(admin, {
    customerId: custId,
    payments: [],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '125', unitPrice: '2.00' }],
  });
  assert.equal(s3.advanceApplied, '200.00');
  assert.equal(s3.dueAmount, '50.00');

  await assert.rejects(
    () => reversePayment(admin, payRes.paymentId, 'Should fail after advance consumed'),
    /advance credit.*already been consumed/i
  );

  const pay2 = await recordPartyPayment(admin, {
    partyType: 'CUSTOMER',
    partyId: custId,
    method: 'BANK',
    amount: '150.00',
  });
  assert.equal(pay2.allocatedToDocs, '50.00');
  assert.equal(pay2.advanceAdded, '100.00');
  await reversePayment(admin, pay2.paymentId, 'Entered wrong bank ref');
  const custFinal = (await db.queryOne<{ current_balance: string; advance_balance: string }>(
    'SELECT current_balance, advance_balance FROM customers WHERE id = $1',
    [custId]
  ))!;
  assert.equal(custFinal.current_balance, '50.00');
  assert.equal(custFinal.advance_balance, '0.00');
});

test('atomic PostgreSQL doc_sequences prevent collisions under parallel concurrent transactions', async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      withTransaction((tx) => generateDocNumber(tx, 'INVTEST', 'sales', 'invoice_number'))
    )
  );
  const nums = new Set(results);
  assert.equal(nums.size, 12);
  assert.equal(Array.from(nums).every((n) => n.startsWith('INVTEST-')), true);
});

test('CONCURRENCY SAFETY: Multi-counter race on limited batch blocks overselling and preserves positive stock invariant', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;
  const sup = (await db.queryOne<{ id: string }>("SELECT id FROM suppliers WHERE code = 'SUP-001'"))!;

  // Create dedicated test medicine + single batch with exactly 5.000000 units
  const medId = await createMedicine(admin, {
    brandName: 'ConcurrencyTestMed',
    genericName: 'Concurrency Molecule',
    strength: '50mg',
    dosageForm: 'Tablet',
    baseUnitName: 'Tablet',
    minStockLevel: '1',
  });
  const medObj = (await listMedicines('ConcurrencyTestMed'))[0] as unknown as {
    id: string;
    units: Array<{ id: string; is_base: boolean }>;
  };
  const baseUnit = medObj.units.find((u) => Boolean(u.is_base))!;

  await createPurchase(admin, {
    supplierId: sup.id,
    status: 'RECEIVED',
    paidAmount: '0.00',
    lines: [
      {
        medicineId: medId,
        unitId: baseUnit.id,
        batchNumber: 'CONC-BATCH-1',
        expiryDate: '2029-10-01',
        quantityInput: '5',
        unitCost: '10.00',
        sellingPricePerBase: '5.00',
      },
    ],
  });

  // Launch 4 simultaneous checkout transactions each trying to buy 4 tablets out of 5 available
  const settled = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      completeSale(admin, {
        payments: [{ method: 'CASH', amount: '20.00' }],
        lines: [{ medicineId: medId, unitId: baseUnit.id, quantityInput: '4', unitPrice: '5.00' }],
      })
    )
  );

  const successes = settled.filter((r) => r.status === 'fulfilled');
  const failures = settled.filter((r) => r.status === 'rejected') as Array<PromiseRejectedResult>;
  assert.equal(successes.length, 1, `Expected exactly 1 concurrent sale to succeed, got ${successes.length}`);
  assert.equal(failures.length, 3);
  for (const f of failures) {
    assert.match(String((f.reason as Error)?.message || f.reason), /Insufficient.*stock/i);
  }

  const batchAfter = (await db.queryOne<{ id: string; current_qty_base: string }>(
    "SELECT id, current_qty_base FROM batches WHERE medicine_id = $1 AND batch_number = 'CONC-BATCH-1'",
    [medId]
  ))!;
  assert.equal(batchAfter.current_qty_base, '1.000000');

  // Verify database CHECK (current_qty_base >= 0) directly blocks negative quantity even on raw SQL
  await assert.rejects(
    () => db.execute('UPDATE batches SET current_qty_base = -1 WHERE id = $1', [batchAfter.id]),
    /chk_batches_non_negative_qty|check constraint/i
  );

  const recon = await reconcileInventoryLedger(db);
  assert.equal(recon.healthy, true);
  const chain = await verifyAuditChain(db);
  assert.equal(chain.valid, true);
});

test('6-decimal Excel import validation rejects excess precision and duplicate barcodes, persists valid rows', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

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
      barcode: '9990001112223',
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

  const preview = await parseAndValidateExcelImport(buf);
  assert.equal(preview.length, 2);
  assert.equal(preview[0].errors.length, 0);
  assert.ok(preview[1].errors.some((e) => e.includes('Duplicate barcode')));
  assert.ok(preview[1].errors.some((e) => e.includes('more than 6 decimal places')));

  const result = await executeExcelImport(admin, [preview[0]]);
  assert.equal(result.createdMeds, 1);
  assert.equal(result.addedBatches, 1);

  const insertedMed = (await db.queryOne<{
    medicine_code: string;
    barcode: string;
    storage_info: string;
    min_stock_level: string;
  }>("SELECT medicine_code, barcode, storage_info, min_stock_level FROM medicines WHERE barcode = '9990001112223'"))!;
  assert.equal(insertedMed.medicine_code, 'MED-9001');
  assert.equal(insertedMed.storage_info, 'Shelf E1');
  assert.equal(insertedMed.min_stock_level, '12.500000');
});

test('login rate limiting locks after 5 failures and resets on clear', async () => {
  const user = 'ratetest';
  const ip = '127.0.0.55';
  await clearLoginAttempts(user, ip);
  for (let i = 0; i < 4; i++) {
    const r = await recordFailedLoginAttempt(user, ip);
    assert.equal(r.locked, false);
  }
  const fifth = await recordFailedLoginAttempt(user, ip);
  assert.equal(fifth.locked, true);
  const check = await checkLoginRateLimit(user, ip);
  assert.equal(check.blocked, true);
  await clearLoginAttempts(user, ip);
  assert.equal((await checkLoginRateLimit(user, ip)).blocked, false);
});

test('Forced password change API gating, concurrent HTTP idempotency, concurrent HTTP POS race, and retry after failure', async () => {
  const db = await getDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);
  app.use('/api', buildApiRouter());

  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Health endpoint check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { ok: boolean; database: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.database, testDbName);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
    });
    assert.equal(loginRes.status, 200);
    const cookieHeader = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

    const blockedGet = await fetch(`${baseUrl}/api/medicines`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(blockedGet.status, 403);
    const blockedBody = (await blockedGet.json()) as { code?: string };
    assert.equal(blockedBody.code, 'PASSWORD_CHANGE_REQUIRED');

    const samePwRes = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: cookieHeader },
      body: JSON.stringify({ newPassword: 'Admin@123' }),
    });
    assert.equal(samePwRes.status, 400);

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

    const expCat = (await db.queryOne<{ id: string }>('SELECT id FROM expense_categories LIMIT 1'))!;
    const idempKey = `test-idemp-${Date.now()}`;

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
        body: JSON.stringify({
          paymentMethod: 'BANK',
          amount: '25.00',
          name: 'Idempotent Courier',
          categoryId: expCat.id,
        }),
      }),
    ]);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    const body1 = (await r1.json()) as { expenseNumber: string };
    const body2 = (await r2.json()) as { expenseNumber: string };
    assert.equal(body1.expenseNumber, body2.expenseNumber);

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

    // Concurrent HTTP POS checkout race on remaining 1 unit of ConcurrencyTestMed
    const concMed = (await listMedicines('ConcurrencyTestMed'))[0] as unknown as {
      id: string;
      units: Array<{ id: string; is_base: boolean }>;
    };
    const concUnit = concMed.units.find((u) => Boolean(u.is_base))!;
    const posResponses = await Promise.all(
      [1, 2, 3].map((idx) =>
        fetch(`${baseUrl}/api/sales`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'MediNest',
            'Idempotency-Key': `http-pos-race-${Date.now()}-${idx}`,
            Cookie: cookieHeader,
          },
          body: JSON.stringify({
            payments: [{ method: 'CASH', amount: '5.00' }],
            lines: [{ medicineId: concMed.id, unitId: concUnit.id, quantityInput: '1', unitPrice: '5.00' }],
          }),
        })
      )
    );
    const statuses = posResponses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 400, 400]);

    // Check /api/admin/audit returns both logs and rows cleanly
    const auditRes = await fetch(`${baseUrl}/api/admin/audit?limit=5`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(auditRes.status, 200);
    const auditBody = (await auditRes.json()) as { logs: unknown[]; rows: unknown[]; total: number };
    assert.equal(auditBody.logs.length, auditBody.rows.length);
  } finally {
    server.close();
  }
});

test('PostgreSQL pg_dump backup & restore verifies SHA-256, blocks tampered archives, snapshots PRE_RESTORE, and audits outcomes', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

  const cleanBkp = await createVerifiedBackup(admin, 'MANUAL');
  const rec = (await db.queryOne<{ id: string; file_path: string }>(
    'SELECT id, file_path FROM backup_records WHERE id = $1',
    [cleanBkp.id]
  ))!;

  const cleanCopyBytes = fs.readFileSync(rec.file_path);
  fs.writeFileSync(rec.file_path, Buffer.concat([cleanCopyBytes, Buffer.from('TAMPER')]));

  await assert.rejects(() => restoreFromBackup(admin, rec.id), /SHA-256 checksum mismatch/i);
  const failAudit = (await db.queryOne<{ status: string; reason: string }>(
    "SELECT status, reason FROM audit_logs WHERE action = 'RESTORE_BACKUP' ORDER BY seq DESC LIMIT 1"
  ))!;
  assert.equal(failAudit.status, 'FAILURE');
  assert.match(failAudit.reason, /SHA-256/i);

  fs.writeFileSync(rec.file_path, cleanCopyBytes);
  const markerCatId = crypto.randomUUID();
  await db.execute('INSERT INTO expense_categories (id, name) VALUES ($1, $2)', [
    markerCatId,
    'Post-Backup Temp Cat',
  ]);

  const restored = await restoreFromBackup(admin, rec.id);
  assert.equal(restored.integrity, 'ok');
  assert.equal(restored.sha256, cleanBkp.sha256);
  assert.ok(restored.preRestoreBackup.includes('pre_restore'));

  const dbAfter = await getDb();
  const markerGone = await dbAfter.queryOne('SELECT id FROM expense_categories WHERE id = $1', [markerCatId]);
  assert.equal(markerGone, undefined);
  const successAudit = (await dbAfter.queryOne<{ status: string }>(
    "SELECT status FROM audit_logs WHERE action = 'RESTORE_BACKUP' ORDER BY seq DESC LIMIT 1"
  ))!;
  assert.equal(successAudit.status, 'SUCCESS');
});

test('Audit hash chain detects post-write tampering in PostgreSQL', async () => {
  const db = await getDb();
  const validBefore = await verifyAuditChain(db);
  assert.equal(validBefore.valid, true);

  let detectedBrokenSeq: number | null = null;
  let validInsideTamperedTx = true;

  await assert.rejects(
    () =>
      withTransaction(async (tx) => {
        const first = (await tx.queryOne<{ seq: number }>('SELECT seq FROM audit_logs ORDER BY seq ASC LIMIT 1'))!;
        await tx.execute("UPDATE audit_logs SET reason = 'TAMPERED_IN_PG' WHERE seq = $1", [first.seq]);
        const broken = await verifyAuditChain(tx);
        validInsideTamperedTx = broken.valid;
        detectedBrokenSeq = broken.brokenAtSeq;
        throw new Error('ROLLBACK_TAMPER_CHECK');
      }),
    /ROLLBACK_TAMPER_CHECK/
  );

  assert.equal(validInsideTamperedTx, false);
  assert.equal(detectedBrokenSeq, 1);

  const validAfter = await verifyAuditChain(db);
  assert.equal(validAfter.valid, true);
});

test('License-free HTTP API preserves RBAC, LAN overview, settings, and sales/purchase batched queries', async () => {
  const db = await getDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);
  app.use('/api', buildApiRouter());

  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@NewStrong99!' }),
    });
    assert.equal(loginRes.status, 200);
    const adminCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

    const authMeRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: adminCookie } });
    assert.equal(authMeRes.status, 200);
    const authMeBody = (await authMeRes.json()) as {
      license?: unknown;
      settings: { drug_license_no: string; pharmacy_name: string };
    };
    assert.equal('license' in authMeBody, false);
    assert.ok(authMeBody.settings.drug_license_no.length > 0);

    const overviewRes = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
    assert.equal(overviewRes.status, 200);
    const overviewBody = (await overviewRes.json()) as {
      license?: unknown;
      networkInfo: { port: number; urls: string[] };
      permissions: Array<{ code: string }>;
    };
    assert.equal('license' in overviewBody, false);
    assert.ok(Array.isArray(overviewBody.networkInfo.urls));
    assert.equal(overviewBody.permissions.some((p) => p.code === 'admin.license'), false);

    // Verify batched /api/sales and /api/purchases return full nested lines/allocations/payments cleanly
    const [salesGet, purchasesGet] = await Promise.all([
      fetch(`${baseUrl}/api/sales?limit=20`, { headers: { Cookie: adminCookie } }),
      fetch(`${baseUrl}/api/purchases?limit=20`, { headers: { Cookie: adminCookie } }),
    ]);
    assert.equal(salesGet.status, 200);
    assert.equal(purchasesGet.status, 200);
    const salesJson = (await salesGet.json()) as { sales: Array<{ lines: Array<{ allocations: unknown[] }> }> };
    const purchasesJson = (await purchasesGet.json()) as { purchases: Array<{ lines: unknown[] }> };
    assert.ok(salesJson.sales.length >= 1);
    assert.ok(salesJson.sales[0].lines.length >= 1);
    assert.ok(purchasesJson.purchases.length >= 1);

    const settingsRes = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: adminCookie },
      body: JSON.stringify({
        pharmacyName: authMeBody.settings.pharmacy_name,
        drugLicenseNo: 'DGDA-PG-2026',
        currency: 'BDT',
        expiryWarningDays: 90,
      }),
    });
    assert.equal(settingsRes.status, 200);

    const updatedSettings = (await db.queryOne<{ drug_license_no: string }>(
      'SELECT drug_license_no FROM pharmacy_settings WHERE id = 1'
    ))!;
    assert.equal(updatedSettings.drug_license_no, 'DGDA-PG-2026');

    const cashierRole = (await db.queryOne<{ id: string }>("SELECT id FROM roles WHERE name = 'POS Cashier'"))!;
    const testCashierId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO users (id, username, password_hash, full_name, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
       VALUES ($1, 'rbac_cashier', $2, 'RBAC Cashier', $3, FALSE, TRUE, FALSE, $4, $5)`,
      [testCashierId, hashPassword('Cashier@Strong99!'), cashierRole.id, now, now]
    );

    const cashierLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
      body: JSON.stringify({ username: 'rbac_cashier', password: 'Cashier@Strong99!' }),
    });
    assert.equal(cashierLogin.status, 200);
    const cashierCookie = cashierLogin.headers.get('set-cookie')?.split(';')[0] || '';

    const cashierOverview = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: cashierCookie },
    });
    assert.equal(cashierOverview.status, 200);
    const cashierOverviewBody = (await cashierOverview.json()) as {
      users: unknown[];
      auditLogs: unknown[];
      backups: unknown[];
    };
    assert.equal(cashierOverviewBody.users.length, 0);
    assert.equal(cashierOverviewBody.auditLogs.length, 0);
    assert.equal(cashierOverviewBody.backups.length, 0);

    for (const [method, endpoint] of [
      ['POST', '/api/admin/users'],
      ['GET', '/api/admin/audit/export'],
      ['POST', '/api/admin/backups'],
      ['PUT', '/api/admin/settings'],
    ] as const) {
      const denied = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: cashierCookie },
        ...(method === 'PUT' || method === 'POST' ? { body: JSON.stringify({ pharmacyName: 'Hack' }) } : {}),
      });
      assert.equal(denied.status, 403);
    }

    await db.execute('DELETE FROM sessions WHERE user_id = $1', [testCashierId]);
    await db.execute('DELETE FROM users WHERE id = $1', [testCashierId]);
  } finally {
    server.close();
  }
});

test('SQLite-to-PostgreSQL migration script preserves all real pharmacy.db data, financial sums, inventory ledger, and audit chain cleanly', async () => {
  const realSqlitePath = path.resolve(process.cwd(), 'data/pharmacy.db');
  if (!fs.existsSync(realSqlitePath)) {
    return;
  }

  await closeDb();
  await withAdminPgClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${migTestDbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${migTestDbName}"`);
  });

  process.env.PGDATABASE = migTestDbName;
  try {
    const summary = await migrateSqliteToPostgres({ sqlitePath: realSqlitePath, force: true });
    assert.equal(summary.inventoryLedgerHealthy, true);
    assert.equal(summary.auditChainValid, true);
    assert.equal(
      summary.financialTotals.salesNetTotal.sqlite,
      summary.financialTotals.salesNetTotal.postgres
    );
    assert.equal(
      summary.financialTotals.batchStockTotalBase.sqlite,
      summary.financialTotals.batchStockTotalBase.postgres
    );
    assert.ok(summary.tableCounts.medicines.postgres >= 1);
    assert.ok(summary.tableCounts.batches.postgres >= 1);
    assert.ok(summary.tableCounts.users.postgres >= 1);

    // Re-running without --force MUST abort cleanly without overwriting migrated data
    await assert.rejects(() => migrateSqliteToPostgres({ sqlitePath: realSqlitePath, force: false }), /not empty/i);
  } finally {
    await closeDb();
    await withAdminPgClient(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${migTestDbName}" WITH (FORCE)`);
    });
    process.env.PGDATABASE = testDbName;
    await getDb();
  }
});
