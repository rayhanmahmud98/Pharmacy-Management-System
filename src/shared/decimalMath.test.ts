import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateBatchesFEFO,
  computeCashVariance,
  computeExpectedCash,
  computeInvoiceTotals,
  computeLineTotals,
  computeReturnCogsReversal,
  convertToBaseUnits,
  resolvePermission,
  type BatchCandidate,
} from './decimalMath';

test('manual unit conversions support non-10 strip and box sizes with zero hardcoding', () => {
  // Medicine A: 1 Strip = 12 Tablets, 1 Box = 60 Tablets
  assert.equal(convertToBaseUnits('2', '12').toFixed(4), '24.0000');
  assert.equal(convertToBaseUnits('1.5', '60').toFixed(4), '90.0000');
  // Medicine B: 1 Strip = 6 Capsules, 1 Box = 48 Capsules
  assert.equal(convertToBaseUnits('3', '6').toFixed(4), '18.0000');
  assert.equal(convertToBaseUnits('2', '48').toFixed(4), '96.0000');
});

test('invalid conversion ratios and quantities are rejected', () => {
  assert.throws(() => convertToBaseUnits('1', '0'), /greater than zero/);
  assert.throws(() => convertToBaseUnits('1', '-10'), /greater than zero/);
  assert.throws(() => convertToBaseUnits('0', '10'), /greater than zero/);
});

test('Decimal precision avoids binary floating point drift (0.1 + 0.2 = 0.30)', () => {
  const l1 = computeLineTotals({ quantityInput: '1', conversionRatio: '1', unitPriceOrCost: '0.10' });
  const l2 = computeLineTotals({ quantityInput: '1', conversionRatio: '1', unitPriceOrCost: '0.20' });
  const inv = computeInvoiceTotals({ lines: [l1, l2], invoiceDiscount: '0', paidAmount: '0.30' });
  assert.equal(inv.netTotal.toFixed(2), '0.30');
  assert.equal(inv.dueAmount.toFixed(2), '0.00');
});

test('FEFO allocation excludes expired/quarantined batches and splits across earliest expiry', () => {
  const batches: BatchCandidate[] = [
    {
      id: 'b-expired',
      batchNumber: 'EXP01',
      expiryDate: '2026-11-20',
      receivedDate: '2025-01-01',
      status: 'ACTIVE',
      currentQtyBase: '100',
      purchaseCostPerBase: '2.00',
    },
    {
      id: 'b-quarantined',
      batchNumber: 'QRN01',
      expiryDate: '2027-01-01',
      receivedDate: '2025-02-01',
      status: 'QUARANTINED',
      currentQtyBase: '50',
      purchaseCostPerBase: '2.10',
    },
    {
      id: 'b-late',
      batchNumber: 'LATE01',
      expiryDate: '2027-12-31',
      receivedDate: '2026-03-01',
      status: 'ACTIVE',
      currentQtyBase: '40',
      purchaseCostPerBase: '2.50',
    },
    {
      id: 'b-early',
      batchNumber: 'EARLY01',
      expiryDate: '2027-03-15',
      receivedDate: '2026-01-15',
      status: 'ACTIVE',
      currentQtyBase: '15',
      purchaseCostPerBase: '2.20',
    },
  ];

  // Need 25 base units as of 2026-11-23 -> takes 15 from EARLY01 + 10 from LATE01
  const allocs = allocateBatchesFEFO(batches, '25', '2026-11-23');
  assert.equal(allocs.length, 2);
  assert.equal(allocs[0].batchNumber, 'EARLY01');
  assert.equal(allocs[0].qtyBase.toFixed(2), '15.00');
  assert.equal(allocs[0].cogsTotal.toFixed(2), '33.00');
  assert.equal(allocs[1].batchNumber, 'LATE01');
  assert.equal(allocs[1].qtyBase.toFixed(2), '10.00');
  assert.equal(allocs[1].cogsTotal.toFixed(2), '25.00');
});

test('FEFO rejects insufficient stock and expired manual batch override', () => {
  const batches: BatchCandidate[] = [
    {
      id: 'b-expired',
      batchNumber: 'EXP01',
      expiryDate: '2026-11-23',
      receivedDate: '2025-01-01',
      status: 'ACTIVE',
      currentQtyBase: '100',
      purchaseCostPerBase: '2.00',
    },
    {
      id: 'b-ok',
      batchNumber: 'OK01',
      expiryDate: '2027-06-01',
      receivedDate: '2026-01-01',
      status: 'ACTIVE',
      currentQtyBase: '5',
      purchaseCostPerBase: '2.00',
    },
  ];

  assert.throws(() => allocateBatchesFEFO(batches, '10', '2026-11-23'), /Insufficient sellable stock/);
  assert.throws(() => allocateBatchesFEFO(batches, '5', '2026-11-23', 'b-expired'), /Cannot sell expired batch/);
});

test('sales return COGS reversal uses historical batch allocation costs', () => {
  const orig = [
    { batchId: 'b1', qtyBase: '15', costPerBaseSnapshot: '2.20' },
    { batchId: 'b2', qtyBase: '10', costPerBaseSnapshot: '2.50' },
  ];
  const rev = computeReturnCogsReversal(orig, '20');
  assert.equal(rev.length, 2);
  assert.equal(rev[0].cogsReversed.toFixed(2), '33.00');
  assert.equal(rev[1].qtyBase.toFixed(2), '5.00');
  assert.equal(rev[1].cogsReversed.toFixed(2), '12.50');
  assert.throws(() => computeReturnCogsReversal(orig, '26'), /exceeds available sold quantity/);
});

test('cash session expected cash and variance calculation', () => {
  const expected = computeExpectedCash('5000.00', '12450.50', '3200.00', '-100.00');
  assert.equal(expected.toFixed(2), '14150.50');
  const variance = computeCashVariance('14100.00', expected);
  assert.equal(variance.toFixed(2), '-50.50');
});

test('permission precedence enforces inactive > super_admin > override > role', () => {
  assert.equal(resolvePermission({ isActive: false, isSuperAdmin: true, userOverride: 'ALLOW', roleAllows: true }), false);
  assert.equal(resolvePermission({ isActive: true, isSuperAdmin: true, userOverride: 'DENY', roleAllows: false }), true);
  assert.equal(resolvePermission({ isActive: true, isSuperAdmin: false, userOverride: 'ALLOW', roleAllows: false }), true);
  assert.equal(resolvePermission({ isActive: true, isSuperAdmin: false, userOverride: 'DENY', roleAllows: true }), false);
  assert.equal(resolvePermission({ isActive: true, isSuperAdmin: false, userOverride: null, roleAllows: true }), true);
});
