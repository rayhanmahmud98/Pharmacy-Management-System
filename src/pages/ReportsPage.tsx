import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { apiFetch, formatBDT, formatQty } from '../lib/api';

interface ReportPayload {
  filters: { fromDate: string; toDate: string };
  profitSummary: {
    grossSales: string;
    totalDiscount: string;
    netSales: string;
    salesReturns: string;
    netSalesAfterReturns: string;
    cogs: string;
    cogsReversedOnReturns: string;
    netCogs: string;
    grossProfit: string;
  };
  salesByMedicine: Array<{
    id: string;
    brand_name: string;
    generic_name: string;
    base_unit_name: string;
    category_name: string;
    total_qty_base: number;
    total_revenue: number;
    total_cogs: number;
  }>;
  collectionsByMethod: Array<{
    method: string;
    inflow: number;
    outflow: number;
  }>;
  inventoryValuation: Array<{
    id: string;
    brand_name: string;
    strength: string;
    base_unit_name: string;
    sellable_qty: number;
    cost_valuation: number;
    retail_valuation: number;
    sold_in_period: number;
  }>;
}

export const ReportsPage: React.FC = () => {
  const today = new Date().toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState(`${today.slice(0, 8)}01`);
  const [toDate, setToDate] = useState(today);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [tab, setTab] = useState<'profit' | 'sales' | 'inventory' | 'collections'>('profit');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    const res = await apiFetch<ReportPayload>(
      `/api/reports?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`
    );
    setReport(res);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Pharmacy Financial, Profit & Inventory Reports</h1>
          <p className="text-xs text-slate-500">
            Historical profit uses actual batch COGS snapshots at time of sale (never current cost).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            type="date"
            aria-label="Report from date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono-num"
          />
          <span className="text-slate-400">to</span>
          <input
            type="date"
            aria-label="Report to date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono-num"
          />
          <button
            type="button"
            onClick={load}
            className="px-3 py-1.5 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded"
          >
            Apply Filter
          </button>
          <a
            href={`/api/reports/export?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded"
          >
            <Download className="w-3.5 h-3.5" />
            Export Excel (.xlsx)
          </a>
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs">{error}</div>}

      <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        {[
          { id: 'profit', label: 'Profit & Historical COGS' },
          { id: 'sales', label: 'Sales by Medicine' },
          { id: 'collections', label: 'Collections by Method' },
          { id: 'inventory', label: 'Inventory Valuation & Movement' },
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

      {report && tab === 'profit' && (
        <div className="bg-white border border-slate-200 rounded-lg p-5 max-w-xl">
          <h2 className="text-sm font-bold text-slate-900 mb-3">
            Gross Profit Statement ({report.filters.fromDate} to {report.filters.toDate})
          </h2>
          <div className="space-y-2 text-xs font-mono-num">
            <div className="flex justify-between">
              <span className="font-sans text-slate-600">Gross Sales</span>
              <span>{formatBDT(report.profitSummary.grossSales)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span className="font-sans">- Line & Invoice Discounts</span>
              <span>-{formatBDT(report.profitSummary.totalDiscount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="font-sans text-slate-700 font-medium">Net Sales (Before Returns)</span>
              <span>{formatBDT(report.profitSummary.netSales)}</span>
            </div>
            <div className="flex justify-between text-red-700">
              <span className="font-sans">- Sales Returns</span>
              <span>-{formatBDT(report.profitSummary.salesReturns)}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-slate-200 font-semibold text-slate-900">
              <span className="font-sans">Net Revenue</span>
              <span>{formatBDT(report.profitSummary.netSalesAfterReturns)}</span>
            </div>
            <div className="flex justify-between pt-2">
              <span className="font-sans text-slate-600">Historical Batch COGS</span>
              <span>{report.profitSummary.cogs === 'RESTRICTED' ? 'RESTRICTED' : formatBDT(report.profitSummary.cogs)}</span>
            </div>
            <div className="flex justify-between text-emerald-700">
              <span className="font-sans">- COGS Reversed on Returns</span>
              <span>
                {report.profitSummary.cogsReversedOnReturns === 'RESTRICTED'
                  ? 'RESTRICTED'
                  : formatBDT(report.profitSummary.cogsReversedOnReturns)}
              </span>
            </div>
            <div className="flex justify-between pt-2 border-t border-slate-300 text-sm font-bold text-emerald-700">
              <span className="font-sans">Gross Profit</span>
              <span>
                {report.profitSummary.grossProfit === 'RESTRICTED'
                  ? 'RESTRICTED'
                  : formatBDT(report.profitSummary.grossProfit)}
              </span>
            </div>
          </div>
        </div>
      )}

      {report && tab === 'sales' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5">Medicine</th>
                <th className="text-left px-4 py-2.5">Category</th>
                <th className="text-right px-4 py-2.5">Qty Sold (Base)</th>
                <th className="text-right px-4 py-2.5">Revenue</th>
                <th className="text-right px-4 py-2.5">Batch COGS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.salesByMedicine.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5 font-medium">{r.brand_name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{r.category_name}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">
                    {formatQty(r.total_qty_base)} {r.base_unit_name}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono-num font-semibold">{formatBDT(r.total_revenue)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">{formatBDT(r.total_cogs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && tab === 'collections' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto max-w-2xl">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5">Payment Method</th>
                <th className="text-right px-4 py-2.5">Cash/MFS Inflow</th>
                <th className="text-right px-4 py-2.5">Outflow (Supplier/Refund)</th>
                <th className="text-right px-4 py-2.5">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.collectionsByMethod.map((c) => (
                <tr key={c.method}>
                  <td className="px-4 py-2.5 font-semibold">{c.method}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num text-emerald-700">{formatBDT(c.inflow)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num text-red-700">{formatBDT(c.outflow)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num font-bold">{formatBDT(c.inflow - c.outflow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && tab === 'inventory' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5">Medicine</th>
                <th className="text-right px-4 py-2.5">Sellable Stock</th>
                <th className="text-right px-4 py-2.5">Cost Valuation</th>
                <th className="text-right px-4 py-2.5">Retail Valuation</th>
                <th className="text-right px-4 py-2.5">Sold in Period</th>
                <th className="text-left px-4 py-2.5">Velocity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.inventoryValuation.map((iv) => (
                <tr key={iv.id}>
                  <td className="px-4 py-2.5 font-medium">{iv.brand_name} {iv.strength}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">
                    {formatQty(iv.sellable_qty)} {iv.base_unit_name}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono-num">{formatBDT(iv.cost_valuation)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">{formatBDT(iv.retail_valuation)}</td>
                  <td className="px-4 py-2.5 text-right font-mono-num">{formatQty(iv.sold_in_period)}</td>
                  <td className="px-4 py-2.5">
                    {iv.sold_in_period === 0 ? (
                      <span className="text-slate-500">Dead / Non-moving</span>
                    ) : iv.sold_in_period >= 20 ? (
                      <span className="text-emerald-700 font-medium">Fast-moving</span>
                    ) : (
                      <span className="text-amber-700">Slow-moving</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
