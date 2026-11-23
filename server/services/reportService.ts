import Decimal from 'decimal.js';
import * as XLSX from 'xlsx';
import { getDb, todayDate } from '../db.ts';
import { d, money } from '../../src/shared/decimalMath.ts';
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

  const todaySales = db
    .prepare(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(CAST(net_total AS REAL)), 0) as net_total,
              COALESCE(SUM(CAST(total_cogs AS REAL)), 0) as total_cogs
       FROM sales WHERE sale_date = ? AND status = 'COMPLETED'`
    )
    .get(today) as { count: number; net_total: number; total_cogs: number };

  const todayReturns = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(total_refund_value AS REAL)), 0) as refund_total,
              COALESCE(SUM(CAST(total_cogs_reversed AS REAL)), 0) as cogs_rev
       FROM sales_returns WHERE return_date = ?`
    )
    .get(today) as { refund_total: number; cogs_rev: number };

  const todayExpenses = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total
       FROM expenses WHERE expense_date = ? AND status = 'POSTED'`
    )
    .get(today) as { total: number };

  const customerDue = db
    .prepare('SELECT COALESCE(SUM(CAST(current_balance AS REAL)), 0) as total FROM customers WHERE is_active = 1')
    .get() as { total: number };

  const supplierDue = db
    .prepare('SELECT COALESCE(SUM(CAST(current_balance AS REAL)), 0) as total FROM suppliers WHERE is_active = 1')
    .get() as { total: number };

  const nearExpiryBatches = db
    .prepare(
      `SELECT b.id, b.batch_number, b.expiry_date, b.current_qty_base, b.base_unit_name, m.brand_name, m.strength
       FROM batches b
       JOIN medicines m ON m.id = b.medicine_id
       WHERE b.status = 'ACTIVE' AND CAST(b.current_qty_base AS REAL) > 0 AND b.expiry_date <= ? AND b.expiry_date > ?
       ORDER BY b.expiry_date ASC LIMIT 10`
    )
    .all(warnDate, today);

  const expiredBatches = db
    .prepare(
      `SELECT b.id, b.batch_number, b.expiry_date, b.current_qty_base, b.base_unit_name, m.brand_name, m.strength
       FROM batches b
       JOIN medicines m ON m.id = b.medicine_id
       WHERE CAST(b.current_qty_base AS REAL) > 0 AND (b.expiry_date <= ? OR b.status = 'EXPIRED')
       ORDER BY b.expiry_date ASC LIMIT 10`
    )
    .all(today);

  const lowStockMeds = db
    .prepare(
      `SELECT * FROM (
         SELECT m.id, m.brand_name, m.strength, m.base_unit_name, m.min_stock_level,
                COALESCE((SELECT SUM(CAST(b.current_qty_base AS REAL)) FROM batches b WHERE b.medicine_id = m.id AND b.status = 'ACTIVE' AND b.expiry_date > ?), 0) as sellable_stock
         FROM medicines m
         WHERE m.is_active = 1 AND CAST(m.min_stock_level AS REAL) > 0
       )
       WHERE sellable_stock <= CAST(min_stock_level AS REAL)
       ORDER BY sellable_stock ASC LIMIT 10`
    )
    .all(today);

  const activeSessionId = getActiveCashSessionId();
  const activeCashSession = activeSessionId ? getCashSessionSummary(activeSessionId) : null;

  const grossProfitToday = money(
    d(todaySales.net_total)
      .sub(d(todayReturns.refund_total))
      .sub(d(todaySales.total_cogs).sub(d(todayReturns.cogs_rev)))
  );

  return {
    today,
    kpis: {
      todaySaleCount: todaySales.count,
      todayNetSales: money(todaySales.net_total).toFixed(2),
      todayGrossProfit: grossProfitToday.toFixed(2),
      todayExpenses: money(todayExpenses.total).toFixed(2),
      customerDueTotal: money(customerDue.total).toFixed(2),
      supplierDueTotal: money(supplierDue.total).toFixed(2),
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

  // 1. Sales & Profit (strictly historical batch COGS)
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

  const returnSummary = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(total_refund_value AS REAL)), 0) as total_refunds,
              COALESCE(SUM(CAST(total_cogs_reversed AS REAL)), 0) as total_cogs_rev
       FROM sales_returns WHERE return_date >= ? AND return_date <= ?`
    )
    .get(fromDate, toDate) as { total_refunds: number; total_cogs_rev: number };

  const netCogs = money(totalCogs.sub(d(returnSummary.total_cogs_rev)));
  const netSalesAfterReturns = money(netSales.sub(d(returnSummary.total_refunds)));
  const grossProfit = money(netSalesAfterReturns.sub(netCogs));

  // Sales by medicine
  const salesByMedicine = db
    .prepare(
      `SELECT m.id, m.brand_name, m.generic_name, m.base_unit_name, COALESCE(c.name, 'Uncategorized') as category_name,
              SUM(CAST(sl.qty_base AS REAL)) as total_qty_base,
              SUM(CAST(sl.line_total AS REAL)) as total_revenue,
              SUM(CAST(sl.cogs_total AS REAL)) as total_cogs
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       JOIN medicines m ON m.id = sl.medicine_id
       LEFT JOIN categories c ON c.id = m.category_id
       WHERE s.status = 'COMPLETED' AND s.sale_date >= ? AND s.sale_date <= ?
         ${filters.categoryId ? 'AND m.category_id = ?' : ''}
       GROUP BY m.id
       ORDER BY total_revenue DESC`
    )
    .all(...(filters.categoryId ? [fromDate, toDate, filters.categoryId] : [fromDate, toDate]));

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

  // Payment collections by method
  const collectionsByMethod = db
    .prepare(
      `SELECT method,
              SUM(CASE WHEN direction = 'IN' THEN CAST(amount AS REAL) ELSE 0 END) as inflow,
              SUM(CASE WHEN direction = 'OUT' THEN CAST(amount AS REAL) ELSE 0 END) as outflow
       FROM payments
       WHERE status = 'POSTED' AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
       GROUP BY method`
    )
    .all(fromDate, toDate);

  // Inventory valuation & Fast/Slow/Dead stock
  const inventoryValuation = db
    .prepare(
      `SELECT m.id, m.brand_name, m.strength, m.base_unit_name,
              COALESCE(SUM(CASE WHEN b.status = 'ACTIVE' AND b.expiry_date > ? THEN CAST(b.current_qty_base AS REAL) ELSE 0 END), 0) as sellable_qty,
              COALESCE(SUM(CASE WHEN b.status = 'ACTIVE' AND b.expiry_date > ? THEN CAST(b.current_qty_base AS REAL) * CAST(b.purchase_cost_per_base AS REAL) ELSE 0 END), 0) as cost_valuation,
              COALESCE(SUM(CASE WHEN b.status = 'ACTIVE' AND b.expiry_date > ? THEN CAST(b.current_qty_base AS REAL) * CAST(b.selling_price_per_base AS REAL) ELSE 0 END), 0) as retail_valuation,
              COALESCE((SELECT SUM(CAST(sl.qty_base AS REAL)) FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id WHERE sl.medicine_id = m.id AND s.status = 'COMPLETED' AND s.sale_date >= ? AND s.sale_date <= ?), 0) as sold_in_period
       FROM medicines m
       LEFT JOIN batches b ON b.medicine_id = m.id
       WHERE m.is_active = 1
       GROUP BY m.id
       ORDER BY cost_valuation DESC`
    )
    .all(today, today, today, fromDate, toDate);

  const expensesRows = db
    .prepare(
      `SELECT e.*, ec.name as category_name, u.full_name as user_name
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       JOIN users u ON u.id = e.created_by
       WHERE e.expense_date >= ? AND e.expense_date <= ?
       ORDER BY e.expense_date DESC`
    )
    .all(fromDate, toDate);

  return {
    filters: { fromDate, toDate },
    profitSummary: {
      grossSales: money(grossSales).toFixed(2),
      totalDiscount: money(totalDiscount).toFixed(2),
      netSales: money(netSales).toFixed(2),
      salesReturns: money(returnSummary.total_refunds).toFixed(2),
      netSalesAfterReturns: netSalesAfterReturns.toFixed(2),
      cogs: money(totalCogs).toFixed(2),
      cogsReversedOnReturns: money(returnSummary.total_cogs_rev).toFixed(2),
      netCogs: netCogs.toFixed(2),
      grossProfit: grossProfit.toFixed(2),
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
