import Decimal from 'decimal.js';
import { generateDocNumber, nowIso, todayDate, uuid, withTransaction, type DbExecutor } from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import {
  allocateBatchesFEFO,
  allocateInvoiceDiscountAcrossLines,
  computeInvoiceTotals,
  computeLineTotals,
  computeReturnCogsReversal,
  d,
  money,
  qty,
  roundMoney,
  roundQty,
  validateCurrencyInput,
  validateQuantityInput,
  type BatchCandidate,
} from '../../src/shared/decimalMath.ts';
import { getActiveCashSessionId } from './financeService.ts';

export interface SaleLineInput {
  medicineId: string;
  unitId: string;
  quantityInput: string;
  unitPrice: string;
  lineDiscount?: string;
  manualBatchId?: string | null;
  manualOverrideReason?: string;
}

export interface SalePaymentInput {
  method: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
  amount: string;
  referenceNo?: string;
}

export async function completeSale(
  user: AuthUser,
  input: {
    customerId?: string | null;
    saleDate?: string;
    invoiceDiscount?: string;
    applyAdvance?: boolean;
    notes?: string;
    counterCode?: string | null;
    cashSessionId?: string | null;
    lines: SaleLineInput[];
    payments: SalePaymentInput[];
  },
  existingTx?: DbExecutor
) {
  if (!input.lines || input.lines.length === 0) {
    throw new Error('At least one medicine line is required to complete a sale');
  }
  const today = todayDate();
  const sDate = input.saleDate || today;

  const invDisc = validateCurrencyInput(input.invoiceDiscount ?? '0', 'Invoice discount', { allowZero: true });
  for (const p of input.payments || []) {
    validateCurrencyInput(p.amount ?? '0', `${p.method} payment amount`, { allowZero: true });
  }

  return withTransaction(async (tx) => {
    let customer:
      | { id: string; name: string; current_balance: string; advance_balance: string; credit_limit: string }
      | undefined;
    if (input.customerId) {
      customer = await tx.queryOne<NonNullable<typeof customer>>(
        'SELECT id, name, current_balance, advance_balance, credit_limit FROM customers WHERE id = $1 AND is_active = TRUE FOR UPDATE',
        [input.customerId]
      );
      if (!customer) throw new Error('Selected customer not found or inactive');
    }

    const saleId = uuid();
    const invoiceNumber = await generateDocNumber(tx, 'INV', 'sales', 'invoice_number');
    const ts = nowIso();

    // Lock all involved medicine batches up front in deterministic sorted order to prevent deadlocks & overselling races
    const distinctMedIds = Array.from(new Set(input.lines.map((l) => l.medicineId))).sort();
    const lockedBatches = await tx.query<{
      id: string;
      medicine_id: string;
      batch_number: string;
      expiry_date: string;
      received_date: string;
      status: BatchCandidate['status'];
      current_qty_base: string;
      purchase_cost_per_base: string;
    }>(
      `SELECT id, medicine_id, batch_number, expiry_date, received_date, status, current_qty_base, purchase_cost_per_base
       FROM batches
       WHERE medicine_id = ANY($1::text[])
       ORDER BY medicine_id ASC, id ASC
       FOR UPDATE`,
      [distinctMedIds]
    );

    const batchesByMed = new Map<string, typeof lockedBatches>();
    const batchBalanceMap = new Map<string, Decimal>();
    for (const b of lockedBatches) {
      batchBalanceMap.set(b.id, qty(b.current_qty_base));
      const arr = batchesByMed.get(b.medicine_id) || [];
      arr.push(b);
      batchesByMed.set(b.medicine_id, arr);
    }

    const preparedLines = [];
    for (const line of input.lines) {
      const med = await tx.queryOne<{
        id: string;
        brand_name: string;
        base_unit_name: string;
        is_active: boolean;
      }>('SELECT id, brand_name, base_unit_name, is_active FROM medicines WHERE id = $1', [line.medicineId]);
      if (!med || !med.is_active) throw new Error('Medicine not found or inactive');

      const unit = await tx.queryOne<{
        id: string;
        unit_name: string;
        conversion_to_base: string;
        allow_sale: boolean;
      }>('SELECT id, unit_name, conversion_to_base, allow_sale FROM medicine_units WHERE id = $1 AND medicine_id = $2 AND is_active = TRUE', [
        line.unitId,
        line.medicineId,
      ]);
      if (!unit) throw new Error(`Unit not configured for ${med.brand_name}`);
      if (!unit.allow_sale) throw new Error(`Unit '${unit.unit_name}' is not enabled for sales on ${med.brand_name}`);

      const calc = computeLineTotals({
        quantityInput: line.quantityInput,
        conversionRatio: unit.conversion_to_base,
        unitPriceOrCost: line.unitPrice,
        discountAmount: line.lineDiscount || '0',
      });

      if (line.manualBatchId) {
        if (!user.permissions['pos.manual_batch']) {
          throw new Error('Permission denied: manual batch override requires pos.manual_batch permission');
        }
        if (!line.manualOverrideReason?.trim()) {
          throw new Error(`Manual batch override on ${med.brand_name} requires a mandatory reason`);
        }
      }

      const dbBatches = batchesByMed.get(med.id) || [];
      const candidates: BatchCandidate[] = dbBatches.map((b) => ({
        id: b.id,
        batchNumber: b.batch_number,
        expiryDate: b.expiry_date,
        receivedDate: b.received_date,
        status: b.status,
        currentQtyBase: batchBalanceMap.get(b.id)!,
        purchaseCostPerBase: b.purchase_cost_per_base,
      }));

      const allocations = allocateBatchesFEFO(candidates, calc.quantityBase, today, line.manualBatchId);
      for (const a of allocations) {
        batchBalanceMap.set(a.batchId, roundQty(batchBalanceMap.get(a.batchId)!.sub(a.qtyBase)));
      }
      const lineCogs = roundMoney(allocations.reduce((acc, a) => acc.add(a.cogsTotal), new Decimal(0)));

      preparedLines.push({
        line,
        med,
        unit,
        calc,
        allocations,
        lineCogs,
      });
    }

    const anyLineDisc = preparedLines.some((l) => l.calc.discount.gt(0));
    if ((anyLineDisc || invDisc.gt(0)) && !user.permissions['pos.discount']) {
      throw new Error('Permission denied: applying discounts requires pos.discount permission');
    }

    let totalPaid = new Decimal(0);
    const validPayments = (input.payments || []).filter((p) => validateCurrencyInput(p.amount, 'Payment amount').gt(0));
    for (const p of validPayments) {
      totalPaid = totalPaid.add(validateCurrencyInput(p.amount, 'Payment amount'));
    }
    totalPaid = roundMoney(totalPaid);

    const totals = computeInvoiceTotals({
      lines: preparedLines.map((l) => ({
        grossTotal: l.calc.grossTotal,
        discount: l.calc.discount,
        netTotal: l.calc.netTotal,
      })),
      invoiceDiscount: invDisc,
      paidAmount: totalPaid,
    });

    const effectiveLineTotals = allocateInvoiceDiscountAcrossLines(
      preparedLines.map((l) => l.calc.netTotal),
      totals.invoiceDiscount
    );

    let advanceApplied = new Decimal(0);
    let finalDueAmount = totals.dueAmount;
    if (
      customer &&
      customer.name !== 'Walk-in Customer' &&
      input.applyAdvance !== false &&
      totals.dueAmount.gt(0)
    ) {
      const advAvail = money(customer.advance_balance || '0.00');
      if (advAvail.gt(0)) {
        advanceApplied = Decimal.min(advAvail, totals.dueAmount);
        finalDueAmount = roundMoney(totals.dueAmount.sub(advanceApplied));
      }
    }

    if (finalDueAmount.gt(0)) {
      if (!customer || customer.name === 'Walk-in Customer') {
        throw new Error('Credit / due sales require selecting a registered customer');
      }
      const limit = money(customer.credit_limit);
      if (limit.gt(0)) {
        const projected = roundMoney(d(customer.current_balance).add(finalDueAmount));
        if (projected.gt(limit)) {
          throw new Error(
            `Customer credit limit exceeded: limit ${limit.toFixed(2)}, projected balance ${projected.toFixed(2)}`
          );
        }
      }
    }

    const totalCogs = roundMoney(preparedLines.reduce((acc, l) => acc.add(l.lineCogs), new Decimal(0)));

    await tx.execute(
      `INSERT INTO sales (
        id, invoice_number, customer_id, sale_date, status, gross_subtotal, line_discount_total,
        invoice_discount, net_total, paid_amount, due_amount, advance_applied, total_cogs, notes, created_by, created_at
      ) VALUES ($1, $2, $3, $4, 'COMPLETED', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        saleId,
        invoiceNumber,
        customer?.id || null,
        sDate,
        totals.grossSubtotal.toFixed(2),
        totals.lineDiscountTotal.toFixed(2),
        totals.invoiceDiscount.toFixed(2),
        totals.netTotal.toFixed(2),
        totals.paidAmount.toFixed(2),
        finalDueAmount.toFixed(2),
        advanceApplied.toFixed(2),
        totalCogs.toFixed(2),
        (input.notes || '').trim(),
        user.id,
        ts,
      ]
    );

    for (let idx = 0; idx < preparedLines.length; idx++) {
      const item = preparedLines[idx];
      const effLineTotal = effectiveLineTotals[idx];
      const lineId = uuid();

      await tx.execute(
        `INSERT INTO sale_lines (
          id, sale_id, medicine_id, unit_id, unit_name_snapshot, conversion_ratio_snapshot,
          qty_input, qty_base, unit_price, gross_total, line_discount, line_total, effective_line_total, cogs_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          lineId,
          saleId,
          item.med.id,
          item.unit.id,
          item.unit.unit_name,
          d(item.unit.conversion_to_base).toFixed(6),
          validateQuantityInput(item.line.quantityInput, 'Quantity').toFixed(6),
          item.calc.quantityBase.toFixed(6),
          validateCurrencyInput(item.line.unitPrice, 'Unit price').toFixed(2),
          item.calc.grossTotal.toFixed(2),
          item.calc.discount.toFixed(2),
          item.calc.netTotal.toFixed(2),
          effLineTotal.toFixed(2),
          item.lineCogs.toFixed(2),
        ]
      );

      for (const alloc of item.allocations) {
        await tx.execute(
          `INSERT INTO sale_batch_allocations (
            id, sale_line_id, batch_id, qty_base, cost_per_base_snapshot, cogs_total, is_manual_override, override_reason
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            uuid(),
            lineId,
            alloc.batchId,
            alloc.qtyBase.toFixed(6),
            alloc.costPerBaseSnapshot.toFixed(6),
            alloc.cogsTotal.toFixed(2),
            Boolean(item.line.manualBatchId),
            item.line.manualOverrideReason?.trim() || '',
          ]
        );

        // Atomic conditional stock deduction backed by row lock + CHECK constraint
        const deducted = await tx.queryOne<{ id: string }>(
          `UPDATE batches
           SET current_qty_base = current_qty_base - $1::numeric, updated_at = $2
           WHERE id = $3 AND current_qty_base >= $1::numeric
           RETURNING id`,
          [alloc.qtyBase.toFixed(6), ts, alloc.batchId]
        );
        if (!deducted) {
          throw new Error(`Insufficient stock: concurrency check prevented overselling batch ${alloc.batchNumber}`);
        }

        await tx.execute(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
            cost_per_base_snapshot, reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, 'SALE', 'SALE', $5, $6, $7, $8, $9, $10)`,
          [
            uuid(),
            item.med.id,
            alloc.batchId,
            alloc.qtyBase.neg().toFixed(6),
            saleId,
            lineId,
            alloc.costPerBaseSnapshot.toFixed(6),
            item.line.manualBatchId ? `Manual override: ${item.line.manualOverrideReason}` : `FEFO Sale ${invoiceNumber}`,
            user.id,
            ts,
          ]
        );
      }
    }

    let cashPaidTotal = new Decimal(0);
    for (const p of validPayments) {
      const amt = validateCurrencyInput(p.amount, 'Payment amount', { allowZero: false });
      const payId = uuid();
      const payNo = await generateDocNumber(tx, 'PAY', 'payments', 'payment_number');
      await tx.execute(
        `INSERT INTO payments (
          id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at
        ) VALUES ($1, $2, 'CUSTOMER', $3, 'IN', $4, $5, $6, $7, 'POSTED', $8, $9)`,
        [
          payId,
          payNo,
          customer?.id || '',
          p.method,
          amt.toFixed(2),
          (p.referenceNo || '').trim(),
          `Sale payment for ${invoiceNumber}`,
          user.id,
          ts,
        ]
      );
      await tx.execute(
        `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated)
         VALUES ($1, $2, 'SALE', $3, $4)`,
        [uuid(), payId, saleId, amt.toFixed(2)]
      );

      if (p.method === 'CASH') {
        cashPaidTotal = cashPaidTotal.add(amt);
      }
    }

    if (cashPaidTotal.gt(0)) {
      const cashSessionId = await getActiveCashSessionId(tx, input.counterCode, input.cashSessionId, user.id);
      if (!cashSessionId) {
        throw new Error('Cannot complete a CASH sale without an OPEN cash session');
      }
      await tx.execute(
        `INSERT INTO cash_movements (
          id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
        ) VALUES ($1, $2, 'CASH_SALE', $3, 'SALE', $4, $5, $6, $7)`,
        [
          uuid(),
          cashSessionId,
          roundMoney(cashPaidTotal).toFixed(2),
          saleId,
          `Cash received on ${invoiceNumber}`,
          user.id,
          ts,
        ]
      );
    }

    if (customer && advanceApplied.gt(0)) {
      const nextAdv = roundMoney(money(customer.advance_balance || '0.00').sub(advanceApplied));
      await tx.execute('UPDATE customers SET advance_balance = $1, updated_at = $2 WHERE id = $3', [
        nextAdv.toFixed(2),
        ts,
        customer.id,
      ]);
      await tx.execute(
        `INSERT INTO party_advance_ledger (id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at)
         VALUES ($1, 'CUSTOMER', $2, 'APPLIED_TO_INVOICE', 'SALE', $3, $4, $5, $6, $7)`,
        [uuid(), customer.id, saleId, advanceApplied.neg().toFixed(2), `Advance applied to ${invoiceNumber}`, user.id, ts]
      );
    }

    if (customer && finalDueAmount.gt(0)) {
      await tx.execute('UPDATE customers SET current_balance = $1, updated_at = $2 WHERE id = $3', [
        roundMoney(d(customer.current_balance).add(finalDueAmount)).toFixed(2),
        ts,
        customer.id,
      ]);
    }

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'COMPLETE_SALE',
      module: 'sales',
      targetType: 'SALE',
      targetId: saleId,
      transactionRef: invoiceNumber,
      afterState: {
        netTotal: totals.netTotal.toFixed(2),
        paid: totals.paidAmount.toFixed(2),
        advanceApplied: advanceApplied.toFixed(2),
        due: finalDueAmount.toFixed(2),
        cashOnly: roundMoney(cashPaidTotal).toFixed(2),
        cogs: totalCogs.toFixed(2),
      },
    });

    return {
      saleId,
      invoiceNumber,
      netTotal: totals.netTotal.toFixed(2),
      paidAmount: totals.paidAmount.toFixed(2),
      advanceApplied: advanceApplied.toFixed(2),
      dueAmount: finalDueAmount.toFixed(2),
      totalCogs: totalCogs.toFixed(2),
    };
  }, existingTx);
}

