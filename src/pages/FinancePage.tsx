import React, { useEffect, useRef, useState } from 'react';
import { Lock, Plus, Unlock } from 'lucide-react';
import {
  apiFetch,
  checkStrictDecimalInput,
  formatBDT,
  getDisplayCurrencySymbol,
  newIdempotencyKey,
} from '../lib/api';
import { ReasonPromptModal } from '../components/ActionModals';
import type { AuthUser } from '../types';

interface FinanceData {
  activeSummary: {
    session: {
      id: string;
      session_number: string;
      opened_by_name: string;
      opened_at: string;
      opening_cash: string;
    };
    movements: Array<{
      id: string;
      movement_type: string;
      amount_signed: string;
      notes: string;
      username: string;
      created_at: string;
    }>;
    totals: {
      openingCash: string;
      cashReceived: string;
      cashPaid: string;
      cashAdjustments: string;
      expectedCash: string;
    };
  } | null;
  sessions: Array<{
    id: string;
    session_number: string;
    status: string;
    opened_by_name: string;
    opened_at: string;
    opening_cash: string;
    closed_by_name: string | null;
    closed_at: string | null;
    expected_cash: string | null;
    actual_cash: string | null;
    variance: string | null;
    variance_reason: string;
  }>;
  expenseCategories: Array<{ id: string; name: string }>;
  expenses: Array<{
    id: string;
    expense_number: string;
    category_name: string;
    name: string;
    amount: string;
    expense_date: string;
    payment_method: string;
    status: string;
    created_by_name: string;
  }>;
}

interface Props {
  user: AuthUser;
  writable: boolean;
}

