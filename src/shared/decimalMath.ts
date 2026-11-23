import Decimal from 'decimal.js';

Decimal.set({ precision: 36, rounding: Decimal.ROUND_HALF_UP });

export type DecimalInput = Decimal | string | number;

const STRICT_DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const MAX_INTEGER_DIGITS = 18;

export interface StrictDecimalOptions {
  fieldName?: string;
  maxIntDigits?: number;
  maxFracDigits: number;
  allowZero?: boolean;
  allowNegative?: boolean;
}

/**
 * Strictly parses a numeric value WITHOUT silent rounding or truncation of user input.
 * Rejects empty strings, NaN, Infinity, scientific notation, >18 integer digits,
 * and fractional digits exceeding maxFracDigits.
 */
export function parseStrictDecimal(value: DecimalInput, opts: StrictDecimalOptions): Decimal {
  const fieldName = opts.fieldName || 'Value';
  const maxInt = opts.maxIntDigits ?? MAX_INTEGER_DIGITS;
  const maxFrac = opts.maxFracDigits;
  const allowZero = opts.allowZero ?? true;
  const allowNegative = opts.allowNegative ?? false;

  let dec: Decimal;

  if (value instanceof Decimal) {
    if (!value.isFinite() || value.isNaN()) {
      throw new Error(`${fieldName} is not a valid finite number`);
    }
    const fixed = value.toFixed();
    const parts = fixed.replace(/^-/, '').split('.');
    if (parts[0].length > maxInt) {
      throw new Error(`${fieldName} exceeds maximum ${maxInt} integer digits`);
    }
    if ((parts[1]?.length ?? 0) > maxFrac) {
      throw new Error(`${fieldName} cannot have more than ${maxFrac} decimal places`);
    }
    dec = value;
  } else {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`${fieldName} is not a valid finite number`);
      }
    }
    const raw = String(value ?? '').trim();
    if (!raw) {
      throw new Error(`${fieldName} is required`);
    }
    if (!STRICT_DECIMAL_RE.test(raw)) {
      throw new Error(`${fieldName} has invalid numeric format '${raw}'`);
    }
    const unsigned = raw.startsWith('-') ? raw.slice(1) : raw;
    const [intPart, fracPart = ''] = unsigned.split('.');
    const significantIntLen = intPart.replace(/^0+/, '').length || 1;
    if (intPart.length > maxInt || significantIntLen > maxInt) {
      throw new Error(`${fieldName} exceeds maximum ${maxInt} integer digits`);
    }
    if (fracPart.length > maxFrac) {
      throw new Error(`${fieldName} cannot have more than ${maxFrac} decimal places`);
    }
    dec = new Decimal(raw);
  }

  if (!allowNegative && dec.lt(0)) {
    throw new Error(`${fieldName} cannot be negative`);
  }
  if (!allowZero && dec.eq(0)) {
    throw new Error(`${fieldName} must be strictly greater than zero`);
  }
  return dec;
}

export function validateCurrencyInput(
  value: DecimalInput,
  fieldName = 'Amount',
  opts?: { allowZero?: boolean; allowNegative?: boolean }
): Decimal {
  return parseStrictDecimal(value, {
    fieldName,
    maxIntDigits: MAX_INTEGER_DIGITS,
    maxFracDigits: 2,
    allowZero: opts?.allowZero ?? true,
    allowNegative: opts?.allowNegative ?? false,
  });
}

export function validateQuantityInput(
  value: DecimalInput,
  fieldName = 'Quantity',
  opts?: { allowZero?: boolean; allowNegative?: boolean }
): Decimal {
  return parseStrictDecimal(value, {
    fieldName,
    maxIntDigits: MAX_INTEGER_DIGITS,
    maxFracDigits: 6,
    allowZero: opts?.allowZero ?? true,
    allowNegative: opts?.allowNegative ?? false,
  });
}