export async function createSalesReturn(
  user: AuthUser,
  input: {
    saleId: string;
    settlementType: 'CASH_REFUND' | 'MFS_REFUND' | 'CUSTOMER_CREDIT';
    reason: string;
    counterCode?: string | null;
    cashSessionId?: string | null;
    lines: Array<{
      saleLineId: string;
      qtyBase: string;
      disposition: 'RESTOCK_SELLABLE' | 'QUARANTINE' | 'DAMAGED' | 'WRITE_OFF' | 'NOT_RESTOCKABLE';
    }>;
  },
  existingTx?: DbExecutor
) {
  if (!input.reason?.trim()) throw new Error('Return reason is required');
  if (!input.lines || input.lines.length === 0) throw new Error('At least one return line is required');

  for (const rl of input.lines) {
    validateQuantityInput(rl.qtyBase ?? '0', 'Return quantity', { allowZero: true });
  }

  return withTransaction(async (tx) => {
    const sale = await tx.queryOne<{
      id: string;
      invoice_number: string;
      customer_id: string | null;
      status: string;
      invoice_discount: string;
      net_total: string;
      paid_amount: string;
      due_amount: string;
    }>('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [input.saleId]);
    if (!sale || sale.status !== 'COMPLETED') throw new Error('Only COMPLETED sales can be returned');

    if (input.settlementType === 'CUSTOMER_CREDIT' && !sale.customer_id) {
      throw new Error('Customer credit settlement requires a linked customer on the original sale');
    }

    const allSaleLines = await tx.query<{
      id: string;
      medicine_id: string;
      qty_base: string;
      line_total: string;
      effective_line_total: string | null;
    }>('SELECT id, medicine_id, qty_base, line_total, effective_line_total FROM sale_lines WHERE sale_id = $1 ORDER BY id ASC', [
      sale.id,
    ]);

    const computedLegacyEffective = allocateInvoiceDiscountAcrossLines(
      allSaleLines.map((l) => l.line_total),
      sale.invoice_discount || '0'
    );
    const saleLineMap = new Map<
      string,
      { id: string; medicineId: string; qtyBase: Decimal; effectiveLineTotal: Decimal }
    >();
    allSaleLines.forEach((sl, idx) => {
      const eff = sl.effective_line_total ? money(sl.effective_line_total) : computedLegacyEffective[idx];
      saleLineMap.set(sl.id, {
        id: sl.id,
        medicineId: sl.medicine_id,
        qtyBase: qty(sl.qty_base),
        effectiveLineTotal: eff,
      });
    });

    const qtyReturnedByLine = new Map<string, Decimal>();
    const refundedByLine = new Map<string, Decimal>();
    const remainingAllocsByLine = new Map<
      string,
      Array<{ batchId: string; qtyBase: Decimal; costPerBaseSnapshot: string }>
    >();

    async function ensureLineTrackingLoaded(saleLineId: string) {
      if (qtyReturnedByLine.has(saleLineId)) return;
      const prevLines = await tx.query<{ batch_id: string; qty_base: string; refund_line_total: string }>(
        'SELECT batch_id, qty_base, refund_line_total FROM sales_return_lines WHERE sale_line_id = $1',
        [saleLineId]
      );

      let alreadyReturned = new Decimal(0);
      let alreadyRefunded = new Decimal(0);
      const prevPerBatch = new Map<string, Decimal>();
      for (const pr of prevLines) {
        const qPrev = qty(pr.qty_base);
        alreadyReturned = alreadyReturned.add(qPrev);
        alreadyRefunded = alreadyRefunded.add(money(pr.refund_line_total));
        prevPerBatch.set(pr.batch_id, (prevPerBatch.get(pr.batch_id) || new Decimal(0)).add(qPrev));
      }
      qtyReturnedByLine.set(saleLineId, alreadyReturned);
      refundedByLine.set(saleLineId, roundMoney(alreadyRefunded));

      const origAllocs = await tx.query<{ batch_id: string; qty_base: string; cost_per_base_snapshot: string }>(
        `SELECT sba.batch_id, sba.qty_base, sba.cost_per_base_snapshot
         FROM sale_batch_allocations sba
         JOIN batches b ON b.id = sba.batch_id
         WHERE sba.sale_line_id = $1
         ORDER BY b.expiry_date ASC, sba.id ASC`,
        [saleLineId]
      );

      const remAllocs = origAllocs
        .map((oa) => {
          const usedPrev = prevPerBatch.get(oa.batch_id) || new Decimal(0);
          const avail = roundQty(qty(oa.qty_base).sub(usedPrev));
          return {
            batchId: oa.batch_id,
            qtyBase: avail.gt(0) ? avail : new Decimal(0),
            costPerBaseSnapshot: oa.cost_per_base_snapshot,
          };
        })
        .filter((x) => x.qtyBase.gt(0));
      remainingAllocsByLine.set(saleLineId, remAllocs);
    }

    const ts = nowIso();
    const today = todayDate();
    const returnId = uuid();
    const returnNumber = await generateDocNumber(tx, 'SRN', 'sales_returns', 'return_number');

    let totalRefundValue = new Decimal(0);
    let totalCogsReversed = new Decimal(0);

    const preparedReturnLines: Array<{
      saleLineId: string;
      medicineId: string;
      disposition: string;
      allocs: Array<{ batchId: string; qtyBase: Decimal; costPerBaseSnapshot: Decimal; cogsReversed: Decimal; refundPart: Decimal }>;
    }> = [];

    for (const reqLine of input.lines) {
      const qRet = validateQuantityInput(reqLine.qtyBase, 'Return quantity', { allowZero: true });
      if (qRet.lte(0)) continue;

      const sl = saleLineMap.get(reqLine.saleLineId);
      if (!sl) throw new Error('Sale line not found on this invoice');

      await ensureLineTrackingLoaded(sl.id);

      const curReturned = qtyReturnedByLine.get(sl.id)!;
      const maxReturnable = roundQty(sl.qtyBase.sub(curReturned));
      if (qRet.gt(maxReturnable)) {
        throw new Error(`Return quantity ${qRet.toFixed(6)} exceeds remaining returnable quantity ${maxReturnable.toFixed(6)}`);
      }

      const remAllocs = remainingAllocsByLine.get(sl.id)!;
      const cogsSplits = computeReturnCogsReversal(remAllocs, qRet);

      for (const sp of cogsSplits) {
        for (const ra of remAllocs) {
          if (ra.batchId === sp.batchId && ra.qtyBase.gt(0)) {
            ra.qtyBase = roundQty(ra.qtyBase.sub(sp.qtyBase));
            break;
          }
        }
      }
      remainingAllocsByLine.set(
        sl.id,
        remAllocs.filter((x) => x.qtyBase.gt(0))
      );

      const prevLineRefund = refundedByLine.get(sl.id)!;
      const remainingLineValue = roundMoney(Decimal.max(new Decimal(0), sl.effectiveLineTotal.sub(prevLineRefund)));
      const isFinalRemainder = qRet.eq(maxReturnable);
      let lineRefundTotal = isFinalRemainder
        ? remainingLineValue
        : roundMoney(qRet.mul(sl.effectiveLineTotal).div(sl.qtyBase));
      if (lineRefundTotal.gt(remainingLineValue)) {
        lineRefundTotal = remainingLineValue;
      }

      let allocatedRefund = new Decimal(0);
      const splitWithRefund = cogsSplits.map((sp, idx) => {
        const refundPart =
          idx === cogsSplits.length - 1
            ? roundMoney(lineRefundTotal.sub(allocatedRefund))
            : roundMoney(lineRefundTotal.mul(sp.qtyBase).div(qRet));
        allocatedRefund = allocatedRefund.add(refundPart);
        totalCogsReversed = totalCogsReversed.add(sp.cogsReversed);
        return { ...sp, refundPart };
      });
      totalRefundValue = totalRefundValue.add(lineRefundTotal);

      qtyReturnedByLine.set(sl.id, roundQty(curReturned.add(qRet)));
      refundedByLine.set(sl.id, roundMoney(prevLineRefund.add(lineRefundTotal)));

      preparedReturnLines.push({
        saleLineId: sl.id,
        medicineId: sl.medicineId,
        disposition: reqLine.disposition,
        allocs: splitWithRefund,
      });
    }

    if (preparedReturnLines.length === 0) throw new Error('No positive return quantities submitted');
    totalRefundValue = roundMoney(totalRefundValue);
    totalCogsReversed = roundMoney(totalCogsReversed);

    const salePaid = money(sale.paid_amount);
    const saleDue = money(sale.due_amount);

    if (input.settlementType === 'CASH_REFUND' || input.settlementType === 'MFS_REFUND') {
      if (totalRefundValue.gt(salePaid)) {
        throw new Error(
          `Cannot issue ${input.settlementType} of ${totalRefundValue.toFixed(2)}: exceeds remaining paid amount (${salePaid.toFixed(2)}) on invoice ${sale.invoice_number}. Use Customer Credit to settle unpaid invoice due.`
        );
      }
    }

    const refundAmount = input.settlementType === 'CUSTOMER_CREDIT' ? new Decimal(0) : totalRefundValue;
    const creditAmount = input.settlementType === 'CUSTOMER_CREDIT' ? totalRefundValue : new Decimal(0);

    let dueSettled = new Decimal(0);
    let advanceCreated = new Decimal(0);
    if (input.settlementType === 'CUSTOMER_CREDIT') {
      dueSettled = Decimal.min(creditAmount, saleDue);
      advanceCreated = roundMoney(creditAmount.sub(dueSettled));
    }

    await tx.execute(
      `INSERT INTO sales_returns (
        id, return_number, sale_id, customer_id, return_date, total_refund_value,
        settlement_type, refund_amount, credit_amount, due_settled, advance_created,
        total_cogs_reversed, reason, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        returnId,
        returnNumber,
        sale.id,
        sale.customer_id,
        today,
        totalRefundValue.toFixed(2),
        input.settlementType,
        refundAmount.toFixed(2),
        creditAmount.toFixed(2),
        dueSettled.toFixed(2),
        advanceCreated.toFixed(2),
        totalCogsReversed.toFixed(2),
        input.reason.trim(),
        user.id,
        ts,
      ]
    );

    for (const rl of preparedReturnLines) {
      for (const sp of rl.allocs) {
        const srlId = uuid();
        await tx.execute(
          `INSERT INTO sales_return_lines (
            id, sales_return_id, sale_line_id, medicine_id, batch_id, qty_base,
            disposition, cost_per_base_snapshot, cogs_reversed, refund_line_total
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            srlId,
            returnId,
            rl.saleLineId,
            rl.medicineId,
            sp.batchId,
            sp.qtyBase.toFixed(6),
            rl.disposition,
            sp.costPerBaseSnapshot.toFixed(6),
            sp.cogsReversed.toFixed(2),
            sp.refundPart.toFixed(2),
          ]
        );

        const origBatch = (await tx.queryOne<{
          id: string;
          medicine_id: string;
          batch_number: string;
          expiry_date: string;
          supplier_id: string | null;
          purchase_id: string | null;
          received_date: string;
          purchase_cost_per_base: string;
          selling_price_per_base: string;
          current_qty_base: string;
          base_unit_name: string;
        }>('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [sp.batchId]))!;

        if (rl.disposition === 'RESTOCK_SELLABLE') {
          if (origBatch.expiry_date <= today) {
            throw new Error(`Batch ${origBatch.batch_number} is expired (${origBatch.expiry_date}) and cannot be restocked as sellable`);
          }
          await tx.execute('UPDATE batches SET current_qty_base = $1, updated_at = $2 WHERE id = $3', [
            roundQty(qty(origBatch.current_qty_base).add(sp.qtyBase)).toFixed(6),
            ts,
            origBatch.id,
          ]);
          await tx.execute(
            `INSERT INTO stock_movements (
              id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
              cost_per_base_snapshot, reason, created_by, created_at
            ) VALUES ($1, $2, $3, $4, 'SALE_RETURN', 'SALES_RETURN', $5, $6, $7, $8, $9, $10)`,
            [
              uuid(),
              rl.medicineId,
              origBatch.id,
              sp.qtyBase.toFixed(6),
              returnId,
              srlId,
              sp.costPerBaseSnapshot.toFixed(6),
              `Restocked after inspection (${input.reason.trim()})`,
              user.id,
              ts,
            ]
          );
        } else if (rl.disposition === 'QUARANTINE') {
          let qBatchNum = `${origBatch.batch_number}-QRN`;
          const existingQ = await tx.queryOne<{ id: string; current_qty_base: string; status: string }>(
            'SELECT id, current_qty_base, status FROM batches WHERE medicine_id = $1 AND batch_number = $2 AND expiry_date = $3 FOR UPDATE',
            [rl.medicineId, qBatchNum, origBatch.expiry_date]
          );
          let targetBatchId: string;
          if (existingQ && existingQ.status === 'QUARANTINED') {
            targetBatchId = existingQ.id;
            await tx.execute('UPDATE batches SET current_qty_base = $1, updated_at = $2 WHERE id = $3', [
              roundQty(qty(existingQ.current_qty_base).add(sp.qtyBase)).toFixed(6),
              ts,
              targetBatchId,
            ]);
          } else if (existingQ && qty(existingQ.current_qty_base).eq(0)) {
            targetBatchId = existingQ.id;
            await tx.execute(
              "UPDATE batches SET status = 'QUARANTINED', current_qty_base = $1, notes = $2, updated_at = $3 WHERE id = $4",
              [sp.qtyBase.toFixed(6), `Quarantined from ${returnNumber}`, ts, targetBatchId]
            );
          } else {
            if (existingQ) {
              qBatchNum = `${origBatch.batch_number}-QRN-${returnNumber.slice(-4)}`;
            }
            targetBatchId = uuid();
            await tx.execute(
              `INSERT INTO batches (
                id, medicine_id, batch_number, expiry_date, supplier_id, purchase_id, received_date,
                purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
                base_unit_name, status, notes, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'QUARANTINED', $13, $14, $15)`,
              [
                targetBatchId,
                rl.medicineId,
                qBatchNum,
                origBatch.expiry_date,
                origBatch.supplier_id,
                origBatch.purchase_id,
                today,
                sp.costPerBaseSnapshot.toFixed(6),
                origBatch.selling_price_per_base,
                sp.qtyBase.toFixed(6),
                sp.qtyBase.toFixed(6),
                origBatch.base_unit_name,
                `Quarantined from ${returnNumber}`,
                ts,
                ts,
              ]
            );
          }
          await tx.execute(
            `INSERT INTO stock_movements (
              id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
              cost_per_base_snapshot, reason, created_by, created_at
            ) VALUES ($1, $2, $3, $4, 'SALE_RETURN', 'SALES_RETURN', $5, $6, $7, $8, $9, $10)`,
            [
              uuid(),
              rl.medicineId,
              targetBatchId,
              sp.qtyBase.toFixed(6),
              returnId,
              srlId,
              sp.costPerBaseSnapshot.toFixed(6),
              `Quarantined on return (${input.reason.trim()})`,
              user.id,
              ts,
            ]
          );
        } else {
          await tx.execute(
            `INSERT INTO stock_movements (
              id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
              cost_per_base_snapshot, reason, created_by, created_at
            ) VALUES ($1, $2, $3, '0.000000', 'DAMAGE_WRITEOFF', 'SALES_RETURN', $4, $5, $6, $7, $8, $9)`,
            [
              uuid(),
              rl.medicineId,
              origBatch.id,
              returnId,
              srlId,
              sp.costPerBaseSnapshot.toFixed(6),
              `Non-restockable return (${rl.disposition}): ${input.reason.trim()}`,
              user.id,
              ts,
            ]
          );
        }
      }
    }

    if (input.settlementType === 'CASH_REFUND' || input.settlementType === 'MFS_REFUND') {
      await tx.execute('UPDATE sales SET paid_amount = $1 WHERE id = $2', [
        roundMoney(salePaid.sub(refundAmount)).toFixed(2),
        sale.id,
      ]);
      if (input.settlementType === 'CASH_REFUND') {
        const cashSessionId = await getActiveCashSessionId(tx, input.counterCode, input.cashSessionId, user.id);
        if (!cashSessionId) throw new Error('Cannot issue CASH refund without an OPEN cash session');
        await tx.execute(
          `INSERT INTO cash_movements (
            id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
          ) VALUES ($1, $2, 'CASH_REFUND', $3, 'SALES_RETURN', $4, $5, $6, $7)`,
          [
            uuid(),
            cashSessionId,
            refundAmount.neg().toFixed(2),
            returnId,
            `Cash refund for ${returnNumber} (${sale.invoice_number})`,
            user.id,
            ts,
          ]
        );
      }
    } else if (input.settlementType === 'CUSTOMER_CREDIT' && sale.customer_id) {
      const nextSaleDue = roundMoney(saleDue.sub(dueSettled));
      await tx.execute('UPDATE sales SET due_amount = $1 WHERE id = $2', [nextSaleDue.toFixed(2), sale.id]);

      const cust = (await tx.queryOne<{ current_balance: string; advance_balance: string }>(
        'SELECT current_balance, advance_balance FROM customers WHERE id = $1 FOR UPDATE',
        [sale.customer_id]
      ))!;

      const curBal = money(cust.current_balance);
      const nextBal = dueSettled.gt(0) ? roundMoney(Decimal.max(new Decimal(0), curBal.sub(dueSettled))) : curBal;
      const nextAdv = roundMoney(money(cust.advance_balance || '0.00').add(advanceCreated));

      await tx.execute('UPDATE customers SET current_balance = $1, advance_balance = $2, updated_at = $3 WHERE id = $4', [
        nextBal.toFixed(2),
        nextAdv.toFixed(2),
        ts,
        sale.customer_id,
      ]);

      if (advanceCreated.gt(0)) {
        await tx.execute(
          `INSERT INTO party_advance_ledger (id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at)
           VALUES ($1, 'CUSTOMER', $2, 'RETURN_CREDIT', 'SALES_RETURN', $3, $4, $5, $6, $7)`,
          [
            uuid(),
            sale.customer_id,
            returnId,
            advanceCreated.toFixed(2),
            `Return credit excess from ${returnNumber} (${sale.invoice_number})`,
            user.id,
            ts,
          ]
        );
      }
    }

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'SALES_RETURN',
      module: 'sales',
      targetType: 'SALES_RETURN',
      targetId: returnId,
      transactionRef: returnNumber,
      afterState: {
        saleInvoice: sale.invoice_number,
        totalRefundValue: totalRefundValue.toFixed(2),
        dueSettled: dueSettled.toFixed(2),
        advanceCreated: advanceCreated.toFixed(2),
        totalCogsReversed: totalCogsReversed.toFixed(2),
        settlementType: input.settlementType,
      },
      reason: input.reason.trim(),
    });

    return {
      returnId,
      returnNumber,
      totalRefundValue: totalRefundValue.toFixed(2),
      dueSettled: dueSettled.toFixed(2),
      advanceCreated: advanceCreated.toFixed(2),
      totalCogsReversed: totalCogsReversed.toFixed(2),
    };
  }, existingTx);
}

