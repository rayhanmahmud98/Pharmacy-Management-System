import Decimal from 'decimal.js';
import { generateDocNumber, getDb, nowIso, todayDate, uuid, withTransaction, type DbExecutor } from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import {
  computeCashVariance,
  computeExpectedCash,
  d,
  money,
  roundMoney,
  validateCurrencyInput,
} from '../../src/shared/decimalMath.ts';

export async function getActiveCashSessionId(tx?: DbExecutor): Promise<string | null> {
  const db = tx || (await getDb());
  const row = await db.queryOne<{ id: string }>(
    "SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1"
  );
  return row?.id ?? null;
}

export async function getCashSessionSummary(sessionId: string, tx?: DbExecutor) {
  const db = tx || (await getDb());
  const session = await db.queryOne<Record<string, unknown>>(
    `SELECT cs.*, u1.full_name AS opened_by_name, u2.full_name AS closed_by_name
     FROM cash_sessions cs
     JOIN users u1 ON u1.id = cs.opened_by
     LEFT JOIN users u2 ON u2.id = cs.closed_by
     WHERE cs.id = $1`,
    [sessionId]
  );
  if (!session) return null;

  const movements = await db.query<{
    id: string;
    movement_type: string;
    amount_signed: string;
    reference_type: string;
    reference_id: string;
    notes: string;
    username: string;
    created_at: string;
  }>(
    `SELECT cm.*, u.username
     FROM cash_movements cm
     JOIN users u ON u.id = cm.created_by
     WHERE cm.cash_session_id = $1
     ORDER BY cm.created_at DESC`,
    [sessionId]
  );

  let cashReceived = new Decimal(0);
  let cashPaid = new Decimal(0);
  let cashAdjustments = new Decimal(0);

  for (const m of movements) {
    if (m.movement_type === 'OPENING_CASH') continue;
    const amt = d(m.amount_signed);
    if (m.movement_type === 'CASH_ADJUSTMENT' || m.movement_type === 'CASH_VARIANCE' || m.movement_type === 'REVERSAL') {
      cashAdjustments = cashAdjustments.add(amt);
    } else if (amt.gt(0)) {
      cashReceived = cashReceived.add(amt);
    } else {
      cashPaid = cashPaid.add(amt.abs());
    }
  }

  const expectedCash = computeExpectedCash(
    String(session.opening_cash),
    roundMoney(cashReceived),
    roundMoney(cashPaid),
    roundMoney(cashAdjustments)
  );

  return {
    session,
    movements,
    totals: {
      openingCash: roundMoney(d(String(session.opening_cash))).toFixed(2),
      cashReceived: roundMoney(cashReceived).toFixed(2),
      cashPaid: roundMoney(cashPaid).toFixed(2),
      cashAdjustments: roundMoney(cashAdjustments).toFixed(2),
      expectedCash: expectedCash.toFixed(2),
    },
  };
}

export async function openCashSession(
  user: AuthUser,
  openingCashStr: string,
  notes = '',
  existingTx?: DbExecutor
) {
  const openingCash = validateCurrencyInput(openingCashStr, 'Opening cash', { allowZero: true });

  return withTransaction(async (tx) => {
    const existing = await tx.queryOne<{ session_number: string }>(
      "SELECT session_number FROM cash_sessions WHERE status = 'OPEN' FOR UPDATE"
    );
    if (existing) {
      throw new Error(`Cash session ${existing.session_number} is already OPEN. Close it before opening a new one.`);
    }

    const id = uuid();
    const num = await generateDocNumber(tx, 'CSH', 'cash_sessions', 'session_number');
    const ts = nowIso();

    await tx.execute(
      `INSERT INTO cash_sessions (id, session_number, status, opened_by, opened_at, opening_cash, notes)
       VALUES ($1, $2, 'OPEN', $3, $4, $5, $6)`,
      [id, num, user.id, ts, openingCash.toFixed(2), notes.trim()]
    );

    await tx.execute(
      `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
       VALUES ($1, $2, 'OPENING_CASH', $3, 'CASH_SESSION', $4, $5, $6, $7)`,
      [uuid(), id, openingCash.toFixed(2), id, notes.trim() || 'Opening cash float', user.id, ts]
    );

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'OPEN_CASH_SESSION',
      module: 'finance',
      targetType: 'CASH_SESSION',
      targetId: id,
      transactionRef: num,
      afterState: { openingCash: openingCash.toFixed(2) },
    });

    return { id, sessionNumber: num };
  }, existingTx);
}

