import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, PackageX, ShoppingCart, Wallet } from 'lucide-react';
import { apiFetch, formatBDT, formatQty } from '../lib/api';

interface DashboardData {
  today: string;
  kpis: {
    todaySaleCount: number;
    todayNetSales: string;
    todayGrossProfit: string;
    todayExpenses: string;
    customerDueTotal: string;
    supplierDueTotal: string;
    activeDrawerExpectedCash: string | null;
    activeCashSessionNumber: string | null;
  };
  alerts: {
    expiryWarningDays: number;
    nearExpiryBatches: Array<{
      id: string;
      batch_number: string;
      expiry_date: string;
      current_qty_base: string;
      base_unit_name: string;
      brand_name: string;
      strength: string;
    }>;
    expiredBatches: Array<{
      id: string;
      batch_number: string;
      expiry_date: string;
      current_qty_base: string;
      base_unit_name: string;
      brand_name: string;
      strength: string;
    }>;
    lowStockMeds: Array<{
      id: string;
      brand_name: string;
      strength: string;
      base_unit_name: string;
      min_stock_level: string;
      sellable_stock: number;
    }>;
  };
}

interface Props {
  onNavigate: (tab: string) => void;
  canViewProfit: boolean;
}

export const DashboardPage: React.FC<Props> = ({ onNavigate, canViewProfit }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<DashboardData>('/api/dashboard')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return <div className="p-4 bg-red-50 border border-red-200 text-red-800 rounded-md text-sm">{error}</div>;
  }
  if (!data) {
    return <div className="p-6 text-sm text-slate-500">Loading pharmacy operational overview...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Pharmacy Operations Overview</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Business Date: {data.today} · Expiry Warning Window: {data.alerts.expiryWarningDays} days
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('pos')}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap shrink-0"
        >
          <ShoppingCart className="w-4 h-4" />
          Open POS Counter
        </button>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Today's Net Sales</div>
          <div className="text-2xl font-bold text-slate-900 font-mono-num mt-1">
            {formatBDT(data.kpis.todayNetSales)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {data.kpis.todaySaleCount} completed invoice{data.kpis.todaySaleCount === 1 ? '' : 's'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Today's Gross Profit (Batch COGS)</div>
          <div className="text-2xl font-bold text-emerald-700 font-mono-num mt-1">
            {canViewProfit ? formatBDT(data.kpis.todayGrossProfit) : 'Restricted'}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Expenses today: {formatBDT(data.kpis.todayExpenses)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Physical Cash Drawer</span>
            <Wallet className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-2xl font-bold text-slate-900 font-mono-num mt-1">
            {data.kpis.activeDrawerExpectedCash !== null
              ? formatBDT(data.kpis.activeDrawerExpectedCash)
              : 'Session Closed'}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {data.kpis.activeCashSessionNumber || 'Open a session in Finance'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Outstanding Receivables / Payables</div>
          <div className="text-lg font-bold text-slate-900 font-mono-num mt-1">
            Due In: {formatBDT(data.kpis.customerDueTotal)}
          </div>
          <div className="text-xs text-slate-600 font-mono-num mt-1">
            Supplier Payable: {formatBDT(data.kpis.supplierDueTotal)}
          </div>
        </div>
      </div>

      {/* Actionable Inventory & Expiry Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Expired & Near Expiry */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <h2 className="text-sm font-semibold text-slate-900">Expiry & Quarantine Watch</h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800"
            >
              Manage Batches <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Medicine / Batch</th>
                  <th className="text-left px-4 py-2 font-medium">Expiry</th>
                  <th className="text-right px-4 py-2 font-medium">Stock</th>
                  <th className="text-left px-4 py-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.alerts.expiredBatches.map((b) => (
                  <tr key={b.id} className="bg-red-50/40">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{b.brand_name} {b.strength}</div>
                      <div className="text-slate-500 font-mono-num">{b.batch_number}</div>
                    </td>
                    <td className="px-4 py-2.5 font-mono-num text-red-700 font-medium">{b.expiry_date}</td>
                    <td className="px-4 py-2.5 text-right font-mono-num">
                      {formatQty(b.current_qty_base)} {b.base_unit_name}
                    </td>
                    <td className="px-4 py-2.5 text-red-700 font-semibold">EXPIRED (Blocked)</td>
                  </tr>
                ))}
                {data.alerts.nearExpiryBatches.map((b) => (
                  <tr key={b.id}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{b.brand_name} {b.strength}</div>
                      <div className="text-slate-500 font-mono-num">{b.batch_number}</div>
                    </td>
                    <td className="px-4 py-2.5 font-mono-num text-amber-700 font-medium">{b.expiry_date}</td>
                    <td className="px-4 py-2.5 text-right font-mono-num">
                      {formatQty(b.current_qty_base)} {b.base_unit_name}
                    </td>
                    <td className="px-4 py-2.5 text-amber-700 font-medium">Near Expiry (FEFO First)</td>
                  </tr>
                ))}
                {data.alerts.expiredBatches.length === 0 && data.alerts.nearExpiryBatches.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                      No expired or near-expiry batches within {data.alerts.expiryWarningDays} days.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Low Stock Medicines */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <PackageX className="w-4 h-4 text-slate-600" />
              <h2 className="text-sm font-semibold text-slate-900">Low Stock Reorder Alerts</h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('purchases')}
              className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800"
            >
              Create Purchase <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Medicine</th>
                  <th className="text-right px-4 py-2 font-medium">Sellable Stock</th>
                  <th className="text-right px-4 py-2 font-medium">Minimum Level</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.alerts.lowStockMeds.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      {m.brand_name} {m.strength}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono-num text-red-700 font-semibold">
                      {formatQty(m.sellable_stock)} {m.base_unit_name}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono-num text-slate-600">
                      {formatQty(m.min_stock_level)} {m.base_unit_name}
                    </td>
                  </tr>
                ))}
                {data.alerts.lowStockMeds.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                      All active medicines are above their configured minimum stock level.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
