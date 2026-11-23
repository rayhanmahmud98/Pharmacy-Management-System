import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.PHARMACY_DATA_DIR
  ? path.resolve(process.env.PHARMACY_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
export const DB_PATH = path.join(DATA_DIR, 'pharmacy.db');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const LICENSE_PATH = path.join(DATA_DIR, 'license.json');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

for (const dir of [DATA_DIR, BACKUP_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  initSchema(db);
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayDate(): string {
  // Use local date in YYYY-MM-DD (Asia/Dhaka UTC+6 friendly or system date)
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function generateDocNumber(db: DatabaseSync, prefix: string, table: string, column: string): string {
  const datePart = todayDate().replace(/-/g, '');
  const likePattern = `${prefix}-${datePart}-%`;
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${column} LIKE ?`)
    .get(likePattern) as { cnt: number };
  const seq = String((row?.cnt ?? 0) + 1).padStart(4, '0');
  return `${prefix}-${datePart}-${seq}`;
}

export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore rollback errors if already rolled back
    }
    throw err;
  }
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pharmacy_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pharmacy_name TEXT NOT NULL DEFAULT 'Dhaka Care Pharmacy',
      pharmacy_name_bn TEXT NOT NULL DEFAULT 'ঢাকা কেয়ার ফার্মেসি',
      drug_license_no TEXT NOT NULL DEFAULT 'DL-DHK-2026-0418',
      address TEXT NOT NULL DEFAULT 'House 14, Road 6, Dhanmondi, Dhaka 1205',
      phone TEXT NOT NULL DEFAULT '+880 1711-000111',
      email TEXT NOT NULL DEFAULT 'contact@dhakacarepharmacy.local',
      logo_data_url TEXT NOT NULL DEFAULT '',
      receipt_footer TEXT NOT NULL DEFAULT 'ধন্যবাদ। প্রেসক্রিপশন ছাড়া অ্যান্টিবায়োটিক বিক্রি করা হয় না।',
      expiry_warning_days INTEGER NOT NULL DEFAULT 90,
      backup_retention_count INTEGER NOT NULL DEFAULT 14,
      printer_type TEXT NOT NULL DEFAULT 'THERMAL_80MM',
      setup_completed INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permissions (
      code TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_code)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES roles(id),
      is_super_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
      effect TEXT NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
      reason TEXT NOT NULL DEFAULT '',
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, permission_code)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS manufacturers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      country TEXT NOT NULL DEFAULT 'Bangladesh',
      phone TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS medicines (
      id TEXT PRIMARY KEY,
      brand_name TEXT NOT NULL,
      generic_name TEXT NOT NULL,
      bangla_name TEXT NOT NULL DEFAULT '',
      alternative_names TEXT NOT NULL DEFAULT '',
      strength TEXT NOT NULL DEFAULT '',
      dosage_form TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id),
      manufacturer_id TEXT REFERENCES manufacturers(id),
      description TEXT NOT NULL DEFAULT '',
      base_unit_name TEXT NOT NULL,
      min_stock_level TEXT NOT NULL DEFAULT '0',
      rx_required INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicine_units (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      unit_name TEXT NOT NULL,
      conversion_to_base TEXT NOT NULL,
      is_base INTEGER NOT NULL DEFAULT 0,
      allow_purchase INTEGER NOT NULL DEFAULT 1,
      allow_sale INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (medicine_id, unit_name)
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      contact_person TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      return_policy_days INTEGER NOT NULL DEFAULT 30,
      return_policy_notes TEXT NOT NULL DEFAULT '',
      opening_balance TEXT NOT NULL DEFAULT '0.00',
      current_balance TEXT NOT NULL DEFAULT '0.00',
      notes TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      opening_balance TEXT NOT NULL DEFAULT '0.00',
      current_balance TEXT NOT NULL DEFAULT '0.00',
      credit_limit TEXT NOT NULL DEFAULT '0.00',
      notes TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      purchase_number TEXT NOT NULL UNIQUE,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      supplier_invoice_no TEXT NOT NULL DEFAULT '',
      purchase_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('DRAFT', 'RECEIVED', 'CANCELLED', 'REVERSED')),
      gross_subtotal TEXT NOT NULL DEFAULT '0.00',
      discount_total TEXT NOT NULL DEFAULT '0.00',
      net_total TEXT NOT NULL DEFAULT '0.00',
      paid_amount TEXT NOT NULL DEFAULT '0.00',
      due_amount TEXT NOT NULL DEFAULT '0.00',
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      received_by TEXT REFERENCES users(id),
      received_at TEXT,
      reversed_by TEXT REFERENCES users(id),
      reversed_at TEXT,
      reversal_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      supplier_id TEXT REFERENCES suppliers(id),
      purchase_id TEXT REFERENCES purchases(id),
      received_date TEXT NOT NULL,
      purchase_cost_per_base TEXT NOT NULL,
      selling_price_per_base TEXT NOT NULL,
      initial_qty_base TEXT NOT NULL,
      current_qty_base TEXT NOT NULL,
      base_unit_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'WRITTEN_OFF', 'INACTIVE')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (medicine_id, batch_number, expiry_date)
    );

    CREATE TABLE IF NOT EXISTS purchase_lines (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_id TEXT REFERENCES batches(id),
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      unit_id TEXT REFERENCES medicine_units(id),
      unit_name_snapshot TEXT NOT NULL,
      conversion_ratio_snapshot TEXT NOT NULL,
      qty_input TEXT NOT NULL,
      qty_base TEXT NOT NULL,
      unit_cost TEXT NOT NULL,
      selling_price_per_base TEXT NOT NULL,
      line_discount TEXT NOT NULL DEFAULT '0.00',
      line_total TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id TEXT PRIMARY KEY,
      return_number TEXT NOT NULL UNIQUE,
      purchase_id TEXT NOT NULL REFERENCES purchases(id),
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      return_date TEXT NOT NULL,
      total_amount TEXT NOT NULL,
      settlement_type TEXT NOT NULL CHECK (settlement_type IN ('SUPPLIER_CREDIT', 'CASH_REFUND', 'BANK_REFUND')),
      refund_amount TEXT NOT NULL DEFAULT '0.00',
      credit_amount TEXT NOT NULL DEFAULT '0.00',
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_return_lines (
      id TEXT PRIMARY KEY,
      purchase_return_id TEXT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
      purchase_line_id TEXT REFERENCES purchase_lines(id),
      batch_id TEXT NOT NULL REFERENCES batches(id),
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      qty_base TEXT NOT NULL,
      cost_per_base_snapshot TEXT NOT NULL,
      line_total TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      customer_id TEXT REFERENCES customers(id),
      sale_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REVERSED')),
      gross_subtotal TEXT NOT NULL,
      line_discount_total TEXT NOT NULL,
      invoice_discount TEXT NOT NULL,
      net_total TEXT NOT NULL,
      paid_amount TEXT NOT NULL,
      due_amount TEXT NOT NULL,
      total_cogs TEXT NOT NULL DEFAULT '0.00',
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      reversed_by TEXT REFERENCES users(id),
      reversed_at TEXT,
      reversal_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_lines (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      unit_id TEXT REFERENCES medicine_units(id),
      unit_name_snapshot TEXT NOT NULL,
      conversion_ratio_snapshot TEXT NOT NULL,
      qty_input TEXT NOT NULL,
      qty_base TEXT NOT NULL,
      unit_price TEXT NOT NULL,
      gross_total TEXT NOT NULL,
      line_discount TEXT NOT NULL DEFAULT '0.00',
      line_total TEXT NOT NULL,
      cogs_total TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_batch_allocations (
      id TEXT PRIMARY KEY,
      sale_line_id TEXT NOT NULL REFERENCES sale_lines(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      qty_base TEXT NOT NULL,
      cost_per_base_snapshot TEXT NOT NULL,
      cogs_total TEXT NOT NULL,
      is_manual_override INTEGER NOT NULL DEFAULT 0,
      override_reason TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sales_returns (
      id TEXT PRIMARY KEY,
      return_number TEXT NOT NULL UNIQUE,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      customer_id TEXT REFERENCES customers(id),
      return_date TEXT NOT NULL,
      total_refund_value TEXT NOT NULL,
      settlement_type TEXT NOT NULL CHECK (settlement_type IN ('CASH_REFUND', 'MFS_REFUND', 'CUSTOMER_CREDIT')),
      refund_amount TEXT NOT NULL DEFAULT '0.00',
      credit_amount TEXT NOT NULL DEFAULT '0.00',
      total_cogs_reversed TEXT NOT NULL DEFAULT '0.00',
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_return_lines (
      id TEXT PRIMARY KEY,
      sales_return_id TEXT NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
      sale_line_id TEXT NOT NULL REFERENCES sale_lines(id),
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_id TEXT NOT NULL REFERENCES batches(id),
      qty_base TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('RESTOCK_SELLABLE', 'QUARANTINE', 'DAMAGED', 'WRITE_OFF', 'NOT_RESTOCKABLE')),
      cost_per_base_snapshot TEXT NOT NULL,
      cogs_reversed TEXT NOT NULL,
      refund_line_total TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_id TEXT NOT NULL REFERENCES batches(id),
      qty_change_base TEXT NOT NULL,
      movement_type TEXT NOT NULL CHECK (movement_type IN (
        'OPENING_STOCK', 'PURCHASE_RECEIVED', 'SALE', 'SALE_RETURN',
        'PURCHASE_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
        'DAMAGE_WRITEOFF', 'EXPIRY_WRITEOFF', 'SALE_REVERSAL', 'PURCHASE_REVERSAL'
      )),
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      reference_line_id TEXT NOT NULL DEFAULT '',
      cost_per_base_snapshot TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id TEXT PRIMARY KEY,
      adjustment_number TEXT NOT NULL UNIQUE,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      adjustment_type TEXT NOT NULL CHECK (adjustment_type IN (
        'STOCK_INCREASE', 'STOCK_DECREASE', 'DAMAGE', 'MISSING_STOCK',
        'EXPIRY', 'OPENING_CORRECTION', 'RECONCILIATION'
      )),
      expected_qty_base TEXT NOT NULL,
      actual_qty_base TEXT NOT NULL,
      variance_qty_base TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id TEXT PRIMARY KEY,
      session_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'FORCE_CLOSED')),
      opened_by TEXT NOT NULL REFERENCES users(id),
      opened_at TEXT NOT NULL,
      opening_cash TEXT NOT NULL,
      closed_by TEXT REFERENCES users(id),
      closed_at TEXT,
      expected_cash TEXT,
      actual_cash TEXT,
      variance TEXT,
      variance_reason TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS cash_movements (
      id TEXT PRIMARY KEY,
      cash_session_id TEXT NOT NULL REFERENCES cash_sessions(id),
      movement_type TEXT NOT NULL CHECK (movement_type IN (
        'OPENING_CASH', 'CASH_SALE', 'CUSTOMER_CASH_COLLECTION',
        'SUPPLIER_CASH_PAYMENT', 'CASH_EXPENSE', 'CASH_REFUND',
        'CASH_ADJUSTMENT', 'CASH_VARIANCE', 'REVERSAL'
      )),
      amount_signed TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      payment_number TEXT NOT NULL UNIQUE,
      party_type TEXT NOT NULL CHECK (party_type IN ('CUSTOMER', 'SUPPLIER', 'EXPENSE')),
      party_id TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
      method TEXT NOT NULL CHECK (method IN ('CASH', 'BKASH', 'NAGAD', 'ROCKET', 'BANK', 'CARD', 'OTHER')),
      amount TEXT NOT NULL,
      reference_no TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('POSTED', 'REVERSED')),
      reversed_payment_id TEXT REFERENCES payments(id),
      reversal_reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_allocations (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('SALE', 'PURCHASE', 'CUSTOMER_OPENING', 'SUPPLIER_OPENING')),
      target_id TEXT NOT NULL,
      amount_allocated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expense_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      expense_number TEXT NOT NULL UNIQUE,
      category_id TEXT NOT NULL REFERENCES expense_categories(id),
      name TEXT NOT NULL,
      amount TEXT NOT NULL,
      expense_date TEXT NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'BKASH', 'NAGAD', 'ROCKET', 'BANK', 'CARD', 'OTHER')),
      reference_no TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('POSTED', 'REVERSED')),
      reversed_by TEXT REFERENCES users(id),
      reversed_at TEXT,
      reversal_reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      user_id TEXT,
      username TEXT NOT NULL DEFAULT 'system',
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      transaction_ref TEXT NOT NULL DEFAULT '',
      before_state TEXT NOT NULL DEFAULT '{}',
      after_state TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL DEFAULT '',
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backup_records (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      integrity_check_result TEXT NOT NULL,
      backup_type TEXT NOT NULL CHECK (backup_type IN ('MANUAL', 'AUTO_DAILY', 'PRE_UPDATE', 'PRE_RESTORE')),
      status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'FAILED')),
      error_message TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_medicines_brand ON medicines(brand_name);
    CREATE INDEX IF NOT EXISTS idx_medicines_generic ON medicines(generic_name);
    CREATE INDEX IF NOT EXISTS idx_batches_medicine_expiry ON batches(medicine_id, status, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_batch ON stock_movements(batch_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date, status);
    CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date, status);
    CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit_logs(seq);
    CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id, created_at);
  `);
}