export async function closeCashSession(
  user: AuthUser,
  sessionId: string,
  input: {
    actualCash: string;
    varianceReason?: string;
    notes?: string;
    forceClose?: boolean;
  },
  existingTx?: DbExecutor
) {
  const actualCash = validateCurrencyInput(input.actualCash, 'Actual counted cash', { allowZero: true });

  return withTransaction(async (tx) => {
    const session = await tx.queryOne<{
      id: string;
      session_number: string;
      status: string;
      opening_cash: string;
    }>('SELECT id, session_number, status, opening_cash FROM cash_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (!session) throw new Error('Cash session not found');
    if (session.status !== 'OPEN') throw new Error('Cash session is already closed');

    if (input.forceClose && !user.permissions['cash.force_close']) {
      throw new Error('Permission denied: force-closing a cash session requires cash.force_close');
    }

    const mvs = await tx.query<{ movement_type: string; amount_signed: string }>(
      'SELECT movement_type, amount_signed FROM cash_movements WHERE cash_session_id = $1',
      [sessionId]
    );

    let cashReceived = new Decimal(0);
    let cashPaid = new Decimal(0);
    let cashAdjustments = new Decimal(0);
    for (const m of mvs) {
      if (m.movement_type === 'OPENING_CASH') continue;
      const amt = d(m.amount_signed);
      if (m.movement_type === 'CASH_ADJUSTMENT' || m.movement_type === 'CASH_VARIANCE' || m.movement_type === 'REVERSAL') {
        cashAdjustments = cashAdjustments.add(amt);
      } else if (amt.gt(0)) {
        cashReceived = cashReceived.add(amt);
      } else {
        cashPaid = cashPaid.add(amt.abs());
      }
    }

    const expectedCash = computeExpectedCash(
      session.opening_cash,
      roundMoney(cashReceived),
      roundMoney(cashPaid),
      roundMoney(cashAdjustments)
    );
    const variance = computeCashVariance(actualCash, expectedCash);

    if (!variance.eq(0) && !input.varianceReason?.trim()) {
      throw new Error(`Cash variance of ${variance.toFixed(2)} detected. A mandatory variance reason is required.`);
    }
    if (input.forceClose && !input.varianceReason?.trim() && !input.notes?.trim()) {
      throw new Error('Force-closing a session requires a mandatory reason');
    }

    const ts = nowIso();
    const nextStatus = input.forceClose ? 'FORCE_CLOSED' : 'CLOSED';

    if (!variance.eq(0)) {
      await tx.execute(
        `INSERT INTO cash_movements (
          id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
        ) VALUES ($1, $2, 'CASH_VARIANCE', $3, 'CASH_SESSION', $4, $5, $6, $7)`,
        [
          uuid(),
          sessionId,
          variance.toFixed(2),
          sessionId,
          `Closing variance adjustment: ${input.varianceReason?.trim()}`,
          user.id,
          ts,
        ]
      );
    }

    await tx.execute(
      `UPDATE cash_sessions SET
        status = $1, closed_by = $2, closed_at = $3, expected_cash = $4, actual_cash = $5,
        variance = $6, variance_reason = $7, notes = COALESCE(NULLIF($8, ''), notes)
       WHERE id = $9`,
      [
        nextStatus,
        user.id,
        ts,
        expectedCash.toFixed(2),
        actualCash.toFixed(2),
        variance.toFixed(2),
        (input.varianceReason || '').trim(),
        (input.notes || '').trim(),
        sessionId,
      ]
    );

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: input.forceClose ? 'FORCE_CLOSE_CASH_SESSION' : 'CLOSE_CASH_SESSION',
      module: 'finance',
      targetType: 'CASH_SESSION',
      targetId: sessionId,
      transactionRef: session.session_number,
      beforeState: { status: 'OPEN', expectedCash: expectedCash.toFixed(2) },
      afterState: { status: nextStatus, actualCash: actualCash.toFixed(2), variance: variance.toFixed(2) },
      reason: (input.varianceReason || input.notes || '').trim(),
    });

    return {
      sessionNumber: session.session_number,
      expectedCash: expectedCash.toFixed(2),
      actualCash: actualCash.toFixed(2),
      variance: variance.toFixed(2),
    };
  }, existingTx);
}