export function validateConversionInput(value: DecimalInput, fieldName = 'Conversion ratio'): Decimal {
  return parseStrictDecimal(value, {
    fieldName,
    maxIntDigits: MAX_INTEGER_DIGITS,
    maxFracDigits: 6,
    allowZero: false,
    allowNegative: false,
  });
}

export function validateCostInput(
  value: DecimalInput,
  fieldName = 'Cost per base unit',
  opts?: { allowZero?: boolean }
): Decimal {
  return parseStrictDecimal(value, {
    fieldName,
    maxIntDigits: MAX_INTEGER_DIGITS,
    maxFracDigits: 6,
    allowZero: opts?.allowZero ?? true,
    allowNegative: false,
  });
}

export function d(value: DecimalInput): Decimal {
  if (value instanceof Decimal) {
    if (!value.isFinite() || value.isNaN()) throw new Error('Invalid numeric value');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid numeric value');
    const rawNum = value.toString();
    if (/[eE]/.test(rawNum)) {
      return new Decimal(value.toFixed(10));
    }
    return new Decimal(rawNum);
  }
  const str = String(value ?? '').trim();
  if (!str) throw new Error('Empty numeric value');
  if (!STRICT_DECIMAL_RE.test(str)) {
    throw new Error(`Invalid numeric format '${str}'`);
  }
  return new Decimal(str);
}

