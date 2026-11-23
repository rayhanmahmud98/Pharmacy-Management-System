import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Plus, Search, Trash2 } from 'lucide-react';
import { apiFetch, formatBDT, formatQty } from '../lib/api';
import type { AuthUser, Medicine, PharmacySettings, SaleRecord } from '../types';
import { ReceiptPrintModal } from '../components/ReceiptPrintModal';

interface CustomerOption {
  id: string;
  code: string;
  name: string;
  phone: string;
  current_balance: string;
  credit_limit: string;
}

interface CartLine {
  key: string;
  medicine: Medicine;
  unitId: string;
  quantityInput: string;
  unitPrice: string;
  lineDiscount: string;
  manualBatchId: string;
  manualOverrideReason: string;
}

interface PaymentEntry {
  key: string;
  method: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
  amount: string;
  referenceNo: string;
}

interface Props {
  user: AuthUser;
  settings: PharmacySettings;
  writable: boolean;
}

export const PosPage: React.FC<Props> = ({ user, settings, writable }) => {
  const [search, setSearch] = useState('');
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [invoiceDiscount, setInvoiceDiscount] = useState('0');
  const [payments, setPayments] = useState<PaymentEntry[]>([
    { key: 'p1', method: 'CASH', amount: '', referenceNo: '' },
  ]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [completedSale, setCompletedSale] = useState<SaleRecord | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  async function loadCatalog(q = '') {
    const [medRes, partyRes] = await Promise.all([
      apiFetch<{ medicines: Medicine[] }>(`/api/medicines?search=${encodeURIComponent(q)}`),
      apiFetch<{ customers: CustomerOption[] }>('/api/parties'),
    ]);
    setMedicines(medRes.medicines);
    setCustomers(partyRes.customers);
    if (!selectedCustomerId && partyRes.customers.length > 0) {
      const walkin = partyRes.customers.find((c) => c.code === 'CUST-WALKIN') || partyRes.customers[0];
      setSelectedCustomerId(walkin.id);
    }
  }

  useEffect(() => {
    loadCatalog('').catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const filteredMeds = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return medicines;
    return medicines.filter(
      (m) =>
        m.brand_name.toLowerCase().includes(q) ||
        m.generic_name.toLowerCase().includes(q) ||
        m.bangla_name.toLowerCase().includes(q) ||
        m.strength.toLowerCase().includes(q)
    );
  }, [medicines, search]);

  function addMedicineToCart(med: Medicine) {
    setError('');
    setSuccessMsg('');
    const saleUnits = med.units.filter((u) => u.is_active && u.allow_sale);
    const defaultUnit = saleUnits.find((u) => !u.is_base) || saleUnits[0];
    if (!defaultUnit) {
      setError(`No active sale unit configured for ${med.brand_name}`);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const activeBatches = med.batches.filter((b) => b.status === 'ACTIVE' && b.expiry_date > today && Number(b.current_qty_base) > 0);
    const baseSellingPrice = Number(activeBatches[0]?.selling_price_per_base || 0);
    const unitPrice = (baseSellingPrice * Number(defaultUnit.conversion_to_base)).toFixed(2);

    setCart((prev) => [
      ...prev,
      {
        key: `${med.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        medicine: med,
        unitId: defaultUnit.id,
        quantityInput: '1',
        unitPrice,
        lineDiscount: '0',
        manualBatchId: '',
        manualOverrideReason: '',
      },
    ]);
  }

  function updateCartLine(key: string, patch: Partial<CartLine>) {
    setCart((prev) =>
      prev.map((line) => {
        if (line.key !== key) return line;
        const updated = { ...line, ...patch };
        if (patch.unitId && patch.unitId !== line.unitId) {
          const newUnit = line.medicine.units.find((u) => u.id === patch.unitId);
          const today = new Date().toISOString().slice(0, 10);
          const activeBatch = line.medicine.batches.find((b) => b.status === 'ACTIVE' && b.expiry_date > today);
          if (newUnit && activeBatch) {
            updated.unitPrice = (Number(activeBatch.selling_price_per_base) * Number(newUnit.conversion_to_base)).toFixed(2);
          }
        }
        return updated;
      })
    );
  }

  const cartSummary = useMemo(() => {
    let gross = 0;
    let lineDisc = 0;
    for (const l of cart) {
      const q = Number(l.quantityInput || 0);
      const p = Number(l.unitPrice || 0);
      const d = Number(l.lineDiscount || 0);
      gross += q * p;
      lineDisc += d;
    }
    const invDisc = Number(invoiceDiscount || 0);
    const net = Math.max(0, gross - lineDisc - invDisc);
    const paid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const due = Math.max(0, net - paid);
    return { gross, lineDisc, invDisc, net, paid, due };
  }, [cart, invoiceDiscount, payments]);

  function fillExactCash() {
    setPayments([{ key: 'p1', method: 'CASH', amount: cartSummary.net.toFixed(2), referenceNo: '' }]);
  }

  async function handleCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!writable) {
      setError('License is in Read-Only mode. Sales cannot be posted.');
      return;
    }
    setError('');
    setSuccessMsg('');
    setSubmitting(true);
    try {
      const res = await apiFetch<{ saleId: string; invoiceNumber: string; netTotal: string }>('/api/sales', {
        method: 'POST',
        body: JSON.stringify({
          customerId: selectedCustomerId || null,
          invoiceDiscount: invoiceDiscount || '0',
          notes,
          lines: cart.map((l) => ({
            medicineId: l.medicine.id,
            unitId: l.unitId,
            quantityInput: l.quantityInput,
            unitPrice: l.unitPrice,
            lineDiscount: l.lineDiscount || '0',
            manualBatchId: l.manualBatchId || null,
            manualOverrideReason: l.manualOverrideReason,
          })),
          payments: payments.filter((p) => Number(p.amount) > 0),
        }),
      });

      const salesData = await apiFetch<{ sales: SaleRecord[] }>('/api/sales');
      const created = salesData.sales.find((s) => s.id === res.saleId) || null;
      setCompletedSale(created);
      setSuccessMsg(`Sale ${res.invoiceNumber} completed (${formatBDT(res.netTotal)})`);
      setCart([]);
      setInvoiceDiscount('0');
      setNotes('');
      setPayments([{ key: 'p1', method: 'CASH', amount: '', referenceNo: '' }]);
      await loadCatalog(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setSubmitting(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Point of Sale (FEFO Counter)</h1>
          <p className="text-xs text-slate-500">
            Press <kbd className="px-1.5 py-0.5 bg-slate-200 rounded text-[11px] font-mono-num">F2</kbd> to focus medicine search · Expired & quarantined batches are automatically excluded
          </p>
        </div>
        {successMsg && (
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-xs font-medium">
            <CheckCircle2 className="w-4 h-4" />
            {successMsg}
          </div>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs font-medium">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left: Medicine Search & Quick Select */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-3 border-b border-slate-200">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                ref={searchRef}
                type="text"
                aria-label="Search medicine by brand, generic, strength, or Bangla name"
                placeholder="Search brand, generic, strength, বাংলা নাম..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div className="max-h-[580px] overflow-y-auto divide-y divide-slate-100">
            {filteredMeds.map((med) => {
              const sellable = Number(med.sellable_stock_base || 0);
              const earliestActive = med.batches.find((b) => b.status === 'ACTIVE' && b.expiry_date > today && Number(b.current_qty_base) > 0);
              return (
                <button
                  key={med.id}
                  type="button"
                  onClick={() => addMedicineToCart(med)}
                  disabled={sellable <= 0}
                  className="w-full text-left px-4 py-3 hover:bg-teal-50/50 disabled:opacity-50 transition-colors flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 truncate">
                      {med.brand_name} {med.strength}
                      {med.rx_required ? <span className="ml-2 text-[11px] text-amber-700 font-medium">Rx</span> : null}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {med.generic_name} {med.bangla_name ? `· ${med.bangla_name}` : ''}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 font-mono-num">
                      {earliestActive
                        ? `FEFO: ${earliestActive.batch_number} · Exp ${earliestActive.expiry_date} · ${formatBDT(earliestActive.selling_price_per_base)}/${med.base_unit_name}`
                        : 'No sellable active batch'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-xs font-mono-num font-bold ${sellable > 0 ? 'text-teal-700' : 'text-red-700'}`}>
                      {formatQty(sellable)} {med.base_unit_name}
                    </div>
                    <div className="text-[11px] text-slate-400">Add to bill</div>
                  </div>
                </button>
              );
            })}
            {filteredMeds.length === 0 && (
              <div className="p-6 text-center text-xs text-slate-500">No medicines matched "{search}".</div>
            )}
          </div>
        </div>

        {/* Right: Active Bill / Checkout */}
        <form onSubmit={handleCheckout} className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
            <div className="flex-1 min-w-[220px]">
              <label htmlFor="pos-customer" className="block text-xs font-medium text-slate-600 mb-1">
                Customer Account
              </label>
              <select
                id="pos-customer"
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white"
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.phone ? `(${c.phone})` : ''} {Number(c.current_balance) > 0 ? `— Due ${formatBDT(c.current_balance)}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500">Cart Items</div>
              <div className="text-base font-bold font-mono-num text-slate-900">{cart.length} lines</div>
            </div>
          </div>

          {/* Cart Table */}
          {cart.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-md">
              Select medicines from the left catalog to start billing.
            </div>
          ) : (
            <div className="space-y-3">
              {cart.map((line) => {
                const saleUnits = line.medicine.units.filter((u) => u.is_active && u.allow_sale);
                const selectedUnit = saleUnits.find((u) => u.id === line.unitId) || saleUnits[0];
                const conv = Number(selectedUnit?.conversion_to_base || 1);
                const qtyBase = Number(line.quantityInput || 0) * conv;
                const lineNet = Math.max(
                  0,
                  Number(line.quantityInput || 0) * Number(line.unitPrice || 0) - Number(line.lineDiscount || 0)
                );
                const activeBatches = line.medicine.batches.filter(
                  (b) => b.status === 'ACTIVE' && b.expiry_date > today && Number(b.current_qty_base) > 0
                );

                return (
                  <div key={line.key} className="p-3 border border-slate-200 rounded-md space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">
                          {line.medicine.brand_name} {line.medicine.strength}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono-num">
                          1 {selectedUnit?.unit_name} = {formatQty(conv)} {line.medicine.base_unit_name} · Base deduction:{' '}
                          {formatQty(qtyBase)} {line.medicine.base_unit_name}
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${line.medicine.brand_name}`}
                        onClick={() => setCart((prev) => prev.filter((c) => c.key !== line.key))}
                        className="p-1.5 text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
                      <div className="col-span-2 sm:col-span-2">
                        <label className="block text-[11px] text-slate-500 mb-0.5">Unit</label>
                        <select
                          aria-label={`Unit for ${line.medicine.brand_name}`}
                          value={line.unitId}
                          onChange={(e) => updateCartLine(line.key, { unitId: e.target.value })}
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded bg-white"
                        >
                          {saleUnits.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.unit_name} ({formatQty(u.conversion_to_base)} {line.medicine.base_unit_name})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-0.5">Qty</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          aria-label={`Quantity for ${line.medicine.brand_name}`}
                          value={line.quantityInput}
                          onChange={(e) => updateCartLine(line.key, { quantityInput: e.target.value })}
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded font-mono-num"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-0.5">Price / Unit</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          aria-label={`Price for ${line.medicine.brand_name}`}
                          value={line.unitPrice}
                          onChange={(e) => updateCartLine(line.key, { unitPrice: e.target.value })}
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded font-mono-num"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-0.5">Line Disc (৳)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          disabled={!user.permissions['pos.discount']}
                          aria-label={`Discount for ${line.medicine.brand_name}`}
                          value={line.lineDiscount}
                          onChange={(e) => updateCartLine(line.key, { lineDiscount: e.target.value })}
                          className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded font-mono-num disabled:bg-slate-100"
                        />
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-slate-500">Line Total</div>
                        <div className="text-sm font-bold font-mono-num text-slate-900">{formatBDT(lineNet)}</div>
                      </div>
                    </div>

                    {user.permissions['pos.manual_batch'] && activeBatches.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                        <select
                          aria-label={`Batch allocation for ${line.medicine.brand_name}`}
                          value={line.manualBatchId}
                          onChange={(e) => updateCartLine(line.key, { manualBatchId: e.target.value })}
                          className="px-2 py-1 text-[11px] border border-slate-200 rounded bg-slate-50"
                        >
                          <option value="">Auto FEFO Batch Allocation (Recommended)</option>
                          {activeBatches.map((b) => (
                            <option key={b.id} value={b.id}>
                              Manual: {b.batch_number} · Exp {b.expiry_date} ({formatQty(b.current_qty_base)} avail)
                            </option>
                          ))}
                        </select>
                        {line.manualBatchId && (
                          <input
                            type="text"
                            placeholder="Mandatory reason for manual batch override..."
                            value={line.manualOverrideReason}
                            onChange={(e) => updateCartLine(line.key, { manualOverrideReason: e.target.value })}
                            required
                            className="px-2 py-1 text-[11px] border border-amber-300 rounded bg-amber-50/40"
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Discount & Split Payment Section */}
          <div className="pt-3 border-t border-slate-200 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700 whitespace-nowrap">Payments (Cash / MFS / Bank)</span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={fillExactCash}
                    className="text-[11px] font-medium text-teal-700 hover:underline whitespace-nowrap"
                  >
                    Exact Cash
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPayments((prev) => [
                        ...prev,
                        { key: `p-${Date.now()}`, method: 'BKASH', amount: '', referenceNo: '' },
                      ])
                    }
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-700 hover:text-slate-900 whitespace-nowrap"
                  >
                    <Plus className="w-3 h-3 shrink-0" /> Split Pay
                  </button>
                </div>
              </div>

              {payments.map((p, idx) => (
                <div key={p.key} className="grid grid-cols-12 gap-1.5 items-center">
                  <select
                    aria-label={`Payment method ${idx + 1}`}
                    value={p.method}
                    onChange={(e) =>
                      setPayments((prev) =>
                        prev.map((x) =>
                          x.key === p.key ? { ...x, method: e.target.value as PaymentEntry['method'] } : x
                        )
                      )
                    }
                    className="col-span-4 px-2 py-1.5 text-xs border border-slate-300 rounded bg-white"
                  >
                    <option value="CASH">Cash</option>
                    <option value="BKASH">bKash</option>
                    <option value="NAGAD">Nagad</option>
                    <option value="ROCKET">Rocket</option>
                    <option value="BANK">Bank</option>
                    <option value="CARD">Card</option>
                    <option value="OTHER">Other</option>
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Amount"
                    aria-label={`Payment amount ${idx + 1}`}
                    value={p.amount}
                    onChange={(e) =>
                      setPayments((prev) =>
                        prev.map((x) => (x.key === p.key ? { ...x, amount: e.target.value } : x))
                      )
                    }
                    className="col-span-4 px-2 py-1.5 text-xs border border-slate-300 rounded font-mono-num"
                  />
                  <input
                    type="text"
                    placeholder="Ref / TrxID"
                    aria-label={`Payment reference ${idx + 1}`}
                    value={p.referenceNo}
                    onChange={(e) =>
                      setPayments((prev) =>
                        prev.map((x) => (x.key === p.key ? { ...x, referenceNo: e.target.value } : x))
                      )
                    }
                    className="col-span-4 px-2 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
              ))}
              <input
                type="text"
                placeholder="Optional invoice notes..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
              />
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-600">Gross Subtotal</span>
                <span className="font-mono-num font-medium">{formatBDT(cartSummary.gross)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Line Discounts</span>
                <span className="font-mono-num">-{formatBDT(cartSummary.lineDisc)}</span>
              </div>
              <div className="flex justify-between items-center gap-2">
                <label htmlFor="pos-inv-disc" className="text-slate-600">
                  Invoice Discount (৳)
                </label>
                <input
                  id="pos-inv-disc"
                  type="number"
                  step="0.01"
                  min="0"
                  disabled={!user.permissions['pos.discount']}
                  value={invoiceDiscount}
                  onChange={(e) => setInvoiceDiscount(e.target.value)}
                  className="w-24 px-2 py-1 text-right font-mono-num border border-slate-300 rounded bg-white disabled:bg-slate-100"
                />
              </div>
              <div className="flex justify-between pt-2 border-t border-slate-300 text-sm font-bold text-slate-900">
                <span>Net Total</span>
                <span className="font-mono-num">{formatBDT(cartSummary.net)}</span>
              </div>
              <div className="flex justify-between text-slate-700">
                <span>Total Paid</span>
                <span className="font-mono-num font-medium">{formatBDT(cartSummary.paid)}</span>
              </div>
              <div className="flex justify-between font-semibold text-amber-700">
                <span>Balance Due</span>
                <span className="font-mono-num">{formatBDT(cartSummary.due)}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                setCart([]);
                setInvoiceDiscount('0');
                setPayments([{ key: 'p1', method: 'CASH', amount: '', referenceNo: '' }]);
              }}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
            >
              Clear Bill
            </button>
            <button
              type="submit"
              disabled={submitting || cart.length === 0 || !writable}
              className="px-6 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md"
            >
              {submitting ? 'Processing Atomic Sale...' : 'Complete Sale & Print'}
            </button>
          </div>
        </form>
      </div>

      {completedSale && (
        <ReceiptPrintModal
          sale={completedSale}
          settings={settings}
          onClose={() => setCompletedSale(null)}
        />
      )}
    </div>
  );
};
