import Decimal from 'decimal.js';
import { generateDocNumber, nowIso, todayDate, uuid, withTransaction, type DbExecutor } from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import {
  computeInvoiceTotals,
  computeLineTotals,
  computeWeightedAverageCost,
  d,
  money,
  qty,
  roundCost6,
  roundMoney,
  roundQty,
  validateCurrencyInput,
  validateQuantityInput,
} from '../../src/shared/decimalMath.ts';
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

export async function createPurchase(
  user: AuthUser,
  input: {
    supplierId: string;
    supplierInvoiceNo?: string;
    purchaseDate?: string;
    status: 'DRAFT' | 'RECEIVED';
    paidAmount?: string;
    applyAdvance?: boolean;
    paymentMethod?: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
    paymentReference?: string;
    notes?: string;
    lines: PurchaseLineInput[];
  },
  existingTx?: DbExecutor
) {
  if (!input.supplierId) throw new Error('Supplier is required');
  if (!input.lines || input.lines.length === 0) throw new Error('At least one purchase line is required');
  const today = todayDate();
  const pDate = input.purchaseDate || today;

  if (input.status === 'RECEIVED' && input.paidAmount !== undefined) {
    validateCurrencyInput(input.paidAmount, 'Paid amount', { allowZero: true });
  }

  return withTransaction(async (tx) => {
    const supplier = await tx.queryOne<{
      id: string;
      name: string;
      current_balance: string;
      advance_balance: string;
    }>('SELECT id, name, current_balance, advance_balance FROM suppliers WHERE id = $1 AND is_active = TRUE FOR UPDATE', [
      input.supplierId,
    ]);
    if (!supplier) throw new Error('Active supplier not found');

    const purchaseId = uuid();
    const purchaseNumber = await generateDocNumber(tx, 'PUR', 'purchases', 'purchase_number');
    const ts = nowIso();

    const computedLines = [];
    for (const line of input.lines) {
      if (!line.batchNumber?.trim()) throw new Error('Batch number is required for all purchase lines');
      if (!line.expiryDate || !/^\d{4}-\d{2}-\d{2}$/.test(line.expiryDate)) {
        throw new Error('Valid expiry date (YYYY-MM-DD) is required');
      }
      if (line.expiryDate <= today) {
        throw new Error(`Cannot purchase already expired batch ${line.batchNumber} (${line.expiryDate})`);
      }

      const med = await tx.queryOne<{ id: string; brand_name: string; base_unit_name: string }>(
        'SELECT id, brand_name, base_unit_name FROM medicines WHERE id = $1',
        [line.medicineId]
      );
      if (!med) throw new Error('Medicine not found');

      const unit = await tx.queryOne<{
        id: string;
        unit_name: string;
        conversion_to_base: string;
        allow_purchase: boolean;
      }>('SELECT id, unit_name, conversion_to_base, allow_purchase FROM medicine_units WHERE id = $1 AND medicine_id = $2 AND is_active = TRUE', [
        line.unitId,
        line.medicineId,
      ]);
      if (!unit) throw new Error(`Unit not found for ${med.brand_name}`);
      if (!unit.allow_purchase) throw new Error(`Unit '${unit.unit_name}' is disabled for purchasing on ${med.brand_name}`);

      const calc = computeLineTotals({
        quantityInput: line.quantityInput,
        conversionRatio: unit.conversion_to_base,
        unitPriceOrCost: line.unitCost,
        discountAmount: line.lineDiscount || '0',
      });
      const sellPrice = validateCurrencyInput(line.sellingPricePerBase, `Selling price for ${med.brand_name}`, {
        allowZero: false,
      });

      computedLines.push({
        ...line,
        med,
        unit,
        calc,
        sellPrice,
        costPerBase: roundCost6(d(calc.netTotal).div(calc.quantityBase)),
      });
    }

    const totals = computeInvoiceTotals({
      lines: computedLines.map((l) => ({
        grossTotal: l.calc.grossTotal,
        discount: l.calc.discount,
        netTotal: l.calc.netTotal,
      })),
      invoiceDiscount: '0',
      paidAmount: input.status === 'RECEIVED' ? input.paidAmount || '0' : '0',
    });

    let advanceApplied = new Decimal(0);
    let finalDueAmount = totals.dueAmount;
    if (input.status === 'RECEIVED' && input.applyAdvance !== false && totals.dueAmount.gt(0)) {
      const supAdv = money(supplier.advance_balance || '0.00');
      if (supAdv.gt(0)) {
        advanceApplied = Decimal.min(supAdv, totals.dueAmount);
        finalDueAmount = roundMoney(totals.dueAmount.sub(advanceApplied));
      }
    }

    await tx.execute(
      `INSERT INTO purchases (
        id, purchase_number, supplier_id, supplier_invoice_no, purchase_date, status,
        gross_subtotal, discount_total, net_total, paid_amount, due_amount, advance_applied, notes,
        created_by, received_by, received_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
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
        finalDueAmount.toFixed(2),
        advanceApplied.toFixed(2),
        (input.notes || '').trim(),
        user.id,
        input.status === 'RECEIVED' ? user.id : null,
        input.status === 'RECEIVED' ? ts : null,
        ts,
        ts,
      ]
    );

    for (const l of computedLines) {
      const plId = uuid();
      let batchId: string | null = null;

      if (input.status === 'RECEIVED') {
        await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `batch:${l.med.id}:${l.batchNumber.trim()}:${l.expiryDate}`,
        ]);
        const existingBatch = await tx.queryOne<{
          id: string;
          status: string;
          current_qty_base: string;
          initial_qty_base: string;
          purchase_cost_per_base: string;
        }>(
          'SELECT id, status, current_qty_base, initial_qty_base, purchase_cost_per_base FROM batches WHERE medicine_id = $1 AND batch_number = $2 AND expiry_date = $3 FOR UPDATE',
          [l.med.id, l.batchNumber.trim(), l.expiryDate]
        );

        if (existingBatch) {
          if (['QUARANTINED', 'WRITTEN_OFF', 'DAMAGED', 'EXPIRED'].includes(existingBatch.status)) {
            throw new Error(
              `Cannot receive stock into batch ${l.batchNumber.trim()} because its status is ${existingBatch.status}`
            );
          }
          batchId = existingBatch.id;
          const wac = computeWeightedAverageCost(
            existingBatch.current_qty_base,
            existingBatch.purchase_cost_per_base,
            l.calc.quantityBase,
            l.costPerBase
          );
          const newCur = roundQty(qty(existingBatch.current_qty_base).add(l.calc.quantityBase)).toFixed(6);
          const newInit = roundQty(qty(existingBatch.initial_qty_base).add(l.calc.quantityBase)).toFixed(6);
          await tx.execute(
            `UPDATE batches SET current_qty_base = $1, initial_qty_base = $2, purchase_cost_per_base = $3, selling_price_per_base = $4, status = 'ACTIVE', updated_at = $5 WHERE id = $6`,
            [newCur, newInit, wac.toFixed(6), l.sellPrice.toFixed(2), ts, batchId]
          );
        } else {
          batchId = uuid();
          await tx.execute(
            `INSERT INTO batches (
              id, medicine_id, batch_number, expiry_date, supplier_id, purchase_id, received_date,
              purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
              base_unit_name, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE', $13, $14)`,
            [
              batchId,
              l.med.id,
              l.batchNumber.trim(),
              l.expiryDate,
              supplier.id,
              purchaseId,
              pDate,
              l.costPerBase.toFixed(6),
              l.sellPrice.toFixed(2),
              l.calc.quantityBase.toFixed(6),
              l.calc.quantityBase.toFixed(6),
              l.med.base_unit_name,
              ts,
              ts,
            ]
          );
        }

        await tx.execute(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type,
            reference_type, reference_id, reference_line_id, cost_per_base_snapshot,
            reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, 'PURCHASE_RECEIVED', 'PURCHASE', $5, $6, $7, $8, $9, $10)`,
          [
            uuid(),
            l.med.id,
            batchId,
            l.calc.quantityBase.toFixed(6),
            purchaseId,
            plId,
            l.costPerBase.toFixed(6),
            `Purchase ${purchaseNumber}`,
            user.id,
            ts,
          ]
        );
      }

      await tx.execute(
        `INSERT INTO purchase_lines (
          id, purchase_id, medicine_id, batch_id, batch_number, expiry_date,
          unit_id, unit_name_snapshot, conversion_ratio_snapshot, qty_input, qty_base,
          unit_cost, selling_price_per_base, line_discount, line_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          plId,
          purchaseId,
          l.med.id,
          batchId,
          l.batchNumber.trim(),
          l.expiryDate,
          l.unit.id,
          l.unit.unit_name,
          d(l.unit.conversion_to_base).toFixed(6),
          validateQuantityInput(l.quantityInput, 'Quantity').toFixed(6),
          l.calc.quantityBase.toFixed(6),
          validateCurrencyInput(l.unitCost, 'Unit cost').toFixed(2),
          l.sellPrice.toFixed(2),
          l.calc.discount.toFixed(2),
          l.calc.netTotal.toFixed(2),
        ]
      );
    }

    if (input.status === 'RECEIVED') {
      if (advanceApplied.gt(0)) {
        const nextAdv = roundMoney(money(supplier.advance_balance || '0.00').sub(advanceApplied));
        await tx.execute('UPDATE suppliers SET advance_balance = $1, updated_at = $2 WHERE id = $3', [
          nextAdv.toFixed(2),
          ts,
          supplier.id,
        ]);
        await tx.execute(
          `INSERT INTO party_advance_ledger (id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at)
           VALUES ($1, 'SUPPLIER', $2, 'APPLIED_TO_INVOICE', 'PURCHASE', $3, $4, $5, $6, $7)`,
          [uuid(), supplier.id, purchaseId, advanceApplied.neg().toFixed(2), `Advance applied to ${purchaseNumber}`, user.id, ts]
        );
      }

      if (finalDueAmount.gt(0)) {
        const nextBal = roundMoney(d(supplier.current_balance).add(finalDueAmount)).toFixed(2);
        await tx.execute('UPDATE suppliers SET current_balance = $1, updated_at = $2 WHERE id = $3', [
          nextBal,
          ts,
          supplier.id,
        ]);
      }

      if (totals.paidAmount.gt(0)) {
        const method = input.paymentMethod || 'CASH';
        const payId = uuid();
        const payNo = await generateDocNumber(tx, 'PAY', 'payments', 'payment_number');
        await tx.execute(
          `INSERT INTO payments (
            id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at
          ) VALUES ($1, $2, 'SUPPLIER', $3, 'OUT', $4, $5, $6, $7, 'POSTED', $8, $9)`,
          [
            payId,
            payNo,
            supplier.id,
            method,
            totals.paidAmount.toFixed(2),
            (input.paymentReference || '').trim(),
            `Payment on ${purchaseNumber}`,
            user.id,
            ts,
          ]
        );
        await tx.execute(
          `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated)
           VALUES ($1, $2, 'PURCHASE', $3, $4)`,
          [uuid(), payId, purchaseId, totals.paidAmount.toFixed(2)]
        );

        if (method === 'CASH') {
          const cashSessionId = await getActiveCashSessionId(tx);
          if (!cashSessionId) {
            throw new Error('Cannot pay supplier in CASH without an OPEN cash session');
          }
          await tx.execute(
            `INSERT INTO cash_movements (
              id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
            ) VALUES ($1, $2, 'SUPPLIER_CASH_PAYMENT', $3, 'PURCHASE', $4, $5, $6, $7)`,
            [
              uuid(),
              cashSessionId,
              totals.paidAmount.neg().toFixed(2),
              purchaseId,
              `Cash paid for ${purchaseNumber}`,
              user.id,
              ts,
            ]
          );
        }
      }
    }

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: input.status === 'RECEIVED' ? 'RECEIVE_PURCHASE' : 'CREATE_PURCHASE_DRAFT',
      module: 'purchases',
      targetType: 'PURCHASE',
      targetId: purchaseId,
      transactionRef: purchaseNumber,
      afterState: {
        status: input.status,
        netTotal: totals.netTotal.toFixed(2),
        paid: totals.paidAmount.toFixed(2),
        advanceApplied: advanceApplied.toFixed(2),
        due: finalDueAmount.toFixed(2),
      },
    });

    return { purchaseId, purchaseNumber };
  }, existingTx);
}

