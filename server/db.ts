import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool, types } = pg;

// Preserve exact DATE ('YYYY-MM-DD'), UTC TIMESTAMPTZ (ISO .000Z), and INT8 numeric counts
types.setTypeParser(1082, (val: string) => val);
types.setTypeParser(1184, (val: string) => new Date(val).toISOString());
types.setTypeParser(1114, (val: string) => new Date(val).toISOString());
types.setTypeParser(20, (val: string) => {
  const n = Number(val);
  return Number.isSafeInteger(n) ? n : val;
});

export const DATA_DIR = process.env.PHARMACY_DATA_DIR
  ? path.resolve(process.env.PHARMACY_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
export const SQLITE_LEGACY_PATH = path.join(DATA_DIR, 'pharmacy.db');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

for (const dir of [DATA_DIR, BACKUP_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export interface DbExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

interface InternalExecutor extends DbExecutor {
  _txDepth?: number;
  _client?: pg.PoolClient;
}

export interface PgConnectionDetails {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean | { rejectUnauthorized: boolean };
  max: number;
}

export function getPgConnectionDetails(): PgConnectionDetails {
  const sslMode = (process.env.PGSSL || process.env.PGSSLMODE || '').trim().toLowerCase();
  const rejectUnauthorized = process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false';
  let ssl: boolean | { rejectUnauthorized: boolean } = false;
  if (sslMode && sslMode !== 'disable' && sslMode !== 'false' && sslMode !== '0') {
    ssl = { rejectUnauthorized };
  }

  if (process.env.DATABASE_URL?.trim()) {
    const parsed = new URL(process.env.DATABASE_URL.trim());
    const urlSsl = parsed.searchParams.get('sslmode')?.toLowerCase();
    if (urlSsl && urlSsl !== 'disable' && !ssl) {
      ssl = { rejectUnauthorized };
    }
    return {
      host: parsed.hostname || '127.0.0.1',
      port: Number(parsed.port || 5432),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '') || 'medinest'),
      user: decodeURIComponent(parsed.username || 'postgres'),
      password: decodeURIComponent(parsed.password || ''),
      ssl,
      max: Math.max(2, Number(process.env.PGPOOL_MAX || 20)),
    };
  }

  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'medinest',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD ?? '',
    ssl,
    max: Math.max(2, Number(process.env.PGPOOL_MAX || 20)),
  };
}

let _pool: pg.Pool | null = null;
let _initPromise: Promise<void> | null = null;
let _maintenanceRestoreInProgress = false;

export function setDbMaintenanceMode(active: boolean): void {
  _maintenanceRestoreInProgress = active;
}

export function isDbMaintenanceMode(): boolean {
  return _maintenanceRestoreInProgress;
}

function createMaintenanceError(): Error & { code: string } {
  const err = new Error('Database restore in progress. Please retry in a few seconds.') as Error & { code: string };
  err.code = '57P03';
  return err;
}

function createExecutorFromQueryable(
  queryable: { query: (text: string, values?: unknown[]) => Promise<pg.QueryResult> },
  txDepth?: number,
  client?: pg.PoolClient
): InternalExecutor {
  return {
    _txDepth: txDepth,
    _client: client,
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: unknown[] = []
    ): Promise<T[]> {
      const res = await queryable.query(sql, params);
      return res.rows as T[];
    },
    async queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: unknown[] = []
    ): Promise<T | undefined> {
      const res = await queryable.query(sql, params);
      return (res.rows[0] as T | undefined) ?? undefined;
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const res = await queryable.query(sql, params);
      return { rowCount: res.rowCount ?? 0 };
    },
  };
}

export function getRawPool(): pg.Pool {
  if (_pool) return _pool;
  const cfg = getPgConnectionDetails();
  _pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl,
    max: cfg.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  _pool.on('error', (err) => {
    console.error('PostgreSQL pool background error:', err.message);
  });
  return _pool;
}