export async function recordPartyPayment(
  user: AuthUser,
  input: {
    partyType: 'CUSTOMER' | 'SUPPLIER';
    partyId: string;
    method: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
    amount: string;
    referenceNo?: string;
    notes?: string;
    targetDocId?: string | null;
  },
  existingTx?: DbExecutor
) {
  const amt = validateCurrencyInput(input.amount, 'Payment amount', { allowZero: false });

  return withTransaction(async (tx) => {
    const ts = nowIso();
    const payId = uuid();
    const payNo = await generateDocNumber(tx, 'PAY', 'payments', 'payment_number');
    const direction = input.partyType === 'CUSTOMER' ? 'IN' : 'OUT';
    let allocatedToDocs = new Decimal(0);
    let openingApplied = new Decimal(0);
    let advanceAdded = new Decimal(0);

    if (input.partyType === 'CUSTOMER') {
      const cust = await tx.queryOne<{
        id: string;
        name: string;
        current_balance: string;
        advance_balance: string;
      }>('SELECT id, name, current_balance, advance_balance FROM customers WHERE id = $1 FOR UPDATE', [input.partyId]);
      if (!cust) throw new Error('Customer not found');

      await tx.execute(
        `INSERT INTO payments (id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at)
         VALUES ($1, $2, 'CUSTOMER', $3, 'IN', $4, $5, $6, $7, 'POSTED', $8, $9)`,
        [
          payId,
          payNo,
          cust.id,
          input.method,
          amt.toFixed(2),
          (input.referenceNo || '').trim(),
          (input.notes || '').trim(),
          user.id,
          ts,
        ]
      );

      let remainingToAlloc = amt;
      const candidateSales = input.targetDocId
        ? await tx.query<{ id: string; paid_amount: string; due_amount: string }>(
            "SELECT id, paid_amount, due_amount FROM sales WHERE id = $1 AND customer_id = $2 AND status = 'COMPLETED' FOR UPDATE",
            [input.targetDocId, cust.id]
          )
        : await tx.query<{ id: string; paid_amount: string; due_amount: string }>(
            "SELECT id, paid_amount, due_amount FROM sales WHERE customer_id = $1 AND status = 'COMPLETED' ORDER BY sale_date ASC, created_at ASC FOR UPDATE",
            [cust.id]
          );

      for (const s of candidateSales) {
        if (remainingToAlloc.lte(0)) break;
        const due = money(s.due_amount);
        if (due.lte(0)) continue;
        const apply = Decimal.min(due, remainingToAlloc);
        await tx.execute(
          `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES ($1, $2, 'SALE', $3, $4)`,
          [uuid(), payId, s.id, apply.toFixed(2)]
        );
        await tx.execute('UPDATE sales SET paid_amount = $1, due_amount = $2 WHERE id = $3', [
          roundMoney(d(s.paid_amount).add(apply)).toFixed(2),
          roundMoney(due.sub(apply)).toFixed(2),
          s.id,
        ]);
        allocatedToDocs = roundMoney(allocatedToDocs.add(apply));
        remainingToAlloc = roundMoney(remainingToAlloc.sub(apply));
      }

      if (remainingToAlloc.gt(0)) {
        const otherOpenRow = await tx.query<{ due_amount: string }>(
          "SELECT due_amount FROM sales WHERE customer_id = $1 AND status = 'COMPLETED'",
          [cust.id]
        );
        let remainingOpenInvoiceDue = new Decimal(0);
        for (const r of otherOpenRow) {
          remainingOpenInvoiceDue = remainingOpenInvoiceDue.add(money(r.due_amount));
        }
        remainingOpenInvoiceDue = roundMoney(remainingOpenInvoiceDue);

        const balAfterInvoiceAllocs = Decimal.max(0, roundMoney(d(cust.current_balance).sub(allocatedToDocs)));
        const uninvoicedDue = Decimal.max(0, roundMoney(balAfterInvoiceAllocs.sub(remainingOpenInvoiceDue)));
        if (uninvoicedDue.gt(0)) {
          openingApplied = Decimal.min(uninvoicedDue, remainingToAlloc);
          await tx.execute(
            `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES ($1, $2, 'CUSTOMER_OPENING', $3, $4)`,
            [uuid(), payId, cust.id, openingApplied.toFixed(2)]
          );
          remainingToAlloc = roundMoney(remainingToAlloc.sub(openingApplied));
        }
      }

      if (remainingToAlloc.gt(0)) {
        advanceAdded = remainingToAlloc;
        await tx.execute(
          `INSERT INTO party_advance_ledger (
            id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at
          ) VALUES ($1, 'CUSTOMER', $2, 'ADVANCE_RECEIPT', 'PAYMENT', $3, $4, $5, $6, $7)`,
          [
            uuid(),
            cust.id,
            payId,
            advanceAdded.toFixed(2),
            `Advance credit from payment ${payNo}`,
            user.id,
            ts,
          ]
        );
      }

      const nextBal = roundMoney(d(cust.current_balance).sub(allocatedToDocs).sub(openingApplied));
      const nextAdv = roundMoney(d(cust.advance_balance || '0.00').add(advanceAdded));
      await tx.execute('UPDATE customers SET current_balance = $1, advance_balance = $2, updated_at = $3 WHERE id = $4', [
        nextBal.toFixed(2),
        nextAdv.toFixed(2),
        ts,
        cust.id,
      ]);

      if (input.method === 'CASH') {
        const cashSessionId = await getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Cannot collect CASH payment without an OPEN cash session');
        await tx.execute(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES ($1, $2, 'CUSTOMER_CASH_COLLECTION', $3, 'PAYMENT', $4, $5, $6, $7)`,
          [uuid(), cashSessionId, amt.toFixed(2), payId, `Cash collected from ${cust.name} (${payNo})`, user.id, ts]
        );
      }

      await recordAudit(tx, {
        userId: user.id,
        username: user.username,
        action: 'CUSTOMER_PAYMENT',
        module: 'finance',
        targetType: 'PAYMENT',
        targetId: payId,
        transactionRef: payNo,
        afterState: {
          customer: cust.name,
          method: input.method,
          amount: amt.toFixed(2),
          allocatedToInvoices: allocatedToDocs.toFixed(2),
          openingApplied: openingApplied.toFixed(2),
          advanceAdded: advanceAdded.toFixed(2),
          newBalance: nextBal.toFixed(2),
          newAdvanceBalance: nextAdv.toFixed(2),
        },
      });
    } else {
      const sup = await tx.queryOne<{
        id: string;
        name: string;
        current_balance: string;
        advance_balance: string;
      }>('SELECT id, name, current_balance, advance_balance FROM suppliers WHERE id = $1 FOR UPDATE', [input.partyId]);
      if (!sup) throw new Error('Supplier not found');

      await tx.execute(
        `INSERT INTO payments (id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at)
         VALUES ($1, $2, 'SUPPLIER', $3, 'OUT', $4, $5, $6, $7, 'POSTED', $8, $9)`,
        [
          payId,
          payNo,
          sup.id,
          input.method,
          amt.toFixed(2),
          (input.referenceNo || '').trim(),
          (input.notes || '').trim(),
          user.id,
          ts,
        ]
      );

      let remainingToAlloc = amt;
      const candidatePurchases = input.targetDocId
        ? await tx.query<{ id: string; paid_amount: string; due_amount: string }>(
            "SELECT id, paid_amount, due_amount FROM purchases WHERE id = $1 AND supplier_id = $2 AND status = 'RECEIVED' FOR UPDATE",
            [input.targetDocId, sup.id]
          )
        : await tx.query<{ id: string; paid_amount: string; due_amount: string }>(
            "SELECT id, paid_amount, due_amount FROM purchases WHERE supplier_id = $1 AND status = 'RECEIVED' ORDER BY purchase_date ASC, created_at ASC FOR UPDATE",
            [sup.id]
          );

      for (const p of candidatePurchases) {
        if (remainingToAlloc.lte(0)) break;
        const due = money(p.due_amount);
        if (due.lte(0)) continue;
        const apply = Decimal.min(due, remainingToAlloc);
        await tx.execute(
          `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES ($1, $2, 'PURCHASE', $3, $4)`,
          [uuid(), payId, p.id, apply.toFixed(2)]
        );
        await tx.execute('UPDATE purchases SET paid_amount = $1, due_amount = $2, updated_at = $3 WHERE id = $4', [
          roundMoney(d(p.paid_amount).add(apply)).toFixed(2),
          roundMoney(due.sub(apply)).toFixed(2),
          ts,
          p.id,
        ]);
        allocatedToDocs = roundMoney(allocatedToDocs.add(apply));
        remainingToAlloc = roundMoney(remainingToAlloc.sub(apply));
      }

      if (remainingToAlloc.gt(0)) {
        const otherOpenRow = await tx.query<{ due_amount: string }>(
          "SELECT due_amount FROM purchases WHERE supplier_id = $1 AND status = 'RECEIVED'",
          [sup.id]
        );
        let remainingOpenPurDue = new Decimal(0);
        for (const r of otherOpenRow) {
          remainingOpenPurDue = remainingOpenPurDue.add(money(r.due_amount));
        }
        remainingOpenPurDue = roundMoney(remainingOpenPurDue);

        const balAfterPurAllocs = Decimal.max(0, roundMoney(d(sup.current_balance).sub(allocatedToDocs)));
        const uninvoicedDue = Decimal.max(0, roundMoney(balAfterPurAllocs.sub(remainingOpenPurDue)));
        if (uninvoicedDue.gt(0)) {
          openingApplied = Decimal.min(uninvoicedDue, remainingToAlloc);
          await tx.execute(
            `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES ($1, $2, 'SUPPLIER_OPENING', $3, $4)`,
            [uuid(), payId, sup.id, openingApplied.toFixed(2)]
          );
          remainingToAlloc = roundMoney(remainingToAlloc.sub(openingApplied));
        }
      }

      if (remainingToAlloc.gt(0)) {
        advanceAdded = remainingToAlloc;
        await tx.execute(
          `INSERT INTO party_advance_ledger (
            id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at
          ) VALUES ($1, 'SUPPLIER', $2, 'ADVANCE_RECEIPT', 'PAYMENT', $3, $4, $5, $6, $7)`,
          [
            uuid(),
            sup.id,
            payId,
            advanceAdded.toFixed(2),
            `Supplier advance credit from payment ${payNo}`,
            user.id,
            ts,
          ]
        );
      }

      const nextBal = roundMoney(d(sup.current_balance).sub(allocatedToDocs).sub(openingApplied));
      const nextAdv = roundMoney(d(sup.advance_balance || '0.00').add(advanceAdded));
      await tx.execute('UPDATE suppliers SET current_balance = $1, advance_balance = $2, updated_at = $3 WHERE id = $4', [
        nextBal.toFixed(2),
        nextAdv.toFixed(2),
        ts,
        sup.id,
      ]);

      if (input.method === 'CASH') {
        const cashSessionId = await getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Cannot pay supplier in CASH without an OPEN cash session');
        await tx.execute(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES ($1, $2, 'SUPPLIER_CASH_PAYMENT', $3, 'PAYMENT', $4, $5, $6, $7)`,
          [uuid(), cashSessionId, amt.neg().toFixed(2), payId, `Cash paid to ${sup.name} (${payNo})`, user.id, ts]
        );
      }

      await recordAudit(tx, {
        userId: user.id,
        username: user.username,
        action: 'SUPPLIER_PAYMENT',
        module: 'finance',
        targetType: 'PAYMENT',
        targetId: payId,
        transactionRef: payNo,
        afterState: {
          supplier: sup.name,
          method: input.method,
          amount: amt.toFixed(2),
          allocatedToPurchases: allocatedToDocs.toFixed(2),
          openingApplied: openingApplied.toFixed(2),
          advanceAdded: advanceAdded.toFixed(2),
          newBalance: nextBal.toFixed(2),
          newAdvanceBalance: nextAdv.toFixed(2),
        },
      });
    }

    return {
      paymentId: payId,
      paymentNumber: payNo,
      direction,
      allocatedToDocs: allocatedToDocs.toFixed(2),
      openingApplied: openingApplied.toFixed(2),
      advanceAdded: advanceAdded.toFixed(2),
    };
  }, existingTx);
}

