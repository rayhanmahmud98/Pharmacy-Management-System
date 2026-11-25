import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import zlib from 'node:zlib';
import pg from 'pg';
import ExcelJS from 'exceljs';

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
  checkDbHealth,
  generateDocNumber,
  sanitizeHttpError,
  setDbMaintenanceMode,
  withTransaction,
} = await import('./db.ts');
const { seedDatabaseIfEmpty } = await import('./seed.ts');
const {
  resolveSessionMiddleware,
  checkLoginRateLimit,
  clearLoginAttempts,
  extractClientIp,
  getUserEffectivePermissions,
  hashPassword,
  loadAuthUserById,
  recordFailedLoginAttempt,
} = await import('./auth.ts');
const { verifyAuditChain, exportAuditLogsExcelBuffer } = await import('./audit.ts');
const {
  adjustStock,
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
const { completeSale, createSalesReturn, reverseSale } = await import('./services/salesService.ts');
const {
  closeCashSession,
  createExpense,
  getActiveCashSessionId,
  getCashSessionSummary,
  getOpenCashSessionsSummary,
  openCashSession,
  recordPartyPayment,
  reversePayment,
} = await import('./services/financeService.ts');
const {
  buildMedicineImportTemplateBuffer,
  createVerifiedBackup,
  parseAndValidateExcelImport,
  executeExcelImport,
  restoreFromBackup,
} = await import('./services/backupService.ts');
const {
  MAX_XLSX_UPLOAD_BYTES,
  parseXlsxFirstSheetToRows,
  writeSheetsToXlsxBuffer,
} = await import('./services/excelService.ts');
const { exportReportToExcelBuffer, getComprehensiveReport } = await import('./services/reportService.ts');
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
      opening_expiry_date: new Date('2029-12-31T00:00:00Z'),
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
  const buf = await writeSheetsToXlsxBuffer([{ name: 'Sheet1', rows }]);

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

test('PRIORITY 1 & 2: Multi-counter simultaneous cash sessions, independent closing, ambiguity guard, and concurrent LAN multi-session requests', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

  // Close any pre-existing open sessions so we start from a clean slate
  const preOpen = await db.query<{ id: string }>("SELECT id FROM cash_sessions WHERE status = 'OPEN'");
  for (const s of preOpen) {
    const sum = (await getCashSessionSummary(s.id, db))!;
    await closeCashSession(admin, s.id, {
      actualCash: sum.totals.expectedCash,
      varianceReason: 'Reset prior shift for multi-counter test',
      forceClose: true,
    });
  }

  // Open COUNTER-1 and COUNTER-2 simultaneously
  const c1 = await openCashSession(admin, '1000.00', 'Morning shift counter 1', undefined, 'COUNTER-1');
  const c2 = await openCashSession(admin, '2500.00', 'Morning shift counter 2', undefined, 'COUNTER-2');
  assert.equal(c1.counterCode, 'COUNTER-1');
  assert.equal(c2.counterCode, 'COUNTER-2');

  // Opening a second OPEN session on COUNTER-1 must fail
  await assert.rejects(
    () => openCashSession(admin, '100.00', 'Duplicate counter 1', undefined, 'COUNTER-1'),
    /already OPEN for COUNTER-1/i
  );

  // Ambiguity guard when >1 counter open and no counterCode/sessionId supplied
  await assert.rejects(() => getActiveCashSessionId(db), /Multiple counter cash sessions are currently OPEN/i);

  const med = (await listMedicines('Napa Extend'))[0] as unknown as {
    id: string;
    units: Array<{ id: string; is_base: boolean }>;
  };
  const baseUnit = med.units.find((u) => Boolean(u.is_base))!;
  const expCat = (await db.queryOne<{ id: string }>('SELECT id FROM expense_categories LIMIT 1'))!;

  // Spin up HTTP server and create second concurrent cashier terminal session
  const cashierRole = (await db.queryOne<{ id: string }>("SELECT id FROM roles WHERE name = 'POS Cashier'"))!;
  const lanCashierId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO users (id, username, password_hash, full_name, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
     VALUES ($1, 'lan_cashier2', $2, 'Counter 2 Cashier', $3, FALSE, TRUE, FALSE, $4, $5)`,
    [lanCashierId, hashPassword('Cashier@LAN2!'), cashierRole.id, now, now]
  );

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);
  app.use('/api', buildApiRouter());
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const [admLogin, cashLogin] = await Promise.all([
      fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
        body: JSON.stringify({ username: 'admin', password: 'Admin@NewStrong99!' }),
      }),
      fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
        body: JSON.stringify({ username: 'lan_cashier2', password: 'Cashier@LAN2!' }),
      }),
    ]);
    assert.equal(admLogin.status, 200);
    assert.equal(cashLogin.status, 200);
    const adminCookie = admLogin.headers.get('set-cookie')?.split(';')[0] || '';
    const cashierCookie = cashLogin.headers.get('set-cookie')?.split(';')[0] || '';

    // Concurrent LAN requests from COUNTER-1 (admin) and COUNTER-2 (cashier)
    const [saleC1Res, saleC2Res, expC2Res, dashC1Res, dashC2Res] = await Promise.all([
      fetch(`${baseUrl}/api/sales`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'X-Counter-Id': 'COUNTER-1',
          'Idempotency-Key': `lan-c1-${Date.now()}`,
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          payments: [{ method: 'CASH', amount: '20.00' }],
          lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '10', unitPrice: '2.00' }],
        }),
      }),
      fetch(`${baseUrl}/api/sales`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'X-Counter-Id': 'COUNTER-2',
          'Idempotency-Key': `lan-c2-${Date.now()}`,
          Cookie: cashierCookie,
        },
        body: JSON.stringify({
          payments: [{ method: 'CASH', amount: '50.00' }],
          lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '25', unitPrice: '2.00' }],
        }),
      }),
      createExpense(admin, {
        categoryId: expCat.id,
        name: 'Counter 2 Stationery',
        amount: '15.00',
        paymentMethod: 'CASH',
        counterCode: 'COUNTER-2',
      }),
      fetch(`${baseUrl}/api/dashboard`, {
        headers: { Cookie: adminCookie, 'X-Counter-Id': 'COUNTER-1' },
      }),
      fetch(`${baseUrl}/api/dashboard`, {
        headers: { Cookie: cashierCookie, 'X-Counter-Id': 'COUNTER-2' },
      }),
    ]);

    assert.equal(saleC1Res.status, 201);
    assert.equal(saleC2Res.status, 201);
    assert.ok(expC2Res.expenseId);
    assert.equal(dashC1Res.status, 200);
    assert.equal(dashC2Res.status, 200);

    const openList = await getOpenCashSessionsSummary(db);
    assert.equal(openList.length, 2);
    const sum1 = (await getCashSessionSummary(c1.id, db))!;
    const sum2 = (await getCashSessionSummary(c2.id, db))!;
    assert.equal(sum1.totals.expectedCash, '1020.00');
    assert.equal(sum2.totals.expectedCash, '2535.00');

    // Close COUNTER-1 independently with variance (-5.00); verify COUNTER-2 stays OPEN and closed summary preserves pre-variance expectedCash
    const close1 = await closeCashSession(admin, c1.id, {
      actualCash: '1015.00',
      varianceReason: 'Short 5 BDT coin',
    });
    assert.equal(close1.variance, '-5.00');
    const c1ClosedSummary = (await getCashSessionSummary(c1.id, db))!;
    assert.equal(c1ClosedSummary.totals.expectedCash, '1020.00');

    const c2StillOpen = await db.queryOne<{ status: string }>('SELECT status FROM cash_sessions WHERE id = $1', [c2.id]);
    assert.equal(c2StillOpen?.status, 'OPEN');

    // Close COUNTER-2 cleanly
    await closeCashSession(admin, c2.id, { actualCash: '2535.00' });
    await openCashSession(admin, '500.00', 'Reopen COUNTER-1', db, 'COUNTER-1');
  } finally {
    server.close();
    await db.execute('DELETE FROM sessions WHERE user_id = $1', [lanCashierId]);
  }
});

test('PRIORITY 4, 5 & 7: Reversal idempotency, shared-payment sale reversal guard, quarantine batch expiry match, filtered reports, and proxy-spoofing/audit hardening', async () => {
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

  // Create two batches sharing batch_number with different expiry dates to test QUARANTINE exact (medicine, batch_number, expiry) lookup
  await createPurchase(admin, {
    supplierId: sup.id,
    status: 'RECEIVED',
    paidAmount: '0.00',
    lines: [
      {
        medicineId: med.id,
        unitId: boxUnit.id,
        batchNumber: 'SHARED-BN-99',
        expiryDate: '2030-01-15',
        quantityInput: '1',
        unitCost: '120.00',
        sellingPricePerBase: '2.00',
      },
      {
        medicineId: med.id,
        unitId: boxUnit.id,
        batchNumber: 'SHARED-BN-99',
        expiryDate: '2030-06-15',
        quantityInput: '1',
        unitCost: '120.00',
        sellingPricePerBase: '2.00',
      },
    ],
  });

  // Dedicated customer for filtered report & shared-payment reversal guard test
  const custA = crypto.randomUUID();
  const custB = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.execute(
    `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, advance_balance, credit_limit, notes, is_active, created_at, updated_at)
     VALUES ($1, 'CUST-FLT-A', 'Filter Cust A', '01710000001', '', '0.00', '0.00', '0.00', '5000.00', '', TRUE, $3, $4),
            ($2, 'CUST-FLT-B', 'Filter Cust B', '01710000002', '', '0.00', '0.00', '0.00', '5000.00', '', TRUE, $3, $4)`,
    [custA, custB, ts, ts]
  );

  const sA1 = await completeSale(admin, {
    counterCode: 'COUNTER-1',
    customerId: custA,
    payments: [],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '10', unitPrice: '2.00' }],
  });
  const sA2 = await completeSale(admin, {
    counterCode: 'COUNTER-1',
    customerId: custA,
    payments: [],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '15', unitPrice: '2.00' }],
  });
  const sB1 = await completeSale(admin, {
    counterCode: 'COUNTER-1',
    customerId: custB,
    payments: [{ method: 'CASH', amount: '40.00' }],
    lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '20', unitPrice: '2.00' }],
  });
  const sB1Line = (await db.queryOne<{ id: string }>('SELECT id FROM sale_lines WHERE sale_id = $1', [sB1.saleId]))!;
  await createSalesReturn(admin, {
    counterCode: 'COUNTER-1',
    saleId: sB1.saleId,
    settlementType: 'CASH_REFUND',
    reason: 'Quarantine test return 1',
    lines: [{ saleLineId: sB1Line.id, qtyBase: '2', disposition: 'QUARANTINE' }],
  });
  // Second quarantine return on same invoice/batch must accumulate cleanly instead of hitting unique constraint
  await createSalesReturn(admin, {
    counterCode: 'COUNTER-1',
    saleId: sB1.saleId,
    settlementType: 'CASH_REFUND',
    reason: 'Quarantine test return 2',
    lines: [{ saleLineId: sB1Line.id, qtyBase: '3', disposition: 'QUARANTINE' }],
  });

  // Filtered report for customer A must NOT subtract customer B's returns
  const repCustA = await getComprehensiveReport({ customerId: custA });
  assert.equal(repCustA.profitSummary.grossSales, '50.00');
  assert.equal(repCustA.profitSummary.salesReturns, '0.00');
  assert.equal(repCustA.profitSummary.netSales, '50.00');

  // Shared multi-invoice payment for customer A
  const sharedPay = await recordPartyPayment(admin, {
    partyType: 'CUSTOMER',
    partyId: custA,
    method: 'BANK',
    amount: '50.00',
  });
  // Direct reverseSale on sA1 must be blocked because sharedPay spans multiple invoices
  await assert.rejects(
    () => reverseSale(admin, sA1.saleId, 'Direct reversal attempt while shared payment active'),
    /Reverse PAY-.*first/i
  );
  // Reverse the shared payment first, then reverseSale succeeds cleanly!
  await reversePayment(admin, sharedPay.paymentId, 'Undo shared payment before invoice reversal');
  await reverseSale(admin, sA1.saleId, 'Clean reversal after shared payment undone');

  // Security & Reversal Idempotency HTTP verification
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);
  app.use('/api', buildApiRouter());
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Spoofed X-Forwarded-For must be ignored when trust proxy is disabled
    const spoofResIp = extractClientIp({
      ip: '192.168.1.44',
      headers: { 'x-forwarded-for': '8.8.8.8, 1.1.1.1' },
      socket: { remoteAddress: '192.168.1.44' },
    } as unknown as express.Request);
    assert.equal(spoofResIp, '192.168.1.44');

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@NewStrong99!' }),
    });
    const adminCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

    // Idempotent sale reversal replay + mismatch 409
    const revKey = `rev-sale-idemp-${Date.now()}`;
    const [rev1, rev2] = await Promise.all([
      fetch(`${baseUrl}/api/sales/${sA2.saleId}/reverse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'Idempotency-Key': revKey,
          Cookie: adminCookie,
        },
        body: JSON.stringify({ reason: 'Idempotent reversal check' }),
      }),
      fetch(`${baseUrl}/api/sales/${sA2.saleId}/reverse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'Idempotency-Key': revKey,
          Cookie: adminCookie,
        },
        body: JSON.stringify({ reason: 'Idempotent reversal check' }),
      }),
    ]);
    assert.equal(rev1.status, 200);
    assert.equal(rev2.status, 200);

    const revMismatch = await fetch(`${baseUrl}/api/sales/${sA2.saleId}/reverse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'MediNest',
        'Idempotency-Key': revKey,
        Cookie: adminCookie,
      },
      body: JSON.stringify({ reason: 'Different reversal reason' }),
    });
    assert.equal(revMismatch.status, 409);

    // Category & Manufacturer creation must append audit_logs
    const catCreate = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: adminCookie },
      body: JSON.stringify({ name: 'AuditVerifiedCat' }),
    });
    assert.equal(catCreate.status, 201);
    const catAudit = await db.queryOne<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'CREATE_CATEGORY' ORDER BY seq DESC LIMIT 1"
    );
    assert.equal(catAudit?.action, 'CREATE_CATEGORY');

    // Expense reversal idempotency & audit verification
    const expCatRow = (await db.queryOne<{ id: string }>('SELECT id FROM expense_categories LIMIT 1'))!;
    const expCreated = await createExpense(admin, {
      categoryId: expCatRow.id,
      name: 'Idempotent Reversal Expense',
      amount: '12.00',
      paymentMethod: 'BANK',
    });
    const expRevKey = `rev-exp-idemp-${Date.now()}`;
    const [expRev1, expRev2] = await Promise.all([
      fetch(`${baseUrl}/api/expenses/${expCreated.expenseId}/reverse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'Idempotency-Key': expRevKey,
          Cookie: adminCookie,
        },
        body: JSON.stringify({ reason: 'Idempotent expense reversal' }),
      }),
      fetch(`${baseUrl}/api/expenses/${expCreated.expenseId}/reverse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'Idempotency-Key': expRevKey,
          Cookie: adminCookie,
        },
        body: JSON.stringify({ reason: 'Idempotent expense reversal' }),
      }),
    ]);
    assert.equal(expRev1.status, 200);
    assert.equal(expRev2.status, 200);

    // Clean close & check ledger invariants
    const chain = await verifyAuditChain(db);
    assert.equal(chain.valid, true);
    const recon = await reconcileInventoryLedger(db);
    assert.equal(recon.healthy, true);
  } finally {
    server.close();
  }
});