export async function reverseSale(
  user: AuthUser,
  saleId: string,
  reason: string,
  existingTx?: DbExecutor,
  options?: { counterCode?: string | null; cashSessionId?: string | null }
) {
  if (!reason?.trim()) throw new Error('Mandatory reason is required to reverse a sale');
  return withTransaction(async (tx) => {
    const sale = await tx.queryOne<{
      id: string;
      invoice_number: string;
      customer_id: string | null;
      status: string;
      due_amount: string;
      advance_applied: string;
    }>('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
    if (!sale) throw new Error('Sale not found');
    if (sale.status !== 'COMPLETED') throw new Error('Only COMPLETED sales can be reversed');

    const existingReturns = await tx.queryOne<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM sales_returns WHERE sale_id = $1',
      [saleId]
    );
    if (Number(existingReturns?.cnt ?? 0) > 0) {
      throw new Error('Cannot reverse a sale that already has partial/full sales returns');
    }

    const ts = nowIso();
    const lines = await tx.query<{ id: string; medicine_id: string }>(
      'SELECT id, medicine_id FROM sale_lines WHERE sale_id = $1 ORDER BY id ASC',
      [saleId]
    );

    for (const l of lines) {
      const allocs = await tx.query<{
        batch_id: string;
        qty_base: string;
        cost_per_base_snapshot: string;
      }>('SELECT batch_id, qty_base, cost_per_base_snapshot FROM sale_batch_allocations WHERE sale_line_id = $1 ORDER BY batch_id ASC', [
        l.id,
      ]);
      for (const a of allocs) {
        await tx.execute('SELECT id FROM batches WHERE id = $1 FOR UPDATE', [a.batch_id]);
        await tx.execute('UPDATE batches SET current_qty_base = current_qty_base + $1::numeric, updated_at = $2 WHERE id = $3', [
          qty(a.qty_base).toFixed(6),
          ts,
          a.batch_id,
        ]);
        await tx.execute(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
            cost_per_base_snapshot, reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, 'SALE_REVERSAL', 'SALE_REVERSAL', $5, $6, $7, $8, $9, $10)`,
          [uuid(), l.medicine_id, a.batch_id, qty(a.qty_base).toFixed(6), saleId, l.id, a.cost_per_base_snapshot, reason.trim(), user.id, ts]
        );
      }
    }

    const advApplied = money(sale.advance_applied || '0.00');
    if (sale.customer_id && (money(sale.due_amount).gt(0) || advApplied.gt(0))) {
      const cust = (await tx.queryOne<{ current_balance: string; advance_balance: string }>(
        'SELECT current_balance, advance_balance FROM customers WHERE id = $1 FOR UPDATE',
        [sale.customer_id]
      ))!;
      const nextDueBal = roundMoney(d(cust.current_balance).sub(d(sale.due_amount)));
      const nextAdvBal = roundMoney(money(cust.advance_balance || '0.00').add(advApplied));
      await tx.execute('UPDATE customers SET current_balance = $1, advance_balance = $2, updated_at = $3 WHERE id = $4', [
        nextDueBal.toFixed(2),
        nextAdvBal.toFixed(2),
        ts,
        sale.customer_id,
      ]);
      if (advApplied.gt(0)) {
        await tx.execute(
          `INSERT INTO party_advance_ledger (id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at)
           VALUES ($1, 'CUSTOMER', $2, 'REVERSAL', 'SALE_REVERSAL', $3, $4, $5, $6, $7)`,
          [uuid(), sale.customer_id, saleId, advApplied.toFixed(2), `Restored advance on reversal of ${sale.invoice_number}`, user.id, ts]
        );
      }
    }

    const paidAllocs = await tx.query<{ id: string; payment_number: string; method: string; amount: string }>(
      `SELECT p.id, p.payment_number, p.method, p.amount FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
       WHERE pa.target_type = 'SALE' AND pa.target_id = $1 AND p.status = 'POSTED'
       FOR UPDATE OF p`,
      [saleId]
    );

    for (const p of paidAllocs) {
      const siblingCount = await tx.queryOne<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM payment_allocations WHERE payment_id = $1',
        [p.id]
      );
      const advLinked = await tx.queryOne<{ cnt: number }>(
        "SELECT COUNT(*)::int AS cnt FROM party_advance_ledger WHERE source_type = 'PAYMENT' AND source_id = $1",
        [p.id]
      );
      if (Number(siblingCount?.cnt ?? 0) > 1 || Number(advLinked?.cnt ?? 0) > 0) {
        throw new Error(
          `Cannot reverse sale ${sale.invoice_number} while shared customer payment ${p.payment_number} is still active. Reverse ${p.payment_number} first in Parties & Payments.`
        );
      }

      await tx.execute("UPDATE payments SET status = 'REVERSED', reversal_reason = $1 WHERE id = $2", [reason.trim(), p.id]);
      if (p.method === 'CASH') {
        let preferredSessionId = options?.cashSessionId || null;
        if (!preferredSessionId && !options?.counterCode) {
          const origMove = await tx.queryOne<{ cash_session_id: string; status: string }>(
            `SELECT cm.cash_session_id, cs.status
             FROM cash_movements cm
             JOIN cash_sessions cs ON cs.id = cm.cash_session_id
             WHERE cm.reference_type = 'SALE' AND cm.reference_id = $1
             ORDER BY cm.created_at DESC LIMIT 1`,
            [saleId]
          );
          if (origMove?.status === 'OPEN') preferredSessionId = origMove.cash_session_id;
        }
        const cashSessionId = await getActiveCashSessionId(tx, options?.counterCode, preferredSessionId, user.id);
        if (!cashSessionId) throw new Error('Open cash session required to reverse cash sale payment');
        await tx.execute(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES ($1, $2, 'REVERSAL', $3, 'SALE_REVERSAL', $4, $5, $6, $7)`,
          [uuid(), cashSessionId, money(p.amount).neg().toFixed(2), saleId, `Reversal of ${sale.invoice_number}`, user.id, ts]
        );
      }
    }

    await tx.execute(
      "UPDATE sales SET status = 'REVERSED', reversed_by = $1, reversed_at = $2, reversal_reason = $3 WHERE id = $4",
      [user.id, ts, reason.trim(), saleId]
    );

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'REVERSE_SALE',
      module: 'sales',
      targetType: 'SALE',
      targetId: saleId,
      transactionRef: sale.invoice_number,
      beforeState: { status: 'COMPLETED' },
      afterState: { status: 'REVERSED' },
      reason: reason.trim(),
    });
  }, existingTx);
}
