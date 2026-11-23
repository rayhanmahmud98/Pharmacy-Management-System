import Decimal from 'decimal.js';
import { generateDocNumber, nowIso, todayDate, uuid, withTransaction } from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import {
  allocateBatchesFEFO,
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

export function completeSale(
  user: AuthUser,
  input: {
    customerId?: string | null;
    saleDate?: string;
    invoiceDiscount?: string;
    notes?: string;
    lines: SaleLineInput[];
    payments: SalePaymentInput[];
  }
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

  return withTransaction((tx) => {
    let customer: { id: string; name: string; current_balance: string; credit_limit: string } | undefined;
    if (input.customerId) {
      customer = tx
        .prepare('SELECT id, name, current_balance, credit_limit FROM customers WHERE id = ? AND is_active = 1')
        .get(input.customerId) as typeof customer;
      if (!customer) throw new Error('Selected customer not found or inactive');
    }

    const saleId = uuid();
    const invoiceNumber = generateDocNumber(tx, 'INV', 'sales', 'invoice_number');
    const ts = nowIso();

    // Preload in-transaction batch balances so multiple lines for the same medicine deduct sequentially
    const batchBalanceMap = new Map<string, Decimal>();

    const preparedLines = input.lines.map((line) => {
      const med = tx.prepare('SELECT id, brand_name, base_unit_name, is_active FROM medicines WHERE id = ?').get(line.medicineId) as
        | { id: string; brand_name: string; base_unit_name: string; is_active: number }
        | undefined;
      if (!med || !med.is_active) throw new Error('Medicine not found or inactive');

      const unit = tx
        .prepare('SELECT * FROM medicine_units WHERE id = ? AND medicine_id = ? AND is_active = 1')
        .get(line.unitId, line.medicineId) as
        | { id: string; unit_name: string; conversion_to_base: string; allow_sale: number }
        | undefined;
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

      const dbBatches = tx
        .prepare(
          `SELECT id, batch_number, expiry_date, received_date, status, current_qty_base, purchase_cost_per_base
           FROM batches WHERE medicine_id = ?`
        )
        .all(med.id) as Array<{
        id: string;
        batch_number: string;
        expiry_date: string;
        received_date: string;
        status: BatchCandidate['status'];
        current_qty_base: string;
        purchase_cost_per_base: string;
      }>;

      const candidates: BatchCandidate[] = dbBatches.map((b) => {
        if (!batchBalanceMap.has(b.id)) {
          batchBalanceMap.set(b.id, qty(b.current_qty_base));
        }
        return {
          id: b.id,
          batchNumber: b.batch_number,
          expiryDate: b.expiry_date,
          receivedDate: b.received_date,
          status: b.status,
          currentQtyBase: batchBalanceMap.get(b.id)!,
          purchaseCostPerBase: b.purchase_cost_per_base,
        };
      });

      const allocations = allocateBatchesFEFO(candidates, calc.quantityBase, today, line.manualBatchId);
      for (const a of allocations) {
        batchBalanceMap.set(a.batchId, roundQty(batchBalanceMap.get(a.batchId)!.sub(a.qtyBase)));
      }
      const lineCogs = roundMoney(allocations.reduce((acc, a) => acc.add(a.cogsTotal), new Decimal(0)));

      return {
        line,
        med,
        unit,
        calc,
        allocations,
        lineCogs,
      };
    });

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

    if (totals.dueAmount.gt(0)) {
      if (!customer || customer.name === 'Walk-in Customer') {
        throw new Error('Credit / due sales require selecting a registered customer');
      }
      const limit = money(customer.credit_limit);
      if (limit.gt(0)) {
        const projected = roundMoney(d(customer.current_balance).add(totals.dueAmount));
        if (projected.gt(limit)) {
          throw new Error(
            `Customer credit limit exceeded: limit ${limit.toFixed(2)}, projected balance ${projected.toFixed(2)}`
          );
        }
      }
    }

    const totalCogs = roundMoney(preparedLines.reduce((acc, l) => acc.add(l.lineCogs), new Decimal(0)));

    tx.prepare(
      `INSERT INTO sales (
        id, invoice_number, customer_id, sale_date, status, gross_subtotal, line_discount_total,
        invoice_discount, net_total, paid_amount, due_amount, total_cogs, notes, created_by, created_at
      ) VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      saleId,
      invoiceNumber,
      customer?.id || null,
      sDate,
      totals.grossSubtotal.toFixed(2),
      totals.lineDiscountTotal.toFixed(2),
      totals.invoiceDiscount.toFixed(2),
      totals.netTotal.toFixed(2),
      totals.paidAmount.toFixed(2),
      totals.dueAmount.toFixed(2),
      totalCogs.toFixed(2),
      (input.notes || '').trim(),
      user.id,
      ts
    );

    const insertLine = tx.prepare(
      `INSERT INTO sale_lines (
        id, sale_id, medicine_id, unit_id, unit_name_snapshot, conversion_ratio_snapshot,
        qty_input, qty_base, unit_price, gross_total, line_discount, line_total, cogs_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAlloc = tx.prepare(
      `INSERT INTO sale_batch_allocations (
        id, sale_line_id, batch_id, qty_base, cost_per_base_snapshot, cogs_total, is_manual_override, override_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMovement = tx.prepare(
      `INSERT INTO stock_movements (
        id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
        cost_per_base_snapshot, reason, created_by, created_at
      ) VALUES (?, ?, ?, ?, 'SALE', 'SALE', ?, ?, ?, ?, ?, ?)`
    );

    for (const item of preparedLines) {
      const lineId = uuid();
      insertLine.run(
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
        item.lineCogs.toFixed(2)
      );

      for (const alloc of item.allocations) {
        insertAlloc.run(
          uuid(),
          lineId,
          alloc.batchId,
          alloc.qtyBase.toFixed(6),
          alloc.costPerBaseSnapshot.toFixed(6),
          alloc.cogsTotal.toFixed(2),
          item.line.manualBatchId ? 1 : 0,
          item.line.manualOverrideReason?.trim() || ''
        );

        const batchRow = tx.prepare('SELECT current_qty_base FROM batches WHERE id = ?').get(alloc.batchId) as {
          current_qty_base: string;
        };
        const nextQty = roundQty(qty(batchRow.current_qty_base).sub(alloc.qtyBase));
        if (nextQty.lt(0)) {
          throw new Error(`Concurrency check failed: negative stock prevented for batch ${alloc.batchNumber}`);
        }
        tx.prepare('UPDATE batches SET current_qty_base = ?, updated_at = ? WHERE id = ?').run(
          nextQty.toFixed(6),
          ts,
          alloc.batchId
        );

        insertMovement.run(
          uuid(),
          item.med.id,
          alloc.batchId,
          alloc.qtyBase.neg().toFixed(6),
          saleId,
          lineId,
          alloc.costPerBaseSnapshot.toFixed(6),
          item.line.manualBatchId ? `Manual override: ${item.line.manualOverrideReason}` : `FEFO Sale ${invoiceNumber}`,
          user.id,
          ts
        );
      }
    }

    let cashPaidTotal = new Decimal(0);
    for (const p of validPayments) {
      const amt = validateCurrencyInput(p.amount, 'Payment amount', { allowZero: false });
      const payId = uuid();
      const payNo = generateDocNumber(tx, 'PAY', 'payments', 'payment_number');
      tx.prepare(
        `INSERT INTO payments (
          id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at
        ) VALUES (?, ?, 'CUSTOMER', ?, 'IN', ?, ?, ?, ?, 'POSTED', ?, ?)`
      ).run(
        payId,
        payNo,
        customer?.id || '',
        p.method,
        amt.toFixed(2),
        (p.referenceNo || '').trim(),
        `Sale payment for ${invoiceNumber}`,
        user.id,
        ts
      );
      tx.prepare(
        `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated)
         VALUES (?, ?, 'SALE', ?, ?)`
      ).run(uuid(), payId, saleId, amt.toFixed(2));

      if (p.method === 'CASH') {
        cashPaidTotal = cashPaidTotal.add(amt);
      }
    }

    if (cashPaidTotal.gt(0)) {
      const cashSessionId = getActiveCashSessionId(tx);
      if (!cashSessionId) {
        throw new Error('Cannot complete a CASH sale without an OPEN cash session');
      }
      tx.prepare(
        `INSERT INTO cash_movements (
          id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
        ) VALUES (?, ?, 'CASH_SALE', ?, 'SALE', ?, ?, ?, ?)`
      ).run(
        uuid(),
        cashSessionId,
        roundMoney(cashPaidTotal).toFixed(2),
        saleId,
        `Cash received on ${invoiceNumber}`,
        user.id,
        ts
      );
    }

    if (customer && totals.dueAmount.gt(0)) {
      tx.prepare('UPDATE customers SET current_balance = ?, updated_at = ? WHERE id = ?').run(
        roundMoney(d(customer.current_balance).add(totals.dueAmount)).toFixed(2),
        ts,
        customer.id
      );
    }

    recordAudit(tx, {
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
        due: totals.dueAmount.toFixed(2),
        cashOnly: roundMoney(cashPaidTotal).toFixed(2),
        cogs: totalCogs.toFixed(2),
      },
    });

    return {
      saleId,
      invoiceNumber,
      netTotal: totals.netTotal.toFixed(2),
      paidAmount: totals.paidAmount.toFixed(2),
      dueAmount: totals.dueAmount.toFixed(2),
      totalCogs: totalCogs.toFixed(2),
    };
  });
}

export function createSalesReturn(
  user: AuthUser,
  input: {
    saleId: string;
    settlementType: 'CASH_REFUND' | 'MFS_REFUND' | 'CUSTOMER_CREDIT';
    reason: string;
    lines: Array<{
      saleLineId: string;
      qtyBase: string;
      disposition: 'RESTOCK_SELLABLE' | 'QUARANTINE' | 'DAMAGED' | 'WRITE_OFF' | 'NOT_RESTOCKABLE';
    }>;
  }
) {
  if (!input.reason?.trim()) throw new Error('Return reason is required');
  if (!input.lines || input.lines.length === 0) throw new Error('At least one return line is required');

  for (const rl of input.lines) {
    validateQuantityInput(rl.qtyBase ?? '0', 'Return quantity', { allowZero: true });
  }

  return withTransaction((tx) => {
    const sale = tx.prepare('SELECT * FROM sales WHERE id = ?').get(input.saleId) as
      | { id: string; invoice_number: string; customer_id: string | null; status: string; net_total: string; due_amount: string }
      | undefined;
    if (!sale || sale.status !== 'COMPLETED') throw new Error('Only COMPLETED sales can be returned');

    if (input.settlementType === 'CUSTOMER_CREDIT' && !sale.customer_id) {
      throw new Error('Customer credit settlement requires a linked customer on the original sale');
    }

    const ts = nowIso();
    const today = todayDate();
    const returnId = uuid();
    const returnNumber = generateDocNumber(tx, 'SRN', 'sales_returns', 'return_number');

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

      const sl = tx.prepare('SELECT * FROM sale_lines WHERE id = ? AND sale_id = ?').get(reqLine.saleLineId, sale.id) as
        | { id: string; medicine_id: string; qty_base: string; line_total: string }
        | undefined;
      if (!sl) throw new Error('Sale line not found on this invoice');

      const prevLines = tx
        .prepare('SELECT batch_id, qty_base FROM sales_return_lines WHERE sale_line_id = ?')
        .all(sl.id) as Array<{ batch_id: string; qty_base: string }>;

      let alreadyReturned = new Decimal(0);
      const prevPerBatch = new Map<string, Decimal>();
      for (const pr of prevLines) {
        const qPrev = qty(pr.qty_base);
        alreadyReturned = alreadyReturned.add(qPrev);
        prevPerBatch.set(pr.batch_id, (prevPerBatch.get(pr.batch_id) || new Decimal(0)).add(qPrev));
      }

      const maxReturnable = roundQty(d(sl.qty_base).sub(alreadyReturned));
      if (qRet.gt(maxReturnable)) {
        throw new Error(`Return quantity ${qRet.toFixed(6)} exceeds remaining returnable quantity ${maxReturnable.toFixed(6)}`);
      }

      const origAllocs = tx
        .prepare('SELECT batch_id, qty_base, cost_per_base_snapshot FROM sale_batch_allocations WHERE sale_line_id = ?')
        .all(sl.id) as Array<{ batch_id: string; qty_base: string; cost_per_base_snapshot: string }>;

      const remainingOrigAllocs = origAllocs
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

      const cogsSplits = computeReturnCogsReversal(remainingOrigAllocs, qRet);
      const effectivePricePerBase = d(sl.line_total).div(d(sl.qty_base));

      const splitWithRefund = cogsSplits.map((sp) => {
        const refundPart = roundMoney(sp.qtyBase.mul(effectivePricePerBase));
        totalRefundValue = totalRefundValue.add(refundPart);
        totalCogsReversed = totalCogsReversed.add(sp.cogsReversed);
        return { ...sp, refundPart };
      });

      preparedReturnLines.push({
        saleLineId: sl.id,
        medicineId: sl.medicine_id,
        disposition: reqLine.disposition,
        allocs: splitWithRefund,
      });
    }

    if (preparedReturnLines.length === 0) throw new Error('No positive return quantities submitted');
    totalRefundValue = roundMoney(totalRefundValue);
    totalCogsReversed = roundMoney(totalCogsReversed);

    const refundAmount = input.settlementType === 'CUSTOMER_CREDIT' ? new Decimal(0) : totalRefundValue;
    const creditAmount = input.settlementType === 'CUSTOMER_CREDIT' ? totalRefundValue : new Decimal(0);

    tx.prepare(
      `INSERT INTO sales_returns (
        id, return_number, sale_id, customer_id, return_date, total_refund_value,
        settlement_type, refund_amount, credit_amount, total_cogs_reversed, reason, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      returnId,
      returnNumber,
      sale.id,
      sale.customer_id,
      today,
      totalRefundValue.toFixed(2),
      input.settlementType,
      refundAmount.toFixed(2),
      creditAmount.toFixed(2),
      totalCogsReversed.toFixed(2),
      input.reason.trim(),
      user.id,
      ts
    );

    for (const rl of preparedReturnLines) {
      for (const sp of rl.allocs) {
        const srlId = uuid();
        tx.prepare(
          `INSERT INTO sales_return_lines (
            id, sales_return_id, sale_line_id, medicine_id, batch_id, qty_base,
            disposition, cost_per_base_snapshot, cogs_reversed, refund_line_total
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          srlId,
          returnId,
          rl.saleLineId,
          rl.medicineId,
          sp.batchId,
          sp.qtyBase.toFixed(6),
          rl.disposition,
          sp.costPerBaseSnapshot.toFixed(6),
          sp.cogsReversed.toFixed(2),
          sp.refundPart.toFixed(2)
        );

        const origBatch = tx.prepare('SELECT * FROM batches WHERE id = ?').get(sp.batchId) as {
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
        };

        if (rl.disposition === 'RESTOCK_SELLABLE') {
          if (origBatch.expiry_date <= today) {
            throw new Error(`Batch ${origBatch.batch_number} is expired (${origBatch.expiry_date}) and cannot be restocked as sellable`);
          }
          tx.prepare('UPDATE batches SET current_qty_base = ?, updated_at = ? WHERE id = ?').run(
            roundQty(qty(origBatch.current_qty_base).add(sp.qtyBase)).toFixed(6),
            ts,
            origBatch.id
          );
          tx.prepare(
            `INSERT INTO stock_movements (
              id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
              cost_per_base_snapshot, reason, created_by, created_at
            ) VALUES (?, ?, ?, ?, 'SALE_RETURN', 'SALES_RETURN', ?, ?, ?, ?, ?, ?)`
          ).run(
            uuid(),
            rl.medicineId,
            origBatch.id,
            sp.qtyBase.toFixed(6),
            returnId,
            srlId,
            sp.costPerBaseSnapshot.toFixed(6),
            `Restocked after inspection (${input.reason.trim()})`,
            user.id,
            ts
          );
        } else if (rl.disposition === 'QUARANTINE') {
          const qBatchNum = `${origBatch.batch_number}-QRN`;
          const existingQ = tx
            .prepare("SELECT id, current_qty_base FROM batches WHERE medicine_id = ? AND batch_number = ? AND status = 'QUARANTINED'")
            .get(rl.medicineId, qBatchNum) as { id: string; current_qty_base: string } | undefined;
          let targetBatchId: string;
          if (existingQ) {
            targetBatchId = existingQ.id;
            tx.prepare('UPDATE batches SET current_qty_base = ?, updated_at = ? WHERE id = ?').run(
              roundQty(qty(existingQ.current_qty_base).add(sp.qtyBase)).toFixed(6),
              ts,
              targetBatchId
            );
          } else {
            targetBatchId = uuid();
            tx.prepare(
              `INSERT INTO batches (
                id, medicine_id, batch_number, expiry_date, supplier_id, purchase_id, received_date,
                purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
                base_unit_name, status, notes, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUARANTINED', ?, ?, ?)`
            ).run(
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
              ts
            );
          }
          tx.prepare(
            `INSERT INTO stock_movements (
              id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
              cost_per_base_snapshot, reason, created_by, created_at
            ) VALUES (?, ?, ?, ?, 'SALE_RETURN', 'SALES_RETURN', ?, ?, ?, ?, ?, ?)`
          ).run(
            uuid(),
            rl.medicineId,
            targetBatchId,
            sp.qtyBase.toFixed(6),
            returnId,
            srlId,
            sp.costPerBaseSnapshot.toFixed(6),
            `Quarantined on return (${input.reason.trim()})`,
            user.id,
            ts
          );
        } else {
          tx.prepare(
            `INSERT INTO stock_movements (
              id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
              cost_per_base_snapshot, reason, created_by, created_at
            ) VALUES (?, ?, ?, '0.000000', 'DAMAGE_WRITEOFF', 'SALES_RETURN', ?, ?, ?, ?, ?, ?)`
          ).run(
            uuid(),
            rl.medicineId,
            origBatch.id,
            returnId,
            srlId,
            sp.costPerBaseSnapshot.toFixed(6),
            `Non-restockable return (${rl.disposition}): ${input.reason.trim()}`,
            user.id,
            ts
          );
        }
      }
    }

    if (input.settlementType === 'CASH_REFUND') {
      const cashSessionId = getActiveCashSessionId(tx);
      if (!cashSessionId) throw new Error('Cannot issue CASH refund without an OPEN cash session');
      tx.prepare(
        `INSERT INTO cash_movements (
          id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
        ) VALUES (?, ?, 'CASH_REFUND', ?, 'SALES_RETURN', ?, ?, ?, ?)`
      ).run(
        uuid(),
        cashSessionId,
        refundAmount.neg().toFixed(2),
        returnId,
        `Cash refund for ${returnNumber} (${sale.invoice_number})`,
        user.id,
        ts
      );
    } else if (input.settlementType === 'CUSTOMER_CREDIT' && sale.customer_id) {
      const cust = tx.prepare('SELECT current_balance FROM customers WHERE id = ?').get(sale.customer_id) as {
        current_balance: string;
      };
      tx.prepare('UPDATE customers SET current_balance = ?, updated_at = ? WHERE id = ?').run(
        roundMoney(d(cust.current_balance).sub(creditAmount)).toFixed(2),
        ts,
        sale.customer_id
      );
    }

    recordAudit(tx, {
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
        totalCogsReversed: totalCogsReversed.toFixed(2),
        settlementType: input.settlementType,
      },
      reason: input.reason.trim(),
    });

    return {
      returnId,
      returnNumber,
      totalRefundValue: totalRefundValue.toFixed(2),
      totalCogsReversed: totalCogsReversed.toFixed(2),
    };
  });
}

export function reverseSale(user: AuthUser, saleId: string, reason: string) {
  if (!reason?.trim()) throw new Error('Mandatory reason is required to reverse a sale');
  return withTransaction((tx) => {
    const sale = tx.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as
      | { id: string; invoice_number: string; customer_id: string | null; status: string; due_amount: string }
      | undefined;
    if (!sale) throw new Error('Sale not found');
    if (sale.status !== 'COMPLETED') throw new Error('Only COMPLETED sales can be reversed');

    const existingReturns = tx.prepare('SELECT COUNT(*) as cnt FROM sales_returns WHERE sale_id = ?').get(saleId) as { cnt: number };
    if (existingReturns.cnt > 0) {
      throw new Error('Cannot reverse a sale that already has partial/full sales returns');
    }

    const ts = nowIso();
    const lines = tx.prepare('SELECT * FROM sale_lines WHERE sale_id = ?').all(saleId) as Array<{
      id: string;
      medicine_id: string;
    }>;

    for (const l of lines) {
      const allocs = tx.prepare('SELECT * FROM sale_batch_allocations WHERE sale_line_id = ?').all(l.id) as Array<{
        batch_id: string;
        qty_base: string;
        cost_per_base_snapshot: string;
      }>;
      for (const a of allocs) {
        const batch = tx.prepare('SELECT current_qty_base FROM batches WHERE id = ?').get(a.batch_id) as { current_qty_base: string };
        tx.prepare('UPDATE batches SET current_qty_base = ?, updated_at = ? WHERE id = ?').run(
          roundQty(qty(batch.current_qty_base).add(qty(a.qty_base))).toFixed(6),
          ts,
          a.batch_id
        );
        tx.prepare(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
            cost_per_base_snapshot, reason, created_by, created_at
          ) VALUES (?, ?, ?, ?, 'SALE_REVERSAL', 'SALE_REVERSAL', ?, ?, ?, ?, ?, ?)`
        ).run(uuid(), l.medicine_id, a.batch_id, qty(a.qty_base).toFixed(6), saleId, l.id, a.cost_per_base_snapshot, reason.trim(), user.id, ts);
      }
    }

    if (sale.customer_id && money(sale.due_amount).gt(0)) {
      const cust = tx.prepare('SELECT current_balance FROM customers WHERE id = ?').get(sale.customer_id) as { current_balance: string };
      tx.prepare('UPDATE customers SET current_balance = ?, updated_at = ? WHERE id = ?').run(
        roundMoney(d(cust.current_balance).sub(d(sale.due_amount))).toFixed(2),
        ts,
        sale.customer_id
      );
    }

    const paidAllocs = tx
      .prepare(
        `SELECT p.id, p.method, p.amount FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id
         WHERE pa.target_type = 'SALE' AND pa.target_id = ? AND p.status = 'POSTED'`
      )
      .all(saleId) as Array<{ id: string; method: string; amount: string }>;

    for (const p of paidAllocs) {
      tx.prepare("UPDATE payments SET status = 'REVERSED', reversal_reason = ? WHERE id = ?").run(reason.trim(), p.id);
      if (p.method === 'CASH') {
        const cashSessionId = getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Open cash session required to reverse cash sale payment');
        tx.prepare(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES (?, ?, 'REVERSAL', ?, 'SALE_REVERSAL', ?, ?, ?, ?)`
        ).run(uuid(), cashSessionId, money(p.amount).neg().toFixed(2), saleId, `Reversal of ${sale.invoice_number}`, user.id, ts);
      }
    }

    tx.prepare(
      "UPDATE sales SET status = 'REVERSED', reversed_by = ?, reversed_at = ?, reversal_reason = ? WHERE id = ?"
    ).run(user.id, ts, reason.trim(), saleId);

    recordAudit(tx, {
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
  });
}