/** Explicit boundary rounding ONLY for calculated financial totals (never for raw user input). */
export function roundMoney(value: Decimal): Decimal {
  return d(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Explicit boundary rounding ONLY for derived base quantities (max 6 decimals). */
export function roundQty(value: Decimal): Decimal {
  return d(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/** Explicit boundary rounding ONLY for derived per-base-unit cost snapshots (max 6 decimals). */
export function roundCost6(value: Decimal): Decimal {
  return d(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/**
 * Validates currency input strictly (max 2 decimals, max 18 integer digits) without silent rounding.
 */
export function money(value: DecimalInput, fieldName = 'Amount'): Decimal {
  return validateCurrencyInput(value, fieldName, { allowZero: true, allowNegative: true });
}

/**
 * Validates quantity input strictly (max 6 decimals, max 18 integer digits) without silent rounding.
 */
export function qty(value: DecimalInput, fieldName = 'Quantity'): Decimal {
  return validateQuantityInput(value, fieldName, { allowZero: true, allowNegative: true });
}

/**
 * Validates unit conversion ratio strictly (max 6 decimals, max 18 integer digits, > 0).
 */
export function ratio(value: DecimalInput, fieldName = 'Conversion ratio'): Decimal {
  return validateConversionInput(value, fieldName);
}

/**
 * Validates per-base cost snapshot strictly (max 6 decimals, max 18 integer digits, >= 0).
 */
export function cost6(value: DecimalInput, fieldName = 'Cost per base unit'): Decimal {
  return validateCostInput(value, fieldName, { allowZero: true });
}

export function convertToBaseUnits(inputQty: DecimalInput, conversionRatio: DecimalInput): Decimal {
  const q = validateQuantityInput(inputQty, 'Quantity', { allowZero: false });
  const r = validateConversionInput(conversionRatio, 'Conversion ratio');
  return roundQty(q.mul(r));
}

export interface LineCalcInput {
  quantityInput: DecimalInput;
  conversionRatio: DecimalInput;
  unitPriceOrCost: DecimalInput;
  discountAmount?: DecimalInput;
}

export interface LineCalcResult {
  quantityBase: Decimal;
  grossTotal: Decimal;
  discount: Decimal;
  netTotal: Decimal;
}

export function computeLineTotals(input: LineCalcInput): LineCalcResult {
  const qInput = validateQuantityInput(input.quantityInput, 'Line quantity', { allowZero: false });
  const conv = validateConversionInput(input.conversionRatio, 'Conversion ratio');
  const price = validateCurrencyInput(input.unitPriceOrCost, 'Unit price/cost', { allowZero: true });
  const disc = validateCurrencyInput(input.discountAmount ?? '0', 'Line discount', { allowZero: true });

  const quantityBase = roundQty(qInput.mul(conv));
  const grossTotal = roundMoney(qInput.mul(price));
  if (disc.gt(grossTotal)) {
    throw new Error('Line discount cannot exceed gross line total');
  }
  const netTotal = roundMoney(grossTotal.sub(disc));
  return { quantityBase, grossTotal, discount: disc, netTotal };
}

export interface InvoiceTotalsInput {
  lines: Array<{ grossTotal: DecimalInput; discount: DecimalInput; netTotal: DecimalInput }>;
  invoiceDiscount?: DecimalInput;
  paidAmount?: DecimalInput;
}

export interface InvoiceTotalsResult {
  grossSubtotal: Decimal;
  lineDiscountTotal: Decimal;
  invoiceDiscount: Decimal;
  netTotal: Decimal;
  paidAmount: Decimal;
  dueAmount: Decimal;
}

export function computeInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotalsResult {
  let grossSubtotal = new Decimal(0);
  let lineDiscountTotal = new Decimal(0);
  let lineNetSum = new Decimal(0);

  for (const line of input.lines) {
    grossSubtotal = grossSubtotal.add(validateCurrencyInput(line.grossTotal, 'Line gross total'));
    lineDiscountTotal = lineDiscountTotal.add(validateCurrencyInput(line.discount, 'Line discount'));
    lineNetSum = lineNetSum.add(validateCurrencyInput(line.netTotal, 'Line net total'));
  }

  grossSubtotal = roundMoney(grossSubtotal);
  lineDiscountTotal = roundMoney(lineDiscountTotal);
  const invDisc = validateCurrencyInput(input.invoiceDiscount ?? '0', 'Invoice discount', { allowZero: true });
  if (invDisc.gt(lineNetSum)) throw new Error('Invoice discount cannot exceed net subtotal');

  const netTotal = roundMoney(lineNetSum.sub(invDisc));
  const paid = validateCurrencyInput(input.paidAmount ?? '0', 'Paid amount', { allowZero: true });
  if (paid.gt(netTotal)) throw new Error('Paid amount cannot exceed net invoice total');

  const dueAmount = roundMoney(netTotal.sub(paid));
  return {
    grossSubtotal,
    lineDiscountTotal,
    invoiceDiscount: invDisc,
    netTotal,
    paidAmount: paid,
    dueAmount,
  };
}

export interface BatchCandidate {
  id: string;
  batchNumber: string;
  expiryDate: string; // YYYY-MM-DD
  receivedDate: string; // YYYY-MM-DD or ISO
  status: 'ACTIVE' | 'QUARANTINED' | 'EXPIRED' | 'WRITTEN_OFF' | 'INACTIVE' | 'DEPLETED' | 'DAMAGED';
  currentQtyBase: DecimalInput;
  purchaseCostPerBase: DecimalInput;
}

export interface BatchAllocationResult {
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  qtyBase: Decimal;
  costPerBaseSnapshot: Decimal;
  cogsTotal: Decimal;
}

export function allocateBatchesFEFO(
  candidates: BatchCandidate[],
  requiredQtyBase: DecimalInput,
  asOfDate: string, // YYYY-MM-DD
  manualBatchId?: string | null
): BatchAllocationResult[] {
  const needed = validateQuantityInput(requiredQtyBase, 'Required quantity', { allowZero: false });

  const eligible = candidates.filter((b) => {
    if (b.status !== 'ACTIVE') return false;
    if (b.expiryDate <= asOfDate) return false;
    if (qty(b.currentQtyBase).lte(0)) return false;
    return true;
  });

  if (manualBatchId) {
    const chosen = candidates.find((b) => b.id === manualBatchId);
    if (!chosen) throw new Error('Selected batch does not exist');
    if (chosen.status !== 'ACTIVE') {
      throw new Error(`Cannot sell from batch ${chosen.batchNumber} (status: ${chosen.status})`);
    }
    if (chosen.expiryDate <= asOfDate) {
      throw new Error(`Cannot sell expired batch ${chosen.batchNumber} (expired ${chosen.expiryDate})`);
    }
    const available = qty(chosen.currentQtyBase);
    if (available.lt(needed)) {
      throw new Error(
        `Insufficient stock in selected batch ${chosen.batchNumber}: available ${available.toFixed(6)}, requested ${needed.toFixed(6)}`
      );
    }
    const cost = cost6(chosen.purchaseCostPerBase);
    return [
      {
        batchId: chosen.id,
        batchNumber: chosen.batchNumber,
        expiryDate: chosen.expiryDate,
        qtyBase: needed,
        costPerBaseSnapshot: cost,
        cogsTotal: roundMoney(needed.mul(cost)),
      },
    ];
  }

  eligible.sort((a, b) => {
    if (a.expiryDate !== b.expiryDate) return a.expiryDate < b.expiryDate ? -1 : 1;
    if (a.receivedDate !== b.receivedDate) return a.receivedDate < b.receivedDate ? -1 : 1;
    return a.batchNumber.localeCompare(b.batchNumber);
  });

  let remaining = needed;
  const allocations: BatchAllocationResult[] = [];

  for (const batch of eligible) {
    if (remaining.lte(0)) break;
    const available = qty(batch.currentQtyBase);
    if (available.lte(0)) continue;
    const take = Decimal.min(available, remaining);
    const cost = cost6(batch.purchaseCostPerBase);
    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      qtyBase: take,
      costPerBaseSnapshot: cost,
      cogsTotal: roundMoney(take.mul(cost)),
    });
    remaining = roundQty(remaining.sub(take));
  }

  if (remaining.gt(0)) {
    const totalAvail = eligible.reduce((acc, b) => acc.add(qty(b.currentQtyBase)), new Decimal(0));
    throw new Error(
      `Insufficient sellable stock: requested ${needed.toFixed(6)} base units, available ${totalAvail.toFixed(6)}`
    );
  }

  return allocations;
}

export function computeReturnCogsReversal(
  originalAllocations: Array<{ batchId: string; qtyBase: DecimalInput; costPerBaseSnapshot: DecimalInput }>,
  returnQtyBase: DecimalInput
): Array<{ batchId: string; qtyBase: Decimal; costPerBaseSnapshot: Decimal; cogsReversed: Decimal }> {
  let remaining = validateQuantityInput(returnQtyBase, 'Return quantity', { allowZero: false });

  const totalOrig = originalAllocations.reduce((s, a) => s.add(qty(a.qtyBase)), new Decimal(0));
  if (remaining.gt(totalOrig)) {
    throw new Error(`Return quantity (${remaining.toFixed(6)}) exceeds available sold quantity (${totalOrig.toFixed(6)})`);
  }

  const results: Array<{ batchId: string; qtyBase: Decimal; costPerBaseSnapshot: Decimal; cogsReversed: Decimal }> = [];
  for (const alloc of originalAllocations) {
    if (remaining.lte(0)) break;
    const avail = qty(alloc.qtyBase);
    if (avail.lte(0)) continue;
    const take = Decimal.min(avail, remaining);
    const cost = cost6(alloc.costPerBaseSnapshot);
    results.push({
      batchId: alloc.batchId,
      qtyBase: take,
      costPerBaseSnapshot: cost,
      cogsReversed: roundMoney(take.mul(cost)),
    });
    remaining = roundQty(remaining.sub(take));
  }
  return results;
}

export function computeExpectedCash(
  openingCash: DecimalInput,
  cashReceived: DecimalInput,
  cashPaid: DecimalInput,
  cashAdjustments: DecimalInput
): Decimal {
  return roundMoney(
    money(openingCash, 'Opening cash')
      .add(money(cashReceived, 'Cash received'))
      .sub(money(cashPaid, 'Cash paid'))
      .add(money(cashAdjustments, 'Cash adjustments'))
  );
}

export function computeCashVariance(actualCash: DecimalInput, expectedCash: DecimalInput): Decimal {
  return roundMoney(money(actualCash, 'Actual cash').sub(money(expectedCash, 'Expected cash')));
}

export interface PermissionContext {
  isActive: boolean;
  isSuperAdmin: boolean;
  userOverride: 'ALLOW' | 'DENY' | null;
  roleAllows: boolean;
}

export function resolvePermission(ctx: PermissionContext): boolean {
  if (!ctx.isActive) return false;
  if (ctx.isSuperAdmin) return true;
  if (ctx.userOverride === 'ALLOW') return true;
  if (ctx.userOverride === 'DENY') return false;
  return ctx.roleAllows;
}

/**
 * Proportionally distributes an invoice-level discount across line net totals
 * using exact Decimal arithmetic, assigning any rounding penny remainder to the last
 * positive line so SUM(effectiveLineTotals) === roundMoney(SUM(lineTotals) - invoiceDiscount).
 */
export function allocateInvoiceDiscountAcrossLines(
  lineTotals: DecimalInput[],
  invoiceDiscount: DecimalInput
): Decimal[] {
  const lines = lineTotals.map((lt) => validateCurrencyInput(lt, 'Line net total', { allowZero: true }));
  const invDisc = validateCurrencyInput(invoiceDiscount ?? '0', 'Invoice discount', { allowZero: true });
  const subtotal = roundMoney(lines.reduce((s, v) => s.add(v), new Decimal(0)));

  if (invDisc.gt(subtotal)) {
    throw new Error('Invoice discount cannot exceed line net subtotal');
  }
  if (lines.length === 0 || invDisc.eq(0) || subtotal.eq(0)) {
    return lines.map((l) => roundMoney(l));
  }

  const targetNetTotal = roundMoney(subtotal.sub(invDisc));
  const lastPositiveIdx = lines.reduce((acc, v, idx) => (v.gt(0) ? idx : acc), -1);
  if (lastPositiveIdx === -1) {
    return lines.map((l) => roundMoney(l));
  }

  const result: Decimal[] = new Array(lines.length).fill(new Decimal(0));
  let allocatedNet = new Decimal(0);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].eq(0)) {
      result[i] = new Decimal(0);
      continue;
    }
    if (i === lastPositiveIdx) {
      result[i] = roundMoney(targetNetTotal.sub(allocatedNet));
    } else {
      const share = roundMoney(lines[i].mul(targetNetTotal).div(subtotal));
      result[i] = share;
      allocatedNet = allocatedNet.add(share);
    }
  }
  return result;
}

/**
 * Computes weighted-average per-base-unit cost (6 decimal places) when replenishing
 * an existing batch with stock at a different purchase cost.
 */
export function computeWeightedAverageCost(
  existingQtyBase: DecimalInput,
  existingCostPerBase: DecimalInput,
  addedQtyBase: DecimalInput,
  addedCostPerBase: DecimalInput
): Decimal {
  const qOld = qty(existingQtyBase, 'Existing batch quantity');
  const cOld = cost6(existingCostPerBase, 'Existing batch cost');
  const qNew = validateQuantityInput(addedQtyBase, 'Added batch quantity', { allowZero: false });
  const cNew = cost6(addedCostPerBase, 'New batch cost');

  if (qOld.lte(0)) {
    return roundCost6(cNew);
  }
  const totalQty = qOld.add(qNew);
  const totalValue = qOld.mul(cOld).add(qNew.mul(cNew));
  return roundCost6(totalValue.div(totalQty));
}