export async function ensureDbReady(): Promise<void> {
  if (_maintenanceRestoreInProgress) {
    throw createMaintenanceError();
  }
  if (_initPromise) return _initPromise;
  const pool = getRawPool();
  _initPromise = (async () => {
    const maxAttempts = Number(process.env.PG_CONNECT_RETRIES || 6);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let client: pg.PoolClient | undefined;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        // Prevent concurrent startup workers from racing schema creation
        await client.query('SELECT pg_advisory_xact_lock(90421000)');
        const exec = createExecutorFromQueryable(client, 0, client);
        await initSchema(exec);
        await client.query('COMMIT');
        return;
      } catch (err) {
        lastErr = err;
        if (client) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore rollback failure
          }
        }
        const pgCode = (err as { code?: string })?.code;
        const isTransient =
          pgCode === 'ECONNREFUSED' ||
          pgCode === 'ENOTFOUND' ||
          pgCode === 'ETIMEDOUT' ||
          pgCode === '57P03' || // cannot_connect_now (starting up)
          pgCode === '57P01' || // admin_shutdown
          pgCode === '08006' ||
          pgCode === '08001';
        if (!isTransient || attempt === maxAttempts) {
          _initPromise = null;
          throw err;
        }
        await new Promise((r) => setTimeout(r, Math.min(2000, attempt * 400)));
      } finally {
        client?.release();
      }
    }
    _initPromise = null;
    throw lastErr;
  })();
  return _initPromise;
}

export async function getDb(): Promise<DbExecutor> {
  await ensureDbReady();
  return createExecutorFromQueryable(getRawPool());
}

export async function closeDb(): Promise<void> {
  _initPromise = null;
  if (_pool) {
    const p = _pool;
    _pool = null;
    await p.end();
  }
}

export function resetDbInitializationState(): void {
  _initPromise = null;
}

export async function checkDbHealth(): Promise<{ ok: boolean; database: string; latencyMs: number }> {
  if (_maintenanceRestoreInProgress) {
    throw createMaintenanceError();
  }
  const start = Date.now();
  const pool = getRawPool();
  const res = await pool.query('SELECT current_database() AS db');
  return {
    ok: true,
    database: String(res.rows[0]?.db || ''),
    latencyMs: Date.now() - start,
  };
}

export async function cleanupExpiredOperationalState(): Promise<void> {
  if (_maintenanceRestoreInProgress) return;
  try {
    const db = await getDb();
    await db.execute('DELETE FROM sessions WHERE expires_at < NOW()');
    await db.execute("DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '30 days'");
  } catch {
    // Best-effort housekeeping; never disrupt live requests
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

const ALLOWED_DOC_TABLES = new Set([
  'sales',
  'sales_returns',
  'purchases',
  'purchase_returns',
  'stock_adjustments',
  'cash_sessions',
  'payments',
  'expenses',
]);

const ALLOWED_DOC_COLUMNS = new Set([
  'invoice_number',
  'return_number',
  'purchase_number',
  'adjustment_number',
  'session_number',
  'payment_number',
  'expense_number',
]);

/**
 * Concurrency-safe sequential document number generator backed by doc_sequences.
 * Uses PostgreSQL transaction advisory lock + row lock / atomic upsert.
 */
export async function generateDocNumber(
  tx: DbExecutor,
  prefix: string,
  table: string,
  column: string
): Promise<string> {
  if (!ALLOWED_DOC_TABLES.has(table) || !ALLOWED_DOC_COLUMNS.has(column)) {
    throw new Error('Invalid sequence target');
  }

  const datePart = todayDate().replace(/-/g, '');
  const seqKey = `${prefix}-${datePart}`;

  await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1))', [`docseq:${seqKey}`]);

  const existing = await tx.queryOne<{ current_val: number }>(
    'SELECT current_val FROM doc_sequences WHERE seq_key = $1 FOR UPDATE',
    [seqKey]
  );

  let nextVal: number;
  if (!existing) {
    const likePattern = `${seqKey}-%`;
    const rows = await tx.query<{ doc_no: string }>(
      `SELECT ${column} AS doc_no FROM ${table} WHERE ${column} LIKE $1`,
      [likePattern]
    );
    let maxExisting = 0;
    for (const r of rows) {
      const parts = String(r.doc_no || '').split('-');
      const tail = Number.parseInt(parts[parts.length - 1] || '0', 10);
      if (Number.isFinite(tail) && tail > maxExisting) maxExisting = tail;
    }
    nextVal = maxExisting + 1;
    await tx.execute(
      `INSERT INTO doc_sequences (seq_key, current_val)
       VALUES ($1, $2)
       ON CONFLICT (seq_key) DO UPDATE SET current_val = GREATEST(doc_sequences.current_val + 1, EXCLUDED.current_val)`,
      [seqKey, nextVal]
    );
    const confirmed = await tx.queryOne<{ current_val: number }>(
      'SELECT current_val FROM doc_sequences WHERE seq_key = $1',
      [seqKey]
    );
    nextVal = Number(confirmed?.current_val ?? nextVal);
  } else {
    const updated = await tx.queryOne<{ current_val: number }>(
      'UPDATE doc_sequences SET current_val = current_val + 1 WHERE seq_key = $1 RETURNING current_val',
      [seqKey]
    );
    nextVal = Number(updated!.current_val);
  }

  const seq = String(nextVal).padStart(4, '0');
  return `${seqKey}-${seq}`;
}

