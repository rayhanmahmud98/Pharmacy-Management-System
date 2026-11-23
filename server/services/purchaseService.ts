import Decimal from 'decimal.js';
import { generateDocNumber, getDb, nowIso, todayDate, uuid, withTransaction } from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import { computeInvoiceTotals, computeLineTotals, d, money, qty } from '../../src/shared/decimalMath.ts';
import { getActiveCashSessionId } from './financeService.ts';

export interface PurchaseLineInput {
  medicineId: string;
  unitId: string;
  batchNumber: string;
  expiryDate: string; // YYYY-MM-DD
  quantityInput: string;
  unitCost: string;
  sellingPricePerBase: string;
  lineDiscount?: string;
}

export function createPurchase(
  user: AuthUser,
  input: {
    supplierId: string;
    supplierInvoiceNo?: string;
    purchaseDate?: string;
    status: 'DRAFT' | 'RECEIVED';
    paidAmount?: string;
    paymentMethod?: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
    paymentReference?: string;
    notes?: string;
    lines: PurchaseLineInput[];
  }
) {
  if (!input.supplierId) throw new Error('Supplier is required');
  if (!input.lines || input.lines.length === 0) throw new Error('At least one purchase line is required');
  const today = todayDate();
  const pDate = input.purchaseDate || today;

  return withTransaction((tx) => {
    const supplier = tx.prepare('SELECT * FROM suppliers WHERE id = ? AND is_active = 1').get(input.supplierId) as
      | { id: string; name: string; current_balance: string }
      | undefined;
    if (!supplier) throw new Error('Active supplier not found');

    const purchaseId = uuid();
    const purchaseNumber = generateDocNumber(tx, 'PUR', 'purchases', 'purchase_number');
    const ts = nowIso();

    const computedLines = input.lines.map((line) => {
      if (!line.batchNumber?.trim()) throw new Error('Batch number is required for all purchase lines');
      if (!line.expiryDate || !/^\d{4}-\d{2}-\d{2}$/.test(line.expiryDate)) {
        throw new Error('Valid expiry date (YYYY-MM-DD) is required');
      }
      if (line.expiryDate <= today) {
        throw new Error(`Cannot purchase already expired batch ${line.batchNumber} (${line.expiryDate})`);
      }

      const med = tx.prepare('SELECT id, brand_name, base_unit_name FROM medicines WHERE id = ?').get(line.medicineId) as
        | { id: string; brand_name: string; base_unit_name: string }
        | undefined;
      if (!med) throw new Error('Medicine not found');

      const unit = tx
        .prepare('SELECT * FROM medicine_units WHERE id = ? AND medicine_id = ? AND is_active = 1')
        .get(line.unitId, line.medicineId) as
        | { id: string; unit_name: string; conversion_to_base: string; allow_purchase: number }
        | undefined;
      if (!unit) throw new Error(`Unit not found for ${med.brand_name}`);
      if (!unit.allow_purchase) throw new Error(`Unit '${unit.unit_name}' is disabled for purchasing on ${med.brand_name}`);

      const calc = computeLineTotals({
        quantityInput: line.quantityInput,
        conversionRatio: unit.conversion_to_base,
        unitPriceOrCost: line.unitCost,
        discountAmount: line.lineDiscount || '0',
      });
      const sellPrice = money(line.sellingPricePerBase);
      if (sellPrice.lte(0)) throw new Error(`Selling price per base unit must be positive for ${med.brand_name}`);

      return {
        ...line,
        med,
        unit,
        calc,
        sellPrice,
        costPerBase: d(calc.netTotal).div(calc.quantityBase).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
      };
    });

    const totals = computeInvoiceTotals({
      lines: computedLines.map((l) => ({
        grossTotal: l.calc.grossTotal,
        discount: l.calc.discount,
        netTotal: l.calc.netTotal,
      })),
      invoiceDiscount: '0',
      paidAmount: input.status === 'RECEIVED' ? input.paidAmount || '0' : '0',
    });

    tx.prepare(
      `INSERT INTO purchases (
        id, purchase_number, supplier_id, supplier_invoice_no, purchase_date, status,
        gross_subtotal, discount_total, net_total, paid_amount, due_amount, notes,
        created_by, received_by, received_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      purchaseId,
      purchaseNumber,
      supplier.id,
      (input.supplierInvoiceNo || '').trim(),
      pDate,
      input.status,
      totals.grossSubtotal.toFixed(2),
      totals.lineDiscountTotal.toFixed(2),
      totals.netTotal.toFixed(2),
      totals.paidAmount.toFixed(2),
      totals.dueAmount.toFixed(2),
      (input.notes || '').trim(),
      user.id,
      input.status === 'RECEIVED' ? user.id : null,
      input.status === 'RECEIVED' ? ts : null,
      ts,
      ts
    );

    const insertPL = tx.prepare(
      `INSERT INTO purchase_lines (
        id, purchase_id, medicine_id, batch_id, batch_number, expiry_date,
        unit_id, unit_name_snapshot, conversion_ratio_snapshot, qty_input, qty_base,
        unit_cost, selling_price_per_base, line_discount, line_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const l of computedLines) {
      const plId = uuid();
      let batchId: string | null = null;

      if (input.status === 'RECEIVED') {
        const existingBatch = tx
          .prepare('SELECT * FROM batches WHERE medicine_id = ? AND batch_number = ? AND expiry_date = ?')
          .get(l.med.id, l.batchNumber.trim(), l.expiryDate) as
          | { id: string; current_qty_base: string; initial_qty_base: string }
          | undefined;

        if (existingBatch) {
          batchId = existingBatch.id;
          const newCur = qty(existingBatch.current_qty_base).add(l.calc.quantityBase).toFixed(4);
          const newInit = qty(existingBatch.initial_qty_base).add(l.calc.quantityBase).toFixed(4);
          tx.prepare(
            `UPDATE batches SET current_qty_base = ?, initial_qty_base = ?, purchase_cost_per_base = ?, selling_price_per_base = ?, updated_at = ? WHERE id = ?`
          ).run(newCur, newInit, l.costPerBase.toFixed(4), l.sellPrice.toFixed(2), ts, batchId);
        } else {
          batchId = uuid();
          tx.prepare(
            `INSERT INTO batches (
              id, medicine_id, batch_number, expiry_date, supplier_id, purchase_id, received_date,
              purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
              base_unit_name, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
          ).run(
            batchId,
            l.med.id,
            l.batchNumber.trim(),
            l.expiryDate,
            supplier.id,
            purchaseId,
            pDate,
            l.costPerBase.toFixed(4),
            l.sellPrice.toFixed(2),
            l.calc.quantityBase.toFixed(4),
            l.calc.quantityBase.toFixed(4),
            l.med.base_unit_name,
            ts,
            ts
          );
        }

        tx.prepare(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type,
            reference_type, reference_id, reference_line_id, cost_per_base_snapshot,
            reason, created_by, created_at
          ) VALUES (?, ?, ?, ?, 'PURCHASE_RECEIVED', 'PURCHASE', ?, ?, ?, ?, ?, ?)`
        ).run(
          uuid(),
          l.med.id,
          batchId,
          l.calc.quantityBase.toFixed(4),
          purchaseId,
          plId,
          l.costPerBase.toFixed(4),
          `Purchase ${purchaseNumber}`,
          user.id,
          ts
        );
      }

      insertPL.run(
        plId,
        purchaseId,
        l.med.id,
        batchId,
        l.batchNumber.trim(),
        l.expiryDate,
        l.unit.id,
        l.unit.unit_name,
        d(l.unit.conversion_to_base).toFixed(4),
        qty(l.quantityInput).toFixed(4),
        l.calc.quantityBase.toFixed(4),
        money(l.unitCost).toFixed(2),
        l.sellPrice.toFixed(2),
        l.calc.discount.toFixed(2),
        l.calc.netTotal.toFixed(2)
      );
    }

    if (input.status === 'RECEIVED') {
      // Increase supplier payable by dueAmount
      if (totals.dueAmount.gt(0)) {
        const nextBal = money(d(supplier.current_balance).add(totals.dueAmount)).toFixed(2);
        tx.prepare('UPDATE suppliers SET current_balance = ?, updated_at = ? WHERE id = ?').run(
          nextBal,
          ts,
          supplier.id
        );
      }

      if (totals.paidAmount.gt(0)) {
        const method = input.paymentMethod || 'CASH';
        const payId = uuid();
        const payNo = generateDocNumber(tx, 'PAY', 'payments', 'payment_number');
        tx.prepare(
          `INSERT INTO payments (
            id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at
          ) VALUES (?, ?, 'SUPPLIER', ?, 'OUT', ?, ?, ?, ?, 'POSTED', ?, ?)`
        ).run(
          payId,
          payNo,
          supplier.id,
          method,
          totals.paidAmount.toFixed(2),
          (input.paymentReference || '').trim(),
          `Payment on ${purchaseNumber}`,
          user.id,
          ts
        );
        tx.prepare(
          `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated)
           VALUES (?, ?, 'PURCHASE', ?, ?)`
        ).run(uuid(), payId, purchaseId, totals.paidAmount.toFixed(2));

        if (method === 'CASH') {
          const cashSessionId = getActiveCashSessionId(tx);
          if (!cashSessionId) {
            throw new Error('Cannot pay supplier in CASH without an OPEN cash session');
          }
          tx.prepare(
            `INSERT INTO cash_movements (
              id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
            ) VALUES (?, ?, 'SUPPLIER_CASH_PAYMENT', ?, 'PURCHASE', ?, ?, ?, ?)`
          ).run(
            uuid(),
            cashSessionId,
            totals.paidAmount.neg().toFixed(2),
            purchaseId,
            `Cash paid for ${purchaseNumber}`,
            user.id,
            ts
          );
        }
      }
    }

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: input.status === 'RECEIVED' ? 'RECEIVE_PURCHASE' : 'CREATE_PURCHASE_DRAFT',
      module: 'purchases',
      targetType: 'PURCHASE',
      targetId: purchaseId,
      transactionRef: purchaseNumber,
      afterState: { status: input.status, netTotal: totals.netTotal.toFixed(2), paid: totals.paidAmount.toFixed(2) },
    });

    return { purchaseId, purchaseNumber };
  });
}