test('PRIORITY 6: Live PostgreSQL backup & recovery drill in isolated DB restores exact counts/sums, ledger health, and audit chain', async () => {
  const drillDbName = `medinest_drill_${process.pid}_${Date.now()}`;
  await withAdminPgClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${drillDbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${drillDbName}"`);
  });

  await closeDb();
  process.env.PGDATABASE = drillDbName;

  try {
    const drillDb = await getDb();
    await seedDatabaseIfEmpty();

    const adminRow = (await drillDb.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
    const admin = (await loadAuthUserById(adminRow.id))!;

    const med = (await listMedicines('Napa Extend'))[0] as unknown as {
      id: string;
      units: Array<{ id: string; is_base: boolean }>;
    };
    const baseUnit = med.units.find((u) => Boolean(u.is_base))!;

    // Record operational transactions before backup
    await completeSale(admin, {
      counterCode: 'COUNTER-1',
      payments: [{ method: 'CASH', amount: '30.00' }],
      lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '15', unitPrice: '2.00' }],
    });

    const beforeStats = (await drillDb.queryOne<{
      med_count: string;
      batch_stock_sum: string;
      sales_count: string;
      sales_sum: string;
      audit_count: string;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM medicines)::text AS med_count,
        (SELECT COALESCE(SUM(current_qty_base), 0) FROM batches)::text AS batch_stock_sum,
        (SELECT COUNT(*) FROM sales)::text AS sales_count,
        (SELECT COALESCE(SUM(net_total), 0) FROM sales WHERE status = 'COMPLETED')::text AS sales_sum,
        (SELECT COUNT(*) FROM audit_logs)::text AS audit_count`
    ))!;

    // 1. Take verified pg_dump backup
    const backup = await createVerifiedBackup(admin, 'MANUAL');
    assert.ok(backup.sizeBytes > 0);
    assert.match(backup.integrityCheck, /pg_restore TOC verified/i);

    // 2. Simulate post-backup disaster mutations (delete/modify non-audit rows + add bogus sale)
    await completeSale(admin, {
      counterCode: 'COUNTER-1',
      payments: [{ method: 'CASH', amount: '10.00' }],
      lines: [{ medicineId: med.id, unitId: baseUnit.id, quantityInput: '5', unitPrice: '2.00' }],
    });
    await drillDb.execute('INSERT INTO expense_categories (id, name) VALUES ($1, $2)', [
      crypto.randomUUID(),
      'Disaster-Post-Backup-Cat',
    ]);

    const mutatedStats = (await drillDb.queryOne<{ sales_count: string; sales_sum: string }>(
      `SELECT COUNT(*)::text AS sales_count, COALESCE(SUM(net_total), 0)::text AS sales_sum FROM sales WHERE status = 'COMPLETED'`
    ))!;
    assert.notEqual(mutatedStats.sales_count, beforeStats.sales_count);

    // 3. Restore from verified backup
    const restoreRes = await restoreFromBackup(admin, backup.id);
    assert.equal(restoreRes.integrity, 'ok');

    // 4. Verify pre-mutation data, financial sums, inventory ledger & audit hash chain match 100%
    const restoredDb = await getDb();
    const afterStats = (await restoredDb.queryOne<{
      med_count: string;
      batch_stock_sum: string;
      sales_count: string;
      sales_sum: string;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM medicines)::text AS med_count,
        (SELECT COALESCE(SUM(current_qty_base), 0) FROM batches)::text AS batch_stock_sum,
        (SELECT COUNT(*) FROM sales)::text AS sales_count,
        (SELECT COALESCE(SUM(net_total), 0) FROM sales WHERE status = 'COMPLETED')::text AS sales_sum`
    ))!;

    assert.equal(afterStats.med_count, beforeStats.med_count);
    assert.equal(afterStats.batch_stock_sum, beforeStats.batch_stock_sum);
    assert.equal(afterStats.sales_count, beforeStats.sales_count);
    assert.equal(afterStats.sales_sum, beforeStats.sales_sum);

    const bogusGone = await restoredDb.queryOne("SELECT id FROM expense_categories WHERE name = 'Disaster-Post-Backup-Cat'");
    assert.equal(bogusGone, undefined);

    const recon = await reconcileInventoryLedger(restoredDb);
    assert.equal(recon.healthy, true);
    const chain = await verifyAuditChain(restoredDb);
    assert.equal(chain.valid, true);
  } finally {
    await closeDb();
    await withAdminPgClient(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${drillDbName}" WITH (FORCE)`);
    });
    process.env.PGDATABASE = testDbName;
    await getDb();
  }
});