/**
 * Concurrency-safe customer/supplier/medicine sequential code generator.
 */
export async function generateSequentialCode(
  tx: DbExecutor,
  seqName: string,
  prefix: string,
  padWidth: number,
  table: 'customers' | 'suppliers' | 'medicines',
  column: 'code' | 'medicine_code'
): Promise<string> {
  await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1))', [`codegen:${seqName}`]);

  const existing = await tx.queryOne<{ current_val: number }>(
    'SELECT current_val FROM doc_sequences WHERE seq_key = $1 FOR UPDATE',
    [seqName]
  );

  let nextVal: number;
  if (!existing) {
    const rows = await tx.query<{ code_val: string }>(
      `SELECT ${column} AS code_val FROM ${table} WHERE ${column} LIKE $1`,
      [`${prefix}-%`]
    );
    let maxNum = 0;
    for (const r of rows) {
      const m = new RegExp(`^${prefix}-(\\d+)$`, 'i').exec(String(r.code_val || '').trim());
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
      }
    }
    nextVal = maxNum + 1;
    await tx.execute(
      `INSERT INTO doc_sequences (seq_key, current_val)
       VALUES ($1, $2)
       ON CONFLICT (seq_key) DO UPDATE SET current_val = GREATEST(doc_sequences.current_val + 1, EXCLUDED.current_val)`,
      [seqName, nextVal]
    );
  } else {
    const updated = await tx.queryOne<{ current_val: number }>(
      'UPDATE doc_sequences SET current_val = current_val + 1 WHERE seq_key = $1 RETURNING current_val',
      [seqName]
    );
    nextVal = Number(updated!.current_val);
  }

  return `${prefix}-${String(nextVal).padStart(padWidth, '0')}`;
}

/**
 * Async PostgreSQL transaction wrapper with explicit PoolClient and savepoint nesting.
 */
export async function withTransaction<T>(
  fn: (tx: DbExecutor) => Promise<T> | T,
  existingTx?: DbExecutor
): Promise<T> {
  await ensureDbReady();

  if (existingTx) {
    const internal = existingTx as InternalExecutor;
    if (internal._client && typeof internal._txDepth === 'number') {
      const nextDepth = internal._txDepth + 1;
      const spName = `sp_${nextDepth}`;
      await internal._client.query(`SAVEPOINT ${spName}`);
      const nestedExec = createExecutorFromQueryable(internal._client, nextDepth, internal._client);
      try {
        const result = await fn(nestedExec);
        await internal._client.query(`RELEASE SAVEPOINT ${spName}`);
        return result;
      } catch (err) {
        try {
          await internal._client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
          await internal._client.query(`RELEASE SAVEPOINT ${spName}`);
        } catch {
          // ignore rollback error
        }
        throw err;
      }
    }
  }

  const pool = getRawPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txExec = createExecutorFromQueryable(client, 0, client);
    const result = await fn(txExec);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw err;
  } finally {
    client.release();
  }
}

