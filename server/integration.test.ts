import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shifarx-test-'));
process.env.PHARMACY_DATA_DIR = tmpDir;

const { getDb, closeDb } = await import('./db.ts');
const { seedDatabaseIfEmpty } = await import('./seed.ts');
const { loadAuthUserById, getUserEffectivePermissions } = await import('./auth.ts');
const { verifyAuditChain } = await import('./audit.ts');
const { listMedicines, upsertMedicineUnit, reconcileInventoryLedger } = await import('./services/inventoryService.ts');
const { createPurchase, createPurchaseReturn } = await import('./services/purchaseService.ts');
const { completeSale, createSalesReturn } = await import('./services/salesService.ts');
const { closeCashSession, createExpense, getActiveCashSessionId, getCashSessionSummary } = await import('./services/financeService.ts');
const { createVerifiedBackup } = await import('./services/backupService.ts');

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('full pharmacy end-to-end transaction integrity, FEFO, snapshots, cash drawer, returns, and backup', async () => {
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

  // 2. Sell 13 Strips (156 tablets) -> FEFO takes 144 from NEX-26A + 12 from NEX-26B!
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
        quantityInput: '13',
        unitPrice: '24.00', // 12 tabs * 2.00
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
  const histLine = db.prepare('SELECT conversion_ratio_snapshot, qty_base FROM sale_lines WHERE sale_id = ?').get(saleRes.saleId) as {
    conversion_ratio_snapshot: string;
    qty_base: string;
  };
  assert.equal(Number(histLine.conversion_ratio_snapshot), 12);
  assert.equal(Number(histLine.qty_base), 156);

  // 4. Sales Return with QUARANTINE disposition: must NOT return to sellable stock!
  const slRow = db.prepare('SELECT id FROM sale_lines WHERE sale_id = ?').get(saleRes.saleId) as { id: string };
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

  // 5. Purchase receiving + purchase return
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

  // 6. Cash expense & closing cash session with variance
  const expCat = db.prepare('SELECT id FROM expense_categories LIMIT 1').get() as { id: string };
  createExpense(admin, {
    categoryId: expCat.id,
    name: 'Generator Fuel',
    amount: '100.00',
    paymentMethod: 'CASH',
  });
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