function buildRawZipBuffer(
  entries: Array<{ name: string; content: Buffer; deflate?: boolean; spoofUncompressedSize?: number }>
): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? zlib.deflateRawSync(entry.content) : entry.content;
    const uncompressedSize = entry.spoofUncompressedSize ?? entry.content.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    localParts.push(local, payload);
    cdParts.push(cd);
    offset += local.length + payload.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

test('EXCELJS SECURITY & WORKFLOW: template, multi-sheet export, audit export, malformed/macro/zip-bomb/prototype defense, and RBAC', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

  // 1. Template round-trip produces valid .xlsx and passes validation with 0 errors
  const templateBuf = await buildMedicineImportTemplateBuffer();
  assert.equal(templateBuf.subarray(0, 4).toString('hex'), '504b0304');
  const templatePreview = await parseAndValidateExcelImport(templateBuf);
  assert.equal(templatePreview.length, 1);
  assert.equal(templatePreview[0].errors.length, 0);
  assert.equal(templatePreview[0].openingExpiryDate, '2028-06-30');

  // 2. Reports & Audit Excel exports produce readable multi-sheet / single-sheet .xlsx buffers & neutralize formula injection
  await db.execute(
    `INSERT INTO categories (id, name, description) VALUES ($1, $2, 'Test formula neutralization')`,
    [crypto.randomUUID(), '=cmd|calc']
  );
  const reportBuf = await exportReportToExcelBuffer({});
  const reportWb = new ExcelJS.Workbook();
  await reportWb.xlsx.load(reportBuf as unknown as Parameters<typeof reportWb.xlsx.load>[0]);
  assert.deepEqual(
    reportWb.worksheets.map((w) => w.name),
    ['Profit_Summary', 'Sales_Ledger', 'Sales_By_Medicine', 'Inventory_Valuation', 'Purchases', 'Expenses']
  );

  const formulaBuf = await writeSheetsToXlsxBuffer([
    { name: 'FormulaCheck', rows: [{ col: '=SUM(A1:A2)', neg: '-50.00', plusCmd: '+cmd|calc' }] },
  ]);
  const fWb = new ExcelJS.Workbook();
  await fWb.xlsx.load(formulaBuf as unknown as Parameters<typeof fWb.xlsx.load>[0]);
  assert.equal(fWb.worksheets[0].getRow(2).getCell(1).value, "'=SUM(A1:A2)");
  assert.equal(fWb.worksheets[0].getRow(2).getCell(2).value, '-50.00');
  assert.equal(fWb.worksheets[0].getRow(2).getCell(3).value, "'+cmd|calc");

  const auditBuf = await exportAuditLogsExcelBuffer(db, {});
  const auditWb = new ExcelJS.Workbook();
  await auditWb.xlsx.load(auditBuf as unknown as Parameters<typeof auditWb.xlsx.load>[0]);
  assert.equal(auditWb.worksheets[0].name, 'Audit_Logs');
  assert.ok(auditWb.worksheets[0].actualRowCount >= 2);

  // 3. Empty workbooks & blank sheet rejection
  await assert.rejects(() => parseAndValidateExcelImport(Buffer.alloc(0)), /empty/i);
  const zeroSheetWb = new ExcelJS.Workbook();
  const zeroSheetBuf = Buffer.from(await zeroSheetWb.xlsx.writeBuffer());
  await assert.rejects(() => parseAndValidateExcelImport(zeroSheetBuf), /no sheets/i);

  const blankSheetWb = new ExcelJS.Workbook();
  blankSheetWb.addWorksheet('Blank');
  const blankSheetBuf = Buffer.from(await blankSheetWb.xlsx.writeBuffer());
  await assert.rejects(() => parseAndValidateExcelImport(blankSheetBuf), /empty/i);

  // 4. Invalid file formats & malformed archives
  const legacyXls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
  await assert.rejects(() => parseAndValidateExcelImport(legacyXls), /Legacy binary \.xls/i);
  await assert.rejects(() => parseAndValidateExcelImport(Buffer.from('%PDF-1.7 fake pdf content')), /Invalid file format/i);

  const nonWorkbookZip = buildRawZipBuffer([{ name: 'hello.txt', content: Buffer.from('not an xlsx') }]);
  await assert.rejects(() => parseAndValidateExcelImport(nonWorkbookZip), /missing required Excel workbook metadata/i);

  const corruptedZip = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('corrupt-garbage-bytes-0123456789')]);
  await assert.rejects(() => parseAndValidateExcelImport(corruptedZip), /missing ZIP central directory/i);

  // 5. Macro / ActiveX / Path Traversal / Spoofed ZIP Bomb defenses
  const macroZip = buildRawZipBuffer([
    { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
    { name: 'xl/workbook.xml', content: Buffer.from('<workbook/>') },
    { name: 'xl/vbaProject.bin', content: Buffer.from('MZfakeMacro') },
  ]);
  await assert.rejects(() => parseAndValidateExcelImport(macroZip), /Macro-enabled/i);

  const traversalZip = buildRawZipBuffer([
    { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
    { name: 'xl/workbook.xml', content: Buffer.from('<workbook/>') },
    { name: '../../etc/passwd', content: Buffer.from('root:x:0:0') },
  ]);
  await assert.rejects(() => parseAndValidateExcelImport(traversalZip), /path traversal/i);

  // Forged uncompressedSize=10 in ZIP header while deflated stream expands to 16 MB (> 15 MB limit)
  const bombZip = buildRawZipBuffer([
    { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
    { name: 'xl/workbook.xml', content: Buffer.from('<workbook/>') },
    {
      name: 'xl/sharedStrings.xml',
      content: Buffer.alloc(16 * 1024 * 1024, 0x41),
      deflate: true,
      spoofUncompressedSize: 10,
    },
  ]);
  await assert.rejects(() => parseAndValidateExcelImport(bombZip), /safety limit/i);

  // 6. Oversized raw buffer & row/column limits
  await assert.rejects(() => parseAndValidateExcelImport(Buffer.alloc(MAX_XLSX_UPLOAD_BYTES + 1)), /maximum upload size/i);

  const manyRowsBuf = await writeSheetsToXlsxBuffer([
    {
      name: 'Many',
      rows: Array.from({ length: 6 }, (_, i) => ({
        brand_name: `Med${i}`,
        generic_name: 'Gen',
        base_unit: 'Tablet',
      })),
    },
  ]);
  await assert.rejects(() => parseXlsxFirstSheetToRows(manyRowsBuf, { maxRows: 5 }), /maximum allowed limit of 5 rows/i);
  await assert.rejects(() => parseXlsxFirstSheetToRows(templateBuf, { maxCols: 3 }), /maximum allowed limit of 3 columns/i);

  // 7. Missing required columns & prototype pollution header stripping
  const missingColBuf = await writeSheetsToXlsxBuffer([
    { name: 'MissingCol', rows: [{ brand_name: 'OnlyBrand', generic_name: 'OnlyGeneric' }] },
  ]);
  await assert.rejects(() => parseAndValidateExcelImport(missingColBuf), /Missing required column\(s\): base_unit/i);

  const protoWb = new ExcelJS.Workbook();
  const protoWs = protoWb.addWorksheet('Proto');
  protoWs.addRow(['brand_name', 'generic_name', 'base_unit', '__proto__', 'constructor']);
  protoWs.addRow(['ProtoSafeMed', 'Paracetamol', 'Tablet', '{"polluted":true}', 'bad']);
  const protoBuf = Buffer.from(await protoWb.xlsx.writeBuffer());
  const protoParsed = await parseXlsxFirstSheetToRows(protoBuf, {
    requiredHeaders: ['brand_name', 'generic_name', 'base_unit'],
  });
  assert.equal(protoParsed.length, 1);
  assert.equal(Object.getPrototypeOf(protoParsed[0]), null);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(protoParsed[0], '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(protoParsed[0], 'constructor'), false);

  // 8. Empty rows skipped, invalid dates, incorrect numbers, duplicate medicine detection, atomic failure guard
  const mixedWb = new ExcelJS.Workbook();
  const mixedWs = mixedWb.addWorksheet('Mixed');
  mixedWs.addRow([
    'brand_name',
    'generic_name',
    'strength',
    'base_unit',
    'opening_batch_number',
    'opening_expiry_date',
    'opening_qty_base',
    'cost_per_base',
    'selling_price_per_base',
  ]);
  mixedWs.addRow(['', '', '', '', '', '', '', '', '']); // empty row -> skipped cleanly
  mixedWs.addRow(['PreciseDrop', 'Xylometazoline', '0.1%', 'ml', 'PD-BAD', 'not-a-date', '-5', '1.00', 'abc']);
  mixedWs.addRow(['PreciseDrop', 'Xylometazoline', '0.1%', 'ml', 'PD-PAST', '2020-01-01', '5', '1.00', '2.00']);
  const mixedBuf = Buffer.from(await mixedWb.xlsx.writeBuffer());
  const mixedPreview = await parseAndValidateExcelImport(mixedBuf);
  assert.equal(mixedPreview.length, 2);
  assert.ok(mixedPreview[0].duplicateMedicineId);
  assert.ok(mixedPreview[0].errors.some((e) => e.includes('YYYY-MM-DD')));
  assert.ok(mixedPreview[0].errors.some((e) => e.includes('opening_qty_base')));
  assert.ok(mixedPreview[0].errors.some((e) => e.includes('selling_price_per_base')));
  assert.ok(mixedPreview[1].errors.some((e) => e.includes('YYYY-MM-DD')));
  await assert.rejects(() => executeExcelImport(admin, mixedPreview), /validation errors/i);

  // 9. HTTP RBAC permission checks & clean 400 error handling on malformed payloads
  const roleRow = (await db.queryOne<{ id: string }>("SELECT id FROM roles WHERE name = 'POS Cashier'"))!;
  const noPermId = crypto.randomUUID();
  const nowIsoTs = new Date().toISOString();
  await db.execute(
    `INSERT INTO users (id, username, full_name, password_hash, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
     VALUES ($1, 'xlsx_cashier', 'Cashier No Import', $2, $3, FALSE, TRUE, FALSE, $4, $5)`,
    [noPermId, hashPassword('Cashier@123'), roleRow.id, nowIsoTs, nowIsoTs]
  );

  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);
  app.use('/api', buildApiRouter());

  const srv = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const login = async (username: string, password: string) => {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(r.status, 200);
      return r.headers.get('set-cookie')!.split(';')[0];
    };

    const cashierCookie = await login('xlsx_cashier', 'Cashier@123');
    const adminCookie = await login('admin', 'Admin@NewStrong99!');

    // Cashier lacks medicines.manage & admin.audit -> 403
    const tplForbidden = await fetch(`${baseUrl}/api/medicines/import/template`, {
      headers: { Cookie: cashierCookie },
    });
    assert.equal(tplForbidden.status, 403);

    const prevForbidden = await fetch(`${baseUrl}/api/medicines/import/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: cashierCookie },
      body: JSON.stringify({ fileBase64: templateBuf.toString('base64') }),
    });
    assert.equal(prevForbidden.status, 403);

    const execForbidden = await fetch(`${baseUrl}/api/medicines/import/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: cashierCookie },
      body: JSON.stringify({ rows: [] }),
    });
    assert.equal(execForbidden.status, 403);

    const auditExportForbidden = await fetch(`${baseUrl}/api/admin/audit/export`, {
      headers: { Cookie: cashierCookie },
    });
    assert.equal(auditExportForbidden.status, 403);

    // Admin downloads template, reports export, and audit export -> 200 XLSX
    const tplOk = await fetch(`${baseUrl}/api/medicines/import/template`, { headers: { Cookie: adminCookie } });
    assert.equal(tplOk.status, 200);
    assert.match(tplOk.headers.get('content-type') || '', /spreadsheetml\.sheet/);

    const rptOk = await fetch(`${baseUrl}/api/reports/export`, { headers: { Cookie: adminCookie } });
    assert.equal(rptOk.status, 200);
    const rptArr = Buffer.from(await rptOk.arrayBuffer());
    assert.equal(rptArr.subarray(0, 4).toString('hex'), '504b0304');

    const audOk = await fetch(`${baseUrl}/api/admin/audit/export`, { headers: { Cookie: adminCookie } });
    assert.equal(audOk.status, 200);
    const audArr = Buffer.from(await audOk.arrayBuffer());
    assert.equal(audArr.subarray(0, 4).toString('hex'), '504b0304');

    // Admin malformed payload -> clean 400 error without crash
    const badPrevRes = await fetch(`${baseUrl}/api/medicines/import/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest', Cookie: adminCookie },
      body: JSON.stringify({ fileBase64: Buffer.from('not-an-excel-file-at-all-0123456789').toString('base64') }),
    });
    assert.equal(badPrevRes.status, 400);
    const badPrevJson = (await badPrevRes.json()) as { error: string };
    assert.match(badPrevJson.error, /Invalid file format/i);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('PHASE 6 TASK 4 & HTTP HARDENING: 3-role LAN workflow, 3-counter independent drawers, refresh persistence, JSON 404 & 400 error handlers', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

  // Close any open sessions first
  const preOpen = await db.query<{ id: string }>("SELECT id FROM cash_sessions WHERE status = 'OPEN'");
  for (const s of preOpen) {
    const sum = (await getCashSessionSummary(s.id, db))!;
    await closeCashSession(admin, s.id, {
      actualCash: sum.totals.expectedCash,
      varianceReason: 'Reset prior shift before Phase 6 Task 4 test',
      forceClose: true,
    });
  }

  const cashierRole = (await db.queryOne<{ id: string }>("SELECT id FROM roles WHERE name = 'POS Cashier'"))!;
  const invRole = (await db.queryOne<{ id: string }>("SELECT id FROM roles WHERE name = 'Pharmacy Manager'"))!;
  const ts = new Date().toISOString();

  await db.execute(
    `INSERT INTO users (id, username, full_name, password_hash, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
     VALUES ($1, 'p6_cashier', 'Phase6 Cashier', $3, $4, FALSE, TRUE, FALSE, $5, $6),
            ($2, 'p6_inventory', 'Phase6 Inventory', $3, $7, FALSE, TRUE, FALSE, $5, $6)`,
    [crypto.randomUUID(), crypto.randomUUID(), hashPassword('Phase6@User!'), cashierRole.id, ts, ts, invRole.id]
  );

  // Full Express stack matching server.ts error handling
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);
  app.use('/api', buildApiRouter());
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    const sanitized = sanitizeHttpError(err);
    if (req.path.startsWith('/api')) {
      res.status(sanitized.status).json({ error: sanitized.message });
      return;
    }
    res.status(sanitized.status).type('text/plain').send(sanitized.message);
  });

  const srv = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const login = async (username: string, password: string) => {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(r.status, 200);
      return r.headers.get('set-cookie')!.split(';')[0];
    };

    const [adminCookie, cashierCookie, invCookie] = await Promise.all([
      login('admin', 'Admin@NewStrong99!'),
      login('p6_cashier', 'Phase6@User!'),
      login('p6_inventory', 'Phase6@User!'),
    ]);

    // Check API 404 JSON catch-all & malformed JSON 400 handler & network-info APIPA filtering
    const notFoundRes = await fetch(`${baseUrl}/api/non-existent-endpoint`, { headers: { Cookie: adminCookie } });
    assert.equal(notFoundRes.status, 404);
    assert.match(((await notFoundRes.json()) as { error: string }).error, /not found/i);

    const badJsonRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
      body: '{"username": ',
    });
    assert.equal(badJsonRes.status, 400);
    assert.match(((await badJsonRes.json()) as { error: string }).error, /Malformed JSON/i);

    const netRes = await fetch(`${baseUrl}/api/admin/network-info`, { headers: { Cookie: adminCookie } });
    assert.equal(netRes.status, 200);
    const netJson = (await netRes.json()) as { urls: string[] };
    assert.ok(netJson.urls.every((u) => !u.includes('169.254.')));

    // Admin creates Medicine LAN-Sync, Inventory Manager adds stock via HTTP purchase, Cashier sees & sells it
    const sup = (await db.queryOne<{ id: string }>("SELECT id FROM suppliers WHERE code = 'SUP-001'"))!;
    const newMedId = await createMedicine(admin, {
      brandName: 'LanSyncTab',
      genericName: 'Cetirizine',
      strength: '10mg',
      dosageForm: 'Tablet',
      baseUnitName: 'Tablet',
      units: [{ unitName: 'Box', conversionToBase: '10' }],
    });
    const medInfo = (await listMedicines('LanSyncTab'))[0] as unknown as {
      id: string;
      units: Array<{ id: string; is_base: boolean }>;
    };
    const baseUnit = medInfo.units.find((u) => Boolean(u.is_base))!;

    const invPurRes = await fetch(`${baseUrl}/api/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'MediNest',
        'Idempotency-Key': `p6-pur-${Date.now()}`,
        Cookie: invCookie,
      },
      body: JSON.stringify({
        supplierId: sup.id,
        status: 'RECEIVED',
        paidAmount: '0.00',
        lines: [
          {
            medicineId: newMedId,
            unitId: baseUnit.id,
            batchNumber: 'LS-001',
            expiryDate: '2030-05-01',
            quantityInput: '150',
            unitCost: '1.00',
            sellingPricePerBase: '2.50',
          },
        ],
      }),
    });
    assert.equal(invPurRes.status, 201);

    // Open COUNTER-1, COUNTER-2, COUNTER-3 simultaneously
    const openCounter = async (counterCode: string, openingCash: string) => {
      const r = await fetch(`${baseUrl}/api/cash-sessions/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'X-Counter-Id': counterCode,
          'Idempotency-Key': `p6-open-${counterCode}-${Date.now()}`,
          Cookie: adminCookie,
        },
        body: JSON.stringify({ openingCash, notes: `${counterCode} shift` }),
      });
      assert.equal(r.status, 201);
      return (await r.json()) as { id: string; counterCode: string };
    };

    const [s1, s2, s3] = await Promise.all([
      openCounter('COUNTER-1', '1000.00'),
      openCounter('COUNTER-2', '2000.00'),
      openCounter('COUNTER-3', '3000.00'),
    ]);

    // Cashier on COUNTER-2 sells LanSyncTab (cross-terminal inventory visibility)
    const saleC2 = await fetch(`${baseUrl}/api/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'MediNest',
        'X-Counter-Id': 'COUNTER-2',
        'Idempotency-Key': `p6-sale-c2-${Date.now()}`,
        Cookie: cashierCookie,
      },
      body: JSON.stringify({
        payments: [{ method: 'CASH', amount: '25.00' }],
        lines: [{ medicineId: newMedId, unitId: baseUnit.id, quantityInput: '10', unitPrice: '2.50' }],
      }),
    });
    assert.equal(saleC2.status, 201);

    // Simulated page refresh: session persists & finance reflects active COUNTER-2 drawer
    const meRefresh = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cashierCookie } });
    assert.equal(meRefresh.status, 200);
    const finC2 = await fetch(`${baseUrl}/api/finance`, {
      headers: { Cookie: cashierCookie, 'X-Counter-Id': 'COUNTER-2' },
    });
    assert.equal(finC2.status, 200);
    const finC2Json = (await finC2.json()) as {
      currentCounter: string;
      openSessions: Array<{ id: string }>;
      activeSummary: { totals: { expectedCash: string } };
    };
    assert.equal(finC2Json.currentCounter, 'COUNTER-2');
    assert.equal(finC2Json.openSessions.length, 3);
    assert.equal(finC2Json.activeSummary.totals.expectedCash, '2025.00');

    // Close all 3 counters independently
    await closeCashSession(admin, s1.id, { actualCash: '1000.00' });
    await closeCashSession(admin, s2.id, { actualCash: '2025.00' });
    await closeCashSession(admin, s3.id, { actualCash: '3000.00' });

    const remainingOpen = await getOpenCashSessionsSummary(db);
    assert.equal(remainingOpen.length, 0);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('PHASE 6 TASK 5: 3-counter stock race stress (100 units vs 30+40+50), FEFO/expired rules, concurrent returns & adjustments', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;
  const sup = (await db.queryOne<{ id: string }>("SELECT id FROM suppliers WHERE code = 'SUP-001'"))!;

  // Ensure all 3 counters open
  for (const [cCode, amt] of [
    ['COUNTER-1', '500.00'],
    ['COUNTER-2', '500.00'],
    ['COUNTER-3', '500.00'],
  ]) {
    const existing = await getActiveCashSessionId(db, cCode);
    if (!existing) await openCashSession(admin, amt, `${cCode} stress test`, db, cCode);
  }

  // Medicine A with exact 100 base units
  const medAId = await createMedicine(admin, {
    brandName: 'StressMedA',
    genericName: 'Amoxicillin',
    strength: '500mg',
    dosageForm: 'Capsule',
    baseUnitName: 'Capsule',
  });
  const medAUnit = (await db.queryOne<{ id: string }>('SELECT id FROM medicine_units WHERE medicine_id = $1 AND is_base = TRUE', [medAId]))!;
  await createPurchase(admin, {
    supplierId: sup.id,
    status: 'RECEIVED',
    paidAmount: '0.00',
    lines: [
      {
        medicineId: medAId,
        unitId: medAUnit.id,
        batchNumber: 'STRA-100',
        expiryDate: '2030-08-01',
        quantityInput: '100',
        unitCost: '5.00',
        sellingPricePerBase: '8.00',
      },
    ],
  });

  // Fire 3 concurrent sales via HTTP for 30, 40, and 50 units (total demand 120 > 100 stock)
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);
  app.use('/api', buildApiRouter());
  const srv = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MediNest' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@NewStrong99!' }),
    });
    const adminCookie = loginRes.headers.get('set-cookie')!.split(';')[0];

    const fireSale = (counter: string, q: number, priceTotal: string) =>
      fetch(`${baseUrl}/api/sales`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'MediNest',
          'X-Counter-Id': counter,
          'Idempotency-Key': `stress-${counter}-${q}-${Date.now()}`,
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          payments: [{ method: 'CASH', amount: priceTotal }],
          lines: [{ medicineId: medAId, unitId: medAUnit.id, quantityInput: String(q), unitPrice: '8.00' }],
        }),
      }).then(async (r) => ({ status: r.status, qty: q, body: await r.json() }));

    const results = await Promise.all([
      fireSale('COUNTER-1', 30, '240.00'),
      fireSale('COUNTER-2', 40, '320.00'),
      fireSale('COUNTER-3', 50, '400.00'),
    ]);

    const successes = results.filter((r) => r.status === 201);
    const failures = results.filter((r) => r.status === 400);
    assert.equal(successes.length, 2, 'Exactly two concurrent sales fit in 100 units');
    assert.equal(failures.length, 1, 'Third overlapping sale must fail atomically with 400');

    const totalSoldQty = successes.reduce((acc, r) => acc + r.qty, 0);
    assert.ok(totalSoldQty <= 100);

    const batchRow = (await db.queryOne<{ id: string; current_qty_base: string }>(
      'SELECT id, current_qty_base FROM batches WHERE medicine_id = $1',
      [medAId]
    ))!;
    const remainingQty = Number(batchRow.current_qty_base);
    assert.equal(remainingQty, 100 - totalSoldQty);
    assert.ok(remainingQty >= 0);

    // Multi-batch FEFO + EXPIRED exclusion test
    const medBId = await createMedicine(admin, {
      brandName: 'FefoStrictMed',
      genericName: 'Azithromycin',
      strength: '500mg',
      dosageForm: 'Tablet',
      baseUnitName: 'Tablet',
    });
    const medBUnit = (await db.queryOne<{ id: string }>('SELECT id FROM medicine_units WHERE medicine_id = $1 AND is_base = TRUE', [medBId]))!;
    await createPurchase(admin, {
      supplierId: sup.id,
      status: 'RECEIVED',
      paidAmount: '0.00',
      lines: [
        { medicineId: medBId, unitId: medBUnit.id, batchNumber: 'EXP-OLD', expiryDate: '2029-01-01', quantityInput: '50', unitCost: '10.00', sellingPricePerBase: '15.00' },
        { medicineId: medBId, unitId: medBUnit.id, batchNumber: 'NEAR-01', expiryDate: '2027-06-01', quantityInput: '20', unitCost: '10.00', sellingPricePerBase: '15.00' },
        { medicineId: medBId, unitId: medBUnit.id, batchNumber: 'FAR-02', expiryDate: '2030-06-01', quantityInput: '30', unitCost: '10.00', sellingPricePerBase: '15.00' },
      ],
    });
    await db.execute("UPDATE batches SET status = 'EXPIRED', expiry_date = '2024-01-01' WHERE batch_number = 'EXP-OLD'");

    // Sell 25 -> must allocate 20 from NEAR-01 and 5 from FAR-02, never touching EXP-OLD
    const fefoSale = await completeSale(admin, {
      counterCode: 'COUNTER-1',
      payments: [{ method: 'CASH', amount: '375.00' }],
      lines: [{ medicineId: medBId, unitId: medBUnit.id, quantityInput: '25', unitPrice: '15.00' }],
    });

    const expBatch = (await db.queryOne<{ current_qty_base: string }>("SELECT current_qty_base FROM batches WHERE batch_number = 'EXP-OLD'"))!;
    const nearBatch = (await db.queryOne<{ current_qty_base: string }>("SELECT current_qty_base FROM batches WHERE batch_number = 'NEAR-01'"))!;
    const farBatch = (await db.queryOne<{ id: string; current_qty_base: string }>("SELECT id, current_qty_base FROM batches WHERE batch_number = 'FAR-02'"))!;
    assert.equal(Number(expBatch.current_qty_base), 50);
    assert.equal(Number(nearBatch.current_qty_base), 0);
    assert.equal(Number(farBatch.current_qty_base), 25);

    // Concurrent sales return + stock adjustment on FAR-02 / fefoSale
    const fefoLine = (await db.queryOne<{ id: string }>('SELECT id FROM sale_lines WHERE sale_id = $1', [fefoSale.saleId]))!;
    await Promise.all([
      createSalesReturn(admin, {
        counterCode: 'COUNTER-1',
        saleId: fefoSale.saleId,
        settlementType: 'CASH_REFUND',
        reason: 'Concurrent return stress',
        lines: [{ saleLineId: fefoLine.id, qtyBase: '3', disposition: 'RESTOCK_SELLABLE' }],
      }),
      adjustStock(admin, {
        batchId: farBatch.id,
        adjustmentType: 'DAMAGE',
        actualQtyBase: '23',
        reason: 'Broken blister concurrent adjustment',
      }),
    ]);

    const ledgerHealth = await reconcileInventoryLedger(db);
    assert.equal(ledgerHealth.healthy, true);
    const chain = await verifyAuditChain(db);
    assert.equal(chain.valid, true);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('PHASE 6 TASK 8: Backup failure modes (missing file, tampered SHA-256, corrupt archive) & DB maintenance lock', async () => {
  const db = await getDb();
  const adminRow = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
  const admin = (await loadAuthUserById(adminRow.id))!;

  const backup = await createVerifiedBackup(admin, 'MANUAL');
  const rec = (await db.queryOne<{ file_path: string; sha256: string }>('SELECT file_path, sha256 FROM backup_records WHERE id = $1', [backup.id]))!;

  // 1. Corrupt bytes on disk -> SHA-256 mismatch aborts before touching DB
  const origBytes = fs.readFileSync(rec.file_path);
  try {
    fs.writeFileSync(rec.file_path, Buffer.from('CORRUPTED-BACKUP-FILE-BYTES'));
    await assert.rejects(() => restoreFromBackup(admin, backup.id), /checksum mismatch/i);

    // 2. If checksum matches a corrupt archive -> pg_restore TOC check aborts safely
    const corruptBuf = Buffer.from('NOT-A-VALID-PG-DUMP');
    const corruptSha = crypto.createHash('sha256').update(corruptBuf).digest('hex');
    fs.writeFileSync(rec.file_path, corruptBuf);
    await db.execute('UPDATE backup_records SET sha256 = $1 WHERE id = $2', [corruptSha, backup.id]);
    await assert.rejects(() => restoreFromBackup(admin, backup.id), /pg_restore|corrupt|valid/i);

    // 3. Missing file on disk -> aborts safely
    fs.unlinkSync(rec.file_path);
    await assert.rejects(() => restoreFromBackup(admin, backup.id), /does not exist/i);
  } finally {
    fs.writeFileSync(rec.file_path, origBytes);
    await db.execute('UPDATE backup_records SET sha256 = $1 WHERE id = $2', [rec.sha256, backup.id]);
  }

  // 4. DB maintenance mode lock fails cleanly with 503 during pg_restore window
  setDbMaintenanceMode(true);
  try {
    await assert.rejects(() => getDb(), /restore in progress/i);
    await assert.rejects(
      async () => {
        try {
          await checkDbHealth();
        } catch (err) {
          const san = sanitizeHttpError(err);
          assert.equal(san.status, 503);
          throw err;
        }
      },
      /restore in progress/i
    );
  } finally {
    setDbMaintenanceMode(false);
  }
  const recoveredHealth = await checkDbHealth();
  assert.equal(recoveredHealth.ok, true);
});