export async function reversePayment(
  user: AuthUser,
  paymentId: string,
  reason: string,
  existingTx?: DbExecutor
) {
  if (!reason?.trim()) throw new Error('Mandatory reason is required to reverse a payment');
  return withTransaction(async (tx) => {
    const pay = await tx.queryOne<{
      id: string;
      payment_number: string;
      party_type: string;
      party_id: string;
      direction: string;
      method: string;
      amount: string;
      status: string;
    }>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!pay) throw new Error('Payment not found');
    if (pay.status !== 'POSTED') throw new Error('Payment is already reversed');

    const ts = nowIso();
    const amt = money(pay.amount);

    const advRows = await tx.query<{ amount_signed: string }>(
      "SELECT amount_signed FROM party_advance_ledger WHERE source_type = 'PAYMENT' AND source_id = $1 AND entry_type = 'ADVANCE_RECEIPT'",
      [pay.id]
    );
    let advanceAdded = new Decimal(0);
    for (const ar of advRows) {
      advanceAdded = advanceAdded.add(money(ar.amount_signed));
    }
    advanceAdded = roundMoney(advanceAdded);

    const restoredDueDelta = roundMoney(amt.sub(advanceAdded));

    if (pay.party_type === 'CUSTOMER' && pay.party_id) {
      const cust = await tx.queryOne<{ current_balance: string; advance_balance: string }>(
        'SELECT current_balance, advance_balance FROM customers WHERE id = $1 FOR UPDATE',
        [pay.party_id]
      );
      if (cust) {
        const curAdv = money(cust.advance_balance || '0.00');
        if (curAdv.lt(advanceAdded)) {
          throw new Error(
            `Cannot reverse payment ${pay.payment_number}: advance credit (${advanceAdded.toFixed(2)}) created by this payment has already been consumed on subsequent transactions`
          );
        }
        await tx.execute('UPDATE customers SET current_balance = $1, advance_balance = $2, updated_at = $3 WHERE id = $4', [
          roundMoney(d(cust.current_balance).add(restoredDueDelta)).toFixed(2),
          roundMoney(curAdv.sub(advanceAdded)).toFixed(2),
          ts,
          pay.party_id,
        ]);
      }
    } else if (pay.party_type === 'SUPPLIER' && pay.party_id) {
      const sup = await tx.queryOne<{ current_balance: string; advance_balance: string }>(
        'SELECT current_balance, advance_balance FROM suppliers WHERE id = $1 FOR UPDATE',
        [pay.party_id]
      );
      if (sup) {
        const curAdv = money(sup.advance_balance || '0.00');
        if (curAdv.lt(advanceAdded)) {
          throw new Error(
            `Cannot reverse payment ${pay.payment_number}: supplier advance credit (${advanceAdded.toFixed(2)}) created by this payment has already been consumed on subsequent purchases`
          );
        }
        await tx.execute('UPDATE suppliers SET current_balance = $1, advance_balance = $2, updated_at = $3 WHERE id = $4', [
          roundMoney(d(sup.current_balance).add(restoredDueDelta)).toFixed(2),
          roundMoney(curAdv.sub(advanceAdded)).toFixed(2),
          ts,
          pay.party_id,
        ]);
      }
    }

    if (advanceAdded.gt(0) && (pay.party_type === 'CUSTOMER' || pay.party_type === 'SUPPLIER') && pay.party_id) {
      await tx.execute(
        `INSERT INTO party_advance_ledger (
          id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at
        ) VALUES ($1, $2, $3, 'REVERSAL', 'PAYMENT_REVERSAL', $4, $5, $6, $7, $8)`,
        [
          uuid(),
          pay.party_type,
          pay.party_id,
          pay.id,
          advanceAdded.neg().toFixed(2),
          `Advance reversed from payment ${pay.payment_number}: ${reason.trim()}`,
          user.id,
          ts,
        ]
      );
    }

    const allocs = await tx.query<{
      target_type: string;
      target_id: string;
      amount_allocated: string;
    }>('SELECT * FROM payment_allocations WHERE payment_id = $1 ORDER BY target_id ASC', [pay.id]);

    for (const a of allocs) {
      const alAmt = money(a.amount_allocated);
      if (a.target_type === 'SALE') {
        const s = await tx.queryOne<{ paid_amount: string; due_amount: string }>(
          'SELECT paid_amount, due_amount FROM sales WHERE id = $1 FOR UPDATE',
          [a.target_id]
        );
        if (s) {
          await tx.execute('UPDATE sales SET paid_amount = $1, due_amount = $2 WHERE id = $3', [
            roundMoney(d(s.paid_amount).sub(alAmt)).toFixed(2),
            roundMoney(d(s.due_amount).add(alAmt)).toFixed(2),
            a.target_id,
          ]);
        }
      } else if (a.target_type === 'PURCHASE') {
        const p = await tx.queryOne<{ paid_amount: string; due_amount: string }>(
          'SELECT paid_amount, due_amount FROM purchases WHERE id = $1 FOR UPDATE',
          [a.target_id]
        );
        if (p) {
          await tx.execute('UPDATE purchases SET paid_amount = $1, due_amount = $2, updated_at = $3 WHERE id = $4', [
            roundMoney(d(p.paid_amount).sub(alAmt)).toFixed(2),
            roundMoney(d(p.due_amount).add(alAmt)).toFixed(2),
            ts,
            a.target_id,
          ]);
        }
      }
    }

    if (pay.method === 'CASH') {
      const cashSessionId = await getActiveCashSessionId(tx);
      if (!cashSessionId) throw new Error('Open cash session required to reverse a CASH payment');
      const signed = pay.direction === 'IN' ? amt.neg().toFixed(2) : amt.toFixed(2);
      await tx.execute(
        `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
         VALUES ($1, $2, 'REVERSAL', $3, 'PAYMENT_REVERSAL', $4, $5, $6, $7)`,
        [uuid(), cashSessionId, signed, pay.id, `Reversal of ${pay.payment_number}: ${reason.trim()}`, user.id, ts]
      );
    }

    await tx.execute("UPDATE payments SET status = 'REVERSED', reversal_reason = $1 WHERE id = $2", [
      reason.trim(),
      pay.id,
    ]);

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'REVERSE_PAYMENT',
      module: 'finance',
      targetType: 'PAYMENT',
      targetId: pay.id,
      transactionRef: pay.payment_number,
      beforeState: { status: 'POSTED', amount: pay.amount },
      afterState: {
        status: 'REVERSED',
        restoredDueDelta: restoredDueDelta.toFixed(2),
        reversedAdvance: advanceAdded.toFixed(2),
      },
      reason: reason.trim(),
    });
  }, existingTx);
}

