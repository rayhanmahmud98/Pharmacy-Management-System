import Decimal from 'decimal.js';
import * as XLSX from 'xlsx';
import { getDb, todayDate } from '../db.ts';
import { d, qty, roundMoney, roundQty } from '../../src/shared/decimalMath.ts';
import { getActiveCashSessionId, getCashSessionSummary } from './financeService.ts';

function addDays(baseIsoDate: string, days: number): string {
  const dt = new Date(`${baseIsoDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function getDashboardStats() {
  const db = getDb();
  const today = todayDate();
  const settings = db.prepare('SELECT expiry_warning_days FROM pharmacy_settings WHERE id = 1').get() as
    | { expiry_warning_days: number }
    | undefined;
  const warnDays = settings?.expiry_warning_days ?? 90;
  const warnDate = addDays(today, warnDays);

  const todaySalesRows = db
    .prepare("SELECT net_total, total_cogs FROM sales WHERE sale_date = ? AND status = 'COMPLETED'")
    .all(today) as Array<{ net_total: string; total_cogs: string }>;

  let todayNetSales = new Decimal(0);
  let todayTotalCogs = new Decimal(0);
  for (const r of todaySalesRows) {
    todayNetSales = todayNetSales.add(d(r.net_total));
    todayTotalCogs = todayTotalCogs.add(d(r.total_cogs));
  }

  const todayReturnRows = db
    .prepare('SELECT total_refund_value, total_cogs_reversed FROM sales_returns WHERE return_date = ?')
    .all(today) as Array<{ total_refund_value: string; total_cogs_reversed: string }>;

  let todayRefundTotal = new Decimal(0);
  let todayCogsReversed = new Decimal(0);
  for (const r of todayReturnRows) {
    todayRefundTotal = todayRefundTotal.add(d(r.total_refund_value));
    todayCogsReversed = todayCogsReversed.add(d(r.total_cogs_reversed));
  }

  const todayExpRows = db
    .prepare("SELECT amount FROM expenses WHERE expense_date = ? AND status = 'POSTED'")
    .all(today) as Array<{ amount: string }>;
  let todayExpenses = new Decimal(0);
  for (const r of todayExpRows) {
    todayExpenses = todayExpenses.add(d(r.amount));
  }

  const customerRows = db
    .prepare('SELECT current_balance FROM customers WHERE is_active = 1')
    .all() as Array<{ current_balance: string }>;
  let customerDueTotal = new Decimal(0);
  for (const r of customerRows) {
    customerDueTotal = customerDueTotal.add(d(r.current_balance));
  }

  const supplierRows = db
    .prepare('SELECT current_balance FROM suppliers WHERE is_active = 1')
    .all() as Array<{ current_balance: string }>;
  let supplierDueTotal = new Decimal(0);
  for (const r of supplierRows) {
    supplierDueTotal = supplierDueTotal.add(d(r.current_balance));
  }

  const allBatches = db
    .prepare(
      `SELECT b.id, b.medicine_id, b.batch_number, b.expiry_date, b.current_qty_base, b.base_unit_name, b.status,
              m.brand_name, m.strength
       FROM batches b
       JOIN medicines m ON m.id = b.medicine_id
       ORDER BY b.expiry_date ASC`
    )
    .all() as Array<{
    id: string;
    medicine_id: string;
    batch_number: string;
    expiry_date: string;
    current_qty_base: string;
    base_unit_name: string;
    status: string;
    brand_name: string;
    strength: string;
  }>;

  const nearExpiryBatches: typeof allBatches = [];
  const expiredBatches: typeof allBatches = [];
  const sellableByMed = new Map<string, Decimal>();

  for (const b of allBatches) {
    const q = qty(b.current_qty_base);
    if (q.lte(0)) continue;
    if (b.status === 'ACTIVE' && b.expiry_date > today) {
      sellableByMed.set(b.medicine_id, (sellableByMed.get(b.medicine_id) || new Decimal(0)).add(q));
      if (b.expiry_date <= warnDate && nearExpiryBatches.length < 10) {
        nearExpiryBatches.push(b);
      }
    }
    if ((b.expiry_date <= today || b.status === 'EXPIRED') && expiredBatches.length < 10) {
      expiredBatches.push(b);
    }
  }

  const activeMeds = db
    .prepare('SELECT id, brand_name, strength, base_unit_name, min_stock_level FROM medicines WHERE is_active = 1')
    .all() as Array<{
    id: string;
    brand_name: string;
    strength: string;
    base_unit_name: string;
    min_stock_level: string;
  }>;

  const lowStockMeds = activeMeds
    .map((m) => {
      const minLvl = qty(m.min_stock_level);
      const stock = roundQty(sellableByMed.get(m.id) || new Decimal(0));
      return { ...m, minLvl, stock };
    })
    .filter((m) => m.minLvl.gt(0) && m.stock.lte(m.minLvl))
    .sort((a, b) => a.stock.cmp(b.stock))
    .slice(0, 10)
    .map((m) => ({
      id: m.id,
      brand_name: m.brand_name,
      strength: m.strength,
      base_unit_name: m.base_unit_name,
      min_stock_level: m.min_stock_level,
      sellable_stock: m.stock.toNumber(),
    }));

  const activeSessionId = getActiveCashSessionId();
  const activeCashSession = activeSessionId ? getCashSessionSummary(activeSessionId) : null;

  const grossProfitToday = roundMoney(
    todayNetSales.sub(todayRefundTotal).sub(todayTotalCogs.sub(todayCogsReversed))
  );

  return {
    today,
    kpis: {
      todaySaleCount: todaySalesRows.length,
      todayNetSales: roundMoney(todayNetSales).toFixed(2),
      todayGrossProfit: grossProfitToday.toFixed(2),
      todayExpenses: roundMoney(todayExpenses).toFixed(2),
      customerDueTotal: roundMoney(customerDueTotal).toFixed(2),
      supplierDueTotal: roundMoney(supplierDueTotal).toFixed(2),
      activeDrawerExpectedCash: activeCashSession?.totals.expectedCash ?? null,
      activeCashSessionNumber: (activeCashSession?.session?.session_number as string) ?? null,
    },
    alerts: {
      expiryWarningDays: warnDays,
      nearExpiryBatches,
      expiredBatches,
      lowStockMeds,
    },
  };
}

export function getComprehensiveReport(filters: {
  fromDate?: string;
  toDate?: string;
  categoryId?: string;
  supplierId?: string;
  customerId?: string;
  userId?: string;
}) {
  const db = getDb();
  const today = todayDate();
  const fromDate = filters.fromDate || today.slice(0, 8) + '01';
  const toDate = filters.toDate || today;

  const saleParams: Array<string> = [fromDate, toDate];
  let saleExtra = '';
  if (filters.customerId) {
    saleExtra += ' AND s.customer_id = ?';
    saleParams.push(filters.customerId);
  }
  if (filters.userId) {
    saleExtra += ' AND s.created_by = ?';
    saleParams.push(filters.userId);
  }

  const salesRows = db
    .prepare(
      `SELECT s.*, COALESCE(c.name, 'Walk-in Customer') as customer_name, u.full_name as cashier_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       JOIN users u ON u.id = s.created_by
       WHERE s.sale_date >= ? AND s.sale_date <= ? ${saleExtra}
       ORDER BY s.created_at DESC`
    )
    .all(...saleParams) as Array<Record<string, unknown>>;

  const completedSales = salesRows.filter((s) => s.status === 'COMPLETED');
  let grossSales = new Decimal(0);
  let totalDiscount = new Decimal(0);
  let netSales = new Decimal(0);
  let totalCogs = new Decimal(0);

  for (const s of completedSales) {
    grossSales = grossSales.add(d(String(s.gross_subtotal)));
    totalDiscount = totalDiscount.add(d(String(s.line_discount_total))).add(d(String(s.invoice_discount)));
    netSales = netSales.add(d(String(s.net_total)));
    totalCogs = totalCogs.add(d(String(s.total_cogs)));
  }

  const returnRows = db
    .prepare('SELECT total_refund_value, total_cogs_reversed FROM sales_returns WHERE return_date >= ? AND return_date <= ?')
    .all(fromDate, toDate) as Array<{ total_refund_value: string; total_cogs_reversed: string }>;

  let totalRefunds = new Decimal(0);
  let totalCogsRev = new Decimal(0);
  for (const r of returnRows) {
    totalRefunds = totalRefunds.add(d(r.total_refund_value));
    totalCogsRev = totalCogsRev.add(d(r.total_cogs_reversed));
  }

  const netCogs = roundMoney(totalCogs.sub(totalCogsRev));
  const netSalesAfterReturns = roundMoney(netSales.sub(totalRefunds));
  const grossProfit = roundMoney(netSalesAfterReturns.sub(netCogs));

  // Sales by medicine (aggregated in Decimal)
  const saleLineRows = db
    .prepare(
      `SELECT m.id, m.brand_name, m.generic_name, m.base_unit_name, COALESCE(c.name, 'Uncategorized') as category_name,
              sl.qty_base, sl.line_total, sl.cogs_total
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       JOIN medicines m ON m.id = sl.medicine_id
       LEFT JOIN categories c ON c.id = m.category_id
       WHERE s.status = 'COMPLETED' AND s.sale_date >= ? AND s.sale_date <= ?
         ${filters.categoryId ? 'AND m.category_id = ?' : ''}`
    )
    .all(...(filters.categoryId ? [fromDate, toDate, filters.categoryId] : [fromDate, toDate])) as Array<{
    id: string;
    brand_name: string;
    generic_name: string;
    base_unit_name: string;
    category_name: string;
    qty_base: string;
    line_total: string;
    cogs_total: string;
  }>;

  const salesByMedMap = new Map<
    string,
    {
      id: string;
      brand_name: string;
      generic_name: string;
      base_unit_name: string;
      category_name: string;
      qty: Decimal;
      revenue: Decimal;
      cogs: Decimal;
    }
  >();
  for (const row of saleLineRows) {
    const existing = salesByMedMap.get(row.id) || {
      id: row.id,
      brand_name: row.brand_name,
      generic_name: row.generic_name,
      base_unit_name: row.base_unit_name,
      category_name: row.category_name,
      qty: new Decimal(0),
      revenue: new Decimal(0),
      cogs: new Decimal(0),
    };
    existing.qty = existing.qty.add(d(row.qty_base));
    existing.revenue = existing.revenue.add(d(row.line_total));
    existing.cogs = existing.cogs.add(d(row.cogs_total));
    salesByMedMap.set(row.id, existing);
  }
  const salesByMedicine = Array.from(salesByMedMap.values())
    .sort((a, b) => b.revenue.cmp(a.revenue))
    .map((m) => ({
      id: m.id,
      brand_name: m.brand_name,
      generic_name: m.generic_name,
      base_unit_name: m.base_unit_name,
      category_name: m.category_name,
      total_qty_base: roundQty(m.qty).toNumber(),
      total_revenue: roundMoney(m.revenue).toNumber(),
      total_cogs: roundMoney(m.cogs).toNumber(),
    }));

  // Purchases
  const purParams: Array<string> = [fromDate, toDate];
  let purExtra = '';
  if (filters.supplierId) {
    purExtra += ' AND p.supplier_id = ?';
    purParams.push(filters.supplierId);
  }
  const purchaseRows = db
    .prepare(
      `SELECT p.*, s.name as supplier_name, u.full_name as created_by_name
       FROM purchases p
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN users u ON u.id = p.created_by
       WHERE p.purchase_date >= ? AND p.purchase_date <= ? ${purExtra}
       ORDER BY p.created_at DESC`
    )
    .all(...purParams);

  // Payment collections by method (aggregated in Decimal)
  const paymentRows = db
    .prepare(
      `SELECT method, direction, amount
       FROM payments
       WHERE status = 'POSTED' AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?`
    )
    .all(fromDate, toDate) as Array<{ method: string; direction: string; amount: string }>;

  const collectionsMap = new Map<string, { inflow: Decimal; outflow: Decimal }>();
  for (const p of paymentRows) {
    const cur = collectionsMap.get(p.method) || { inflow: new Decimal(0), outflow: new Decimal(0) };
    if (p.direction === 'IN') cur.inflow = cur.inflow.add(d(p.amount));
    else cur.outflow = cur.outflow.add(d(p.amount));
    collectionsMap.set(p.method, cur);
  }
  const collectionsByMethod = Array.from(collectionsMap.entries()).map(([method, v]) => ({
    method,
    inflow: roundMoney(v.inflow).toNumber(),
    outflow: roundMoney(v.outflow).toNumber(),
  }));

  // Inventory valuation & Fast/Slow/Dead stock (aggregated in Decimal)
  const meds = db
    .prepare('SELECT id, brand_name, strength, base_unit_name FROM medicines WHERE is_active = 1')
    .all() as Array<{ id: string; brand_name: string; strength: string; base_unit_name: string }>;

  const activeBatches = db
    .prepare(
      "SELECT medicine_id, current_qty_base, purchase_cost_per_base, selling_price_per_base FROM batches WHERE status = 'ACTIVE' AND expiry_date > ?"
    )
    .all(today) as Array<{
    medicine_id: string;
    current_qty_base: string;
    purchase_cost_per_base: string;
    selling_price_per_base: string;
  }>;

  const valMap = new Map<string, { qty: Decimal; cost: Decimal; retail: Decimal }>();
  for (const b of activeBatches) {
    const q = qty(b.current_qty_base);
    if (q.lte(0)) continue;
    const cur = valMap.get(b.medicine_id) || { qty: new Decimal(0), cost: new Decimal(0), retail: new Decimal(0) };
    cur.qty = cur.qty.add(q);
    cur.cost = cur.cost.add(q.mul(d(b.purchase_cost_per_base)));
    cur.retail = cur.retail.add(q.mul(d(b.selling_price_per_base)));
    valMap.set(b.medicine_id, cur);
  }

  const inventoryValuation = meds
    .map((m) => {
      const v = valMap.get(m.id) || { qty: new Decimal(0), cost: new Decimal(0), retail: new Decimal(0) };
      const sold = salesByMedMap.get(m.id)?.qty || new Decimal(0);
      return {
        id: m.id,
        brand_name: m.brand_name,
        strength: m.strength,
        base_unit_name: m.base_unit_name,
        sellable_qty: roundQty(v.qty).toNumber(),
        cost_valuation: roundMoney(v.cost).toNumber(),
        retail_valuation: roundMoney(v.retail).toNumber(),
        sold_in_period: roundQty(sold).toNumber(),
      };
    })
    .sort((a, b) => b.cost_valuation - a.cost_valuation);

  const expensesRows = db
    .prepare(
      `SELECT e.*, ec.name as category_name, u.full_name as user_name
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       JOIN users u ON u.id = e.created_by
       WHERE e.expense_date >= ? AND e.expense_date <= ?
       ORDER BY e.expense_date DESC`
    )
    .all(fromDate, toDate) as Array<Record<string, unknown>>;

  let postedExpenses = new Decimal(0);
  for (const e of expensesRows) {
    if (e.status === 'POSTED') {
      postedExpenses = postedExpenses.add(d(String(e.amount)));
    }
  }
  const netProfit = roundMoney(grossProfit.sub(postedExpenses));

  return {
    filters: { fromDate, toDate },
    profitSummary: {
      grossSales: roundMoney(grossSales).toFixed(2),
      totalDiscount: roundMoney(totalDiscount).toFixed(2),
      netSales: roundMoney(netSales).toFixed(2),
      salesReturns: roundMoney(totalRefunds).toFixed(2),
      netSalesAfterReturns: netSalesAfterReturns.toFixed(2),
      cogs: roundMoney(totalCogs).toFixed(2),
      cogsReversedOnReturns: roundMoney(totalCogsRev).toFixed(2),
      netCogs: netCogs.toFixed(2),
      grossProfit: grossProfit.toFixed(2),
      totalExpenses: roundMoney(postedExpenses).toFixed(2),
      netProfit: netProfit.toFixed(2),
    },
    salesRows,
    salesByMedicine,
    purchaseRows,
    collectionsByMethod,
    inventoryValuation,
    expensesRows,
  };
}

export function exportReportToExcelBuffer(filters: { fromDate?: string; toDate?: string }): Buffer {
  const report = getComprehensiveReport(filters);
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([report.profitSummary]), 'Profit_Summary');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(report.salesRows as Array<Record<string, unknown>>),
    'Sales_Ledger'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(report.salesByMedicine as Array<Record<string, unknown>>),
    'Sales_By_Medicine'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(report.inventoryValuation as Array<Record<string, unknown>>),
    'Inventory_Valuation'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(report.purchaseRows as Array<Record<string, unknown>>),
    'Purchases'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(report.expensesRows as Array<Record<string, unknown>>),
    'Expenses'
  );

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