export async function receiveDraftPurchase(
  user: AuthUser,
  purchaseId: string,
  paidAmountStr = '0',
  paymentMethod: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER' = 'CASH',
  applyAdvance = true,
  existingTx?: DbExecutor
) {
  const paid = validateCurrencyInput(paidAmountStr || '0', 'Paid amount', { allowZero: true });

  return withTransaction(async (tx) => {
    const pur = await tx.queryOne<{
      id: string;
      purchase_number: string;
      supplier_id: string;
      status: string;
      net_total: string;
      purchase_date: string;
    }>('SELECT id, purchase_number, supplier_id, status, net_total, purchase_date FROM purchases WHERE id = $1 FOR UPDATE', [
      purchaseId,
    ]);
    if (!pur) throw new Error('Purchase not found');
    if (pur.status !== 'DRAFT') throw new Error('Only DRAFT purchases can be received');

    const supplier = (await tx.queryOne<{
      id: string;
      current_balance: string;
      advance_balance: string;
    }>('SELECT id, current_balance, advance_balance FROM suppliers WHERE id = $1 FOR UPDATE', [pur.supplier_id]))!;

    const lines = await tx.query<{
      id: string;
      medicine_id: string;
      batch_number: string;
      expiry_date: string;
      qty_base: string;
      line_total: string;
      selling_price_per_base: string;
    }>('SELECT * FROM purchase_lines WHERE purchase_id = $1 ORDER BY id ASC', [purchaseId]);

    const today = todayDate();
    const ts = nowIso();
    const netTotal = money(pur.net_total);
    if (paid.gt(netTotal)) throw new Error('Paid amount cannot exceed purchase net total');
    const rawDue = roundMoney(netTotal.sub(paid));
    let advanceApplied = new Decimal(0);
    let finalDue = rawDue;
    if (applyAdvance && rawDue.gt(0)) {
      const supAdv = money(supplier.advance_balance || '0.00');
      if (supAdv.gt(0)) {
        advanceApplied = Decimal.min(supAdv, rawDue);
        finalDue = roundMoney(rawDue.sub(advanceApplied));
      }
    }

    for (const l of lines) {
      if (l.expiry_date <= today) throw new Error(`Batch ${l.batch_number} is already expired (${l.expiry_date})`);
      const med = (await tx.queryOne<{ base_unit_name: string }>('SELECT base_unit_name FROM medicines WHERE id = $1', [
        l.medicine_id,
      ]))!;
      const costPerBase = roundCost6(d(l.line_total).div(d(l.qty_base)));

      await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1))', [`batch:${l.medicine_id}:${l.batch_number}:${l.expiry_date}`]);
      const existingBatch = await tx.queryOne<{
        id: string;
        status: string;
        current_qty_base: string;
        initial_qty_base: string;
        purchase_cost_per_base: string;
      }>(
        'SELECT id, status, current_qty_base, initial_qty_base, purchase_cost_per_base FROM batches WHERE medicine_id = $1 AND batch_number = $2 AND expiry_date = $3 FOR UPDATE',
        [l.medicine_id, l.batch_number, l.expiry_date]
      );

      let batchId: string;
      if (existingBatch) {
        if (['QUARANTINED', 'WRITTEN_OFF', 'DAMAGED', 'EXPIRED'].includes(existingBatch.status)) {
          throw new Error(
            `Cannot receive stock into batch ${l.batch_number} because its status is ${existingBatch.status}`
          );
        }
        batchId = existingBatch.id;
        const wac = computeWeightedAverageCost(
          existingBatch.current_qty_base,
          existingBatch.purchase_cost_per_base,
          l.qty_base,
          costPerBase
        );
        await tx.execute(
          "UPDATE batches SET current_qty_base = $1, initial_qty_base = $2, purchase_cost_per_base = $3, selling_price_per_base = $4, status = 'ACTIVE', updated_at = $5 WHERE id = $6",
          [
            roundQty(qty(existingBatch.current_qty_base).add(qty(l.qty_base))).toFixed(6),
            roundQty(qty(existingBatch.initial_qty_base).add(qty(l.qty_base))).toFixed(6),
            wac.toFixed(6),
            l.selling_price_per_base,
            ts,
            batchId,
          ]
        );
      } else {
        batchId = uuid();
        await tx.execute(
          `INSERT INTO batches (
            id, medicine_id, batch_number, expiry_date, supplier_id, purchase_id, received_date,
            purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
            base_unit_name, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE', $13, $14)`,
          [
            batchId,
            l.medicine_id,
            l.batch_number,
            l.expiry_date,
            pur.supplier_id,
            purchaseId,
            pur.purchase_date,
            costPerBase.toFixed(6),
            l.selling_price_per_base,
            qty(l.qty_base).toFixed(6),
            qty(l.qty_base).toFixed(6),
            med.base_unit_name,
            ts,
            ts,
          ]
        );
      }

      await tx.execute('UPDATE purchase_lines SET batch_id = $1 WHERE id = $2', [batchId, l.id]);
      await tx.execute(
        `INSERT INTO stock_movements (
          id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
          cost_per_base_snapshot, reason, created_by, created_at
        ) VALUES ($1, $2, $3, $4, 'PURCHASE_RECEIVED', 'PURCHASE', $5, $6, $7, $8, $9, $10)`,
        [
          uuid(),
          l.medicine_id,
          batchId,
          qty(l.qty_base).toFixed(6),
          purchaseId,
          l.id,
          costPerBase.toFixed(6),
          `Received ${pur.purchase_number}`,
          user.id,
          ts,
        ]
      );
    }

    await tx.execute(
      `UPDATE purchases SET status = 'RECEIVED', paid_amount = $1, due_amount = $2, advance_applied = $3, received_by = $4, received_at = $5, updated_at = $6 WHERE id = $7`,
      [paid.toFixed(2), finalDue.toFixed(2), advanceApplied.toFixed(2), user.id, ts, ts, purchaseId]
    );

    if (advanceApplied.gt(0)) {
      const nextAdv = roundMoney(money(supplier.advance_balance || '0.00').sub(advanceApplied));
      await tx.execute('UPDATE suppliers SET advance_balance = $1, updated_at = $2 WHERE id = $3', [
        nextAdv.toFixed(2),
        ts,
        supplier.id,
      ]);
      await tx.execute(
        `INSERT INTO party_advance_ledger (id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at)
         VALUES ($1, 'SUPPLIER', $2, 'APPLIED_TO_INVOICE', 'PURCHASE', $3, $4, $5, $6, $7)`,
        [uuid(), supplier.id, purchaseId, advanceApplied.neg().toFixed(2), `Advance applied to ${pur.purchase_number}`, user.id, ts]
      );
    }

    if (finalDue.gt(0)) {
      await tx.execute('UPDATE suppliers SET current_balance = $1, updated_at = $2 WHERE id = $3', [
        roundMoney(d(supplier.current_balance).add(finalDue)).toFixed(2),
        ts,
        supplier.id,
      ]);
    }

    if (paid.gt(0)) {
      const payId = uuid();
      const payNo = await generateDocNumber(tx, 'PAY', 'payments', 'payment_number');
      await tx.execute(
        `INSERT INTO payments (id, payment_number, party_type, party_id, direction, method, amount, notes, status, created_by, created_at)
         VALUES ($1, $2, 'SUPPLIER', $3, 'OUT', $4, $5, $6, 'POSTED', $7, $8)`,
        [payId, payNo, supplier.id, paymentMethod, paid.toFixed(2), `Payment on ${pur.purchase_number}`, user.id, ts]
      );
      await tx.execute(
        `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES ($1, $2, 'PURCHASE', $3, $4)`,
        [uuid(), payId, purchaseId, paid.toFixed(2)]
      );
      if (paymentMethod === 'CASH') {
        const cashSessionId = await getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Cannot pay cash without an OPEN cash session');
        await tx.execute(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES ($1, $2, 'SUPPLIER_CASH_PAYMENT', $3, 'PURCHASE', $4, $5, $6, $7)`,
          [uuid(), cashSessionId, paid.neg().toFixed(2), purchaseId, `Cash paid for ${pur.purchase_number}`, user.id, ts]
        );
      }
    }

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'RECEIVE_PURCHASE',
      module: 'purchases',
      targetType: 'PURCHASE',
      targetId: purchaseId,
      transactionRef: pur.purchase_number,
      beforeState: { status: 'DRAFT' },
      afterState: { status: 'RECEIVED', paid: paid.toFixed(2), advanceApplied: advanceApplied.toFixed(2), due: finalDue.toFixed(2) },
    });
  }, existingTx);
}

export async function cancelDraftPurchase(
  user: AuthUser,
  purchaseId: string,
  reason: string,
  existingTx?: DbExecutor
) {
  return withTransaction(async (tx) => {
    const pur = await tx.queryOne<{ id: string; purchase_number: string; status: string }>(
      'SELECT id, purchase_number, status FROM purchases WHERE id = $1 FOR UPDATE',
      [purchaseId]
    );
    if (!pur) throw new Error('Purchase not found');
    if (pur.status !== 'DRAFT') throw new Error('Only DRAFT purchases can be cancelled; use Reversal for RECEIVED purchases');
    await tx.execute("UPDATE purchases SET status = 'CANCELLED', updated_at = $1 WHERE id = $2", [nowIso(), purchaseId]);
    await recordAudit(tx, {
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
  }, existingTx);
}

export async function createPurchaseReturn(
  user: AuthUser,
  input: {
    purchaseId: string;
    settlementType: 'SUPPLIER_CREDIT' | 'CASH_REFUND' | 'BANK_REFUND';
    reason: string;
    lines: Array<{ purchaseLineId: string; qtyBase: string }>;
  },
  existingTx?: DbExecutor
) {
  if (!input.reason?.trim()) throw new Error('Return reason is required');
  if (!input.lines?.length) throw new Error('At least one return line is required');

  for (const item of input.lines) {
    validateQuantityInput(item.qtyBase ?? '0', 'Return quantity', { allowZero: true });
  }

  return withTransaction(async (tx) => {
    const pur = await tx.queryOne<{
      id: string;
      purchase_number: string;
      supplier_id: string;
      status: string;
      paid_amount: string;
      due_amount: string;
    }>('SELECT * FROM purchases WHERE id = $1 FOR UPDATE', [input.purchaseId]);
    if (!pur || pur.status !== 'RECEIVED') throw new Error('Purchase must be RECEIVED to process a return');

    const supplier = (await tx.queryOne<{
      id: string;
      current_balance: string;
      advance_balance: string;
    }>('SELECT id, current_balance, advance_balance FROM suppliers WHERE id = $1 FOR UPDATE', [pur.supplier_id]))!;

    const ts = nowIso();
    const today = todayDate();
    const retId = uuid();
    const retNo = await generateDocNumber(tx, 'PRN', 'purchase_returns', 'return_number');

    const qtyReturnedByLine = new Map<string, Decimal>();
    const pendingBatchDeduction = new Map<string, Decimal>();

    let totalReturn = new Decimal(0);
    const lineRecords: Array<{
      plId: string;
      batchId: string;
      medId: string;
      qtyBase: Decimal;
      costPerBase: Decimal;
      lineTotal: Decimal;
    }> = [];

    // Lock all involved purchase lines & batches deterministically
    const lineIds = Array.from(new Set(input.lines.map((i) => i.purchaseLineId))).sort();
    const plRows = await tx.query<{
      id: string;
      batch_id: string;
      medicine_id: string;
      qty_base: string;
      line_total: string;
    }>('SELECT id, batch_id, medicine_id, qty_base, line_total FROM purchase_lines WHERE purchase_id = $1 AND id = ANY($2::text[]) ORDER BY id ASC', [
      pur.id,
      lineIds,
    ]);
    const plMap = new Map(plRows.map((p) => [p.id, p]));
    const batchIdsToLock = Array.from(new Set(plRows.map((p) => p.batch_id).filter(Boolean))).sort();
    const lockedBatches =
      batchIdsToLock.length > 0
        ? await tx.query<{
            id: string;
            batch_number: string;
            status: string;
            current_qty_base: string;
            purchase_cost_per_base: string;
          }>('SELECT id, batch_number, status, current_qty_base, purchase_cost_per_base FROM batches WHERE id = ANY($1::text[]) ORDER BY id ASC FOR UPDATE', [
            batchIdsToLock,
          ])
        : [];
    const batchMap = new Map(lockedBatches.map((b) => [b.id, b]));

    for (const item of input.lines) {
      const qRet = validateQuantityInput(item.qtyBase, 'Return quantity', { allowZero: true });
      if (qRet.lte(0)) continue;
      const pl = plMap.get(item.purchaseLineId);
      if (!pl || !pl.batch_id) throw new Error('Purchase line or batch not found');

      if (!qtyReturnedByLine.has(pl.id)) {
        const prevReturnRows = await tx.query<{ qty_base: string }>(
          'SELECT qty_base FROM purchase_return_lines WHERE purchase_line_id = $1',
          [pl.id]
        );
        let alreadyReturned = new Decimal(0);
        for (const pr of prevReturnRows) {
          alreadyReturned = alreadyReturned.add(qty(pr.qty_base));
        }
        qtyReturnedByLine.set(pl.id, alreadyReturned);
      }

      const curReturned = qtyReturnedByLine.get(pl.id)!;
      const maxLineReturnable = roundQty(qty(pl.qty_base).sub(curReturned));
      if (qRet.gt(maxLineReturnable)) {
        throw new Error(
          `Return quantity ${qRet.toFixed(6)} exceeds remaining returnable purchased quantity (${maxLineReturnable.toFixed(6)})`
        );
      }

      const batch = batchMap.get(pl.batch_id);
      if (!batch) throw new Error('Batch not found');
      if (['WRITTEN_OFF', 'INACTIVE'].includes(batch.status)) {
        throw new Error(`Cannot return stock from batch ${batch.batch_number} with status ${batch.status}`);
      }

      const alreadyPendingFromBatch = pendingBatchDeduction.get(batch.id) || new Decimal(0);
      const effectiveAvailBatch = roundQty(qty(batch.current_qty_base).sub(alreadyPendingFromBatch));
      if (effectiveAvailBatch.lt(qRet)) {
        throw new Error(
          `Cannot return ${qRet.toFixed(6)} from batch ${batch.batch_number}; only ${effectiveAvailBatch.toFixed(6)} left in stock`
        );
      }

      qtyReturnedByLine.set(pl.id, roundQty(curReturned.add(qRet)));
      pendingBatchDeduction.set(batch.id, roundQty(alreadyPendingFromBatch.add(qRet)));

      const costPerBase = roundCost6(d(pl.line_total).div(d(pl.qty_base)));
      const lineTotal = roundMoney(qRet.mul(costPerBase));
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
    totalReturn = roundMoney(totalReturn);

    const purPaid = money(pur.paid_amount);
    const purDue = money(pur.due_amount);

    if (input.settlementType === 'CASH_REFUND' || input.settlementType === 'BANK_REFUND') {
      if (totalReturn.gt(purPaid)) {
        throw new Error(
          `Cannot receive ${input.settlementType} of ${totalReturn.toFixed(2)}: exceeds remaining paid amount (${purPaid.toFixed(2)}) on purchase ${pur.purchase_number}. Use Supplier Credit to settle unpaid purchase due.`
        );
      }
    }

    const refundAmount = input.settlementType === 'SUPPLIER_CREDIT' ? new Decimal(0) : totalReturn;
    const creditAmount = input.settlementType === 'SUPPLIER_CREDIT' ? totalReturn : new Decimal(0);

    let dueSettled = new Decimal(0);
    let advanceCreated = new Decimal(0);
    if (input.settlementType === 'SUPPLIER_CREDIT') {
      dueSettled = Decimal.min(creditAmount, purDue);
      advanceCreated = roundMoney(creditAmount.sub(dueSettled));
    }

    await tx.execute(
      `INSERT INTO purchase_returns (
        id, return_number, purchase_id, supplier_id, return_date, total_amount,
        settlement_type, refund_amount, credit_amount, due_settled, advance_created, reason, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        retId,
        retNo,
        pur.id,
        pur.supplier_id,
        today,
        totalReturn.toFixed(2),
        input.settlementType,
        refundAmount.toFixed(2),
        creditAmount.toFixed(2),
        dueSettled.toFixed(2),
        advanceCreated.toFixed(2),
        input.reason.trim(),
        user.id,
        ts,
      ]
    );

    for (const lr of lineRecords) {
      const prlId = uuid();
      await tx.execute(
        `INSERT INTO purchase_return_lines (id, purchase_return_id, purchase_line_id, batch_id, medicine_id, qty_base, cost_per_base_snapshot, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [prlId, retId, lr.plId, lr.batchId, lr.medId, lr.qtyBase.toFixed(6), lr.costPerBase.toFixed(6), lr.lineTotal.toFixed(2)]
      );

      const deducted = await tx.queryOne<{ id: string }>(
        `UPDATE batches SET current_qty_base = current_qty_base - $1::numeric, updated_at = $2
         WHERE id = $3 AND current_qty_base >= $1::numeric
         RETURNING id`,
        [lr.qtyBase.toFixed(6), ts, lr.batchId]
      );
      if (!deducted) {
        throw new Error('Negative batch stock prevented during purchase return');
      }

      await tx.execute(
        `INSERT INTO stock_movements (
          id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
          cost_per_base_snapshot, reason, created_by, created_at
        ) VALUES ($1, $2, $3, $4, 'PURCHASE_RETURN', 'PURCHASE_RETURN', $5, $6, $7, $8, $9, $10)`,
        [uuid(), lr.medId, lr.batchId, lr.qtyBase.neg().toFixed(6), retId, prlId, lr.costPerBase.toFixed(6), input.reason.trim(), user.id, ts]
      );
    }

    if (input.settlementType === 'SUPPLIER_CREDIT') {
      const nextPurDue = roundMoney(purDue.sub(dueSettled));
      await tx.execute('UPDATE purchases SET due_amount = $1, updated_at = $2 WHERE id = $3', [
        nextPurDue.toFixed(2),
        ts,
        pur.id,
      ]);

      const curBal = money(supplier.current_balance);
      const nextBal = dueSettled.gt(0) ? roundMoney(Decimal.max(new Decimal(0), curBal.sub(dueSettled))) : curBal;
      const nextAdv = roundMoney(money(supplier.advance_balance || '0.00').add(advanceCreated));

      await tx.execute('UPDATE suppliers SET current_balance = $1, advance_balance = $2, updated_at = $3 WHERE id = $4', [
        nextBal.toFixed(2),
        nextAdv.toFixed(2),
        ts,
        supplier.id,
      ]);

      if (advanceCreated.gt(0)) {
        await tx.execute(
          `INSERT INTO party_advance_ledger (id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at)
           VALUES ($1, 'SUPPLIER', $2, 'RETURN_CREDIT', 'PURCHASE_RETURN', $3, $4, $5, $6, $7)`,
          [
            uuid(),
            supplier.id,
            retId,
            advanceCreated.toFixed(2),
            `Supplier advance credit excess from ${retNo} (${pur.purchase_number})`,
            user.id,
            ts,
          ]
        );
      }
    } else {
      await tx.execute('UPDATE purchases SET paid_amount = $1, updated_at = $2 WHERE id = $3', [
        roundMoney(purPaid.sub(refundAmount)).toFixed(2),
        ts,
        pur.id,
      ]);
      if (input.settlementType === 'CASH_REFUND') {
        const cashSessionId = await getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Cannot receive cash refund without an OPEN cash session');
        await tx.execute(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES ($1, $2, 'CASH_REFUND', $3, 'PURCHASE_RETURN', $4, $5, $6, $7)`,
          [uuid(), cashSessionId, refundAmount.toFixed(2), retId, `Cash refund from supplier on ${retNo}`, user.id, ts]
        );
      }
    }

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'PURCHASE_RETURN',
      module: 'purchases',
      targetType: 'PURCHASE_RETURN',
      targetId: retId,
      transactionRef: retNo,
      afterState: {
        purchaseNumber: pur.purchase_number,
        totalReturn: totalReturn.toFixed(2),
        dueSettled: dueSettled.toFixed(2),
        advanceCreated: advanceCreated.toFixed(2),
        settlementType: input.settlementType,
      },
      reason: input.reason.trim(),
    });

    return {
      returnNumber: retNo,
      totalAmount: totalReturn.toFixed(2),
      dueSettled: dueSettled.toFixed(2),
      advanceCreated: advanceCreated.toFixed(2),
    };
  }, existingTx);
}