export const FinancePage: React.FC<Props> = ({ user, writable }) => {
  const [data, setData] = useState<FinanceData | null>(null);
  const [openingCash, setOpeningCash] = useState('5000.00');
  const [actualCash, setActualCash] = useState('');
  const [varianceReason, setVarianceReason] = useState('');
  const [forceClose, setForceClose] = useState(false);
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [expForm, setExpForm] = useState({
    categoryId: '',
    name: '',
    amount: '',
    paymentMethod: 'CASH',
    referenceNo: '',
    notes: '',
  });
  const [reverseExpenseTarget, setReverseExpenseTarget] = useState<{ id: string; num: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const openIdempKeyRef = useRef(newIdempotencyKey());
  const closeIdempKeyRef = useRef(newIdempotencyKey());
  const expenseIdempKeyRef = useRef(newIdempotencyKey());
  const currencySym = getDisplayCurrencySymbol();

  async function load() {
    const res = await apiFetch<FinanceData>('/api/finance');
    setData(res);
    if (res.activeSummary) {
      setActualCash(res.activeSummary.totals.expectedCash);
    }
    if (!expForm.categoryId && res.expenseCategories.length > 0) {
      setExpForm((p) => ({ ...p, categoryId: res.expenseCategories[0].id }));
    }
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function handleOpenSession(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError('');
    const err = checkStrictDecimalInput(openingCash, 'currency', 'Opening cash', { allowZero: true });
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ sessionNumber: string }>('/api/cash-sessions/open', {
        method: 'POST',
        headers: { 'Idempotency-Key': openIdempKeyRef.current },
        body: JSON.stringify({ openingCash: openingCash.trim() }),
      });
      openIdempKeyRef.current = newIdempotencyKey();
      setNotice(`Cash session ${res.sessionNumber} opened.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open session');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCloseSession(e: React.FormEvent) {
    e.preventDefault();
    if (!data?.activeSummary || submitting) return;
    setError('');
    const err = checkStrictDecimalInput(actualCash, 'currency', 'Actual counted cash', { allowZero: true });
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ sessionNumber: string; variance: string }>(
        `/api/cash-sessions/${data.activeSummary.session.id}/close`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': closeIdempKeyRef.current },
          body: JSON.stringify({ actualCash: actualCash.trim(), varianceReason, forceClose }),
        }
      );
      closeIdempKeyRef.current = newIdempotencyKey();
      setNotice(`Cash session ${res.sessionNumber} closed (Variance: ${formatBDT(res.variance)}).`);
      setVarianceReason('');
      setForceClose(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close session');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateExpense(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError('');
    const err = checkStrictDecimalInput(expForm.amount, 'currency', 'Expense amount');
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ expenseNumber: string }>('/api/expenses', {
        method: 'POST',
        headers: { 'Idempotency-Key': expenseIdempKeyRef.current },
        body: JSON.stringify({ ...expForm, amount: expForm.amount.trim() }),
      });
      expenseIdempKeyRef.current = newIdempotencyKey();
      setNotice(`Expense ${res.expenseNumber} posted.`);
      setShowExpenseModal(false);
      setExpForm((p) => ({ ...p, name: '', amount: '', referenceNo: '', notes: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Expense failed');
    } finally {
      setSubmitting(false);
    }
  }

  function handleReverseExpense(id: string, num: string) {
    setReverseExpenseTarget({ id, num });
  }

  async function confirmReverseExpense(reason: string) {
    if (!reverseExpenseTarget) return;
    setError('');
    try {
      await apiFetch(`/api/expenses/${reverseExpenseTarget.id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setNotice(`Expense ${reverseExpenseTarget.num} reversed.`);
      setReverseExpenseTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reversal failed');
    }
  }

  if (!data) return <div className="p-6 text-sm text-slate-500">Loading cash sessions and expenses...</div>;

  const active = data.activeSummary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Cash Sessions, Drawer Ledger & Expenses</h1>
          <p className="text-xs text-slate-500">
            Physical drawer tracks actual cash movements only. Variances on closing generate an audited variance adjustment.
          </p>
        </div>
        {user.permissions['expenses.manage'] && (
          <button
            type="button"
            disabled={!writable}
            onClick={() => setShowExpenseModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md"
          >
            <Plus className="w-4 h-4" /> Record Expense
          </button>
        )}
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs">{error}</div>}
      {notice && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-xs">{notice}</div>}

      {/* Active Cash Session Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          {active ? (
            <>
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div>
                  <div className="text-xs font-semibold text-emerald-700">OPEN SESSION</div>
                  <div className="text-base font-bold font-mono-num text-slate-900">
                    {active.session.session_number}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Opened by {active.session.opened_by_name}
                  </div>
                </div>
                <Unlock className="w-5 h-5 text-emerald-700" />
              </div>

              <div className="space-y-1.5 text-xs font-mono-num">
                <div className="flex justify-between">
                  <span className="font-sans text-slate-600">Opening Cash</span>
                  <span>{formatBDT(active.totals.openingCash)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span className="font-sans">+ Cash Received</span>
                  <span>{formatBDT(active.totals.cashReceived)}</span>
                </div>
                <div className="flex justify-between text-red-700">
                  <span className="font-sans">- Cash Paid</span>
                  <span>{formatBDT(active.totals.cashPaid)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-sans text-slate-600">+/- Adjustments</span>
                  <span>{formatBDT(active.totals.cashAdjustments)}</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-slate-200 text-sm font-bold text-slate-900">
                  <span className="font-sans">Expected Cash in Drawer</span>
                  <span>{formatBDT(active.totals.expectedCash)}</span>
                </div>
              </div>

              {user.permissions['cash.close'] && (
                <form onSubmit={handleCloseSession} className="pt-3 border-t border-slate-200 space-y-3 text-xs">
                  <div className="font-semibold text-slate-800">Close Cash Session (Manual Physical Count)</div>
                  <div>
                    <label className="block text-slate-600 mb-1">Actual Counted Cash ({currencySym})</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      required
                      value={actualCash}
                      onChange={(e) => setActualCash(e.target.value)}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">
                      Variance Reason (Required if Actual != Expected)
                    </label>
                    <input
                      type="text"
                      placeholder="Explain any cash shortage or overage..."
                      value={varianceReason}
                      onChange={(e) => setVarianceReason(e.target.value)}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded"
                    />
                  </div>
                  {user.permissions['cash.force_close'] && (
                    <label className="inline-flex items-center gap-2 text-slate-700">
                      <input
                        type="checkbox"
                        checked={forceClose}
                        onChange={(e) => setForceClose(e.target.checked)}
                      />
                      Admin Force-Close Session
                    </label>
                  )}
                  <button
                    type="submit"
                    disabled={!writable || submitting}
                    className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    {submitting ? 'Closing...' : 'Close & Reconcile Cash Session'}
                  </button>
                </form>
              )}
            </>
          ) : (
            <form onSubmit={handleOpenSession} className="space-y-3 text-xs">
              <div className="text-sm font-bold text-slate-900">No Active Cash Session</div>
              <p className="text-slate-500">
                Open a cash session with your starting physical drawer float before taking cash sales or paying cash expenses.
              </p>
              <div>
                <label className="block text-slate-600 mb-1">Opening Cash Float ({currencySym})</label>
                <input
                  type="text"
                  inputMode="decimal"
                  required
                  value={openingCash}
                  onChange={(e) => setOpeningCash(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <button
                type="submit"
                disabled={!writable || !user.permissions['cash.open'] || submitting}
                className="w-full py-2 px-4 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md"
              >
                {submitting ? 'Opening...' : 'Open Cash Session'}
              </button>
            </form>
          )}
        </div>

        {/* Active Cash Movements */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 font-semibold text-sm text-slate-900">
            {active ? `Cash Movements · ${active.session.session_number}` : 'Recent Cash Sessions'}
          </div>
          <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
            {active ? (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                    <th className="text-left px-4 py-2 font-medium">Notes / User</th>
                    <th className="text-right px-4 py-2 font-medium">Cash Effect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {active.movements.map((m) => {
                    const pos = Number(m.amount_signed) >= 0;
                    return (
                      <tr key={m.id}>
                        <td className="px-4 py-2 font-mono-num">{m.movement_type}</td>
                        <td className="px-4 py-2 text-slate-600">
                          {m.notes} <span className="text-slate-400">({m.username})</span>
                        </td>
                        <td className={`px-4 py-2 text-right font-mono-num font-semibold ${pos ? 'text-emerald-700' : 'text-red-700'}`}>
                          {pos ? `+${formatBDT(m.amount_signed)}` : formatBDT(m.amount_signed)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="p-6 text-center text-xs text-slate-500">
                Open a cash session to inspect live cash drawer movements.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Session History & Expenses */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 font-semibold text-sm text-slate-900">
            Cash Session History
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Session #</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Expected</th>
                  <th className="text-right px-3 py-2">Actual</th>
                  <th className="text-right px-3 py-2">Variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2 font-mono-num font-medium">{s.session_number}</td>
                    <td className="px-3 py-2">{s.status}</td>
                    <td className="px-3 py-2 text-right font-mono-num">{s.expected_cash ? formatBDT(s.expected_cash) : '—'}</td>
                    <td className="px-3 py-2 text-right font-mono-num">{s.actual_cash ? formatBDT(s.actual_cash) : '—'}</td>
                    <td className="px-3 py-2 text-right font-mono-num font-semibold">
                      {s.variance !== null ? formatBDT(s.variance) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 font-semibold text-sm text-slate-900">
            Posted Expenses
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Expense #</th>
                  <th className="text-left px-3 py-2">Category / Name</th>
                  <th className="text-left px-3 py-2">Method</th>
                  <th className="text-right px-3 py-2">Amount</th>
                  <th className="text-right px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.expenses.map((e) => (
                  <tr key={e.id} className={e.status === 'REVERSED' ? 'opacity-60' : ''}>
                    <td className="px-3 py-2 font-mono-num">{e.expense_number}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{e.name}</div>
                      <div className="text-slate-500">{e.category_name} · {e.expense_date}</div>
                    </td>
                    <td className="px-3 py-2">{e.payment_method}</td>
                    <td className="px-3 py-2 text-right font-mono-num font-semibold">{formatBDT(e.amount)}</td>
                    <td className="px-3 py-2 text-right">
                      {e.status === 'POSTED' && user.permissions['expenses.reverse'] ? (
                        <button
                          type="button"
                          disabled={!writable}
                          onClick={() => handleReverseExpense(e.id, e.expense_number)}
                          className="text-red-700 hover:underline font-medium"
                        >
                          Reverse
                        </button>
                      ) : (
                        <span className="text-slate-400">{e.status}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {data.expenses.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-slate-500">No expenses recorded yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showExpenseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form onSubmit={handleCreateExpense} className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3">
            <h3 className="text-base font-bold text-slate-900">Record Pharmacy Expense</h3>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-600 mb-1">Category</label>
                <select
                  value={expForm.categoryId}
                  onChange={(e) => setExpForm({ ...expForm, categoryId: e.target.value })}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                >
                  {data.expenseCategories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Expense Description *</label>
                <input
                  type="text"
                  required
                  value={expForm.name}
                  onChange={(e) => setExpForm({ ...expForm, name: e.target.value })}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">Amount ({currencySym}) *</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    placeholder="0.00"
                    value={expForm.amount}
                    onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Payment Method</label>
                  <select
                    value={expForm.paymentMethod}
                    onChange={(e) => setExpForm({ ...expForm, paymentMethod: e.target.value })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                  >
                    <option value="CASH">Cash (Drawer)</option>
                    <option value="BKASH">bKash</option>
                    <option value="BANK">Bank</option>
                    <option value="CARD">Card</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button type="button" onClick={() => setShowExpenseModal(false)} className="px-4 py-2 text-xs bg-slate-100 rounded-md">Cancel</button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md"
              >
                {submitting ? 'Posting...' : 'Post Expense'}
              </button>
            </div>
          </form>
        </div>
      )}
      <ReasonPromptModal
        open={Boolean(reverseExpenseTarget)}
        title={`Reverse Expense ${reverseExpenseTarget?.num || ''}`}
        description="Reversing an expense creates a compensating cash-drawer entry if it was paid from drawer cash."
        onCancel={() => setReverseExpenseTarget(null)}
        onConfirm={confirmReverseExpense}
      />
    </div>
  );
};