export async function createExpense(
  user: AuthUser,
  input: {
    categoryId: string;
    name: string;
    amount: string;
    expenseDate?: string;
    paymentMethod: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
    referenceNo?: string;
    notes?: string;
  },
  existingTx?: DbExecutor
) {
  if (!input.name?.trim()) throw new Error('Expense name is required');
  const amt = validateCurrencyInput(input.amount, 'Expense amount', { allowZero: false });

  return withTransaction(async (tx) => {
    const id = uuid();
    const num = await generateDocNumber(tx, 'EXP', 'expenses', 'expense_number');
    const ts = nowIso();
    const expDate = input.expenseDate || todayDate();

    await tx.execute(
      `INSERT INTO expenses (id, expense_number, category_id, name, amount, expense_date, payment_method, reference_no, notes, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'POSTED', $10, $11)`,
      [
        id,
        num,
        input.categoryId,
        input.name.trim(),
        amt.toFixed(2),
        expDate,
        input.paymentMethod,
        (input.referenceNo || '').trim(),
        (input.notes || '').trim(),
        user.id,
        ts,
      ]
    );

    if (input.paymentMethod === 'CASH') {
      const cashSessionId = await getActiveCashSessionId(tx);
      if (!cashSessionId) throw new Error('Cannot pay CASH expense without an OPEN cash session');
      await tx.execute(
        `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
         VALUES ($1, $2, 'CASH_EXPENSE', $3, 'EXPENSE', $4, $5, $6, $7)`,
        [uuid(), cashSessionId, amt.neg().toFixed(2), id, `${input.name.trim()} (${num})`, user.id, ts]
      );
    }

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'CREATE_EXPENSE',
      module: 'expenses',
      targetType: 'EXPENSE',
      targetId: id,
      transactionRef: num,
      afterState: { name: input.name, amount: amt.toFixed(2), method: input.paymentMethod },
    });

    return { expenseId: id, expenseNumber: num };
  }, existingTx);
}

