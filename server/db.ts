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
  db.exec('PRAGMA busy_timeout = 8000;');
  initSchema(db);
  _db = db;
  return db;
}

export function checkpointWal(): void {
  if (_db) {
    try {
      _db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // ignore if closing or read-only
    }
  }
}

export function closeDb(): void {
  if (_db) {
    checkpointWal();
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
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Atomic sequential document number generator backed by doc_sequences.
 * Must be called inside a transaction (BEGIN IMMEDIATE) to guarantee zero collisions.
 */
export function generateDocNumber(db: DatabaseSync, prefix: string, table: string, column: string): string {
  const datePart = todayDate().replace(/-/g, '');
  const seqKey = `${prefix}-${datePart}`;
  const existing = db.prepare('SELECT current_val FROM doc_sequences WHERE seq_key = ?').get(seqKey) as
    | { current_val: number }
    | undefined;

  let nextVal: number;
  if (!existing) {
    // Initialize from max existing suffix on the table for this date prefix if any exist
    const likePattern = `${seqKey}-%`;
    const rows = db
      .prepare(`SELECT ${column} as doc_no FROM ${table} WHERE ${column} LIKE ?`)
      .all(likePattern) as Array<{ doc_no: string }>;
    let maxExisting = 0;
    for (const r of rows) {
      const parts = String(r.doc_no || '').split('-');
      const tail = Number.parseInt(parts[parts.length - 1] || '0', 10);
      if (Number.isFinite(tail) && tail > maxExisting) maxExisting = tail;
    }
    nextVal = maxExisting + 1;
    db.prepare('INSERT INTO doc_sequences (seq_key, current_val) VALUES (?, ?)').run(seqKey, nextVal);
  } else {
    nextVal = existing.current_val + 1;
    db.prepare('UPDATE doc_sequences SET current_val = ? WHERE seq_key = ?').run(nextVal, seqKey);
  }

  const seq = String(nextVal).padStart(4, '0');
  return `${seqKey}-${seq}`;
}

let txDepth = 0;

export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  const depth = txDepth;
  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE;');
  } else {
    db.exec(`SAVEPOINT sp_${depth};`);
  }
  txDepth++;
  try {
    const result = fn(db);
    if (depth === 0) {
      db.exec('COMMIT;');
    } else {
      db.exec(`RELEASE SAVEPOINT sp_${depth};`);
    }
    return result;
  } catch (err) {
    try {
      if (depth === 0) {
        db.exec('ROLLBACK;');
      } else {
        db.exec(`ROLLBACK TO SAVEPOINT sp_${depth};`);
        db.exec(`RELEASE SAVEPOINT sp_${depth};`);
      }
    } catch {
      // ignore rollback errors if already rolled back
    }
    throw err;
  } finally {
    txDepth--;
  }
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_sequences (
      seq_key TEXT PRIMARY KEY,
      current_val INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      user_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, endpoint, user_id)
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      username_key TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      first_attempt_at TEXT NOT NULL,
      locked_until TEXT,
      PRIMARY KEY (username_key, ip_address)
    );

    CREATE TABLE IF NOT EXISTS license_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_verified_utc TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pharmacy_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pharmacy_name TEXT NOT NULL DEFAULT 'MediNest',
      pharmacy_name_bn TEXT NOT NULL DEFAULT '',
      drug_license_no TEXT NOT NULL DEFAULT 'REG-MN-2026-0001',
      address TEXT NOT NULL DEFAULT '120 Medical Center Road, Suite 100',
      phone TEXT NOT NULL DEFAULT '+1 (555) 010-2040',
      email TEXT NOT NULL DEFAULT 'support@medinest.local',
      website TEXT NOT NULL DEFAULT 'https://medinest.local',
      currency TEXT NOT NULL DEFAULT 'BDT',
      currency_symbol TEXT NOT NULL DEFAULT '৳',
      timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
      default_low_stock_threshold TEXT NOT NULL DEFAULT '10',
      logo_data_url TEXT NOT NULL DEFAULT '',
      receipt_footer TEXT NOT NULL DEFAULT 'Thank you for choosing MediNest Pharmacy. Please retain this receipt for returns or inquiries.',
      expiry_warning_days INTEGER NOT NULL DEFAULT 90,
      backup_retention_count INTEGER NOT NULL DEFAULT 14,
      printer_type TEXT NOT NULL DEFAULT 'A5',
      session_timeout_minutes INTEGER NOT NULL DEFAULT 960,
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
      must_change_password INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT,
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
      medicine_code TEXT NOT NULL DEFAULT '',
      barcode TEXT NOT NULL DEFAULT '',
      brand_name TEXT NOT NULL,
      generic_name TEXT NOT NULL,
      bangla_name TEXT NOT NULL DEFAULT '',
      alternative_names TEXT NOT NULL DEFAULT '',
      strength TEXT NOT NULL DEFAULT '',
      dosage_form TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id),
      manufacturer_id TEXT REFERENCES manufacturers(id),
      storage_info TEXT NOT NULL DEFAULT '',
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
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'WRITTEN_OFF', 'INACTIVE', 'DEPLETED', 'DAMAGED')),
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
      session_id TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      transaction_ref TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'SUCCESS',
      before_state TEXT NOT NULL DEFAULT '{}',
      after_state TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
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

    CREATE TABLE IF NOT EXISTS party_advance_ledger (
      id TEXT PRIMARY KEY,
      party_type TEXT NOT NULL CHECK (party_type IN ('CUSTOMER', 'SUPPLIER')),
      party_id TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('ADVANCE_RECEIPT', 'RETURN_CREDIT', 'APPLIED_TO_INVOICE', 'REVERSAL')),
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      amount_signed TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
  `);

  // Additive migrations for pre-existing databases
  addColumnIfMissing(db, 'pharmacy_settings', 'website', "TEXT NOT NULL DEFAULT 'https://medinest.local'");
  addColumnIfMissing(db, 'pharmacy_settings', 'currency', "TEXT NOT NULL DEFAULT 'BDT'");
  addColumnIfMissing(db, 'pharmacy_settings', 'currency_symbol', "TEXT NOT NULL DEFAULT '৳'");
  addColumnIfMissing(db, 'pharmacy_settings', 'timezone', "TEXT NOT NULL DEFAULT 'Asia/Dhaka'");
  addColumnIfMissing(db, 'pharmacy_settings', 'default_low_stock_threshold', "TEXT NOT NULL DEFAULT '10'");
  addColumnIfMissing(db, 'pharmacy_settings', 'session_timeout_minutes', 'INTEGER NOT NULL DEFAULT 960');

  addColumnIfMissing(db, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'users', 'last_login_at', 'TEXT');

  addColumnIfMissing(db, 'medicines', 'medicine_code', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'medicines', 'barcode', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'medicines', 'storage_info', "TEXT NOT NULL DEFAULT ''");

  addColumnIfMissing(db, 'audit_logs', 'session_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'audit_logs', 'ip_address', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'audit_logs', 'status', "TEXT NOT NULL DEFAULT 'SUCCESS'");
  addColumnIfMissing(db, 'audit_logs', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");

  addColumnIfMissing(db, 'sale_lines', 'effective_line_total', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'sales', 'advance_applied', "TEXT NOT NULL DEFAULT '0.00'");
  addColumnIfMissing(db, 'sales_returns', 'due_settled', "TEXT NOT NULL DEFAULT '0.00'");
  addColumnIfMissing(db, 'sales_returns', 'advance_created', "TEXT NOT NULL DEFAULT '0.00'");
  addColumnIfMissing(db, 'purchases', 'advance_applied', "TEXT NOT NULL DEFAULT '0.00'");
  addColumnIfMissing(db, 'purchase_returns', 'due_settled', "TEXT NOT NULL DEFAULT '0.00'");
  addColumnIfMissing(db, 'purchase_returns', 'advance_created', "TEXT NOT NULL DEFAULT '0.00'");
  addColumnIfMissing(db, 'customers', 'advance_balance', "TEXT NOT NULL DEFAULT '0.00'");
  addColumnIfMissing(db, 'suppliers', 'advance_balance', "TEXT NOT NULL DEFAULT '0.00'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_medicines_brand ON medicines(brand_name);
    CREATE INDEX IF NOT EXISTS idx_medicines_generic ON medicines(generic_name);
    CREATE INDEX IF NOT EXISTS idx_medicines_code ON medicines(medicine_code);
    CREATE INDEX IF NOT EXISTS idx_medicines_barcode ON medicines(barcode);
    CREATE INDEX IF NOT EXISTS idx_batches_medicine_expiry ON batches(medicine_id, status, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_batch ON stock_movements(batch_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date, status);
    CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date, status);
    CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit_logs(seq);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, module);
    CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_advance_ledger_party ON party_advance_ledger(party_type, party_id, created_at);
  `);

  // One-time safe upgrade of untouched legacy template defaults in pre-existing local DBs
  const curSettings = db
    .prepare('SELECT pharmacy_name, printer_type, receipt_footer FROM pharmacy_settings WHERE id = 1')
    .get() as { pharmacy_name: string; printer_type: string; receipt_footer: string } | undefined;

  if (curSettings && curSettings.pharmacy_name === 'Dhaka Care Pharmacy') {
    db.prepare(
      `UPDATE pharmacy_settings
       SET pharmacy_name = 'MediNest',
           pharmacy_name_bn = '',
           drug_license_no = 'REG-MN-2026-0001',
           address = '120 Medical Center Road, Suite 100',
           phone = '+1 (555) 010-2040',
           email = 'support@medinest.local',
           website = 'https://medinest.local',
           receipt_footer = 'Thank you for choosing MediNest Pharmacy. Please retain this receipt for returns or inquiries.',
           printer_type = 'A5',
           updated_at = ?
       WHERE id = 1`
    ).run(nowIso());
  } else if (curSettings && curSettings.printer_type === 'THERMAL_80MM') {
    db.prepare("UPDATE pharmacy_settings SET printer_type = 'A5', pharmacy_name_bn = '' WHERE id = 1").run();
  }

  // Assign deterministic medicine codes to any legacy medicines missing medicine_code
  const uncodedMeds = db
    .prepare("SELECT id FROM medicines WHERE medicine_code = '' ORDER BY created_at ASC, brand_name ASC")
    .all() as Array<{ id: string }>;
  if (uncodedMeds.length > 0) {
    const existingCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM medicines WHERE medicine_code != ''").get() as { cnt: number }
    ).cnt;
    let nextCodeNum = existingCount + 1;
    const updCode = db.prepare('UPDATE medicines SET medicine_code = ? WHERE id = ?');
    for (const m of uncodedMeds) {
      updCode.run(`MED-${String(nextCodeNum).padStart(4, '0')}`, m.id);
      nextCodeNum++;
    }
  }
}