export function sanitizeHttpError(err: unknown): { status: number; message: string } {
  const anyErr = err as { code?: string; constraint?: string; message?: string; statusCode?: number };
  if (anyErr?.code) {
    switch (anyErr.code) {
      case 'ECONNREFUSED':
      case 'ENOTFOUND':
      case 'ETIMEDOUT':
      case '57P01':
      case '57P02':
      case '57P03':
      case '08000':
      case '08001':
      case '08003':
      case '08006':
        return { status: 503, message: 'Database connection temporarily unavailable. Please wait a moment and retry.' };
      case '23505': {
        const c = (anyErr.constraint || '').toLowerCase();
        if (c.includes('cash_sessions')) {
          return { status: 409, message: 'A cash session is already OPEN for this counter. Close it before opening a new one.' };
        }
        if (c.includes('username')) {
          return { status: 409, message: 'Username already exists.' };
        }
        if (c.includes('medicine_units')) {
          return { status: 409, message: 'This unit name already exists for the selected medicine.' };
        }
        if (c.includes('batches')) {
          return { status: 409, message: 'Batch with this number and expiry date already exists for this medicine.' };
        }
        return { status: 409, message: 'A record with the same unique identifier already exists.' };
      }
      case '23503':
        return { status: 400, message: 'Referenced record was not found or cannot be deleted while referenced.' };
      case '23514': {
        const c = (anyErr.constraint || '').toLowerCase();
        if (c.includes('non_negative_qty') || c.includes('current_qty_base')) {
          return { status: 409, message: 'Insufficient stock: concurrent request depleted this batch.' };
        }
        return { status: 400, message: 'Submitted value violates data integrity rules.' };
      }
      case '22P02':
        return { status: 400, message: 'Invalid numeric or date format in request.' };
      case '40001':
      case '40P01':
        return { status: 409, message: 'Concurrent update conflict detected. Please retry your request.' };
      default:
        console.error('Unhandled PostgreSQL error:', anyErr.code, anyErr.constraint || '', anyErr.message);
        return { status: 500, message: 'Database operation failed. Please contact the administrator.' };
    }
  }

  const msg = err instanceof Error ? err.message : 'Unexpected server error';
  const status = typeof anyErr?.statusCode === 'number' ? anyErr.statusCode : 400;
  return { status, message: msg };
}