export async function reversePurchase(
  user: AuthUser,
  purchaseId: string,
  reason: string,
  existingTx?: DbExecutor
) {
  if (!reason?.trim()) throw new Error('Mandatory reason is required for purchase reversal');
  return withTransaction(async (tx) => {
    const pur = await tx.queryOne<{
      id: string;
      purchase_number: string;
      supplier_id: string;
      status: string;
      due_amount: string;
      paid_amount: string;
      advance_applied: string;
    }>('SELECT * FROM purchases WHERE id = $1 FOR UPDATE', [purchaseId]);
    if (!pur) throw new Error('Purchase not found');
    if (pur.status !== 'RECEIVED') throw new Error('Only RECEIVED purchases can be reversed');

    const existingReturns = await tx.queryOne<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM purchase_returns WHERE purchase_id = $1',
      [purchaseId]
    );
    if (Number(existingReturns?.cnt ?? 0) > 0) {
      throw new Error('Cannot reverse a purchase that already has partial/full purchase returns');
    }

    const lines = await tx.query<{
      id: string;
      batch_id: string;
      medicine_id: string;
      qty_base: string;
      line_total: string;
    }>('SELECT id, batch_id, medicine_id, qty_base, line_total FROM purchase_lines WHERE purchase_id = $1 ORDER BY batch_id ASC, id ASC', [
      purchaseId,
    ]);

    const ts = nowIso();
    for (const l of lines) {
      const batch = (await tx.queryOne<{ current_qty_base: string; batch_number: string }>(
        'SELECT current_qty_base, batch_number FROM batches WHERE id = $1 FOR UPDATE',
        [l.batch_id]
      ))!;
      if (qty(batch.current_qty_base).lt(qty(l.qty_base))) {
        throw new Error(`Cannot reverse purchase: stock from batch ${batch.batch_number} has already been sold or adjusted`);
      }
      const costPerBase = roundCost6(d(l.line_total).div(d(l.qty_base)));
      const deducted = await tx.queryOne<{ id: string }>(
        `UPDATE batches SET current_qty_base = current_qty_base - $1::numeric, updated_at = $2
         WHERE id = $3 AND current_qty_base >= $1::numeric
         RETURNING id`,
        [qty(l.qty_base).toFixed(6), ts, l.batch_id]
      );
      if (!deducted) {
        throw new Error(`Cannot reverse purchase: stock from batch ${batch.batch_number} has already been sold or adjusted`);
      }
      await tx.execute(
        `INSERT INTO stock_movements (
          id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id, reference_line_id,
          cost_per_base_snapshot, reason, created_by, created_at
        ) VALUES ($1, $2, $3, $4, 'PURCHASE_REVERSAL', 'PURCHASE_REVERSAL', $5, $6, $7, $8, $9, $10)`,
        [uuid(), l.medicine_id, l.batch_id, qty(l.qty_base).neg().toFixed(6), purchaseId, l.id, costPerBase.toFixed(6), reason.trim(), user.id, ts]
      );
    }

    const advApplied = money(pur.advance_applied || '0.00');
    if (money(pur.due_amount).gt(0) || advApplied.gt(0)) {
      const sup = (await tx.queryOne<{ current_balance: string; advance_balance: string }>(
        'SELECT current_balance, advance_balance FROM suppliers WHERE id = $1 FOR UPDATE',
        [pur.supplier_id]
      ))!;
      await tx.execute('UPDATE suppliers SET current_balance = $1, advance_balance = $2, updated_at = $3 WHERE id = $4', [
        roundMoney(d(sup.current_balance).sub(d(pur.due_amount))).toFixed(2),
        roundMoney(money(sup.advance_balance || '0.00').add(advApplied)).toFixed(2),
        ts,
        pur.supplier_id,
      ]);
      if (advApplied.gt(0)) {
        await tx.execute(
          `INSERT INTO party_advance_ledger (id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at)
           VALUES ($1, 'SUPPLIER', $2, 'REVERSAL', 'PURCHASE_REVERSAL', $3, $4, $5, $6, $7)`,
          [uuid(), pur.supplier_id, purchaseId, advApplied.toFixed(2), `Restored advance on reversal of ${pur.purchase_number}`, user.id, ts]
        );
      }
    }

    const allocs = await tx.query<{ id: string; method: string; amount: string }>(
      `SELECT p.id, p.method, p.amount FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
       WHERE pa.target_type = 'PURCHASE' AND pa.target_id = $1 AND p.status = 'POSTED'
       FOR UPDATE OF p`,
      [purchaseId]
    );

    for (const p of allocs) {
      await tx.execute("UPDATE payments SET status = 'REVERSED', reversal_reason = $1 WHERE id = $2", [
        reason.trim(),
        p.id,
      ]);
      if (p.method === 'CASH') {
        const cashSessionId = await getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Open cash session required to reverse cash purchase payment');
        await tx.execute(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES ($1, $2, 'REVERSAL', $3, 'PURCHASE_REVERSAL', $4, $5, $6, $7)`,
          [uuid(), cashSessionId, money(p.amount).toFixed(2), purchaseId, `Reversal of ${pur.purchase_number}`, user.id, ts]
        );
      }
    }

    await tx.execute(
      "UPDATE purchases SET status = 'REVERSED', reversed_by = $1, reversed_at = $2, reversal_reason = $3, updated_at = $4 WHERE id = $5",
      [user.id, ts, reason.trim(), ts, purchaseId]
    );

    await recordAudit(tx, {
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
  }, existingTx);
}
