import React, { useEffect, useRef, useState } from 'react';
import { Printer, RotateCcw, Search } from 'lucide-react';
import {
  apiFetch,
  checkStrictDecimalInput,
  formatBDT,
  formatQty,
  newIdempotencyKey,
} from '../lib/api';
import type { AuthUser, PharmacySettings, SaleRecord } from '../types';
import { ReceiptPrintModal } from '../components/ReceiptPrintModal';
import { ReasonPromptModal } from '../components/ActionModals';

interface SalesReturnRecord {
  id: string;
  return_number: string;
  invoice_number: string;
  customer_name: string;
  return_date: string;
  total_refund_value: string;
  total_cogs_reversed: string;
  settlement_type: string;
  reason: string;
  created_by_name: string;
  lines: Array<{
    id: string;
    brand_name: string;
    batch_number: string;
    qty_base: string;
    disposition: string;
    cogs_reversed: string;
    refund_line_total: string;
  }>;
}

interface Props {
  user: AuthUser;
  settings: PharmacySettings;
}

export const SalesHistoryPage: React.FC<Props> = ({ user, settings }) => {
  const [sales, setSales] = useState<SaleRecord[]>([]);
  const [returns, setReturns] = useState<SalesReturnRecord[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'sales' | 'returns'>('sales');
  const [printSale, setPrintSale] = useState<SaleRecord | null>(null);
  const [returnTarget, setReturnTarget] = useState<SaleRecord | null>(null);
  const [lineReturns, setLineReturns] = useState<
    Record<string, { qtyBase: string; disposition: 'RESTOCK_SELLABLE' | 'QUARANTINE' | 'DAMAGED' | 'WRITE_OFF' | 'NOT_RESTOCKABLE' }>
  >({});
  const [settlementType, setSettlementType] = useState<'CASH_REFUND' | 'MFS_REFUND' | 'CUSTOMER_CREDIT'>('CASH_REFUND');
  const [returnReason, setReturnReason] = useState('');
  const [reverseSaleTarget, setReverseSaleTarget] = useState<SaleRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submitLockRef = useRef(false);
  const returnIdempKeyRef = useRef(newIdempotencyKey());
  const reverseIdempKeyRef = useRef(newIdempotencyKey());

  async function load(q = search) {
    const res = await apiFetch<{ sales: SaleRecord[]; returns: SalesReturnRecord[] }>(
      `/api/sales?search=${encodeURIComponent(q)}`
    );
    setSales(res.sales);
    setReturns(res.returns);
  }

  useEffect(() => {
    load('').catch((e) => setError(e.message));
  }, []);

  function openReturnModal(s: SaleRecord) {
    returnIdempKeyRef.current = newIdempotencyKey();
    setReturnTarget(s);
    const init: typeof lineReturns = {};
    for (const l of s.lines) {
      init[l.id] = { qtyBase: '', disposition: 'QUARANTINE' };
    }
    setLineReturns(init);
    setSettlementType('CASH_REFUND');
    setReturnReason('');
  }

  async function handleSubmitReturn(e: React.FormEvent) {
    e.preventDefault();
    if (!returnTarget || submitLockRef.current || submitting) return;
    setError('');

    const lines: Array<{ saleLineId: string; qtyBase: string; disposition: string }> = [];
    for (const [saleLineId, v] of Object.entries(lineReturns)) {
      if (v.qtyBase && v.qtyBase.trim() !== '') {
        const qErr = checkStrictDecimalInput(v.qtyBase, 'qty', 'Return quantity', { allowZero: true });
        if (qErr) {
          setError(qErr);
          return;
        }
        if (Number(v.qtyBase) > 0) {
          lines.push({ saleLineId, qtyBase: v.qtyBase, disposition: v.disposition });
        }
      }
    }

    submitLockRef.current = true;
    setSubmitting(true);
    try {
      const res = await apiFetch<{ returnNumber: string; totalRefundValue: string; totalCogsReversed: string }>(
        '/api/sales-returns',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': returnIdempKeyRef.current },
          body: JSON.stringify({
            saleId: returnTarget.id,
            settlementType,
            reason: returnReason,
            lines,
          }),
        }
      );
      returnIdempKeyRef.current = newIdempotencyKey();
      setNotice(
        `Sales Return ${res.returnNumber} processed (${formatBDT(res.totalRefundValue)} · COGS reversed ${formatBDT(res.totalCogsReversed)}).`
      );
      setReturnTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Return failed');
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  async function confirmReverseSale(reason: string) {
    if (!reverseSaleTarget || submitLockRef.current) return;
    submitLockRef.current = true;
    setError('');
    try {
      await apiFetch(`/api/sales/${reverseSaleTarget.id}/reverse`, {
        method: 'POST',
        headers: { 'Idempotency-Key': reverseIdempKeyRef.current },
        body: JSON.stringify({ reason }),
      });
      reverseIdempKeyRef.current = newIdempotencyKey();
      setNotice(`Invoice ${reverseSaleTarget.invoice_number} reversed cleanly with compensating stock & financial movements.`);
      setReverseSaleTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reversal failed');
    } finally {
      submitLockRef.current = false;
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Sales History, Reprints &amp; Inspection Returns</h1>
          <p className="text-xs text-slate-500">
            Completed invoices cannot be deleted. Corrections use authorized reversals or inspection-verified returns.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="Search invoice #, customer..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                load(e.target.value);
              }}
              className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white w-52"
            />
          </div>
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            <button
              type="button"
              onClick={() => setTab('sales')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                tab === 'sales' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Sales Invoices ({sales.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('returns')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                tab === 'returns' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Sales Returns ({returns.length})
            </button>
          </div>
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs">{error}</div>}
      {notice && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-xs">{notice}</div>}

      {tab === 'sales' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Invoice #</th>
                <th className="text-left px-4 py-2.5 font-medium">Date · Cashier</th>
                <th className="text-left px-4 py-2.5 font-medium">Customer</th>
                <th className="text-right px-4 py-2.5 font-medium">Net Total</th>
                <th className="text-right px-4 py-2.5 font-medium">Paid</th>
                <th className="text-right px-4 py-2.5 font-medium">Due</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sales.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 font-mono-num font-semibold text-slate-900">{s.invoice_number}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono-num">{s.sale_date}</span>
                    <span className="text-slate-400"> · {s.cashier_name}</span>
                  </td>
                  <td className="px-4 py-2.5">{s.customer_name}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num font-semibold">{formatBDT(s.net_total)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">{formatBDT(s.paid_amount)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num text-amber-700">{formatBDT(s.due_amount)}</td>
                  <td className="px-4 py-2.5 font-semibold">
                    <span className={s.status === 'COMPLETED' ? 'text-emerald-700' : 'text-red-700'}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setPrintSale(s)}
                      className="inline-flex items-center gap-1 text-teal-700 hover:underline font-medium"
                    >
                      <Printer className="w-3.5 h-3.5" /> Reprint
                    </button>
                    {s.status === 'COMPLETED' && user.permissions['sales.return'] && (
                      <button
                        type="button"
                        onClick={() => openReturnModal(s)}
                        className="inline-flex items-center gap-1 text-amber-700 hover:underline font-medium"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Return
                      </button>
                    )}
                    {s.status === 'COMPLETED' && user.permissions['sales.reverse'] && (
                      <button
                        type="button"
                        onClick={() => {
                          reverseIdempKeyRef.current = newIdempotencyKey();
                          setReverseSaleTarget(s);
                        }}
                        className="text-red-700 hover:underline font-medium"
                      >
                        Reverse
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'returns' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Return #</th>
                <th className="text-left px-4 py-2.5 font-medium">Original Invoice</th>
                <th className="text-left px-4 py-2.5 font-medium">Items &amp; Disposition</th>
                <th className="text-right px-4 py-2.5 font-medium">Refund Value</th>
                <th className="text-right px-4 py-2.5 font-medium">COGS Reversed</th>
                <th className="text-left px-4 py-2.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {returns.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5 font-mono-num font-semibold">{r.return_number}</td>
                  <td className="px-4 py-2.5 font-mono-num">
                    {r.invoice_number} · <span className="font-sans text-slate-500">{r.return_date}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    {r.lines.map((l) => (
                      <div key={l.id}>
                        {l.brand_name} ({formatQty(l.qty_base)}) — <strong>{l.disposition}</strong>
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono-num font-semibold">{formatBDT(r.total_refund_value)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num text-slate-600">{formatBDT(r.total_cogs_reversed)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{r.reason}</td>
                </tr>
              ))}
              {returns.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">No sales returns processed yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {printSale && (
        <ReceiptPrintModal sale={printSale} settings={settings} onClose={() => setPrintSale(null)} />
      )}

      {returnTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form onSubmit={handleSubmitReturn} className="bg-white border border-slate-200 rounded-lg w-full max-w-3xl p-6 space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Sales Return &amp; Mandatory Inspection · {returnTarget.invoice_number}
              </h3>
              <p className="text-xs text-slate-500">
                Returned medicines require explicit inspection disposition before affecting sellable inventory. Original batch COGS is preserved.
              </p>
            </div>

            <div className="space-y-2.5 text-xs">
              {returnTarget.lines.map((l) => {
                const maxRet = Math.max(0, Number(l.qty_base) - Number(l.returned_qty_base || 0));
                const state = lineReturns[l.id] || { qtyBase: '', disposition: 'QUARANTINE' };
                return (
                  <div key={l.id} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center p-2.5 border border-slate-200 rounded">
                    <div className="sm:col-span-5">
                      <div className="font-semibold text-slate-900">{l.brand_name} {l.strength}</div>
                      <div className="text-slate-500 font-mono-num">
                        Sold: {formatQty(l.qty_base)} {l.base_unit_name} · Returnable: {formatQty(maxRet)} {l.base_unit_name}
                      </div>
                    </div>
                    <div className="sm:col-span-3">
                      <input
                        type="text"
                        inputMode="decimal"
                        disabled={maxRet <= 0}
                        placeholder={`Qty (${l.base_unit_name})`}
                        value={state.qtyBase}
                        onChange={(e) => {
                          returnIdempKeyRef.current = newIdempotencyKey();
                          setLineReturns({ ...lineReturns, [l.id]: { ...state, qtyBase: e.target.value } });
                        }}
                        className="w-full px-2 py-1.5 border border-slate-300 rounded font-mono-num"
                      />
                    </div>
                    <div className="sm:col-span-4">
                      <select
                        value={state.disposition}
                        onChange={(e) => {
                          returnIdempKeyRef.current = newIdempotencyKey();
                          setLineReturns({
                            ...lineReturns,
                            [l.id]: {
                              ...state,
                              disposition: e.target.value as typeof state.disposition,
                            },
                          });
                        }}
                        className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white"
                      >
                        <option value="QUARANTINE">Quarantine (Do Not Sell)</option>
                        <option value="RESTOCK_SELLABLE">Restock as Sellable (Unopened Verified)</option>
                        <option value="DAMAGED">Damaged (Write-off)</option>
                        <option value="WRITE_OFF">Write-off</option>
                        <option value="NOT_RESTOCKABLE">Not Restockable</option>
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-2">
              <div>
                <label className="block text-slate-600 mb-1">Refund / Settlement Type</label>
                <select
                  value={settlementType}
                  onChange={(e) => {
                    returnIdempKeyRef.current = newIdempotencyKey();
                    setSettlementType(e.target.value as typeof settlementType);
                  }}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                >
                  <option value="CASH_REFUND">Cash Refund from Drawer</option>
                  <option value="MFS_REFUND">MFS / Bank Refund</option>
                  <option value="CUSTOMER_CREDIT">Customer Account Credit (Reduce Due)</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Mandatory Return Reason *</label>
                <input
                  type="text"
                  required
                  placeholder="Inspection notes & return reason..."
                  value={returnReason}
                  onChange={(e) => {
                    returnIdempKeyRef.current = newIdempotencyKey();
                    setReturnReason(e.target.value);
                  }}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button type="button" onClick={() => setReturnTarget(null)} className="px-4 py-2 text-xs bg-slate-100 rounded-md">
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 text-xs font-semibold text-white bg-amber-700 hover:bg-amber-800 disabled:opacity-50 rounded-md"
              >
                {submitting ? 'Processing...' : 'Process Inspected Return'}
              </button>
            </div>
          </form>
        </div>
      )}
      <ReasonPromptModal
        open={Boolean(reverseSaleTarget)}
        title={`Reverse Invoice ${reverseSaleTarget?.invoice_number || ''}`}
        description="Reversing an invoice creates compensating stock and financial entries while preserving the immutable original invoice."
        onCancel={() => setReverseSaleTarget(null)}
        onConfirm={confirmReverseSale}
      />
    </div>
  );
};