export async function initSchema(db: DbExecutor): Promise<void> {
  await db.execute(`
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
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (idempotency_key, endpoint, user_id)
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      username_key TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      first_attempt_at TIMESTAMPTZ NOT NULL,
      locked_until TIMESTAMPTZ,
      PRIMARY KEY (username_key, ip_address)
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
      default_low_stock_threshold NUMERIC(24, 6) NOT NULL DEFAULT 10.000000,
      logo_data_url TEXT NOT NULL DEFAULT '',
      receipt_footer TEXT NOT NULL DEFAULT 'Thank you for choosing MediNest Pharmacy. Please retain this receipt for returns or inquiries.',
      expiry_warning_days INTEGER NOT NULL DEFAULT 90,
      backup_retention_count INTEGER NOT NULL DEFAULT 14,
      printer_type TEXT NOT NULL DEFAULT 'A5',
      session_timeout_minutes INTEGER NOT NULL DEFAULT 960,
      setup_completed BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL
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
      is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
      effect TEXT NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
      reason TEXT NOT NULL DEFAULT '',
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, permission_code)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
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
      min_stock_level NUMERIC(24, 6) NOT NULL DEFAULT 0.000000,
      rx_required BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicine_units (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      unit_name TEXT NOT NULL,
      conversion_to_base NUMERIC(24, 6) NOT NULL,
      is_base BOOLEAN NOT NULL DEFAULT FALSE,
      allow_purchase BOOLEAN NOT NULL DEFAULT TRUE,
      allow_sale BOOLEAN NOT NULL DEFAULT TRUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
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
      opening_balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      current_balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      advance_balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      notes TEXT NOT NULL DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      opening_balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      current_balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      advance_balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      credit_limit NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      notes TEXT NOT NULL DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      purchase_number TEXT NOT NULL UNIQUE,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      supplier_invoice_no TEXT NOT NULL DEFAULT '',
      purchase_date DATE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('DRAFT', 'RECEIVED', 'CANCELLED', 'REVERSED')),
      gross_subtotal NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      discount_total NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      net_total NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      paid_amount NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      due_amount NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      advance_applied NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      received_by TEXT REFERENCES users(id),
      received_at TIMESTAMPTZ,
      reversed_by TEXT REFERENCES users(id),
      reversed_at TIMESTAMPTZ,
      reversal_reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_number TEXT NOT NULL,
      expiry_date DATE NOT NULL,
      supplier_id TEXT REFERENCES suppliers(id),
      purchase_id TEXT REFERENCES purchases(id),
      received_date DATE NOT NULL,
      purchase_cost_per_base NUMERIC(24, 6) NOT NULL,
      selling_price_per_base NUMERIC(20, 2) NOT NULL,
      initial_qty_base NUMERIC(24, 6) NOT NULL,
      current_qty_base NUMERIC(24, 6) NOT NULL CONSTRAINT chk_batches_non_negative_qty CHECK (current_qty_base >= 0),
      base_unit_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'WRITTEN_OFF', 'INACTIVE', 'DEPLETED', 'DAMAGED')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (medicine_id, batch_number, expiry_date)
    );

    CREATE TABLE IF NOT EXISTS purchase_lines (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_id TEXT REFERENCES batches(id),
      batch_number TEXT NOT NULL,
      expiry_date DATE NOT NULL,
      unit_id TEXT REFERENCES medicine_units(id),
      unit_name_snapshot TEXT NOT NULL,
      conversion_ratio_snapshot NUMERIC(24, 6) NOT NULL,
      qty_input NUMERIC(24, 6) NOT NULL,
      qty_base NUMERIC(24, 6) NOT NULL,
      unit_cost NUMERIC(20, 2) NOT NULL,
      selling_price_per_base NUMERIC(20, 2) NOT NULL,
      line_discount NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      line_total NUMERIC(20, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id TEXT PRIMARY KEY,
      return_number TEXT NOT NULL UNIQUE,
      purchase_id TEXT NOT NULL REFERENCES purchases(id),
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      return_date DATE NOT NULL,
      total_amount NUMERIC(20, 2) NOT NULL,
      settlement_type TEXT NOT NULL CHECK (settlement_type IN ('SUPPLIER_CREDIT', 'CASH_REFUND', 'BANK_REFUND')),
      refund_amount NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      credit_amount NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      due_settled NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      advance_created NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_return_lines (
      id TEXT PRIMARY KEY,
      purchase_return_id TEXT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
      purchase_line_id TEXT REFERENCES purchase_lines(id),
      batch_id TEXT NOT NULL REFERENCES batches(id),
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      qty_base NUMERIC(24, 6) NOT NULL,
      cost_per_base_snapshot NUMERIC(24, 6) NOT NULL,
      line_total NUMERIC(20, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      customer_id TEXT REFERENCES customers(id),
      sale_date DATE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REVERSED')),
      gross_subtotal NUMERIC(20, 2) NOT NULL,
      line_discount_total NUMERIC(20, 2) NOT NULL,
      invoice_discount NUMERIC(20, 2) NOT NULL,
      net_total NUMERIC(20, 2) NOT NULL,
      paid_amount NUMERIC(20, 2) NOT NULL,
      due_amount NUMERIC(20, 2) NOT NULL,
      advance_applied NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      total_cogs NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      reversed_by TEXT REFERENCES users(id),
      reversed_at TIMESTAMPTZ,
      reversal_reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_lines (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      unit_id TEXT REFERENCES medicine_units(id),
      unit_name_snapshot TEXT NOT NULL,
      conversion_ratio_snapshot NUMERIC(24, 6) NOT NULL,
      qty_input NUMERIC(24, 6) NOT NULL,
      qty_base NUMERIC(24, 6) NOT NULL,
      unit_price NUMERIC(20, 2) NOT NULL,
      gross_total NUMERIC(20, 2) NOT NULL,
      line_discount NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      line_total NUMERIC(20, 2) NOT NULL,
      effective_line_total NUMERIC(20, 2),
      cogs_total NUMERIC(20, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_batch_allocations (
      id TEXT PRIMARY KEY,
      sale_line_id TEXT NOT NULL REFERENCES sale_lines(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      qty_base NUMERIC(24, 6) NOT NULL,
      cost_per_base_snapshot NUMERIC(24, 6) NOT NULL,
      cogs_total NUMERIC(20, 2) NOT NULL,
      is_manual_override BOOLEAN NOT NULL DEFAULT FALSE,
      override_reason TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sales_returns (
      id TEXT PRIMARY KEY,
      return_number TEXT NOT NULL UNIQUE,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      customer_id TEXT REFERENCES customers(id),
      return_date DATE NOT NULL,
      total_refund_value NUMERIC(20, 2) NOT NULL,
      settlement_type TEXT NOT NULL CHECK (settlement_type IN ('CASH_REFUND', 'MFS_REFUND', 'CUSTOMER_CREDIT')),
      refund_amount NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      credit_amount NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      due_settled NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      advance_created NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      total_cogs_reversed NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_return_lines (
      id TEXT PRIMARY KEY,
      sales_return_id TEXT NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
      sale_line_id TEXT NOT NULL REFERENCES sale_lines(id),
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_id TEXT NOT NULL REFERENCES batches(id),
      qty_base NUMERIC(24, 6) NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('RESTOCK_SELLABLE', 'QUARANTINE', 'DAMAGED', 'WRITE_OFF', 'NOT_RESTOCKABLE')),
      cost_per_base_snapshot NUMERIC(24, 6) NOT NULL,
      cogs_reversed NUMERIC(20, 2) NOT NULL,
      refund_line_total NUMERIC(20, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_id TEXT NOT NULL REFERENCES batches(id),
      qty_change_base NUMERIC(24, 6) NOT NULL,
      movement_type TEXT NOT NULL CHECK (movement_type IN (
        'OPENING_STOCK', 'PURCHASE_RECEIVED', 'SALE', 'SALE_RETURN',
        'PURCHASE_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
        'DAMAGE_WRITEOFF', 'EXPIRY_WRITEOFF', 'SALE_REVERSAL', 'PURCHASE_REVERSAL'
      )),
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      reference_line_id TEXT NOT NULL DEFAULT '',
      cost_per_base_snapshot NUMERIC(24, 6) NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL
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
      expected_qty_base NUMERIC(24, 6) NOT NULL,
      actual_qty_base NUMERIC(24, 6) NOT NULL,
      variance_qty_base NUMERIC(24, 6) NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id TEXT PRIMARY KEY,
      session_number TEXT NOT NULL UNIQUE,
      counter_code TEXT NOT NULL DEFAULT 'COUNTER-1',
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'FORCE_CLOSED')),
      opened_by TEXT NOT NULL REFERENCES users(id),
      opened_at TIMESTAMPTZ NOT NULL,
      opening_cash NUMERIC(20, 2) NOT NULL,
      closed_by TEXT REFERENCES users(id),
      closed_at TIMESTAMPTZ,
      expected_cash NUMERIC(20, 2),
      actual_cash NUMERIC(20, 2),
      variance NUMERIC(20, 2),
      variance_reason TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT ''
    );
    ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS counter_code TEXT NOT NULL DEFAULT 'COUNTER-1';

    CREATE TABLE IF NOT EXISTS cash_movements (
      id TEXT PRIMARY KEY,
      cash_session_id TEXT NOT NULL REFERENCES cash_sessions(id),
      movement_type TEXT NOT NULL CHECK (movement_type IN (
        'OPENING_CASH', 'CASH_SALE', 'CUSTOMER_CASH_COLLECTION',
        'SUPPLIER_CASH_PAYMENT', 'CASH_EXPENSE', 'CASH_REFUND',
        'CASH_ADJUSTMENT', 'CASH_VARIANCE', 'REVERSAL'
      )),
      amount_signed NUMERIC(20, 2) NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      payment_number TEXT NOT NULL UNIQUE,
      party_type TEXT NOT NULL CHECK (party_type IN ('CUSTOMER', 'SUPPLIER', 'EXPENSE')),
      party_id TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
      method TEXT NOT NULL CHECK (method IN ('CASH', 'BKASH', 'NAGAD', 'ROCKET', 'BANK', 'CARD', 'OTHER')),
      amount NUMERIC(20, 2) NOT NULL,
      reference_no TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('POSTED', 'REVERSED')),
      reversed_payment_id TEXT REFERENCES payments(id),
      reversal_reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_allocations (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('SALE', 'PURCHASE', 'CUSTOMER_OPENING', 'SUPPLIER_OPENING')),
      target_id TEXT NOT NULL,
      amount_allocated NUMERIC(20, 2) NOT NULL
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
      amount NUMERIC(20, 2) NOT NULL,
      expense_date DATE NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'BKASH', 'NAGAD', 'ROCKET', 'BANK', 'CARD', 'OTHER')),
      reference_no TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('POSTED', 'REVERSED')),
      reversed_by TEXT REFERENCES users(id),
      reversed_at TIMESTAMPTZ,
      reversal_reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
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
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backup_records (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      integrity_check_result TEXT NOT NULL,
      backup_type TEXT NOT NULL CHECK (backup_type IN ('MANUAL', 'AUTO_DAILY', 'PRE_UPDATE', 'PRE_RESTORE')),
      status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'FAILED')),
      error_message TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS party_advance_ledger (
      id TEXT PRIMARY KEY,
      party_type TEXT NOT NULL CHECK (party_type IN ('CUSTOMER', 'SUPPLIER')),
      party_id TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('ADVANCE_RECEIPT', 'RETURN_CREDIT', 'APPLIED_TO_INVOICE', 'REVERSAL')),
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      amount_signed NUMERIC(20, 2) NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL
    );

    -- Concurrency & uniqueness constraints (independent open cash session per POS counter)
    DROP INDEX IF EXISTS uq_cash_sessions_single_open;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_sessions_open_per_counter ON cash_sessions (counter_code) WHERE status = 'OPEN';

    -- Operational query indexes
    CREATE INDEX IF NOT EXISTS idx_medicines_brand ON medicines(brand_name);
    CREATE INDEX IF NOT EXISTS idx_medicines_generic ON medicines(generic_name);
    CREATE INDEX IF NOT EXISTS idx_medicines_code ON medicines(medicine_code);
    CREATE INDEX IF NOT EXISTS idx_medicines_barcode ON medicines(barcode);
    CREATE INDEX IF NOT EXISTS idx_medicine_units_medicine ON medicine_units(medicine_id);
    CREATE INDEX IF NOT EXISTS idx_batches_medicine_expiry ON batches(medicine_id, status, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_batches_status_expiry ON batches(status, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_batch ON stock_movements(batch_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date, status);
    CREATE INDEX IF NOT EXISTS idx_sales_returns_date ON sales_returns(return_date);
    CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
    CREATE INDEX IF NOT EXISTS idx_sale_lines_sale ON sale_lines(sale_id);
    CREATE INDEX IF NOT EXISTS idx_sale_batch_alloc_line ON sale_batch_allocations(sale_line_id);
    CREATE INDEX IF NOT EXISTS idx_sales_return_lines_sale_line ON sales_return_lines(sale_line_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date, status);
    CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_lines_purchase ON purchase_lines(purchase_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_return_lines_line ON purchase_return_lines(purchase_line_id);
    CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_alloc_target ON payment_allocations(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit_logs(seq);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, module);
    CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_advance_ledger_party ON party_advance_ledger(party_type, party_id, created_at);

    -- Ensure obsolete software-licensing artifacts are absent
    DROP TABLE IF EXISTS license_state;
    DELETE FROM permissions WHERE code = 'admin.license';
  `);
}