export async function reverseExpense(
  user: AuthUser,
  expenseId: string,
  reason: string,
  existingTx?: DbExecutor
) {
  if (!reason?.trim()) throw new Error('Mandatory reason is required to reverse an expense');
  return withTransaction(async (tx) => {
    const exp = await tx.queryOne<{
      id: string;
      expense_number: string;
      name: string;
      amount: string;
      payment_method: string;
      status: string;
    }>('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [expenseId]);
    if (!exp) throw new Error('Expense not found');
    if (exp.status !== 'POSTED') throw new Error('Expense is already reversed');

    const ts = nowIso();
    if (exp.payment_method === 'CASH') {
      const cashSessionId = await getActiveCashSessionId(tx);
      if (!cashSessionId) throw new Error('Open cash session required to reverse CASH expense');
      await tx.execute(
        `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
         VALUES ($1, $2, 'REVERSAL', $3, 'EXPENSE_REVERSAL', $4, $5, $6, $7)`,
        [
          uuid(),
          cashSessionId,
          money(exp.amount).toFixed(2),
          exp.id,
          `Reversal of ${exp.expense_number}: ${reason.trim()}`,
          user.id,
          ts,
        ]
      );
    }

    await tx.execute(
      "UPDATE expenses SET status = 'REVERSED', reversed_by = $1, reversed_at = $2, reversal_reason = $3 WHERE id = $4",
      [user.id, ts, reason.trim(), exp.id]
    );

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'REVERSE_EXPENSE',
      module: 'expenses',
      targetType: 'EXPENSE',
      targetId: exp.id,
      transactionRef: exp.expense_number,
      beforeState: { status: 'POSTED', amount: exp.amount },
      afterState: { status: 'REVERSED' },
      reason: reason.trim(),
    });
  }, existingTx);
}