test('PHASE 6 TASK 13 & 14: Isolated full working-day 3-counter pharmacy simulation, mathematical cash/profit/stock reconciliation & zero orphans', async () => {
  const opsDbName = `medinest_ops_day_${process.pid}_${Date.now()}`;
  await withAdminPgClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${opsDbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${opsDbName}"`);
  });

  await closeDb();
  process.env.PGDATABASE = opsDbName;

  try {
    const opsDb = await getDb();
    await seedDatabaseIfEmpty();

    const adminRow = (await opsDb.queryOne<{ id: string }>("SELECT id FROM users WHERE username = 'admin'"))!;
    const admin = (await loadAuthUserById(adminRow.id))!;

    // Seed supplier + customer + expense category + clean medicine
    const supId = (await opsDb.queryOne<{ id: string }>("SELECT id FROM suppliers WHERE code = 'SUP-001'"))!.id;
    const expCatId = (await opsDb.queryOne<{ id: string }>('SELECT id FROM expense_categories LIMIT 1'))!.id;
    const custId = crypto.randomUUID();
    const nowTs = new Date().toISOString();
    await opsDb.execute(
      `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, advance_balance, credit_limit, notes, is_active, created_at, updated_at)
       VALUES ($1, 'CUST-OPS-1', 'DaySim Regular Patient', '01811223344', '', '0.00', '0.00', '0.00', '5000.00', '', TRUE, $2, $3)`,
      [custId, nowTs, nowTs]
    );

    const medId = await createMedicine(admin, {
      brandName: 'DayOpsTab',
      genericName: 'Omeprazole',
      strength: '20mg',
      dosageForm: 'Capsule',
      baseUnitName: 'Capsule',
      units: [{ unitName: 'Strip', conversionToBase: '10' }],
    });
    const baseUnitId = (await opsDb.queryOne<{ id: string }>('SELECT id FROM medicine_units WHERE medicine_id = $1 AND is_base = TRUE', [medId]))!.id;

    // Close seeded default open session so all 3 counters start cleanly for the working day
    const seededOpen = await opsDb.query<{ id: string }>("SELECT id FROM cash_sessions WHERE status = 'OPEN'");
    for (const row of seededOpen) {
      const sSum = (await getCashSessionSummary(row.id, opsDb))!;
      await closeCashSession(admin, row.id, {
        actualCash: sSum.totals.expectedCash,
        varianceReason: 'Close seeded pre-shift session',
        forceClose: true,
      });
    }

    const baselineRep = await getComprehensiveReport({});

    // 1. Open all 3 counters for the working day
    const s1 = await openCashSession(admin, '1000.00', 'C1 Morning Float', opsDb, 'COUNTER-1');
    const s2 = await openCashSession(admin, '1500.00', 'C2 Morning Float', opsDb, 'COUNTER-2');
    const s3 = await openCashSession(admin, '2000.00', 'C3 Morning Float', opsDb, 'COUNTER-3');

    // 2. Receive Purchase: 200 capsules @ 4.00 = 800.00 total, paid 300.00 CASH via COUNTER-1 (500.00 supplier payable)
    const pur = await createPurchase(admin, {
      supplierId: supId,
      counterCode: 'COUNTER-1',
      status: 'RECEIVED',
      paidAmount: '300.00',
      paymentMethod: 'CASH',
      lines: [
        {
          medicineId: medId,
          unitId: baseUnitId,
          batchNumber: 'DAY-B1',
          expiryDate: '2030-12-31',
          quantityInput: '200',
          unitCost: '4.00',
          sellingPricePerBase: '7.00',
        },
      ],
    });
    const purBatchId = (await opsDb.queryOne<{ id: string }>("SELECT id FROM batches WHERE batch_number = 'DAY-B1'"))!.id;
    const purLineId = (await opsDb.queryOne<{ id: string }>('SELECT id FROM purchase_lines WHERE purchase_id = $1', [pur.purchaseId]))!.id;

    // 3. Stock adjustment: 5 damaged capsules (195 remaining)
    await adjustStock(admin, {
      batchId: purBatchId,
      adjustmentType: 'DAMAGE',
      actualQtyBase: '195',
      reason: 'Damaged capsule strip',
    });

    // 4. Sales across all 3 counters:
    // - COUNTER-1 cash sale: 20 * 7.00 = 140.00 minus 10.00 discount = 130.00 CASH
    const sale1 = await completeSale(admin, {
      counterCode: 'COUNTER-1',
      invoiceDiscount: '10.00',
      payments: [{ method: 'CASH', amount: '130.00' }],
      lines: [{ medicineId: medId, unitId: baseUnitId, quantityInput: '20', unitPrice: '7.00' }],
    });
    // - COUNTER-2 customer credit sale: 30 * 7.00 = 210.00 (50.00 CASH + 160.00 credit due)
    await completeSale(admin, {
      counterCode: 'COUNTER-2',
      customerId: custId,
      payments: [{ method: 'CASH', amount: '50.00' }],
      lines: [{ medicineId: medId, unitId: baseUnitId, quantityInput: '30', unitPrice: '7.00' }],
    });
    // - COUNTER-3 MFS bKash sale: 25 * 7.00 = 175.00 BKASH (does NOT affect cash drawer)
    await completeSale(admin, {
      counterCode: 'COUNTER-3',
      payments: [{ method: 'BKASH', amount: '175.00', referenceNo: 'TXN-8899' }],
      lines: [{ medicineId: medId, unitId: baseUnitId, quantityInput: '25', unitPrice: '7.00' }],
    });

    // 5. Customer due payment on COUNTER-2: +100.00 CASH (remaining customer due = 60.00)
    await recordPartyPayment(admin, {
      partyType: 'CUSTOMER',
      partyId: custId,
      counterCode: 'COUNTER-2',
      method: 'CASH',
      amount: '100.00',
      notes: 'Due collection at Counter 2',
    });

    // 6. Supplier credit payment on COUNTER-3: -200.00 CASH (remaining supplier due = 300.00)
    await recordPartyPayment(admin, {
      partyType: 'SUPPLIER',
      partyId: supId,
      counterCode: 'COUNTER-3',
      method: 'CASH',
      amount: '200.00',
      notes: 'Supplier partial pay from Counter 3',
    });

    // 7. Partial Sales Return on sale1 at COUNTER-1: 2 capsules (pro-rated refund)
    const sale1Line = (await opsDb.queryOne<{ id: string; effective_line_total: string; qty_base: string }>(
      'SELECT id, effective_line_total, qty_base FROM sale_lines WHERE sale_id = $1',
      [sale1.saleId]
    ))!;
    const retRes = await createSalesReturn(admin, {
      counterCode: 'COUNTER-1',
      saleId: sale1.saleId,
      settlementType: 'CASH_REFUND',
      reason: 'Patient returned 2 extra capsules',
      lines: [{ saleLineId: sale1Line.id, qtyBase: '2', disposition: 'RESTOCK_SELLABLE' }],
    });
    // 2/20 * 130.00 = 13.00 CASH refund
    assert.equal(retRes.totalRefundValue, '13.00');

    // 8. Purchase Return of 5 capsules @ 4.00 = 20.00 credit
    await createPurchaseReturn(admin, {
      purchaseId: pur.purchaseId,
      settlementType: 'SUPPLIER_CREDIT',
      reason: 'Returned 5 dented capsules to supplier',
      lines: [{ purchaseLineId: purLineId, qtyBase: '5' }],
    });

    // 9. Cash Expenses: 45.00 on COUNTER-1, 30.00 on COUNTER-2
    await createExpense(admin, {
      categoryId: expCatId,
      name: 'Printer Thermal Paper Roll',
      amount: '45.00',
      paymentMethod: 'CASH',
      counterCode: 'COUNTER-1',
    });
    await createExpense(admin, {
      categoryId: expCatId,
      name: 'Courier Delivery Charge',
      amount: '30.00',
      paymentMethod: 'CASH',
      counterCode: 'COUNTER-2',
    });

    // Mathematical drawer reconciliation per counter:
    // COUNTER-1: 1000.00 (open) - 300.00 (purchase cash) + 130.00 (sale1) - 13.00 (refund) - 45.00 (expense) = 772.00
    // COUNTER-2: 1500.00 (open) + 50.00 (sale2) + 100.00 (cust payment) - 30.00 (expense) = 1620.00
    // COUNTER-3: 2000.00 (open) + 0.00 (bkash sale) - 200.00 (supplier payment) = 1800.00
    const sum1 = (await getCashSessionSummary(s1.id, opsDb))!;
    const sum2 = (await getCashSessionSummary(s2.id, opsDb))!;
    const sum3 = (await getCashSessionSummary(s3.id, opsDb))!;
    assert.equal(sum1.totals.expectedCash, '772.00');
    assert.equal(sum2.totals.expectedCash, '1620.00');
    assert.equal(sum3.totals.expectedCash, '1800.00');

    await closeCashSession(admin, s1.id, { actualCash: '772.00' });
    await closeCashSession(admin, s2.id, { actualCash: '1620.00' });
    await closeCashSession(admin, s3.id, { actualCash: '1800.00' });

    // Stock math: 200 purchased - 5 damaged - 20 sold - 30 sold - 25 sold + 2 restocked - 5 purchase return = 117 capsules
    const finalBatch = (await opsDb.queryOne<{ current_qty_base: string }>('SELECT current_qty_base FROM batches WHERE id = $1', [purBatchId]))!;
    assert.equal(Number(finalBatch.current_qty_base), 117);

    // Customer & Supplier due balances:
    const custRow = (await opsDb.queryOne<{ current_balance: string }>('SELECT current_balance FROM customers WHERE id = $1', [custId]))!;
    const supRow = (await opsDb.queryOne<{ current_balance: string }>('SELECT current_balance FROM suppliers WHERE id = $1', [supId]))!;
    assert.equal(custRow.current_balance, '60.00');
    assert.equal(supRow.current_balance, '280.00'); // 500 due - 200 paid - 20 purchase return

    // Financial Report reconciliation (exact working-day delta over seeded baseline):
    // Gross sales = 130 + 210 + 175 = 515.00; Returns = 13.00; Net Sales delta = 502.00
    // Sold units = 75; Returned = 2 => Net 73 units * 4.00 cost = 292.00 COGS delta => Gross Profit delta = 210.00
    // Expenses delta = 45 + 30 = 75.00 => Net Profit delta = 135.00
    const rep = await getComprehensiveReport({});
    const delta = (a: string, b: string) => (Number(a) - Number(b)).toFixed(2);
    assert.equal(delta(rep.profitSummary.netSales, baselineRep.profitSummary.netSales), '515.00');
    assert.equal(delta(rep.profitSummary.salesReturns, baselineRep.profitSummary.salesReturns), '13.00');
    assert.equal(delta(rep.profitSummary.netSalesAfterReturns, baselineRep.profitSummary.netSalesAfterReturns), '502.00');
    assert.equal(delta(rep.profitSummary.netCogs, baselineRep.profitSummary.netCogs), '292.00');
    assert.equal(delta(rep.profitSummary.grossProfit, baselineRep.profitSummary.grossProfit), '210.00');
    assert.equal(delta(rep.profitSummary.totalExpenses, baselineRep.profitSummary.totalExpenses), '75.00');
    assert.equal(delta(rep.profitSummary.netProfit, baselineRep.profitSummary.netProfit), '135.00');

    // Integrity & Zero-Orphan Checks
    const recon = await reconcileInventoryLedger(opsDb);
    assert.equal(recon.healthy, true);
    const chain = await verifyAuditChain(opsDb);
    assert.equal(chain.valid, true);

    const orphanCountRow = (await opsDb.queryOne<{ cnt: number }>(
      `SELECT (
        (SELECT COUNT(*) FROM sale_lines sl LEFT JOIN sales s ON s.id = sl.sale_id WHERE s.id IS NULL) +
        (SELECT COUNT(*) FROM sale_batch_allocations sba LEFT JOIN batches b ON b.id = sba.batch_id WHERE b.id IS NULL) +
        (SELECT COUNT(*) FROM stock_movements sm LEFT JOIN batches b ON b.id = sm.batch_id WHERE b.id IS NULL)
      ) AS cnt`
    ))!;
    assert.equal(orphanCountRow.cnt, 0);

    // Full working-day verified pg_dump backup succeeds cleanly
    const eodBackup = await createVerifiedBackup(admin, 'MANUAL');
    assert.ok(eodBackup.sizeBytes > 0);
  } finally {
    await closeDb();
    await withAdminPgClient(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${opsDbName}" WITH (FORCE)`);
    });
    process.env.PGDATABASE = testDbName;
    await getDb();
  }
});



