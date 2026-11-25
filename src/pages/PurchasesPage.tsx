import React, { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { Plus, RotateCcw, Search } from 'lucide-react';
import {
  apiFetch,
  checkStrictDecimalInput,
  formatBDT,
  formatQty,
  getDisplayCurrencySymbol,
  newIdempotencyKey,
} from '../lib/api';
import { ReasonPromptModal } from '../components/ActionModals';
import type { AuthUser, Medicine } from '../types';

interface Supplier {
  id: string;
  name: string;
  code: string;
  current_balance: string;
}

interface PurchaseLine {
  id: string;
  medicine_id: string;
  brand_name: string;
  strength: string;
  base_unit_name: string;
  batch_number: string;
  expiry_date: string;
  unit_name_snapshot: string;
  conversion_ratio_snapshot: string;
  qty_input: string;
  qty_base: string;
  unit_cost: string;
  line_total: string;
  batch_current_qty: string | null;
}

interface PurchaseRecord {
  id: string;
  purchase_number: string;
  supplier_id: string;
  supplier_name: string;
  supplier_invoice_no: string;
  purchase_date: string;
  status: 'DRAFT' | 'RECEIVED' | 'CANCELLED' | 'REVERSED';
  net_total: string;
  paid_amount: string;
  due_amount: string;
  created_by_name: string;
  lines: PurchaseLine[];
}

interface Props {
  user: AuthUser;
}

export const PurchasesPage: React.FC<Props> = ({ user }) => {
  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
  const [search, setSearch] = useState('');
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [returnTarget, setReturnTarget] = useState<PurchaseRecord | null>(null);
  const [returnQuantities, setReturnQuantities] = useState<Record<string, string>>({});
  const [returnSettlement, setReturnSettlement] = useState<'SUPPLIER_CREDIT' | 'CASH_REFUND' | 'BANK_REFUND'>('SUPPLIER_CREDIT');
  const [returnReason, setReturnReason] = useState('');
  const [reverseTarget, setReverseTarget] = useState<PurchaseRecord | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submitLockRef = useRef(false);
  const purchaseIdempKeyRef = useRef(newIdempotencyKey());
  const receiveIdempKeyRef = useRef<{ purchaseId: string; key: string } | null>(null);
  const returnIdempKeyRef = useRef(newIdempotencyKey());
  const reverseIdempKeyRef = useRef(newIdempotencyKey());

  const [supplierId, setSupplierId] = useState('');
  const [supplierInv, setSupplierInv] = useState('');
  const [status, setStatus] = useState<'DRAFT' | 'RECEIVED'>('RECEIVED');
  const [paidAmount, setPaidAmount] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'BANK' | 'BKASH'>('CASH');
  const [lineForm, setLineForm] = useState({
    medicineId: '',
    unitId: '',
    batchNumber: '',
    expiryDate: '2028-06-30',
    quantityInput: '1',
    unitCost: '',
    sellingPricePerBase: '',
  });
  const [draftLines, setDraftLines] = useState<Array<typeof lineForm & { label: string; unitLabel: string; conv: string }>>([]);
  const currencySym = getDisplayCurrencySymbol();

  async function load(q = search) {
    const [purRes, medRes, partyRes] = await Promise.all([
      apiFetch<{ purchases: PurchaseRecord[] }>(`/api/purchases?search=${encodeURIComponent(q)}`),
      apiFetch<{ medicines: Medicine[] }>('/api/medicines'),
      apiFetch<{ suppliers: Supplier[] }>('/api/parties'),
    ]);
    setPurchases(purRes.purchases);
    setMedicines(medRes.medicines);
    setSuppliers(partyRes.suppliers);
    if (!supplierId && partyRes.suppliers.length > 0) setSupplierId(partyRes.suppliers[0].id);
    if (!lineForm.medicineId && medRes.medicines.length > 0) {
      const m = medRes.medicines[0];
      const u = m.units.find((x) => x.allow_purchase && x.is_active) || m.units[0];
      setLineForm((prev) => ({ ...prev, medicineId: m.id, unitId: u?.id || '' }));
    }
  }

  useEffect(() => {
    load('').catch((e) => setError(e.message));
  }, []);

  function addLineToDraft() {
    const med = medicines.find((m) => m.id === lineForm.medicineId);
    const unit = med?.units.find((u) => u.id === lineForm.unitId);
    if (!med || !unit) return;
    if (!lineForm.batchNumber.trim() || !lineForm.unitCost || !lineForm.sellingPricePerBase) {
      setError('Fill batch number, unit cost, and selling price per base unit');
      return;
    }
    const qErr = checkStrictDecimalInput(lineForm.quantityInput, 'qty', 'Purchase quantity');
    if (qErr) {
      setError(qErr);
      return;
    }
    const cErr = checkStrictDecimalInput(lineForm.unitCost, 'currency', 'Cost per purchase unit', { allowZero: true });
    if (cErr) {
      setError(cErr);
      return;
    }
    const sErr = checkStrictDecimalInput(lineForm.sellingPricePerBase, 'currency', 'Selling price per base unit');
    if (sErr) {
      setError(sErr);
      return;
    }
    setError('');
    purchaseIdempKeyRef.current = newIdempotencyKey();
    setDraftLines((prev) => [
      ...prev,
      {
        ...lineForm,
        label: `${med.brand_name} ${med.strength}`,
        unitLabel: unit.unit_name,
        conv: unit.conversion_to_base,
      },
    ]);
    setLineForm((prev) => ({ ...prev, batchNumber: '', quantityInput: '1', unitCost: '', sellingPricePerBase: '' }));
  }

  async function handleSubmitPurchase(e: React.FormEvent) {
    e.preventDefault();
    if (submitLockRef.current || submitting) return;
    if (draftLines.length === 0) {
      setError('Add at least one medicine line first');
      return;
    }
    if (status === 'RECEIVED') {
      const pErr = checkStrictDecimalInput(paidAmount || '0', 'currency', 'Paid amount', { allowZero: true });
      if (pErr) {
        setError(pErr);
        return;
      }
    }
    submitLockRef.current = true;
    setError('');
    setSubmitting(true);
    try {
      const res = await apiFetch<{ purchaseNumber: string }>('/api/purchases', {
        method: 'POST',
        headers: { 'Idempotency-Key': purchaseIdempKeyRef.current },
        body: JSON.stringify({
          supplierId,
          supplierInvoiceNo: supplierInv,
          status,
          paidAmount: status === 'RECEIVED' ? paidAmount : '0',
          paymentMethod,
          lines: draftLines,
        }),
      });
      purchaseIdempKeyRef.current = newIdempotencyKey();
      setNotice(`Purchase ${res.purchaseNumber} saved (${status}).`);
      setShowNew(false);
      setDraftLines([]);
      setPaidAmount('0');
      setSupplierInv('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleReceiveDraft(p: PurchaseRecord) {
    if (submitLockRef.current || submitting) return;
    if (!receiveIdempKeyRef.current || receiveIdempKeyRef.current.purchaseId !== p.id) {
      receiveIdempKeyRef.current = { purchaseId: p.id, key: newIdempotencyKey() };
    }
    submitLockRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await apiFetch(`/api/purchases/${p.id}/receive`, {
        method: 'POST',
        headers: { 'Idempotency-Key': receiveIdempKeyRef.current.key },
        body: JSON.stringify({ paidAmount: '0', paymentMethod: 'CASH' }),
      });
      receiveIdempKeyRef.current = null;
      setNotice(`Purchase ${p.purchase_number} received into active batch inventory.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Receive failed');
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  async function confirmReversePurchase(reason: string) {
    if (!reverseTarget || submitLockRef.current) return;
    submitLockRef.current = true;
    setError('');
    try {
      await apiFetch(`/api/purchases/${reverseTarget.id}/reverse`, {
        method: 'POST',
        headers: { 'Idempotency-Key': reverseIdempKeyRef.current },
        body: JSON.stringify({ reason }),
      });
      reverseIdempKeyRef.current = newIdempotencyKey();
      setNotice(`Purchase ${reverseTarget.purchase_number} reversed.`);
      setReverseTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reversal failed');
    } finally {
      submitLockRef.current = false;
    }
  }

  async function handleReturnSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!returnTarget || submitLockRef.current || submitting) return;
    setError('');
    const lines = Object.entries(returnQuantities)
      .filter(([, q]) => Number(q) > 0)
      .map(([purchaseLineId, qtyBase]) => ({ purchaseLineId, qtyBase }));
    submitLockRef.current = true;
    setSubmitting(true);
    try {
      const res = await apiFetch<{ returnNumber: string }>('/api/purchase-returns', {
        method: 'POST',
        headers: { 'Idempotency-Key': returnIdempKeyRef.current },
        body: JSON.stringify({
          purchaseId: returnTarget.id,
          settlementType: returnSettlement,
          reason: returnReason,
          lines,
        }),
      });
      returnIdempKeyRef.current = newIdempotencyKey();
      setNotice(`Purchase Return ${res.returnNumber} recorded.`);
      setReturnTarget(null);
      setReturnQuantities({});
      setReturnReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Purchase return failed');
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  const selectedMedForForm = medicines.find((m) => m.id === lineForm.medicineId);
  const purchaseUnits = selectedMedForForm?.units.filter((u) => u.is_active && u.allow_purchase) || [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Purchase Management &amp; Supplier Returns</h1>
          <p className="text-xs text-slate-500">
            Receive supplier stock into batch-wise inventory using medicine-specific manual purchase units.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="Search PO #, invoice #, supplier..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                load(e.target.value);
              }}
              className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white w-56"
            />
          </div>
          {user.permissions['purchases.create'] && (
            <button
              type="button"
              onClick={() => {
                purchaseIdempKeyRef.current = newIdempotencyKey();
                setShowNew(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
            >
              <Plus className="w-4 h-4" />
              New Purchase
            </button>
          )}
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs">{error}</div>}
      {notice && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-xs">{notice}</div>}

      <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Purchase #</th>
              <th className="text-left px-4 py-2.5 font-medium">Supplier / Inv #</th>
              <th className="text-left px-4 py-2.5 font-medium">Date</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-right px-4 py-2.5 font-medium">Total</th>
              <th className="text-right px-4 py-2.5 font-medium">Paid</th>
              <th className="text-right px-4 py-2.5 font-medium">Due</th>
              <th className="text-right px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {purchases.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-2.5 font-mono-num font-semibold text-slate-900">{p.purchase_number}</td>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-slate-900">{p.supplier_name}</div>
                  {p.supplier_invoice_no && <div className="text-slate-400 font-mono-num">Ref: {p.supplier_invoice_no}</div>}
                </td>
                <td className="px-4 py-2.5 font-mono-num">{p.purchase_date}</td>
                <td className="px-4 py-2.5 font-semibold">
                  <span
                    className={
                      p.status === 'RECEIVED'
                        ? 'text-emerald-700'
                        : p.status === 'REVERSED'
                        ? 'text-red-700'
                        : 'text-amber-700'
                    }
                  >
                    {p.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono-num font-medium">{formatBDT(p.net_total)}</td>
                <td className="px-4 py-2.5 text-right font-mono-num">{formatBDT(p.paid_amount)}</td>
                <td className="px-4 py-2.5 text-right font-mono-num text-amber-700 font-medium">{formatBDT(p.due_amount)}</td>
                <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                  {p.status === 'DRAFT' && user.permissions['purchases.receive'] && (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => handleReceiveDraft(p)}
                      className="text-teal-700 hover:underline font-medium disabled:opacity-50"
                    >
                      Receive Stock
                    </button>
                  )}
                  {p.status === 'RECEIVED' && user.permissions['purchases.return'] && (
                    <button
                      type="button"
                      onClick={() => {
                        returnIdempKeyRef.current = newIdempotencyKey();
                        setReturnTarget(p);
                      }}
                      className="inline-flex items-center gap-1 text-amber-700 hover:underline font-medium"
                    >
                      <RotateCcw className="w-3 h-3" /> Return
                    </button>
                  )}
                  {p.status === 'RECEIVED' && user.permissions['purchases.reverse'] && (
                    <button
                      type="button"
                      onClick={() => {
                        reverseIdempKeyRef.current = newIdempotencyKey();
                        setReverseTarget(p);
                      }}
                      className="text-red-700 hover:underline font-medium"
                    >
                      Reverse
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {purchases.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                  No purchases matched or recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSubmitPurchase}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6 space-y-4"
          >
            <h3 className="text-base font-bold text-slate-900">Create / Receive Supplier Purchase</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <label className="block text-slate-600 mb-1">Supplier *</label>
                <select
                  value={supplierId}
                  onChange={(e) => {
                    purchaseIdempKeyRef.current = newIdempotencyKey();
                    setSupplierId(e.target.value);
                  }}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                >
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Supplier Invoice #</label>
                <input
                  type="text"
                  value={supplierInv}
                  onChange={(e) => {
                    purchaseIdempKeyRef.current = newIdempotencyKey();
                    setSupplierInv(e.target.value);
                  }}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Action Mode</label>
                <select
                  value={status}
                  onChange={(e) => {
                    purchaseIdempKeyRef.current = newIdempotencyKey();
                    setStatus(e.target.value as 'DRAFT' | 'RECEIVED');
                  }}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                >
                  <option value="RECEIVED">Receive Immediately (Create Batches)</option>
                  <option value="DRAFT">Save as Draft</option>
                </select>
              </div>
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-2 text-xs">
              <div className="font-semibold text-slate-700">Add Purchase Line</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <select
                  value={lineForm.medicineId}
                  onChange={(e) => {
                    const med = medicines.find((m) => m.id === e.target.value);
                    const u = med?.units.find((x) => x.allow_purchase && x.is_active) || med?.units[0];
                    setLineForm({ ...lineForm, medicineId: e.target.value, unitId: u?.id || '' });
                  }}
                  className="px-2 py-1.5 border border-slate-300 rounded bg-white col-span-2"
                >
                  {medicines.map((m) => (
                    <option key={m.id} value={m.id}>{m.brand_name} {m.strength}</option>
                  ))}
                </select>
                <select
                  value={lineForm.unitId}
                  onChange={(e) => setLineForm({ ...lineForm, unitId: e.target.value })}
                  className="px-2 py-1.5 border border-slate-300 rounded bg-white"
                >
                  {purchaseUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.unit_name} ({formatQty(u.conversion_to_base)} {selectedMedForForm?.base_unit_name})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Batch #"
                  value={lineForm.batchNumber}
                  onChange={(e) => setLineForm({ ...lineForm, batchNumber: e.target.value })}
                  className="px-2 py-1.5 border border-slate-300 rounded font-mono-num"
                />
                <input
                  type="date"
                  value={lineForm.expiryDate}
                  onChange={(e) => setLineForm({ ...lineForm, expiryDate: e.target.value })}
                  className="px-2 py-1.5 border border-slate-300 rounded font-mono-num"
                />
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Qty"
                  value={lineForm.quantityInput}
                  onChange={(e) => setLineForm({ ...lineForm, quantityInput: e.target.value })}
                  className="px-2 py-1.5 border border-slate-300 rounded font-mono-num"
                />
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={`Cost / Purchase Unit (${currencySym})`}
                  value={lineForm.unitCost}
                  onChange={(e) => setLineForm({ ...lineForm, unitCost: e.target.value })}
                  className="px-2 py-1.5 border border-slate-300 rounded font-mono-num"
                />
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={`Sell Price / ${selectedMedForForm?.base_unit_name || 'Base'}`}
                  value={lineForm.sellingPricePerBase}
                  onChange={(e) => setLineForm({ ...lineForm, sellingPricePerBase: e.target.value })}
                  className="px-2 py-1.5 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <button
                type="button"
                onClick={addLineToDraft}
                className="px-3 py-1.5 bg-slate-800 text-white rounded text-xs font-medium"
              >
                Add Line to Purchase
              </button>
            </div>

            {draftLines.length > 0 && (
              <table className="w-full text-xs border border-slate-200">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-3 py-2">Medicine</th>
                    <th className="text-left px-3 py-2">Batch / Exp</th>
                    <th className="text-right px-3 py-2">Qty &amp; Unit</th>
                    <th className="text-right px-3 py-2">Line Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {draftLines.map((dl, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 font-medium">{dl.label}</td>
                      <td className="px-3 py-2 font-mono-num">{dl.batchNumber} · {dl.expiryDate}</td>
                      <td className="px-3 py-2 text-right font-mono-num">
                        {dl.quantityInput} {dl.unitLabel} ({formatQty(new Decimal(dl.quantityInput).mul(new Decimal(dl.conv)).toFixed(6))} base)
                      </td>
                      <td className="px-3 py-2 text-right font-mono-num">
                        {formatBDT(new Decimal(dl.quantityInput).mul(new Decimal(dl.unitCost)).toFixed(2))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {status === 'RECEIVED' && (
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-slate-600 mb-1">Paid Amount Now ({currencySym})</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={paidAmount}
                    onChange={(e) => {
                      purchaseIdempKeyRef.current = newIdempotencyKey();
                      setPaidAmount(e.target.value);
                    }}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Payment Method</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => {
                      purchaseIdempKeyRef.current = newIdempotencyKey();
                      setPaymentMethod(e.target.value as typeof paymentMethod);
                    }}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                  >
                    <option value="CASH">Cash</option>
                    <option value="BANK">Bank Transfer</option>
                    <option value="BKASH">bKash</option>
                  </select>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button type="button" onClick={() => setShowNew(false)} className="px-4 py-2 text-xs bg-slate-100 rounded-md">
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md"
              >
                {submitting ? 'Saving...' : status === 'RECEIVED' ? 'Receive Purchase Atomically' : 'Save Purchase Draft'}
              </button>
            </div>
          </form>
        </div>
      )}

      {returnTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form onSubmit={handleReturnSubmit} className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Purchase Return · {returnTarget.purchase_number}
            </h3>
            <div className="space-y-2 text-xs">
              {returnTarget.lines.map((l) => (
                <div key={l.id} className="flex items-center justify-between p-2.5 border border-slate-200 rounded">
                  <div>
                    <div className="font-medium">{l.brand_name} ({l.batch_number})</div>
                    <div className="text-slate-500 font-mono-num">
                      Purchased: {formatQty(l.qty_base)} {l.base_unit_name} · In Stock: {formatQty(l.batch_current_qty)}
                    </div>
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={`Return (${l.base_unit_name})`}
                    value={returnQuantities[l.id] || ''}
                    onChange={(e) => {
                      returnIdempKeyRef.current = newIdempotencyKey();
                      setReturnQuantities({ ...returnQuantities, [l.id]: e.target.value });
                    }}
                    className="w-36 px-2 py-1.5 border border-slate-300 rounded font-mono-num"
                  />
                </div>
              ))}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="block text-slate-600 mb-1">Settlement</label>
                  <select
                    value={returnSettlement}
                    onChange={(e) => {
                      returnIdempKeyRef.current = newIdempotencyKey();
                      setReturnSettlement(e.target.value as typeof returnSettlement);
                    }}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                  >
                    <option value="SUPPLIER_CREDIT">Supplier Credit (Reduce Payable)</option>
                    <option value="CASH_REFUND">Cash Refund</option>
                    <option value="BANK_REFUND">Bank Refund</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Mandatory Reason *</label>
                  <input
                    type="text"
                    required
                    value={returnReason}
                    onChange={(e) => {
                      returnIdempKeyRef.current = newIdempotencyKey();
                      setReturnReason(e.target.value);
                    }}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded"
                  />
                </div>
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
                {submitting ? 'Processing...' : 'Confirm Purchase Return'}
              </button>
            </div>
          </form>
        </div>
      )}
      <ReasonPromptModal
        open={Boolean(reverseTarget)}
        title={`Reverse Purchase ${reverseTarget?.purchase_number || ''}`}
        description="Reversing a received purchase posts compensating stock and supplier ledger movements while keeping the original document immutable."
        onCancel={() => setReverseTarget(null)}
        onConfirm={confirmReversePurchase}
      />
    </div>
  );
};