export function receiveDraftPurchase(
  user: AuthUser,
  purchaseId: string,
  paidAmountStr = '0',
  paymentMethod: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER' = 'CASH'
) {
  return withTransaction((tx) => {
    const pur = tx.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as
      | { id: string; purchase_number: string; supplier_id: string; status: string; net_total: string; purchase_date: string }
      | undefined;
    if (!pur) throw new Error('Purchase not found');
    if (pur.status !== 'DRAFT') throw new Error('Only DRAFT purchases can be received');

    const supplier = tx.prepare('SELECT * FROM suppliers WHERE id = ?').get(pur.supplier_id) as {
      id: string;
      current_balance: string;
    };
    const lines = tx.prepare('SELECT * FROM purchase_lines WHERE purchase_id = ?').all(purchaseId) as Array<{
      id: string;
      medicine_id: string;
      batch_number: string;
      expiry_date: string;
      qty_base: string;
      line_total: string;
      selling_price_per_base: string;
    }>;

    const today = todayDate();
    const ts = nowIso();
    const netTotal = money(pur.net_total);
    const paid = money(paidAmountStr || '0');
    if (paid.lt(0) || paid.gt(netTotal)) throw new Error('Invalid paid amount');
    const due = money(netTotal.sub(paid));

    for (const l of lines) {
      if (l.expiry_date <= today) throw new Error(`Batch ${l.batch_number} is already expired (${l.expiry_date})`);
      const med = tx.prepare('SELECT base_unit_name FROM medicines WHERE id = ?').get(l.medicine_id) as {
        base_unit_name: string;
      };
      const costPerBase = d(l.line_total).div(d(l.qty_base)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const existingBatch = tx
        .prepare('SELECT * FROM batches WHERE medicine_id = ? AND batch_number = ? AND expiry_date = ?')
        .get(l.medicine_id, l.batch_number, l.expiry_date) as
        | { id: string; current_qty_base: string; initial_qty_base: string }
        | undefined;

      let batchId: string;
      if (existingBatch) {
        batchId = existingBatch.id;
        tx.prepare(
          'UPDATE batches SET current_qty_base = ?, initial_qty_base = ?, purchase_cost_per_base = ?, selling_price_per_base = ?, updated_at = ? WHERE id = ?'
        ).run(
          qty(existingBatch.current_qty_base).add(qty(l.qty_base)).toFixed(4),
          qty(existingBatch.initial_qty_base).add(qty(l.qty_base)).toFixed(4),
          costPerBase.toFixed(4),
          l.selling_price_per_base,
          ts,
          batchId
        );
      } else {
        batchId = uuid();
        tx.prepare(
          `INSERT INTO batches (
            id, medicine_id, batch_number, expiry_date, supplier_id, purchase_id, received_date,
            purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
            base_unit_name, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
        ).run(
          batchId,
          l.medicine_id,
          l.batch_number,
          l.expiry_date,
          pur.supplier_id,
          purchaseId,
          pur.purchase_date,
          costPerBase.toFixed(4),
          l.selling_price_per_base,
          l.qty_base,
          l.qty_base,
          med.base_unit_name,
          ts,
          ts
        );
      }

      tx.prepare('UPDATE purchase_lines SET batch_id = ? WHERE id = ?').run(batchId, l.id);
      tx.prepare(
        `INSERT INTO stock_movements (
          id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
          cost_per_base_snapshot, reason, created_by, created_at
        ) VALUES (?, ?, ?, ?, 'PURCHASE_RECEIVED', 'PURCHASE', ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), l.medicine_id, batchId, l.qty_base, purchaseId, l.id, costPerBase.toFixed(4), `Received ${pur.purchase_number}`, user.id, ts);
    }

    tx.prepare(
      `UPDATE purchases SET status = 'RECEIVED', paid_amount = ?, due_amount = ?, received_by = ?, received_at = ?, updated_at = ? WHERE id = ?`
    ).run(paid.toFixed(2), due.toFixed(2), user.id, ts, ts, purchaseId);

    if (due.gt(0)) {
      tx.prepare('UPDATE suppliers SET current_balance = ?, updated_at = ? WHERE id = ?').run(
        money(d(supplier.current_balance).add(due)).toFixed(2),
        ts,
        supplier.id
      );
    }

    if (paid.gt(0)) {
      const payId = uuid();
      const payNo = generateDocNumber(tx, 'PAY', 'payments', 'payment_number');
      tx.prepare(
        `INSERT INTO payments (id, payment_number, party_type, party_id, direction, method, amount, notes, status, created_by, created_at)
         VALUES (?, ?, 'SUPPLIER', ?, 'OUT', ?, ?, ?, 'POSTED', ?, ?)`
      ).run(payId, payNo, supplier.id, paymentMethod, paid.toFixed(2), `Payment on ${pur.purchase_number}`, user.id, ts);
      tx.prepare(
        `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES (?, ?, 'PURCHASE', ?, ?)`
      ).run(uuid(), payId, purchaseId, paid.toFixed(2));
      if (paymentMethod === 'CASH') {
        const cashSessionId = getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Cannot pay cash without an OPEN cash session');
        tx.prepare(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES (?, ?, 'SUPPLIER_CASH_PAYMENT', ?, 'PURCHASE', ?, ?, ?, ?)`
        ).run(uuid(), cashSessionId, paid.neg().toFixed(2), purchaseId, `Cash paid for ${pur.purchase_number}`, user.id, ts);
      }
    }

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'RECEIVE_PURCHASE',
      module: 'purchases',
      targetType: 'PURCHASE',
      targetId: purchaseId,
      transactionRef: pur.purchase_number,
      beforeState: { status: 'DRAFT' },
      afterState: { status: 'RECEIVED', paid: paid.toFixed(2), due: due.toFixed(2) },
    });
  });
}

export function cancelDraftPurchase(user: AuthUser, purchaseId: string, reason: string) {
  return withTransaction((tx) => {
    const pur = tx.prepare('SELECT id, purchase_number, status FROM purchases WHERE id = ?').get(purchaseId) as
      | { id: string; purchase_number: string; status: string }
      | undefined;
    if (!pur) throw new Error('Purchase not found');
    if (pur.status !== 'DRAFT') throw new Error('Only DRAFT purchases can be cancelled; use Reversal for RECEIVED purchases');
    tx.prepare("UPDATE purchases SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(nowIso(), purchaseId);
    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'CANCEL_PURCHASE_DRAFT',
      module: 'purchases',
      targetType: 'PURCHASE',
      targetId: purchaseId,
      transactionRef: pur.purchase_number,
      beforeState: { status: 'DRAFT' },
      afterState: { status: 'CANCELLED' },
      reason,
    });
  });
}

export function createPurchaseReturn(
  user: AuthUser,
  input: {
    purchaseId: string;
    settlementType: 'SUPPLIER_CREDIT' | 'CASH_REFUND' | 'BANK_REFUND';
    reason: string;
    lines: Array<{ purchaseLineId: string; qtyBase: string }>;
  }
) {
  if (!input.reason?.trim()) throw new Error('Return reason is required');
  if (!input.lines?.length) throw new Error('At least one return line is required');

  return withTransaction((tx) => {
    const pur = tx.prepare('SELECT * FROM purchases WHERE id = ?').get(input.purchaseId) as
      | { id: string; purchase_number: string; supplier_id: string; status: string }
      | undefined;
    if (!pur || pur.status !== 'RECEIVED') throw new Error('Purchase must be RECEIVED to process a return');

    const supplier = tx.prepare('SELECT * FROM suppliers WHERE id = ?').get(pur.supplier_id) as {
      id: string;
      current_balance: string;
    };

    const ts = nowIso();
    const today = todayDate();
    const retId = uuid();
    const retNo = generateDocNumber(tx, 'PRN', 'purchase_returns', 'return_number');

    let totalReturn = new Decimal(0);
    const lineRecords: Array<{
      plId: string;
      batchId: string;
      medId: string;
      qtyBase: Decimal;
      costPerBase: Decimal;
      lineTotal: Decimal;
    }> = [];

    for (const item of input.lines) {
      const qRet = qty(item.qtyBase);
      if (qRet.lte(0)) continue;
      const pl = tx.prepare('SELECT * FROM purchase_lines WHERE id = ? AND purchase_id = ?').get(item.purchaseLineId, pur.id) as
        | { id: string; batch_id: string; medicine_id: string; qty_base: string; line_total: string }
        | undefined;
      if (!pl || !pl.batch_id) throw new Error('Purchase line or batch not found');

      const batch = tx.prepare('SELECT * FROM batches WHERE id = ?').get(pl.batch_id) as {
        id: string;
        batch_number: string;
        current_qty_base: string;
        purchase_cost_per_base: string;
      };
      if (qty(batch.current_qty_base).lt(qRet)) {
        throw new Error(`Cannot return ${qRet.toFixed(2)} from batch ${batch.batch_number}; only ${batch.current_qty_base} left in stock`);
      }

      const costPerBase = d(pl.line_total).div(d(pl.qty_base)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const lineTotal = money(qRet.mul(costPerBase));
      totalReturn = totalReturn.add(lineTotal);
      lineRecords.push({
        plId: pl.id,
        batchId: batch.id,
        medId: pl.medicine_id,
        qtyBase: qRet,
        costPerBase,
        lineTotal,
      });
    }

    if (lineRecords.length === 0) throw new Error('No valid positive return quantities provided');
    totalReturn = money(totalReturn);

    const refundAmount = input.settlementType === 'SUPPLIER_CREDIT' ? new Decimal(0) : totalReturn;
    const creditAmount = input.settlementType === 'SUPPLIER_CREDIT' ? totalReturn : new Decimal(0);

    tx.prepare(
      `INSERT INTO purchase_returns (
        id, return_number, purchase_id, supplier_id, return_date, total_amount,
        settlement_type, refund_amount, credit_amount, reason, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      retId,
      retNo,
      pur.id,
      pur.supplier_id,
      today,
      totalReturn.toFixed(2),
      input.settlementType,
      refundAmount.toFixed(2),
      creditAmount.toFixed(2),
      input.reason.trim(),
      user.id,
      ts
    );

    for (const lr of lineRecords) {
      const prlId = uuid();
      tx.prepare(
        `INSERT INTO purchase_return_lines (id, purchase_return_id, purchase_line_id, batch_id, medicine_id, qty_base, cost_per_base_snapshot, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(prlId, retId, lr.plId, lr.batchId, lr.medId, lr.qtyBase.toFixed(4), lr.costPerBase.toFixed(4), lr.lineTotal.toFixed(2));

      const batch = tx.prepare('SELECT current_qty_base FROM batches WHERE id = ?').get(lr.batchId) as { current_qty_base: string };
      tx.prepare('UPDATE batches SET current_qty_base = ?, updated_at = ? WHERE id = ?').run(
        qty(batch.current_qty_base).sub(lr.qtyBase).toFixed(4),
        ts,
        lr.batchId
      );
      tx.prepare(
        `INSERT INTO stock_movements (
          id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
          cost_per_base_snapshot, reason, created_by, created_at
        ) VALUES (?, ?, ?, ?, 'PURCHASE_RETURN', 'PURCHASE_RETURN', ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), lr.medId, lr.batchId, lr.qtyBase.neg().toFixed(4), retId, prlId, lr.costPerBase.toFixed(4), input.reason.trim(), user.id, ts);
    }

    if (creditAmount.gt(0)) {
      tx.prepare('UPDATE suppliers SET current_balance = ?, updated_at = ? WHERE id = ?').run(
        money(d(supplier.current_balance).sub(creditAmount)).toFixed(2),
        ts,
        supplier.id
      );
    } else if (input.settlementType === 'CASH_REFUND') {
      const cashSessionId = getActiveCashSessionId(tx);
      if (!cashSessionId) throw new Error('Cannot receive cash refund without an OPEN cash session');
      tx.prepare(
        `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
         VALUES (?, ?, 'CASH_REFUND', ?, 'PURCHASE_RETURN', ?, ?, ?, ?)`
      ).run(uuid(), cashSessionId, refundAmount.toFixed(2), retId, `Cash refund from supplier on ${retNo}`, user.id, ts);
    }

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'PURCHASE_RETURN',
      module: 'purchases',
      targetType: 'PURCHASE_RETURN',
      targetId: retId,
      transactionRef: retNo,
      afterState: { purchaseNumber: pur.purchase_number, totalReturn: totalReturn.toFixed(2), settlementType: input.settlementType },
      reason: input.reason.trim(),
    });

    return { returnNumber: retNo, totalAmount: totalReturn.toFixed(2) };
  });
}

export function reversePurchase(user: AuthUser, purchaseId: string, reason: string) {
  if (!reason?.trim()) throw new Error('Mandatory reason is required for purchase reversal');
  return withTransaction((tx) => {
    const pur = tx.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as
      | { id: string; purchase_number: string; supplier_id: string; status: string; due_amount: string; paid_amount: string }
      | undefined;
    if (!pur) throw new Error('Purchase not found');
    if (pur.status !== 'RECEIVED') throw new Error('Only RECEIVED purchases can be reversed');

    const lines = tx.prepare('SELECT * FROM purchase_lines WHERE purchase_id = ?').all(purchaseId) as Array<{
      id: string;
      batch_id: string;
      medicine_id: string;
      qty_base: string;
      line_total: string;
    }>;

    const ts = nowIso();
    for (const l of lines) {
      const batch = tx.prepare('SELECT current_qty_base, batch_number FROM batches WHERE id = ?').get(l.batch_id) as {
        current_qty_base: string;
        batch_number: string;
      };
      if (qty(batch.current_qty_base).lt(qty(l.qty_base))) {
        throw new Error(`Cannot reverse purchase: stock from batch ${batch.batch_number} has already been sold or adjusted`);
      }
      const costPerBase = d(l.line_total).div(d(l.qty_base)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      tx.prepare('UPDATE batches SET current_qty_base = ?, updated_at = ? WHERE id = ?').run(
        qty(batch.current_qty_base).sub(qty(l.qty_base)).toFixed(4),
        ts,
        l.batch_id
      );
      tx.prepare(
        `INSERT INTO stock_movements (
          id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
          cost_per_base_snapshot, reason, created_by, created_at
        ) VALUES (?, ?, ?, ?, 'PURCHASE_REVERSAL', 'PURCHASE_REVERSAL', ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), l.medicine_id, l.batch_id, qty(l.qty_base).neg().toFixed(4), purchaseId, l.id, costPerBase.toFixed(4), reason.trim(), user.id, ts);
    }

    // Reverse supplier balance due
    if (money(pur.due_amount).gt(0)) {
      const sup = tx.prepare('SELECT current_balance FROM suppliers WHERE id = ?').get(pur.supplier_id) as { current_balance: string };
      tx.prepare('UPDATE suppliers SET current_balance = ?, updated_at = ? WHERE id = ?').run(
        money(d(sup.current_balance).sub(d(pur.due_amount))).toFixed(2),
        ts,
        pur.supplier_id
      );
    }

    // Reverse cash payments if any
    const allocs = tx
      .prepare(
        `SELECT p.id, p.method, p.amount FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id
         WHERE pa.target_type = 'PURCHASE' AND pa.target_id = ? AND p.status = 'POSTED'`
      )
      .all(purchaseId) as Array<{ id: string; method: string; amount: string }>;

    for (const p of allocs) {
      tx.prepare("UPDATE payments SET status = 'REVERSED', reversal_reason = ? WHERE id = ?").run(reason.trim(), p.id);
      if (p.method === 'CASH') {
        const cashSessionId = getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Open cash session required to reverse cash purchase payment');
        tx.prepare(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES (?, ?, 'REVERSAL', ?, 'PURCHASE_REVERSAL', ?, ?, ?, ?)`
        ).run(uuid(), cashSessionId, money(p.amount).toFixed(2), purchaseId, `Reversal of ${pur.purchase_number}`, user.id, ts);
      }
    }

    tx.prepare(
      "UPDATE purchases SET status = 'REVERSED', reversed_by = ?, reversed_at = ?, reversal_reason = ?, updated_at = ? WHERE id = ?"
    ).run(user.id, ts, reason.trim(), ts, purchaseId);

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'REVERSE_PURCHASE',
      module: 'purchases',
      targetType: 'PURCHASE',
      targetId: purchaseId,
      transactionRef: pur.purchase_number,
      beforeState: { status: 'RECEIVED' },
      afterState: { status: 'REVERSED' },
      reason: reason.trim(),
    });
  });
}
