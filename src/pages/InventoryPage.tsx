import React, { useEffect, useState } from 'react';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { apiFetch, formatBDT, formatQty } from '../lib/api';
import type { AuthUser, Batch } from '../types';

interface InventoryPayload {
  today: string;
  expiryWarningDays: number;
  batches: Array<Batch & { bangla_name: string }>;
  movements: Array<{
    id: string;
    brand_name: string;
    batch_number: string;
    qty_change_base: string;
    movement_type: string;
    reference_type: string;
    cost_per_base_snapshot: string;
    reason: string;
    username: string;
    created_at: string;
  }>;
  adjustments: Array<{
    id: string;
    adjustment_number: string;
    brand_name: string;
    batch_number: string;
    adjustment_type: string;
    expected_qty_base: string;
    actual_qty_base: string;
    variance_qty_base: string;
    reason: string;
    user_name: string;
    created_at: string;
  }>;
  reconciliation: {
    checkedBatches: number;
    discrepancyCount: number;
    healthy: boolean;
    discrepancies: Array<{
      batchNumber: string;
      medicineName: string;
      cachedQty: string;
      ledgerSum: string;
      diff: string;
    }>;
  };
}

interface Props {
  user: AuthUser;
  writable: boolean;
}

export const InventoryPage: React.FC<Props> = ({ user, writable }) => {
  const [data, setData] = useState<InventoryPayload | null>(null);
  const [tab, setTab] = useState<'batches' | 'movements' | 'adjustments'>('batches');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'NEAR_EXPIRY' | 'EXPIRED' | 'QUARANTINED'>('ALL');
  const [adjBatch, setAdjBatch] = useState<Batch | null>(null);
  const [adjType, setAdjType] = useState<'STOCK_INCREASE' | 'STOCK_DECREASE' | 'DAMAGE' | 'MISSING_STOCK' | 'EXPIRY' | 'RECONCILIATION'>('STOCK_DECREASE');
  const [adjActual, setAdjActual] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    const res = await apiFetch<InventoryPayload>('/api/inventory');
    setData(res);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function handleAdjustSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!adjBatch) return;
    setError('');
    try {
      const res = await apiFetch<{ adjustmentNumber: string }>('/api/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify({
          batchId: adjBatch.id,
          adjustmentType: adjType,
          actualQtyBase: adjActual,
          reason: adjReason,
        }),
      });
      setNotice(`Adjustment ${res.adjustmentNumber} recorded in StockMovement ledger.`);
      setAdjBatch(null);
      setAdjReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Adjustment failed');
    }
  }

  async function handleStatusAction(batchId: string, status: 'QUARANTINED' | 'WRITTEN_OFF' | 'ACTIVE') {
    const reason = status === 'WRITTEN_OFF' ? 'Expiry / Damage write-off' : `Status changed to ${status}`;
    setError('');
    try {
      await apiFetch(`/api/inventory/batches/${batchId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, reason }),
      });
      setNotice(`Batch status updated to ${status}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status update failed');
    }
  }

  if (!data) return <div className="p-6 text-sm text-slate-500">Loading inventory ledger...</div>;

  const warnDate = new Date(`${data.today}T00:00:00Z`);
  warnDate.setUTCDate(warnDate.getUTCDate() + data.expiryWarningDays);
  const warnIso = warnDate.toISOString().slice(0, 10);

  const filteredBatches = data.batches.filter((b) => {
    const isExp = b.expiry_date <= data.today || b.status === 'EXPIRED';
    const isNear = !isExp && b.status === 'ACTIVE' && b.expiry_date <= warnIso;
    if (statusFilter === 'ACTIVE') return b.status === 'ACTIVE' && !isExp && Number(b.current_qty_base) > 0;
    if (statusFilter === 'NEAR_EXPIRY') return isNear && Number(b.current_qty_base) > 0;
    if (statusFilter === 'EXPIRED') return isExp && Number(b.current_qty_base) > 0;
    if (statusFilter === 'QUARANTINED') return b.status === 'QUARANTINED';
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Batch Inventory, Expiry & Stock Ledger</h1>
          <p className="text-xs text-slate-500">
            Authoritative immutable StockMovement ledger reconciled against cached batch balances.
          </p>
        </div>
        <div
          className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border ${
            data.reconciliation.healthy
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {data.reconciliation.healthy ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <ShieldAlert className="w-4 h-4" />
          )}
          {data.reconciliation.healthy
            ? `Ledger Reconciled (${data.reconciliation.checkedBatches} batches · 0 discrepancies)`
            : `Reconciliation Alert: ${data.reconciliation.discrepancyCount} mismatch(es)`}
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs">{error}</div>}
      {notice && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-xs">{notice}</div>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {[
            { id: 'batches', label: 'Batch Stock & Expiry' },
            { id: 'movements', label: 'Stock Movement Ledger' },
            { id: 'adjustments', label: 'Adjustments History' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id as typeof tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'batches' && (
          <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
            {[
              { id: 'ALL', label: 'All Batches' },
              { id: 'ACTIVE', label: 'Active' },
              { id: 'NEAR_EXPIRY', label: 'Near Expiry' },
              { id: 'EXPIRED', label: 'Expired' },
              { id: 'QUARANTINED', label: 'Quarantined' },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id as typeof statusFilter)}
                className={`px-2.5 py-1 text-xs font-medium rounded ${
                  statusFilter === f.id ? 'bg-teal-700 text-white' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'batches' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Medicine</th>
                <th className="text-left px-4 py-2.5 font-medium">Batch / Expiry</th>
                <th className="text-right px-4 py-2.5 font-medium">Cost / Base</th>
                <th className="text-right px-4 py-2.5 font-medium">Sell / Base</th>
                <th className="text-right px-4 py-2.5 font-medium">Current Stock</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredBatches.map((b) => {
                const isExpired = b.expiry_date <= data.today || b.status === 'EXPIRED';
                const isNear = !isExpired && b.status === 'ACTIVE' && b.expiry_date <= warnIso;
                return (
                  <tr key={b.id} className={isExpired ? 'bg-red-50/40' : ''}>
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-slate-900">{b.brand_name} {b.strength}</div>
                      <div className="text-slate-500">{b.supplier_name || 'Opening Stock'}</div>
                    </td>
                    <td className="px-4 py-2.5 font-mono-num">
                      <div className="font-medium text-slate-900">{b.batch_number}</div>
                      <div className={isExpired ? 'text-red-700 font-semibold' : isNear ? 'text-amber-700 font-semibold' : 'text-slate-500'}>
                        Exp: {b.expiry_date}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono-num">{formatBDT(b.purchase_cost_per_base)}</td>
                    <td className="px-4 py-2.5 text-right font-mono-num">{formatBDT(b.selling_price_per_base)}</td>
                    <td className="px-4 py-2.5 text-right font-mono-num font-bold text-slate-900">
                      {formatQty(b.current_qty_base)} {b.base_unit_name}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`font-semibold ${
                          b.status === 'WRITTEN_OFF'
                            ? 'text-slate-500'
                            : isExpired
                            ? 'text-red-700'
                            : b.status === 'QUARANTINED'
                            ? 'text-amber-700'
                            : isNear
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                        }`}
                      >
                        {b.status === 'ACTIVE' && isExpired ? 'EXPIRED' : isNear ? 'NEAR EXPIRY' : b.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                      {user.permissions['inventory.adjust'] && b.status !== 'WRITTEN_OFF' && (
                        <button
                          type="button"
                          disabled={!writable}
                          onClick={() => {
                            setAdjBatch(b);
                            setAdjActual(formatQty(b.current_qty_base));
                          }}
                          className="text-teal-700 hover:underline font-medium disabled:opacity-40"
                        >
                          Adjust
                        </button>
                      )}
                      {user.permissions['inventory.expiry'] && b.status === 'ACTIVE' && (
                        <button
                          type="button"
                          disabled={!writable}
                          onClick={() => handleStatusAction(b.id, 'QUARANTINED')}
                          className="text-amber-700 hover:underline font-medium disabled:opacity-40"
                        >
                          Quarantine
                        </button>
                      )}
                      {user.permissions['inventory.expiry'] &&
                        Number(b.current_qty_base) > 0 &&
                        (isExpired || b.status === 'QUARANTINED') && (
                          <button
                            type="button"
                            disabled={!writable}
                            onClick={() => handleStatusAction(b.id, 'WRITTEN_OFF')}
                            className="text-red-700 hover:underline font-medium disabled:opacity-40"
                          >
                            Write Off
                          </button>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'movements' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Timestamp</th>
                <th className="text-left px-4 py-2.5 font-medium">Medicine / Batch</th>
                <th className="text-left px-4 py-2.5 font-medium">Movement Type</th>
                <th className="text-right px-4 py-2.5 font-medium">Qty Change</th>
                <th className="text-right px-4 py-2.5 font-medium">Cost Snapshot</th>
                <th className="text-left px-4 py-2.5 font-medium">Reason / User</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.movements.map((m) => {
                const pos = Number(m.qty_change_base) >= 0;
                return (
                  <tr key={m.id}>
                    <td className="px-4 py-2 font-mono-num text-slate-500">{m.created_at.slice(0, 19).replace('T', ' ')}</td>
                    <td className="px-4 py-2">
                      <span className="font-medium text-slate-900">{m.brand_name}</span>
                      <span className="text-slate-400"> · {m.batch_number}</span>
                    </td>
                    <td className="px-4 py-2 font-mono-num text-slate-700">{m.movement_type}</td>
                    <td className={`px-4 py-2 text-right font-mono-num font-semibold ${pos ? 'text-emerald-700' : 'text-red-700'}`}>
                      {pos ? `+${formatQty(m.qty_change_base)}` : formatQty(m.qty_change_base)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono-num">{formatBDT(m.cost_per_base_snapshot)}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {m.reason} <span className="text-slate-400">({m.username})</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'adjustments' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Adj #</th>
                <th className="text-left px-4 py-2.5 font-medium">Medicine / Batch</th>
                <th className="text-left px-4 py-2.5 font-medium">Type</th>
                <th className="text-right px-4 py-2.5 font-medium">Expected</th>
                <th className="text-right px-4 py-2.5 font-medium">Actual</th>
                <th className="text-right px-4 py-2.5 font-medium">Variance</th>
                <th className="text-left px-4 py-2.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.adjustments.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2.5 font-mono-num font-medium">{a.adjustment_number}</td>
                  <td className="px-4 py-2.5">
                    {a.brand_name} · <span className="font-mono-num text-slate-500">{a.batch_number}</span>
                  </td>
                  <td className="px-4 py-2.5">{a.adjustment_type}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">{formatQty(a.expected_qty_base)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">{formatQty(a.actual_qty_base)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num font-semibold">{formatQty(a.variance_qty_base)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{a.reason}</td>
                </tr>
              ))}
              {data.adjustments.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-500">No stock adjustments recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Stock Adjustment Modal */}
      {adjBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form onSubmit={handleAdjustSubmit} className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Stock Adjustment · {adjBatch.brand_name} ({adjBatch.batch_number})
            </h3>
            <p className="text-xs text-slate-500">
              Expected Quantity: <strong className="font-mono-num">{formatQty(adjBatch.current_qty_base)} {adjBatch.base_unit_name}</strong>.
              Creates an immutable StockMovement ledger entry.
            </p>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-600 mb-1">Adjustment Type</label>
                <select
                  value={adjType}
                  onChange={(e) => setAdjType(e.target.value as typeof adjType)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                >
                  <option value="STOCK_DECREASE">Stock Decrease (Physical Count Short)</option>
                  <option value="STOCK_INCREASE">Stock Increase (Physical Count Over)</option>
                  <option value="DAMAGE">Damage Write-off</option>
                  <option value="MISSING_STOCK">Missing / Shrinkage</option>
                  <option value="EXPIRY">Expiry Write-off</option>
                  <option value="RECONCILIATION">Reconciliation Correction</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Actual Physical Quantity ({adjBatch.base_unit_name})</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={adjActual}
                  onChange={(e) => setAdjActual(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Mandatory Reason *</label>
                <input
                  type="text"
                  required
                  placeholder="Explain physical count or damage reason..."
                  value={adjReason}
                  onChange={(e) => setAdjReason(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setAdjBatch(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                Post Adjustment
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
