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
  roundCost6,
  validateConversionInput,
  validateCostInput,
  validateCurrencyInput,
  validateQuantityInput,
  type BatchCandidate,
} from './decimalMath';

test('strict currency validation enforces max 18 integer digits and max 2 decimal places without silent rounding', () => {
  assert.equal(validateCurrencyInput('100', 'Price').toFixed(2), '100.00');
  assert.equal(validateCurrencyInput('100.5', 'Price').toFixed(2), '100.50');
  assert.equal(validateCurrencyInput('100.50', 'Price').toFixed(2), '100.50');
  assert.equal(validateCurrencyInput('999999999999999999.99', 'Max Price').toFixed(2), '999999999999999999.99');

  assert.throws(() => validateCurrencyInput('100.555', 'Price'), /more than 2 decimal places/);
  assert.throws(() => validateCurrencyInput('1000000000000000000.00', 'Price'), /exceeds maximum 18 integer digits/);
  assert.throws(() => validateCurrencyInput('-1.00', 'Price'), /cannot be negative/);
  assert.throws(() => validateCurrencyInput('0', 'Price', { allowZero: false }), /greater than zero/);
  assert.throws(() => validateCurrencyInput('1e5', 'Price'), /invalid numeric format/);
  assert.throws(() => validateCurrencyInput('1,000.00', 'Price'), /invalid numeric format/);
  assert.throws(() => validateCurrencyInput('', 'Price'), /required/);
  assert.throws(() => validateCurrencyInput(Number.NaN, 'Price'), /finite number/);
  assert.throws(() => validateCurrencyInput(Number.POSITIVE_INFINITY, 'Price'), /finite number/);
});

test('strict 6-decimal validation applies to quantities, conversion ratios, and per-base cost snapshots', () => {
  assert.equal(validateQuantityInput('1.123456', 'Qty').toFixed(6), '1.123456');
  assert.equal(validateQuantityInput('10.000001', 'Qty').toFixed(6), '10.000001');
  assert.equal(validateQuantityInput('999999999999999999.123456', 'Qty').toFixed(6), '999999999999999999.123456');
  assert.equal(validateConversionInput('0.5', 'Conversion').toFixed(6), '0.500000');
  assert.equal(validateCostInput('1.458333', 'Cost').toFixed(6), '1.458333');

  assert.throws(() => validateQuantityInput('1.1234567', 'Qty'), /more than 6 decimal places/);
  assert.throws(() => validateQuantityInput('10.0000001', 'Qty'), /more than 6 decimal places/);
  assert.throws(() => validateCostInput('1.1234567', 'Cost'), /more than 6 decimal places/);
  assert.throws(() => validateConversionInput('1.1234567', 'Conv'), /more than 6 decimal places/);
  assert.throws(() => validateQuantityInput('1000000000000000000.1', 'Qty'), /exceeds maximum 18 integer digits/);
});

test('manual unit conversions support non-10 and fractional 6-decimal sizes with zero hardcoding', () => {
  assert.equal(convertToBaseUnits('2', '12').toFixed(6), '24.000000');
  assert.equal(convertToBaseUnits('1.5', '60').toFixed(6), '90.000000');
  assert.equal(convertToBaseUnits('3', '6').toFixed(6), '18.000000');
  assert.equal(convertToBaseUnits('1.250000', '1.500000').toFixed(6), '1.875000');

  // Cost per base unit computed accurately to 6 decimals (e.g. 175.00 / 120 = 1.458333)
  const unitCost = validateCurrencyInput('175.00', 'Box Cost');
  const conv = validateConversionInput('120', 'Box Conversion');
  assert.equal(roundCost6(unitCost.div(conv)).toFixed(6), '1.458333');
});

test('invalid conversion ratios and quantities are rejected', () => {
  assert.throws(() => convertToBaseUnits('1', '0'), /greater than zero/);
  assert.throws(() => convertToBaseUnits('1', '-10'), /cannot be negative/);
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
      id: 'b-damaged',
      batchNumber: 'DMG01',
      expiryDate: '2027-01-05',
      receivedDate: '2025-02-02',
      status: 'DAMAGED',
      currentQtyBase: '20',
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
