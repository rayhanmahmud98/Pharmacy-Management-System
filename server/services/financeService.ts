import Decimal from 'decimal.js';
import type { DatabaseSync } from 'node:sqlite';
import { generateDocNumber, getDb, nowIso, todayDate, uuid, withTransaction } from '../db.ts';
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

export function getActiveCashSessionId(tx?: DatabaseSync): string | null {
  const db = tx || getDb();
  const row = db
    .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function getCashSessionSummary(sessionId: string) {
  const db = getDb();
  const session = db
    .prepare(
      `SELECT cs.*, u1.full_name as opened_by_name, u2.full_name as closed_by_name
       FROM cash_sessions cs
       JOIN users u1 ON u1.id = cs.opened_by
       LEFT JOIN users u2 ON u2.id = cs.closed_by
       WHERE cs.id = ?`
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!session) return null;

  const movements = db
    .prepare(
      `SELECT cm.*, u.username
       FROM cash_movements cm
       JOIN users u ON u.id = cm.created_by
       WHERE cm.cash_session_id = ?
       ORDER BY cm.created_at DESC`
    )
    .all(sessionId) as Array<{
    id: string;
    movement_type: string;
    amount_signed: string;
    reference_type: string;
    reference_id: string;
    notes: string;
    username: string;
    created_at: string;
  }>;

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

export function openCashSession(user: AuthUser, openingCashStr: string, notes = '') {
  const openingCash = validateCurrencyInput(openingCashStr, 'Opening cash', { allowZero: true });

  return withTransaction((tx) => {
    const existing = tx.prepare("SELECT session_number FROM cash_sessions WHERE status = 'OPEN'").get() as
      | { session_number: string }
      | undefined;
    if (existing) {
      throw new Error(`Cash session ${existing.session_number} is already OPEN. Close it before opening a new one.`);
    }

    const id = uuid();
    const num = generateDocNumber(tx, 'CSH', 'cash_sessions', 'session_number');
    const ts = nowIso();

    tx.prepare(
      `INSERT INTO cash_sessions (id, session_number, status, opened_by, opened_at, opening_cash, notes)
       VALUES (?, ?, 'OPEN', ?, ?, ?, ?)`
    ).run(id, num, user.id, ts, openingCash.toFixed(2), notes.trim());

    tx.prepare(
      `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
       VALUES (?, ?, 'OPENING_CASH', ?, 'CASH_SESSION', ?, ?, ?, ?)`
    ).run(uuid(), id, openingCash.toFixed(2), id, notes.trim() || 'Opening cash float', user.id, ts);

    recordAudit(tx, {
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
  });
}

export function closeCashSession(
  user: AuthUser,
  sessionId: string,
  input: {
    actualCash: string;
    varianceReason?: string;
    notes?: string;
    forceClose?: boolean;
  }
) {
  const actualCash = validateCurrencyInput(input.actualCash, 'Actual counted cash', { allowZero: true });

  return withTransaction((tx) => {
    const session = tx.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(sessionId) as
      | { id: string; session_number: string; status: string; opening_cash: string }
      | undefined;
    if (!session) throw new Error('Cash session not found');
    if (session.status !== 'OPEN') throw new Error('Cash session is already closed');

    if (input.forceClose && !user.permissions['cash.force_close']) {
      throw new Error('Permission denied: force-closing a cash session requires cash.force_close');
    }

    const mvs = tx
      .prepare('SELECT movement_type, amount_signed FROM cash_movements WHERE cash_session_id = ?')
      .all(sessionId) as Array<{ movement_type: string; amount_signed: string }>;

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
      tx.prepare(
        `INSERT INTO cash_movements (
          id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
        ) VALUES (?, ?, 'CASH_VARIANCE', ?, 'CASH_SESSION', ?, ?, ?, ?)`
      ).run(
        uuid(),
        sessionId,
        variance.toFixed(2),
        sessionId,
        `Closing variance adjustment: ${input.varianceReason?.trim()}`,
        user.id,
        ts
      );
    }

    tx.prepare(
      `UPDATE cash_sessions SET
        status = ?, closed_by = ?, closed_at = ?, expected_cash = ?, actual_cash = ?,
        variance = ?, variance_reason = ?, notes = COALESCE(NULLIF(?, ''), notes)
       WHERE id = ?`
    ).run(
      nextStatus,
      user.id,
      ts,
      expectedCash.toFixed(2),
      actualCash.toFixed(2),
      variance.toFixed(2),
      (input.varianceReason || '').trim(),
      (input.notes || '').trim(),
      sessionId
    );

    recordAudit(tx, {
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
  });
}

export function recordPartyPayment(
  user: AuthUser,
  input: {
    partyType: 'CUSTOMER' | 'SUPPLIER';
    partyId: string;
    method: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
    amount: string;
    referenceNo?: string;
    notes?: string;
    targetDocId?: string | null;
  }
) {
  const amt = validateCurrencyInput(input.amount, 'Payment amount', { allowZero: false });

  return withTransaction((tx) => {
    const ts = nowIso();
    const payId = uuid();
    const payNo = generateDocNumber(tx, 'PAY', 'payments', 'payment_number');
    const direction = input.partyType === 'CUSTOMER' ? 'IN' : 'OUT';
    let allocatedToDocs = new Decimal(0);
    let openingApplied = new Decimal(0);
    let advanceAdded = new Decimal(0);

    if (input.partyType === 'CUSTOMER') {
      const cust = tx
        .prepare('SELECT id, name, current_balance, advance_balance FROM customers WHERE id = ?')
        .get(input.partyId) as
        | { id: string; name: string; current_balance: string; advance_balance: string }
        | undefined;
      if (!cust) throw new Error('Customer not found');

      tx.prepare(
        `INSERT INTO payments (id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at)
         VALUES (?, ?, 'CUSTOMER', ?, 'IN', ?, ?, ?, ?, 'POSTED', ?, ?)`
      ).run(payId, payNo, cust.id, input.method, amt.toFixed(2), (input.referenceNo || '').trim(), (input.notes || '').trim(), user.id, ts);

      let remainingToAlloc = amt;
      const candidateSales = input.targetDocId
        ? (tx
            .prepare("SELECT id, paid_amount, due_amount FROM sales WHERE id = ? AND customer_id = ? AND status = 'COMPLETED'")
            .all(input.targetDocId, cust.id) as Array<{ id: string; paid_amount: string; due_amount: string }>)
        : (tx
            .prepare("SELECT id, paid_amount, due_amount FROM sales WHERE customer_id = ? AND status = 'COMPLETED' ORDER BY sale_date ASC, created_at ASC")
            .all(cust.id) as Array<{ id: string; paid_amount: string; due_amount: string }>);

      for (const s of candidateSales) {
        if (remainingToAlloc.lte(0)) break;
        const due = money(s.due_amount);
        if (due.lte(0)) continue;
        const apply = Decimal.min(due, remainingToAlloc);
        tx.prepare(
          `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES (?, ?, 'SALE', ?, ?)`
        ).run(uuid(), payId, s.id, apply.toFixed(2));
        tx.prepare('UPDATE sales SET paid_amount = ?, due_amount = ? WHERE id = ?').run(
          roundMoney(d(s.paid_amount).add(apply)).toFixed(2),
          roundMoney(due.sub(apply)).toFixed(2),
          s.id
        );
        allocatedToDocs = roundMoney(allocatedToDocs.add(apply));
        remainingToAlloc = roundMoney(remainingToAlloc.sub(apply));
      }

      if (remainingToAlloc.gt(0)) {
        const otherOpenRow = tx
          .prepare("SELECT due_amount FROM sales WHERE customer_id = ? AND status = 'COMPLETED'")
          .all(cust.id) as Array<{ due_amount: string }>;
        let remainingOpenInvoiceDue = new Decimal(0);
        for (const r of otherOpenRow) {
          remainingOpenInvoiceDue = remainingOpenInvoiceDue.add(money(r.due_amount));
        }
        remainingOpenInvoiceDue = roundMoney(remainingOpenInvoiceDue);

        const balAfterInvoiceAllocs = Decimal.max(0, roundMoney(d(cust.current_balance).sub(allocatedToDocs)));
        const uninvoicedDue = Decimal.max(0, roundMoney(balAfterInvoiceAllocs.sub(remainingOpenInvoiceDue)));
        if (uninvoicedDue.gt(0)) {
          openingApplied = Decimal.min(uninvoicedDue, remainingToAlloc);
          tx.prepare(
            `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES (?, ?, 'CUSTOMER_OPENING', ?, ?)`
          ).run(uuid(), payId, cust.id, openingApplied.toFixed(2));
          remainingToAlloc = roundMoney(remainingToAlloc.sub(openingApplied));
        }
      }

      if (remainingToAlloc.gt(0)) {
        advanceAdded = remainingToAlloc;
        tx.prepare(
          `INSERT INTO party_advance_ledger (
            id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at
          ) VALUES (?, 'CUSTOMER', ?, 'ADVANCE_RECEIPT', 'PAYMENT', ?, ?, ?, ?, ?)`
        ).run(
          uuid(),
          cust.id,
          payId,
          advanceAdded.toFixed(2),
          `Advance credit from payment ${payNo}`,
          user.id,
          ts
        );
      }

      const nextBal = roundMoney(d(cust.current_balance).sub(allocatedToDocs).sub(openingApplied));
      const nextAdv = roundMoney(d(cust.advance_balance || '0.00').add(advanceAdded));
      tx.prepare('UPDATE customers SET current_balance = ?, advance_balance = ?, updated_at = ? WHERE id = ?').run(
        nextBal.toFixed(2),
        nextAdv.toFixed(2),
        ts,
        cust.id
      );

      if (input.method === 'CASH') {
        const cashSessionId = getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Cannot collect CASH payment without an OPEN cash session');
        tx.prepare(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES (?, ?, 'CUSTOMER_CASH_COLLECTION', ?, 'PAYMENT', ?, ?, ?, ?)`
        ).run(uuid(), cashSessionId, amt.toFixed(2), payId, `Cash collected from ${cust.name} (${payNo})`, user.id, ts);
      }

      recordAudit(tx, {
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
      const sup = tx
        .prepare('SELECT id, name, current_balance, advance_balance FROM suppliers WHERE id = ?')
        .get(input.partyId) as
        | { id: string; name: string; current_balance: string; advance_balance: string }
        | undefined;
      if (!sup) throw new Error('Supplier not found');

      tx.prepare(
        `INSERT INTO payments (id, payment_number, party_type, party_id, direction, method, amount, reference_no, notes, status, created_by, created_at)
         VALUES (?, ?, 'SUPPLIER', ?, 'OUT', ?, ?, ?, ?, 'POSTED', ?, ?)`
      ).run(payId, payNo, sup.id, input.method, amt.toFixed(2), (input.referenceNo || '').trim(), (input.notes || '').trim(), user.id, ts);

      let remainingToAlloc = amt;
      const candidatePurchases = input.targetDocId
        ? (tx
            .prepare("SELECT id, paid_amount, due_amount FROM purchases WHERE id = ? AND supplier_id = ? AND status = 'RECEIVED'")
            .all(input.targetDocId, sup.id) as Array<{ id: string; paid_amount: string; due_amount: string }>)
        : (tx
            .prepare("SELECT id, paid_amount, due_amount FROM purchases WHERE supplier_id = ? AND status = 'RECEIVED' ORDER BY purchase_date ASC, created_at ASC")
            .all(sup.id) as Array<{ id: string; paid_amount: string; due_amount: string }>);

      for (const p of candidatePurchases) {
        if (remainingToAlloc.lte(0)) break;
        const due = money(p.due_amount);
        if (due.lte(0)) continue;
        const apply = Decimal.min(due, remainingToAlloc);
        tx.prepare(
          `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES (?, ?, 'PURCHASE', ?, ?)`
        ).run(uuid(), payId, p.id, apply.toFixed(2));
        tx.prepare('UPDATE purchases SET paid_amount = ?, due_amount = ?, updated_at = ? WHERE id = ?').run(
          roundMoney(d(p.paid_amount).add(apply)).toFixed(2),
          roundMoney(due.sub(apply)).toFixed(2),
          ts,
          p.id
        );
        allocatedToDocs = roundMoney(allocatedToDocs.add(apply));
        remainingToAlloc = roundMoney(remainingToAlloc.sub(apply));
      }

      if (remainingToAlloc.gt(0)) {
        const otherOpenRow = tx
          .prepare("SELECT due_amount FROM purchases WHERE supplier_id = ? AND status = 'RECEIVED'")
          .all(sup.id) as Array<{ due_amount: string }>;
        let remainingOpenPurDue = new Decimal(0);
        for (const r of otherOpenRow) {
          remainingOpenPurDue = remainingOpenPurDue.add(money(r.due_amount));
        }
        remainingOpenPurDue = roundMoney(remainingOpenPurDue);

        const balAfterPurAllocs = Decimal.max(0, roundMoney(d(sup.current_balance).sub(allocatedToDocs)));
        const uninvoicedDue = Decimal.max(0, roundMoney(balAfterPurAllocs.sub(remainingOpenPurDue)));
        if (uninvoicedDue.gt(0)) {
          openingApplied = Decimal.min(uninvoicedDue, remainingToAlloc);
          tx.prepare(
            `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated) VALUES (?, ?, 'SUPPLIER_OPENING', ?, ?)`
          ).run(uuid(), payId, sup.id, openingApplied.toFixed(2));
          remainingToAlloc = roundMoney(remainingToAlloc.sub(openingApplied));
        }
      }

      if (remainingToAlloc.gt(0)) {
        advanceAdded = remainingToAlloc;
        tx.prepare(
          `INSERT INTO party_advance_ledger (
            id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at
          ) VALUES (?, 'SUPPLIER', ?, 'ADVANCE_RECEIPT', 'PAYMENT', ?, ?, ?, ?, ?)`
        ).run(
          uuid(),
          sup.id,
          payId,
          advanceAdded.toFixed(2),
          `Supplier advance credit from payment ${payNo}`,
          user.id,
          ts
        );
      }

      const nextBal = roundMoney(d(sup.current_balance).sub(allocatedToDocs).sub(openingApplied));
      const nextAdv = roundMoney(d(sup.advance_balance || '0.00').add(advanceAdded));
      tx.prepare('UPDATE suppliers SET current_balance = ?, advance_balance = ?, updated_at = ? WHERE id = ?').run(
        nextBal.toFixed(2),
        nextAdv.toFixed(2),
        ts,
        sup.id
      );

      if (input.method === 'CASH') {
        const cashSessionId = getActiveCashSessionId(tx);
        if (!cashSessionId) throw new Error('Cannot pay supplier in CASH without an OPEN cash session');
        tx.prepare(
          `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
           VALUES (?, ?, 'SUPPLIER_CASH_PAYMENT', ?, 'PAYMENT', ?, ?, ?, ?)`
        ).run(uuid(), cashSessionId, amt.neg().toFixed(2), payId, `Cash paid to ${sup.name} (${payNo})`, user.id, ts);
      }

      recordAudit(tx, {
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
  });
}

export function reversePayment(user: AuthUser, paymentId: string, reason: string) {
  if (!reason?.trim()) throw new Error('Mandatory reason is required to reverse a payment');
  return withTransaction((tx) => {
    const pay = tx.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as
      | { id: string; payment_number: string; party_type: string; party_id: string; direction: string; method: string; amount: string; status: string }
      | undefined;
    if (!pay) throw new Error('Payment not found');
    if (pay.status !== 'POSTED') throw new Error('Payment is already reversed');

    const ts = nowIso();
    const amt = money(pay.amount);

    const advRows = tx
      .prepare(
        "SELECT amount_signed FROM party_advance_ledger WHERE source_type = 'PAYMENT' AND source_id = ? AND entry_type = 'ADVANCE_RECEIPT'"
      )
      .all(pay.id) as Array<{ amount_signed: string }>;
    let advanceAdded = new Decimal(0);
    for (const ar of advRows) {
      advanceAdded = advanceAdded.add(money(ar.amount_signed));
    }
    advanceAdded = roundMoney(advanceAdded);

    const restoredDueDelta = roundMoney(amt.sub(advanceAdded));

    if (pay.party_type === 'CUSTOMER' && pay.party_id) {
      const cust = tx.prepare('SELECT current_balance, advance_balance FROM customers WHERE id = ?').get(pay.party_id) as
        | { current_balance: string; advance_balance: string }
        | undefined;
      if (cust) {
        const curAdv = money(cust.advance_balance || '0.00');
        if (curAdv.lt(advanceAdded)) {
          throw new Error(
            `Cannot reverse payment ${pay.payment_number}: advance credit (${advanceAdded.toFixed(2)}) created by this payment has already been consumed on subsequent transactions`
          );
        }
        tx.prepare('UPDATE customers SET current_balance = ?, advance_balance = ?, updated_at = ? WHERE id = ?').run(
          roundMoney(d(cust.current_balance).add(restoredDueDelta)).toFixed(2),
          roundMoney(curAdv.sub(advanceAdded)).toFixed(2),
          ts,
          pay.party_id
        );
      }
    } else if (pay.party_type === 'SUPPLIER' && pay.party_id) {
      const sup = tx.prepare('SELECT current_balance, advance_balance FROM suppliers WHERE id = ?').get(pay.party_id) as
        | { current_balance: string; advance_balance: string }
        | undefined;
      if (sup) {
        const curAdv = money(sup.advance_balance || '0.00');
        if (curAdv.lt(advanceAdded)) {
          throw new Error(
            `Cannot reverse payment ${pay.payment_number}: supplier advance credit (${advanceAdded.toFixed(2)}) created by this payment has already been consumed on subsequent purchases`
          );
        }
        tx.prepare('UPDATE suppliers SET current_balance = ?, advance_balance = ?, updated_at = ? WHERE id = ?').run(
          roundMoney(d(sup.current_balance).add(restoredDueDelta)).toFixed(2),
          roundMoney(curAdv.sub(advanceAdded)).toFixed(2),
          ts,
          pay.party_id
        );
      }
    }

    if (advanceAdded.gt(0) && (pay.party_type === 'CUSTOMER' || pay.party_type === 'SUPPLIER') && pay.party_id) {
      tx.prepare(
        `INSERT INTO party_advance_ledger (
          id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at
        ) VALUES (?, ?, ?, 'REVERSAL', 'PAYMENT_REVERSAL', ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        pay.party_type,
        pay.party_id,
        pay.id,
        advanceAdded.neg().toFixed(2),
        `Advance reversed from payment ${pay.payment_number}: ${reason.trim()}`,
        user.id,
        ts
      );
    }

    const allocs = tx.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(pay.id) as Array<{
      target_type: string;
      target_id: string;
      amount_allocated: string;
    }>;

    for (const a of allocs) {
      const alAmt = money(a.amount_allocated);
      if (a.target_type === 'SALE') {
        const s = tx.prepare('SELECT paid_amount, due_amount FROM sales WHERE id = ?').get(a.target_id) as
          | { paid_amount: string; due_amount: string }
          | undefined;
        if (s) {
          tx.prepare('UPDATE sales SET paid_amount = ?, due_amount = ? WHERE id = ?').run(
            roundMoney(d(s.paid_amount).sub(alAmt)).toFixed(2),
            roundMoney(d(s.due_amount).add(alAmt)).toFixed(2),
            a.target_id
          );
        }
      } else if (a.target_type === 'PURCHASE') {
        const p = tx.prepare('SELECT paid_amount, due_amount FROM purchases WHERE id = ?').get(a.target_id) as
          | { paid_amount: string; due_amount: string }
          | undefined;
        if (p) {
          tx.prepare('UPDATE purchases SET paid_amount = ?, due_amount = ?, updated_at = ? WHERE id = ?').run(
            roundMoney(d(p.paid_amount).sub(alAmt)).toFixed(2),
            roundMoney(d(p.due_amount).add(alAmt)).toFixed(2),
            ts,
            a.target_id
          );
        }
      }
    }

    if (pay.method === 'CASH') {
      const cashSessionId = getActiveCashSessionId(tx);
      if (!cashSessionId) throw new Error('Open cash session required to reverse a CASH payment');
      const signed = pay.direction === 'IN' ? amt.neg().toFixed(2) : amt.toFixed(2);
      tx.prepare(
        `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
         VALUES (?, ?, 'REVERSAL', ?, 'PAYMENT_REVERSAL', ?, ?, ?, ?)`
      ).run(uuid(), cashSessionId, signed, pay.id, `Reversal of ${pay.payment_number}: ${reason.trim()}`, user.id, ts);
    }

    tx.prepare("UPDATE payments SET status = 'REVERSED', reversal_reason = ? WHERE id = ?").run(reason.trim(), pay.id);

    recordAudit(tx, {
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
  });
}

export function createExpense(
  user: AuthUser,
  input: {
    categoryId: string;
    name: string;
    amount: string;
    expenseDate?: string;
    paymentMethod: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
    referenceNo?: string;
    notes?: string;
  }
) {
  if (!input.name?.trim()) throw new Error('Expense name is required');
  const amt = validateCurrencyInput(input.amount, 'Expense amount', { allowZero: false });

  return withTransaction((tx) => {
    const id = uuid();
    const num = generateDocNumber(tx, 'EXP', 'expenses', 'expense_number');
    const ts = nowIso();
    const expDate = input.expenseDate || todayDate();

    tx.prepare(
      `INSERT INTO expenses (id, expense_number, category_id, name, amount, expense_date, payment_method, reference_no, notes, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?)`
    ).run(id, num, input.categoryId, input.name.trim(), amt.toFixed(2), expDate, input.paymentMethod, (input.referenceNo || '').trim(), (input.notes || '').trim(), user.id, ts);

    if (input.paymentMethod === 'CASH') {
      const cashSessionId = getActiveCashSessionId(tx);
      if (!cashSessionId) throw new Error('Cannot pay CASH expense without an OPEN cash session');
      tx.prepare(
        `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
         VALUES (?, ?, 'CASH_EXPENSE', ?, 'EXPENSE', ?, ?, ?, ?)`
      ).run(uuid(), cashSessionId, amt.neg().toFixed(2), id, `${input.name.trim()} (${num})`, user.id, ts);
    }

    recordAudit(tx, {
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
  });
}

export function reverseExpense(user: AuthUser, expenseId: string, reason: string) {
  if (!reason?.trim()) throw new Error('Mandatory reason is required to reverse an expense');
  return withTransaction((tx) => {
    const exp = tx.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId) as
      | { id: string; expense_number: string; name: string; amount: string; payment_method: string; status: string }
      | undefined;
    if (!exp) throw new Error('Expense not found');
    if (exp.status !== 'POSTED') throw new Error('Expense is already reversed');

    const ts = nowIso();
    if (exp.payment_method === 'CASH') {
      const cashSessionId = getActiveCashSessionId(tx);
      if (!cashSessionId) throw new Error('Open cash session required to reverse CASH expense');
      tx.prepare(
        `INSERT INTO cash_movements (id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at)
         VALUES (?, ?, 'REVERSAL', ?, 'EXPENSE_REVERSAL', ?, ?, ?, ?)`
      ).run(uuid(), cashSessionId, money(exp.amount).toFixed(2), exp.id, `Reversal of ${exp.expense_number}: ${reason.trim()}`, user.id, ts);
    }

    tx.prepare(
      "UPDATE expenses SET status = 'REVERSED', reversed_by = ?, reversed_at = ?, reversal_reason = ? WHERE id = ?"
    ).run(user.id, ts, reason.trim(), exp.id);

    recordAudit(tx, {
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
  });
}
