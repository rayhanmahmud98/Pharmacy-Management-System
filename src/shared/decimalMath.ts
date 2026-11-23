import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type DecimalInput = Decimal | string | number;

export function d(value: DecimalInput): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid numeric value');
    return new Decimal(value.toString());
  }
  const str = String(value ?? '').trim();
  if (!str) throw new Error('Empty numeric value');
  return new Decimal(str);
}

export function money(value: DecimalInput): Decimal {
  return d(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function qty(value: DecimalInput): Decimal {
  return d(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export function ratio(value: DecimalInput): Decimal {
  const val = d(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (val.lte(0)) {
    throw new Error('Conversion ratio must be strictly greater than zero');
  }
  return val;
}

export function convertToBaseUnits(inputQty: DecimalInput, conversionRatio: DecimalInput): Decimal {
  const q = qty(inputQty);
  const r = ratio(conversionRatio);
  if (q.lte(0)) {
    throw new Error('Quantity must be strictly greater than zero');
  }
  return qty(q.mul(r));
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
  const qInput = qty(input.quantityInput);
  if (qInput.lte(0)) throw new Error('Line quantity must be positive');
  const conv = ratio(input.conversionRatio);
  const price = money(input.unitPriceOrCost);
  if (price.lt(0)) throw new Error('Unit price/cost cannot be negative');
  const disc = money(input.discountAmount ?? 0);
  if (disc.lt(0)) throw new Error('Line discount cannot be negative');

  const quantityBase = qty(qInput.mul(conv));
  const grossTotal = money(qInput.mul(price));
  if (disc.gt(grossTotal)) {
    throw new Error('Line discount cannot exceed gross line total');
  }
  const netTotal = money(grossTotal.sub(disc));
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
    grossSubtotal = grossSubtotal.add(money(line.grossTotal));
    lineDiscountTotal = lineDiscountTotal.add(money(line.discount));
    lineNetSum = lineNetSum.add(money(line.netTotal));
  }

  grossSubtotal = money(grossSubtotal);
  lineDiscountTotal = money(lineDiscountTotal);
  const invDisc = money(input.invoiceDiscount ?? 0);
  if (invDisc.lt(0)) throw new Error('Invoice discount cannot be negative');
  if (invDisc.gt(lineNetSum)) throw new Error('Invoice discount cannot exceed net subtotal');

  const netTotal = money(lineNetSum.sub(invDisc));
  const paid = money(input.paidAmount ?? 0);
  if (paid.lt(0)) throw new Error('Paid amount cannot be negative');
  if (paid.gt(netTotal)) throw new Error('Paid amount cannot exceed net invoice total');

  const dueAmount = money(netTotal.sub(paid));
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
  status: 'ACTIVE' | 'QUARANTINED' | 'EXPIRED' | 'WRITTEN_OFF' | 'INACTIVE';
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
  const needed = qty(requiredQtyBase);
  if (needed.lte(0)) throw new Error('Required quantity must be positive');

  const eligible = candidates.filter((b) => {
    if (b.status !== 'ACTIVE') return false;
    if (b.expiryDate <= asOfDate) return false; // Expired on or before today cannot be sold normally
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
        `Insufficient stock in selected batch ${chosen.batchNumber}: available ${available.toFixed(2)}, requested ${needed.toFixed(2)}`
      );
    }
    const cost = d(chosen.purchaseCostPerBase).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    return [
      {
        batchId: chosen.id,
        batchNumber: chosen.batchNumber,
        expiryDate: chosen.expiryDate,
        qtyBase: needed,
        costPerBaseSnapshot: cost,
        cogsTotal: money(needed.mul(cost)),
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
    const cost = d(batch.purchaseCostPerBase).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      qtyBase: take,
      costPerBaseSnapshot: cost,
      cogsTotal: money(take.mul(cost)),
    });
    remaining = qty(remaining.sub(take));
  }

  if (remaining.gt(0)) {
    const totalAvail = eligible.reduce((acc, b) => acc.add(qty(b.currentQtyBase)), new Decimal(0));
    throw new Error(
      `Insufficient sellable stock: requested ${needed.toFixed(2)} base units, available ${totalAvail.toFixed(2)}`
    );
  }

  return allocations;
}

export function computeReturnCogsReversal(
  originalAllocations: Array<{ batchId: string; qtyBase: DecimalInput; costPerBaseSnapshot: DecimalInput }>,
  returnQtyBase: DecimalInput
): Array<{ batchId: string; qtyBase: Decimal; costPerBaseSnapshot: Decimal; cogsReversed: Decimal }> {
  let remaining = qty(returnQtyBase);
  if (remaining.lte(0)) throw new Error('Return quantity must be positive');

  const totalOrig = originalAllocations.reduce((s, a) => s.add(qty(a.qtyBase)), new Decimal(0));
  if (remaining.gt(totalOrig)) {
    throw new Error(`Return quantity (${remaining.toFixed(2)}) exceeds available sold quantity (${totalOrig.toFixed(2)})`);
  }

  const results: Array<{ batchId: string; qtyBase: Decimal; costPerBaseSnapshot: Decimal; cogsReversed: Decimal }> = [];
  for (const alloc of originalAllocations) {
    if (remaining.lte(0)) break;
    const avail = qty(alloc.qtyBase);
    if (avail.lte(0)) continue;
    const take = Decimal.min(avail, remaining);
    const cost = d(alloc.costPerBaseSnapshot).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    results.push({
      batchId: alloc.batchId,
      qtyBase: take,
      costPerBaseSnapshot: cost,
      cogsReversed: money(take.mul(cost)),
    });
    remaining = qty(remaining.sub(take));
  }
  return results;
}

export function computeExpectedCash(
  openingCash: DecimalInput,
  cashReceived: DecimalInput,
  cashPaid: DecimalInput,
  cashAdjustments: DecimalInput
): Decimal {
  return money(d(openingCash).add(d(cashReceived)).sub(d(cashPaid)).add(d(cashAdjustments)));
}

export function computeCashVariance(actualCash: DecimalInput, expectedCash: DecimalInput): Decimal {
  return money(d(actualCash).sub(d(expectedCash)));
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
