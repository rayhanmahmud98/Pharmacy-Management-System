import React, { useEffect, useState } from 'react';
import { Plus, Wallet } from 'lucide-react';
import { apiFetch, formatBDT } from '../lib/api';
import { ReasonPromptModal } from '../components/ActionModals';
import type { AuthUser } from '../types';

interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string;
  address: string;
  current_balance: string;
  credit_limit: string;
}

interface Supplier {
  id: string;
  code: string;
  name: string;
  contact_person: string;
  phone: string;
  return_policy_days: number;
  current_balance: string;
}

interface PaymentRow {
  id: string;
  payment_number: string;
  party_type: string;
  direction: string;
  method: string;
  amount: string;
  reference_no: string;
  notes: string;
  status: string;
  user_name: string;
  created_at: string;
}

interface Props {
  user: AuthUser;
  writable: boolean;
}

export const PartiesPage: React.FC<Props> = ({ user, writable }) => {
  const [tab, setTab] = useState<'customers' | 'suppliers' | 'payments'>('customers');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [payModal, setPayModal] = useState<{ partyType: 'CUSTOMER' | 'SUPPLIER'; partyId: string; name: string } | null>(null);
  const [payMethod, setPayMethod] = useState<'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD'>('CASH');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');
  const [showAddModal, setShowAddModal] = useState<'CUSTOMER' | 'SUPPLIER' | null>(null);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newAddr, setNewAddr] = useState('');
  const [newLimit, setNewLimit] = useState('5000');
  const [reversePaymentTarget, setReversePaymentTarget] = useState<PaymentRow | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    const res = await apiFetch<{ customers: Customer[]; suppliers: Supplier[]; payments: PaymentRow[] }>('/api/parties');
    setCustomers(res.customers);
    setSuppliers(res.suppliers);
    setPayments(res.payments);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function handlePaymentSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!payModal) return;
    setError('');
    try {
      const res = await apiFetch<{ paymentNumber: string }>('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          partyType: payModal.partyType,
          partyId: payModal.partyId,
          method: payMethod,
          amount: payAmount,
          referenceNo: payRef,
        }),
      });
      setNotice(`Payment ${res.paymentNumber} posted (${payMethod} ${formatBDT(payAmount)}).`);
      setPayModal(null);
      setPayAmount('');
      setPayRef('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed');
    }
  }

  async function handleAddParty(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (showAddModal === 'CUSTOMER') {
        await apiFetch('/api/customers', {
          method: 'POST',
          body: JSON.stringify({ name: newName, phone: newPhone, address: newAddr, creditLimit: newLimit }),
        });
      } else {
        await apiFetch('/api/suppliers', {
          method: 'POST',
          body: JSON.stringify({ name: newName, phone: newPhone, address: newAddr, returnPolicyDays: 30 }),
        });
      }
      setNotice(`${showAddModal === 'CUSTOMER' ? 'Customer' : 'Supplier'} '${newName}' added.`);
      setShowAddModal(null);
      setNewName('');
      setNewPhone('');
      setNewAddr('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save party');
    }
  }

  function handleReversePayment(p: PaymentRow) {
    setReversePaymentTarget(p);
  }

  async function confirmReversePayment(reason: string) {
    if (!reversePaymentTarget) return;
    setError('');
    try {
      await apiFetch(`/api/payments/${reversePaymentTarget.id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setNotice(`Payment ${reversePaymentTarget.payment_number} reversed.`);
      setReversePaymentTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment reversal failed');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Customers, Suppliers & Payment Ledger</h1>
          <p className="text-xs text-slate-500">
            Transaction-based dues & manual Cash/MFS/Bank payment allocations. Only Cash payments affect the physical drawer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {user.permissions['parties.manage'] && (
            <>
              <button
                type="button"
                disabled={!writable}
                onClick={() => setShowAddModal('CUSTOMER')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md"
              >
                <Plus className="w-3.5 h-3.5" /> Add Customer
              </button>
              <button
                type="button"
                disabled={!writable}
                onClick={() => setShowAddModal('SUPPLIER')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md"
              >
                <Plus className="w-3.5 h-3.5" /> Add Supplier
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs">{error}</div>}
      {notice && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-xs">{notice}</div>}

      <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        {[
          { id: 'customers', label: `Customers (${customers.length})` },
          { id: 'suppliers', label: `Suppliers (${suppliers.length})` },
          { id: 'payments', label: `Payments Ledger (${payments.length})` },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as typeof tab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'customers' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Code · Name</th>
                <th className="text-left px-4 py-2.5 font-medium">Phone & Address</th>
                <th className="text-right px-4 py-2.5 font-medium">Credit Limit</th>
                <th className="text-right px-4 py-2.5 font-medium">Current Due</th>
                <th className="text-right px-4 py-2.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {customers.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-slate-900">{c.name}</div>
                    <div className="font-mono-num text-slate-400">{c.code}</div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{c.phone || '—'} {c.address ? `· ${c.address}` : ''}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">{formatBDT(c.credit_limit)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono-num font-bold ${Number(c.current_balance) > 0 ? 'text-amber-700' : 'text-slate-800'}`}>
                    {formatBDT(c.current_balance)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {user.permissions['payments.record'] && c.code !== 'CUST-WALKIN' && (
                      <button
                        type="button"
                        disabled={!writable}
                        onClick={() => setPayModal({ partyType: 'CUSTOMER', partyId: c.id, name: c.name })}
                        className="inline-flex items-center gap-1 text-teal-700 hover:underline font-medium"
                      >
                        <Wallet className="w-3.5 h-3.5" /> Collect Due
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'suppliers' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Code · Supplier</th>
                <th className="text-left px-4 py-2.5 font-medium">Contact & Policy</th>
                <th className="text-right px-4 py-2.5 font-medium">Payable Due</th>
                <th className="text-right px-4 py-2.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {suppliers.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-slate-900">{s.name}</div>
                    <div className="font-mono-num text-slate-400">{s.code}</div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {s.contact_person} ({s.phone}) · Return window: {s.return_policy_days} days
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono-num font-bold ${Number(s.current_balance) > 0 ? 'text-red-700' : 'text-slate-800'}`}>
                    {formatBDT(s.current_balance)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {user.permissions['payments.record'] && (
                      <button
                        type="button"
                        disabled={!writable}
                        onClick={() => setPayModal({ partyType: 'SUPPLIER', partyId: s.id, name: s.name })}
                        className="inline-flex items-center gap-1 text-teal-700 hover:underline font-medium"
                      >
                        <Wallet className="w-3.5 h-3.5" /> Pay Supplier
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'payments' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Payment #</th>
                <th className="text-left px-4 py-2.5 font-medium">Party / Dir</th>
                <th className="text-left px-4 py-2.5 font-medium">Method / Ref</th>
                <th className="text-right px-4 py-2.5 font-medium">Amount</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-right px-4 py-2.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2.5 font-mono-num font-semibold">{p.payment_number}</td>
                  <td className="px-4 py-2.5">{p.party_type} · {p.direction}</td>
                  <td className="px-4 py-2.5">
                    {p.method} {p.reference_no ? `(${p.reference_no})` : ''}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono-num font-semibold">{formatBDT(p.amount)}</td>
                  <td className="px-4 py-2.5 font-semibold">
                    <span className={p.status === 'POSTED' ? 'text-emerald-700' : 'text-red-700'}>{p.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {p.status === 'POSTED' && user.permissions['payments.reverse'] && (
                      <button
                        type="button"
                        disabled={!writable}
                        onClick={() => handleReversePayment(p)}
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

      {payModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form onSubmit={handlePaymentSubmit} className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3">
            <h3 className="text-base font-bold text-slate-900">
              {payModal.partyType === 'CUSTOMER' ? 'Collect Customer Due' : 'Pay Supplier'} · {payModal.name}
            </h3>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-600 mb-1">Payment Method</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                >
                  <option value="CASH">Cash (Updates Physical Drawer)</option>
                  <option value="BKASH">bKash (Non-Cash)</option>
                  <option value="NAGAD">Nagad (Non-Cash)</option>
                  <option value="ROCKET">Rocket (Non-Cash)</option>
                  <option value="BANK">Bank Transfer (Non-Cash)</option>
                  <option value="CARD">Card (Non-Cash)</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Amount (৳)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Transaction / Reference #</label>
                <input
                  type="text"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button type="button" onClick={() => setPayModal(null)} className="px-4 py-2 text-xs bg-slate-100 rounded-md">
                Cancel
              </button>
              <button type="submit" className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                Post Payment
              </button>
            </div>
          </form>
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form onSubmit={handleAddParty} className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3">
            <h3 className="text-base font-bold text-slate-900">
              Add {showAddModal === 'CUSTOMER' ? 'Customer' : 'Supplier'}
            </h3>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-600 mb-1">Name *</label>
                <input type="text" required value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full px-2.5 py-2 border border-slate-300 rounded" />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Phone</label>
                <input type="text" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} className="w-full px-2.5 py-2 border border-slate-300 rounded" />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Address</label>
                <input type="text" value={newAddr} onChange={(e) => setNewAddr(e.target.value)} className="w-full px-2.5 py-2 border border-slate-300 rounded" />
              </div>
              {showAddModal === 'CUSTOMER' && (
                <div>
                  <label className="block text-slate-600 mb-1">Credit Limit (৳, 0 = Unlimited)</label>
                  <input type="number" min="0" value={newLimit} onChange={(e) => setNewLimit(e.target.value)} className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num" />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button type="button" onClick={() => setShowAddModal(null)} className="px-4 py-2 text-xs bg-slate-100 rounded-md">Cancel</button>
              <button type="submit" className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md">Save</button>
            </div>
          </form>
        </div>
      )}
      <ReasonPromptModal
        open={Boolean(reversePaymentTarget)}
        title={`Reverse Payment ${reversePaymentTarget?.payment_number || ''}`}
        description="Reversing a posted payment creates a compensating cash/party ledger adjustment and marks the entry reversed."
        onCancel={() => setReversePaymentTarget(null)}
        onConfirm={confirmReversePayment}
      />
    </div>
  );
};
