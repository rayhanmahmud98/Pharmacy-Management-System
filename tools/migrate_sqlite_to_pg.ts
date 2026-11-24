import 'dotenv/config';
import Decimal from 'decimal.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyAuditChain } from '../server/audit.ts';
import { type DbExecutor, SQLITE_LEGACY_PATH, closeDb, getDb, withTransaction } from '../server/db.ts';
import { reconcileInventoryLedger } from '../server/services/inventoryService.ts';

export interface MigrationSummary {
  sourcePath: string;
  targetDatabase: string;
  tableCounts: Record<string, { sqlite: number; postgres: number }>;
  financialTotals: {
    salesNetTotal: { sqlite: string; postgres: string };
    purchasesNetTotal: { sqlite: string; postgres: string };
    paymentsTotal: { sqlite: string; postgres: string };
    expensesTotal: { sqlite: string; postgres: string };
    batchStockTotalBase: { sqlite: string; postgres: string };
  };
  inventoryLedgerHealthy: boolean;
  auditChainValid: boolean;
  auditEntries: number;
}

function asBool(val: unknown, fallback = false): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === '1' || s === 'true') return true;
    if (s === '0' || s === 'false') return false;
  }
  return fallback;
}

function asStr(val: unknown, fallback = ''): string {
  if (val === null || val === undefined) return fallback;
  return String(val);
}

function asNullableStr(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val);
  return s === '' ? null : s;
}

function asInt(val: unknown, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asBigIntNum(val: unknown, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asDec(val: unknown, scale: number, fallback = '0'): string {
  if (val === null || val === undefined || String(val).trim() === '') {
    return new Decimal(fallback).toFixed(scale);
  }
  return new Decimal(String(val)).toFixed(scale);
}

function asNullableDec(val: unknown, scale: number): string | null {
  if (val === null || val === undefined || String(val).trim() === '') return null;
  return new Decimal(String(val)).toFixed(scale);
}

function stageReadOnlySqliteCopy(sourcePath: string): { tmpDir: string; db: DatabaseSync } {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SQLite source database not found at: ${sourcePath}`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medinest-sqlite-ro-'));
  const stagedDb = path.join(tmpDir, 'pharmacy.db');
  fs.copyFileSync(sourcePath, stagedDb);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${sourcePath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, `${stagedDb}${suffix}`);
    }
  }
  const db = new DatabaseSync(stagedDb, { readOnly: true });
  return { tmpDir, db };
}

function tableExists(sqlite: DatabaseSync, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function readRows(sqlite: DatabaseSync, tableName: string, orderBy = ''): Array<Record<string, unknown>> {
  if (!tableExists(sqlite, tableName)) return [];
  const sql = orderBy ? `SELECT * FROM ${tableName} ORDER BY ${orderBy}` : `SELECT * FROM ${tableName}`;
  return sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
}

function sumDecimal(rows: Array<Record<string, unknown>>, col: string, scale: number): string {
  let total = new Decimal(0);
  for (const r of rows) {
    const v = r[col];
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      total = total.add(new Decimal(String(v)));
    }
  }
  return total.toFixed(scale);
}

async function syncCodeSequence(
  tx: DbExecutor,
  seqName: string,
  prefix: string,
  table: 'medicines' | 'customers' | 'suppliers',
  column: 'medicine_code' | 'code'
): Promise<void> {
  const rows = await tx.query<{ val: string }>(`SELECT ${column} AS val FROM ${table}`);
  let maxVal = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`, 'i');
  for (const r of rows) {
    const m = re.exec(String(r.val || '').trim());
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxVal) maxVal = n;
    }
  }
  if (maxVal > 0) {
    await tx.execute(
      `INSERT INTO doc_sequences (seq_key, current_val)
       VALUES ($1, $2)
       ON CONFLICT (seq_key) DO UPDATE SET current_val = GREATEST(doc_sequences.current_val, EXCLUDED.current_val)`,
      [seqName, maxVal]
    );
  }
}

export async function migrateSqliteToPostgres(options?: {
  sqlitePath?: string;
  force?: boolean;
}): Promise<MigrationSummary> {
  const sqlitePath = path.resolve(options?.sqlitePath || SQLITE_LEGACY_PATH);
  const force = Boolean(options?.force);

  const { tmpDir, db: sqlite } = stageReadOnlySqliteCopy(sqlitePath);
  try {
    // Ensure PostgreSQL schema exists first
    const rootDb = await getDb();
    const dbMeta = await rootDb.queryOne<{ db: string }>('SELECT current_database() AS db');
    const targetDatabase = String(dbMeta?.db || '');

    const summary = await withTransaction(async (tx) => {
      await tx.execute('SELECT pg_advisory_xact_lock(90421099)');

      const checkTables = ['users', 'medicines', 'sales', 'purchases', 'batches', 'audit_logs'] as const;
      let existingRows = 0;
      for (const t of checkTables) {
        const c = await tx.queryOne<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM ${t}`);
        existingRows += Number(c?.cnt ?? 0);
      }

      if (existingRows > 0 && !force) {
        throw new Error(
          `Target PostgreSQL database '${targetDatabase}' is not empty (${existingRows} rows across core tables). Re-run with --force to cleanly replace target data.`
        );
      }

      if (force) {
        await tx.execute(`
          TRUNCATE TABLE
            party_advance_ledger,
            backup_records,
            audit_logs,
            expenses,
            expense_categories,
            payment_allocations,
            payments,
            cash_movements,
            cash_sessions,
            stock_adjustments,
            stock_movements,
            sales_return_lines,
            sales_returns,
            sale_batch_allocations,
            sale_lines,
            sales,
            purchase_return_lines,
            purchase_returns,
            purchase_lines,
            batches,
            purchases,
            customers,
            suppliers,
            medicine_units,
            medicines,
            manufacturers,
            categories,
            sessions,
            user_permission_overrides,
            users,
            role_permissions,
            permissions,
            roles,
            pharmacy_settings,
            login_attempts,
            idempotency_keys,
            doc_sequences
          RESTART IDENTITY CASCADE
        `);
      }

      const tableCounts: Record<string, { sqlite: number; postgres: number }> = {};

      const docSeqs = readRows(sqlite, 'doc_sequences');
      for (const r of docSeqs) {
        await tx.execute('INSERT INTO doc_sequences (seq_key, current_val) VALUES ($1, $2)', [
          asStr(r.seq_key),
          asInt(r.current_val),
        ]);
      }

      const idempKeys = readRows(sqlite, 'idempotency_keys');
      for (const r of idempKeys) {
        await tx.execute(
          `INSERT INTO idempotency_keys (idempotency_key, endpoint, user_id, request_hash, response_status, response_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            asStr(r.idempotency_key),
            asStr(r.endpoint),
            asStr(r.user_id),
            asStr(r.request_hash),
            asInt(r.response_status, 200),
            asStr(r.response_json, '{}'),
            asStr(r.created_at),
          ]
        );
      }

      const loginAttempts = readRows(sqlite, 'login_attempts');
      for (const r of loginAttempts) {
        await tx.execute(
          `INSERT INTO login_attempts (username_key, ip_address, attempt_count, first_attempt_at, locked_until)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            asStr(r.username_key),
            asStr(r.ip_address),
            asInt(r.attempt_count),
            asStr(r.first_attempt_at),
            asNullableStr(r.locked_until),
          ]
        );
      }

      const settings = readRows(sqlite, 'pharmacy_settings');
      for (const r of settings) {
        await tx.execute(
          `INSERT INTO pharmacy_settings (
            id, pharmacy_name, pharmacy_name_bn, drug_license_no, address, phone, email, website,
            currency, currency_symbol, timezone, default_low_stock_threshold, logo_data_url,
            receipt_footer, expiry_warning_days, backup_retention_count, printer_type,
            session_timeout_minutes, setup_completed, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            asInt(r.id, 1),
            asStr(r.pharmacy_name, 'MediNest'),
            asStr(r.pharmacy_name_bn, ''),
            asStr(r.drug_license_no, ''),
            asStr(r.address, ''),
            asStr(r.phone, ''),
            asStr(r.email, ''),
            asStr(r.website, ''),
            asStr(r.currency, 'BDT'),
            asStr(r.currency_symbol, '৳'),
            asStr(r.timezone, 'Asia/Dhaka'),
            asDec(r.default_low_stock_threshold, 6, '10'),
            asStr(r.logo_data_url, ''),
            asStr(r.receipt_footer, ''),
            asInt(r.expiry_warning_days, 90),
            asInt(r.backup_retention_count, 14),
            asStr(r.printer_type, 'A5'),
            asInt(r.session_timeout_minutes, 960),
            asBool(r.setup_completed, true),
            asStr(r.updated_at),
          ]
        );
      }

      const roles = readRows(sqlite, 'roles');
      for (const r of roles) {
        await tx.execute(
          `INSERT INTO roles (id, name, description, is_system, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [asStr(r.id), asStr(r.name), asStr(r.description), asBool(r.is_system), asStr(r.created_at)]
        );
      }

      const permissions = readRows(sqlite, 'permissions').filter((r) => asStr(r.code) !== 'admin.license');
      for (const r of permissions) {
        await tx.execute(
          `INSERT INTO permissions (code, module, label, description)
           VALUES ($1, $2, $3, $4)`,
          [asStr(r.code), asStr(r.module), asStr(r.label), asStr(r.description)]
        );
      }

      const rolePerms = readRows(sqlite, 'role_permissions').filter((r) => asStr(r.permission_code) !== 'admin.license');
      for (const r of rolePerms) {
        await tx.execute(
          `INSERT INTO role_permissions (role_id, permission_code)
           VALUES ($1, $2)`,
          [asStr(r.role_id), asStr(r.permission_code)]
        );
      }

      const users = readRows(sqlite, 'users');
      for (const r of users) {
        await tx.execute(
          `INSERT INTO users (
            id, username, full_name, phone, email, password_hash, role_id,
            is_super_admin, is_active, must_change_password, last_login_at,
            preferences_json, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            asStr(r.id),
            asStr(r.username),
            asStr(r.full_name),
            asStr(r.phone),
            asStr(r.email),
            asStr(r.password_hash),
            asStr(r.role_id),
            asBool(r.is_super_admin),
            asBool(r.is_active, true),
            asBool(r.must_change_password),
            asNullableStr(r.last_login_at),
            asStr(r.preferences_json, '{}'),
            asStr(r.created_at),
            asStr(r.updated_at),
          ]
        );
      }

      const overrides = readRows(sqlite, 'user_permission_overrides').filter(
        (r) => asStr(r.permission_code) !== 'admin.license'
      );
      for (const r of overrides) {
        await tx.execute(
          `INSERT INTO user_permission_overrides (user_id, permission_code, effect, reason, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            asStr(r.user_id),
            asStr(r.permission_code),
            asStr(r.effect),
            asStr(r.reason),
            asNullableStr(r.updated_by),
            asStr(r.updated_at),
          ]
        );
      }

      const sessions = readRows(sqlite, 'sessions');
      for (const r of sessions) {
        await tx.execute(
          `INSERT INTO sessions (token, user_id, expires_at, created_at)
           VALUES ($1, $2, $3, $4)`,
          [asStr(r.token), asStr(r.user_id), asStr(r.expires_at), asStr(r.created_at)]
        );
      }

      const categories = readRows(sqlite, 'categories');
      for (const r of categories) {
        await tx.execute('INSERT INTO categories (id, name, description) VALUES ($1, $2, $3)', [
          asStr(r.id),
          asStr(r.name),
          asStr(r.description),
        ]);
      }

      const manufacturers = readRows(sqlite, 'manufacturers');
      for (const r of manufacturers) {
        await tx.execute('INSERT INTO manufacturers (id, name, country, phone) VALUES ($1, $2, $3, $4)', [
          asStr(r.id),
          asStr(r.name),
          asStr(r.country, 'Bangladesh'),
          asStr(r.phone),
        ]);
      }

      const medicines = readRows(sqlite, 'medicines');
      for (const r of medicines) {
        await tx.execute(
          `INSERT INTO medicines (
            id, medicine_code, barcode, brand_name, generic_name, bangla_name, alternative_names,
            strength, dosage_form, category_id, manufacturer_id, storage_info, description,
            base_unit_name, min_stock_level, rx_required, is_active, notes, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            asStr(r.id),
            asStr(r.medicine_code),
            asStr(r.barcode),
            asStr(r.brand_name),
            asStr(r.generic_name),
            asStr(r.bangla_name),
            asStr(r.alternative_names),
            asStr(r.strength),
            asStr(r.dosage_form),
            asNullableStr(r.category_id),
            asNullableStr(r.manufacturer_id),
            asStr(r.storage_info),
            asStr(r.description),
            asStr(r.base_unit_name),
            asDec(r.min_stock_level, 6, '0'),
            asBool(r.rx_required),
            asBool(r.is_active, true),
            asStr(r.notes),
            asStr(r.created_at),
            asStr(r.updated_at),
          ]
        );
      }

      const medicineUnits = readRows(sqlite, 'medicine_units');
      for (const r of medicineUnits) {
        await tx.execute(
          `INSERT INTO medicine_units (
            id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            asStr(r.id),
            asStr(r.medicine_id),
            asStr(r.unit_name),
            asDec(r.conversion_to_base, 6, '1'),
            asBool(r.is_base),
            asBool(r.allow_purchase, true),
            asBool(r.allow_sale, true),
            asBool(r.is_active, true),
            asStr(r.created_at),
            asStr(r.updated_at),
          ]
        );
      }

      const suppliers = readRows(sqlite, 'suppliers');
      for (const r of suppliers) {
        await tx.execute(
          `INSERT INTO suppliers (
            id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes,
            opening_balance, current_balance, advance_balance, notes, is_active, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            asStr(r.id),
            asStr(r.code),
            asStr(r.name),
            asStr(r.contact_person),
            asStr(r.phone),
            asStr(r.address),
            asInt(r.return_policy_days, 30),
            asStr(r.return_policy_notes),
            asDec(r.opening_balance, 2, '0'),
            asDec(r.current_balance, 2, '0'),
            asDec(r.advance_balance, 2, '0'),
            asStr(r.notes),
            asBool(r.is_active, true),
            asStr(r.created_at),
            asStr(r.updated_at),
          ]
        );
      }

      const customers = readRows(sqlite, 'customers');
      for (const r of customers) {
        await tx.execute(
          `INSERT INTO customers (
            id, code, name, phone, address, opening_balance, current_balance, advance_balance,
            credit_limit, notes, is_active, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            asStr(r.id),
            asStr(r.code),
            asStr(r.name),
            asStr(r.phone),
            asStr(r.address),
            asDec(r.opening_balance, 2, '0'),
            asDec(r.current_balance, 2, '0'),
            asDec(r.advance_balance, 2, '0'),
            asDec(r.credit_limit, 2, '0'),
            asStr(r.notes),
            asBool(r.is_active, true),
            asStr(r.created_at),
            asStr(r.updated_at),
          ]
        );
      }

      const purchases = readRows(sqlite, 'purchases');
      for (const r of purchases) {
        await tx.execute(
          `INSERT INTO purchases (
            id, purchase_number, supplier_id, supplier_invoice_no, purchase_date, status,
            gross_subtotal, discount_total, net_total, paid_amount, due_amount, advance_applied,
            notes, created_by, received_by, received_at, reversed_by, reversed_at, reversal_reason,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
          [
            asStr(r.id),
            asStr(r.purchase_number),
            asStr(r.supplier_id),
            asStr(r.supplier_invoice_no),
            asStr(r.purchase_date),
            asStr(r.status),
            asDec(r.gross_subtotal, 2, '0'),
            asDec(r.discount_total, 2, '0'),
            asDec(r.net_total, 2, '0'),
            asDec(r.paid_amount, 2, '0'),
            asDec(r.due_amount, 2, '0'),
            asDec(r.advance_applied, 2, '0'),
            asStr(r.notes),
            asStr(r.created_by),
            asNullableStr(r.received_by),
            asNullableStr(r.received_at),
            asNullableStr(r.reversed_by),
            asNullableStr(r.reversed_at),
            asStr(r.reversal_reason),
            asStr(r.created_at),
            asStr(r.updated_at),
          ]
        );
      }

      const batches = readRows(sqlite, 'batches');
      for (const r of batches) {
        await tx.execute(
          `INSERT INTO batches (
            id, medicine_id, batch_number, expiry_date, supplier_id, purchase_id, received_date,
            purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
            base_unit_name, status, notes, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            asStr(r.id),
            asStr(r.medicine_id),
            asStr(r.batch_number),
            asStr(r.expiry_date),
            asNullableStr(r.supplier_id),
            asNullableStr(r.purchase_id),
            asStr(r.received_date),
            asDec(r.purchase_cost_per_base, 6, '0'),
            asDec(r.selling_price_per_base, 2, '0'),
            asDec(r.initial_qty_base, 6, '0'),
            asDec(r.current_qty_base, 6, '0'),
            asStr(r.base_unit_name),
            asStr(r.status),
            asStr(r.notes),
            asStr(r.created_at),
            asStr(r.updated_at),
          ]
        );
      }

      const purchaseLines = readRows(sqlite, 'purchase_lines');
      for (const r of purchaseLines) {
        await tx.execute(
          `INSERT INTO purchase_lines (
            id, purchase_id, medicine_id, batch_id, batch_number, expiry_date, unit_id,
            unit_name_snapshot, conversion_ratio_snapshot, qty_input, qty_base, unit_cost,
            selling_price_per_base, line_discount, line_total
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            asStr(r.id),
            asStr(r.purchase_id),
            asStr(r.medicine_id),
            asNullableStr(r.batch_id),
            asStr(r.batch_number),
            asStr(r.expiry_date),
            asNullableStr(r.unit_id),
            asStr(r.unit_name_snapshot),
            asDec(r.conversion_ratio_snapshot, 6, '1'),
            asDec(r.qty_input, 6, '0'),
            asDec(r.qty_base, 6, '0'),
            asDec(r.unit_cost, 2, '0'),
            asDec(r.selling_price_per_base, 2, '0'),
            asDec(r.line_discount, 2, '0'),
            asDec(r.line_total, 2, '0'),
          ]
        );
      }

      const purchaseReturns = readRows(sqlite, 'purchase_returns');
      for (const r of purchaseReturns) {
        await tx.execute(
          `INSERT INTO purchase_returns (
            id, return_number, purchase_id, supplier_id, return_date, total_amount,
            settlement_type, refund_amount, credit_amount, due_settled, advance_created,
            reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            asStr(r.id),
            asStr(r.return_number),
            asStr(r.purchase_id),
            asStr(r.supplier_id),
            asStr(r.return_date),
            asDec(r.total_amount, 2, '0'),
            asStr(r.settlement_type),
            asDec(r.refund_amount, 2, '0'),
            asDec(r.credit_amount, 2, '0'),
            asDec(r.due_settled, 2, '0'),
            asDec(r.advance_created, 2, '0'),
            asStr(r.reason),
            asStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      const purchaseReturnLines = readRows(sqlite, 'purchase_return_lines');
      for (const r of purchaseReturnLines) {
        await tx.execute(
          `INSERT INTO purchase_return_lines (
            id, purchase_return_id, purchase_line_id, batch_id, medicine_id, qty_base, cost_per_base_snapshot, line_total
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            asStr(r.id),
            asStr(r.purchase_return_id),
            asNullableStr(r.purchase_line_id),
            asStr(r.batch_id),
            asStr(r.medicine_id),
            asDec(r.qty_base, 6, '0'),
            asDec(r.cost_per_base_snapshot, 6, '0'),
            asDec(r.line_total, 2, '0'),
          ]
        );
      }

      const sales = readRows(sqlite, 'sales');
      for (const r of sales) {
        await tx.execute(
          `INSERT INTO sales (
            id, invoice_number, customer_id, sale_date, status, gross_subtotal, line_discount_total,
            invoice_discount, net_total, paid_amount, due_amount, advance_applied, total_cogs,
            notes, created_by, reversed_by, reversed_at, reversal_reason, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            asStr(r.id),
            asStr(r.invoice_number),
            asNullableStr(r.customer_id),
            asStr(r.sale_date),
            asStr(r.status),
            asDec(r.gross_subtotal, 2, '0'),
            asDec(r.line_discount_total, 2, '0'),
            asDec(r.invoice_discount, 2, '0'),
            asDec(r.net_total, 2, '0'),
            asDec(r.paid_amount, 2, '0'),
            asDec(r.due_amount, 2, '0'),
            asDec(r.advance_applied, 2, '0'),
            asDec(r.total_cogs, 2, '0'),
            asStr(r.notes),
            asStr(r.created_by),
            asNullableStr(r.reversed_by),
            asNullableStr(r.reversed_at),
            asStr(r.reversal_reason),
            asStr(r.created_at),
          ]
        );
      }

      const saleLines = readRows(sqlite, 'sale_lines');
      for (const r of saleLines) {
        await tx.execute(
          `INSERT INTO sale_lines (
            id, sale_id, medicine_id, unit_id, unit_name_snapshot, conversion_ratio_snapshot,
            qty_input, qty_base, unit_price, gross_total, line_discount, line_total,
            effective_line_total, cogs_total
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            asStr(r.id),
            asStr(r.sale_id),
            asStr(r.medicine_id),
            asNullableStr(r.unit_id),
            asStr(r.unit_name_snapshot),
            asDec(r.conversion_ratio_snapshot, 6, '1'),
            asDec(r.qty_input, 6, '0'),
            asDec(r.qty_base, 6, '0'),
            asDec(r.unit_price, 2, '0'),
            asDec(r.gross_total, 2, '0'),
            asDec(r.line_discount, 2, '0'),
            asDec(r.line_total, 2, '0'),
            asNullableDec(r.effective_line_total, 2),
            asDec(r.cogs_total, 2, '0'),
          ]
        );
      }

      const saleAllocs = readRows(sqlite, 'sale_batch_allocations');
      for (const r of saleAllocs) {
        await tx.execute(
          `INSERT INTO sale_batch_allocations (
            id, sale_line_id, batch_id, qty_base, cost_per_base_snapshot, cogs_total, is_manual_override, override_reason
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            asStr(r.id),
            asStr(r.sale_line_id),
            asStr(r.batch_id),
            asDec(r.qty_base, 6, '0'),
            asDec(r.cost_per_base_snapshot, 6, '0'),
            asDec(r.cogs_total, 2, '0'),
            asBool(r.is_manual_override),
            asStr(r.override_reason),
          ]
        );
      }

      const salesReturns = readRows(sqlite, 'sales_returns');
      for (const r of salesReturns) {
        await tx.execute(
          `INSERT INTO sales_returns (
            id, return_number, sale_id, customer_id, return_date, total_refund_value,
            settlement_type, refund_amount, credit_amount, due_settled, advance_created,
            total_cogs_reversed, reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            asStr(r.id),
            asStr(r.return_number),
            asStr(r.sale_id),
            asNullableStr(r.customer_id),
            asStr(r.return_date),
            asDec(r.total_refund_value, 2, '0'),
            asStr(r.settlement_type),
            asDec(r.refund_amount, 2, '0'),
            asDec(r.credit_amount, 2, '0'),
            asDec(r.due_settled, 2, '0'),
            asDec(r.advance_created, 2, '0'),
            asDec(r.total_cogs_reversed, 2, '0'),
            asStr(r.reason),
            asStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      const salesReturnLines = readRows(sqlite, 'sales_return_lines');
      for (const r of salesReturnLines) {
        await tx.execute(
          `INSERT INTO sales_return_lines (
            id, sales_return_id, sale_line_id, medicine_id, batch_id, qty_base, disposition,
            cost_per_base_snapshot, cogs_reversed, refund_line_total
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            asStr(r.id),
            asStr(r.sales_return_id),
            asStr(r.sale_line_id),
            asStr(r.medicine_id),
            asStr(r.batch_id),
            asDec(r.qty_base, 6, '0'),
            asStr(r.disposition),
            asDec(r.cost_per_base_snapshot, 6, '0'),
            asDec(r.cogs_reversed, 2, '0'),
            asDec(r.refund_line_total, 2, '0'),
          ]
        );
      }

      const stockMovements = readRows(sqlite, 'stock_movements');
      for (const r of stockMovements) {
        await tx.execute(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id,
            reference_line_id, cost_per_base_snapshot, reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            asStr(r.id),
            asStr(r.medicine_id),
            asStr(r.batch_id),
            asDec(r.qty_change_base, 6, '0'),
            asStr(r.movement_type),
            asStr(r.reference_type),
            asStr(r.reference_id),
            asStr(r.reference_line_id),
            asDec(r.cost_per_base_snapshot, 6, '0'),
            asStr(r.reason),
            asStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      const stockAdjustments = readRows(sqlite, 'stock_adjustments');
      for (const r of stockAdjustments) {
        await tx.execute(
          `INSERT INTO stock_adjustments (
            id, adjustment_number, batch_id, medicine_id, adjustment_type, expected_qty_base,
            actual_qty_base, variance_qty_base, reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            asStr(r.id),
            asStr(r.adjustment_number),
            asStr(r.batch_id),
            asStr(r.medicine_id),
            asStr(r.adjustment_type),
            asDec(r.expected_qty_base, 6, '0'),
            asDec(r.actual_qty_base, 6, '0'),
            asDec(r.variance_qty_base, 6, '0'),
            asStr(r.reason),
            asStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      const cashSessions = readRows(sqlite, 'cash_sessions');
      for (const r of cashSessions) {
        await tx.execute(
          `INSERT INTO cash_sessions (
            id, session_number, status, opened_by, opened_at, opening_cash,
            closed_by, closed_at, expected_cash, actual_cash, variance, variance_reason, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            asStr(r.id),
            asStr(r.session_number),
            asStr(r.status),
            asStr(r.opened_by),
            asStr(r.opened_at),
            asDec(r.opening_cash, 2, '0'),
            asNullableStr(r.closed_by),
            asNullableStr(r.closed_at),
            asNullableDec(r.expected_cash, 2),
            asNullableDec(r.actual_cash, 2),
            asNullableDec(r.variance, 2),
            asStr(r.variance_reason),
            asStr(r.notes),
          ]
        );
      }

      const cashMovements = readRows(sqlite, 'cash_movements');
      for (const r of cashMovements) {
        await tx.execute(
          `INSERT INTO cash_movements (
            id, cash_session_id, movement_type, amount_signed, reference_type, reference_id, notes, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            asStr(r.id),
            asStr(r.cash_session_id),
            asStr(r.movement_type),
            asDec(r.amount_signed, 2, '0'),
            asStr(r.reference_type),
            asStr(r.reference_id),
            asStr(r.notes),
            asStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      const payments = readRows(sqlite, 'payments');
      for (const r of payments) {
        await tx.execute(
          `INSERT INTO payments (
            id, payment_number, party_type, party_id, direction, method, amount, reference_no,
            notes, status, reversed_payment_id, reversal_reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            asStr(r.id),
            asStr(r.payment_number),
            asStr(r.party_type),
            asStr(r.party_id),
            asStr(r.direction),
            asStr(r.method),
            asDec(r.amount, 2, '0'),
            asStr(r.reference_no),
            asStr(r.notes),
            asStr(r.status),
            asNullableStr(r.reversed_payment_id),
            asStr(r.reversal_reason),
            asStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      const paymentAllocations = readRows(sqlite, 'payment_allocations');
      for (const r of paymentAllocations) {
        await tx.execute(
          `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, amount_allocated)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            asStr(r.id),
            asStr(r.payment_id),
            asStr(r.target_type),
            asStr(r.target_id),
            asDec(r.amount_allocated, 2, '0'),
          ]
        );
      }

      const expenseCategories = readRows(sqlite, 'expense_categories');
      for (const r of expenseCategories) {
        await tx.execute('INSERT INTO expense_categories (id, name) VALUES ($1, $2)', [
          asStr(r.id),
          asStr(r.name),
        ]);
      }

      const expenses = readRows(sqlite, 'expenses');
      for (const r of expenses) {
        await tx.execute(
          `INSERT INTO expenses (
            id, expense_number, category_id, name, amount, expense_date, payment_method,
            reference_no, notes, status, reversed_by, reversed_at, reversal_reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            asStr(r.id),
            asStr(r.expense_number),
            asStr(r.category_id),
            asStr(r.name),
            asDec(r.amount, 2, '0'),
            asStr(r.expense_date),
            asStr(r.payment_method),
            asStr(r.reference_no),
            asStr(r.notes),
            asStr(r.status),
            asNullableStr(r.reversed_by),
            asNullableStr(r.reversed_at),
            asStr(r.reversal_reason),
            asStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      const auditLogs = readRows(sqlite, 'audit_logs', 'seq ASC');
      for (const r of auditLogs) {
        await tx.execute(
          `INSERT INTO audit_logs (
            id, seq, user_id, username, session_id, ip_address, action, module, target_type,
            target_id, transaction_ref, status, before_state, after_state, metadata_json,
            reason, prev_hash, entry_hash, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            asStr(r.id),
            asInt(r.seq),
            asNullableStr(r.user_id),
            asStr(r.username, 'system'),
            asStr(r.session_id, ''),
            asStr(r.ip_address, ''),
            asStr(r.action),
            asStr(r.module),
            asStr(r.target_type),
            asStr(r.target_id),
            asStr(r.transaction_ref, ''),
            asStr(r.status, 'SUCCESS'),
            asStr(r.before_state, '{}'),
            asStr(r.after_state, '{}'),
            asStr(r.metadata_json, '{}'),
            asStr(r.reason, ''),
            asStr(r.prev_hash),
            asStr(r.entry_hash),
            asStr(r.created_at),
          ]
        );
      }

      const backupRecords = readRows(sqlite, 'backup_records');
      for (const r of backupRecords) {
        await tx.execute(
          `INSERT INTO backup_records (
            id, filename, file_path, size_bytes, sha256, integrity_check_result,
            backup_type, status, error_message, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            asStr(r.id),
            asStr(r.filename),
            asStr(r.file_path),
            asBigIntNum(r.size_bytes),
            asStr(r.sha256),
            asStr(r.integrity_check_result),
            asStr(r.backup_type),
            asStr(r.status),
            asStr(r.error_message, ''),
            asNullableStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      const advanceLedger = readRows(sqlite, 'party_advance_ledger');
      for (const r of advanceLedger) {
        await tx.execute(
          `INSERT INTO party_advance_ledger (
            id, party_type, party_id, entry_type, source_type, source_id, amount_signed, notes, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            asStr(r.id),
            asStr(r.party_type),
            asStr(r.party_id),
            asStr(r.entry_type),
            asStr(r.source_type),
            asStr(r.source_id),
            asDec(r.amount_signed, 2, '0'),
            asStr(r.notes, ''),
            asStr(r.created_by),
            asStr(r.created_at),
          ]
        );
      }

      // Synchronize entity code sequences so subsequent inserts never collide
      await syncCodeSequence(tx, 'CODE-MED', 'MED', 'medicines', 'medicine_code');
      await syncCodeSequence(tx, 'CODE-CUST', 'CUST', 'customers', 'code');
      await syncCodeSequence(tx, 'CODE-SUP', 'SUP', 'suppliers', 'code');

      // Verify exact row counts across every migrated table
      const countCheckPairs: Array<[string, number]> = [
        ['doc_sequences', docSeqs.length],
        ['idempotency_keys', idempKeys.length],
        ['login_attempts', loginAttempts.length],
        ['pharmacy_settings', settings.length],
        ['roles', roles.length],
        ['permissions', permissions.length],
        ['role_permissions', rolePerms.length],
        ['users', users.length],
        ['user_permission_overrides', overrides.length],
        ['sessions', sessions.length],
        ['categories', categories.length],
        ['manufacturers', manufacturers.length],
        ['medicines', medicines.length],
        ['medicine_units', medicineUnits.length],
        ['suppliers', suppliers.length],
        ['customers', customers.length],
        ['purchases', purchases.length],
        ['batches', batches.length],
        ['purchase_lines', purchaseLines.length],
        ['purchase_returns', purchaseReturns.length],
        ['purchase_return_lines', purchaseReturnLines.length],
        ['sales', sales.length],
        ['sale_lines', saleLines.length],
        ['sale_batch_allocations', saleAllocs.length],
        ['sales_returns', salesReturns.length],
        ['sales_return_lines', salesReturnLines.length],
        ['stock_movements', stockMovements.length],
        ['stock_adjustments', stockAdjustments.length],
        ['cash_sessions', cashSessions.length],
        ['cash_movements', cashMovements.length],
        ['payments', payments.length],
        ['payment_allocations', paymentAllocations.length],
        ['expense_categories', expenseCategories.length],
        ['expenses', expenses.length],
        ['audit_logs', auditLogs.length],
        ['backup_records', backupRecords.length],
        ['party_advance_ledger', advanceLedger.length],
      ];

      for (const [table, sqliteCount] of countCheckPairs) {
        const pgRes = await tx.queryOne<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM ${table}`);
        const pgCount = Number(pgRes?.cnt ?? 0);
        // doc_sequences may contain newly synced CODE-* entries >= sqliteCount
        if (table === 'doc_sequences') {
          if (pgCount < sqliteCount) {
            throw new Error(`Row count mismatch for doc_sequences: sqlite=${sqliteCount}, postgres=${pgCount}`);
          }
        } else if (pgCount !== sqliteCount) {
          throw new Error(`Row count mismatch for ${table}: sqlite=${sqliteCount}, postgres=${pgCount}`);
        }
        tableCounts[table] = { sqlite: sqliteCount, postgres: pgCount };
      }

      // Verify exact financial & inventory sums
      const pgSums = await tx.queryOne<{
        sales_net: string;
        purchases_net: string;
        payments_amt: string;
        expenses_amt: string;
        batches_qty: string;
      }>(`
        SELECT
          COALESCE((SELECT SUM(net_total) FROM sales), 0)::numeric(20,2)::text AS sales_net,
          COALESCE((SELECT SUM(net_total) FROM purchases), 0)::numeric(20,2)::text AS purchases_net,
          COALESCE((SELECT SUM(amount) FROM payments), 0)::numeric(20,2)::text AS payments_amt,
          COALESCE((SELECT SUM(amount) FROM expenses), 0)::numeric(20,2)::text AS expenses_amt,
          COALESCE((SELECT SUM(current_qty_base) FROM batches), 0)::numeric(24,6)::text AS batches_qty
      `);

      const financialTotals = {
        salesNetTotal: { sqlite: sumDecimal(sales, 'net_total', 2), postgres: pgSums!.sales_net },
        purchasesNetTotal: { sqlite: sumDecimal(purchases, 'net_total', 2), postgres: pgSums!.purchases_net },
        paymentsTotal: { sqlite: sumDecimal(payments, 'amount', 2), postgres: pgSums!.payments_amt },
        expensesTotal: { sqlite: sumDecimal(expenses, 'amount', 2), postgres: pgSums!.expenses_amt },
        batchStockTotalBase: { sqlite: sumDecimal(batches, 'current_qty_base', 6), postgres: pgSums!.batches_qty },
      };

      for (const [metric, pair] of Object.entries(financialTotals)) {
        if (pair.sqlite !== pair.postgres) {
          throw new Error(`Post-migration sum mismatch for ${metric}: sqlite=${pair.sqlite}, postgres=${pair.postgres}`);
        }
      }

      const ledgerCheck = await reconcileInventoryLedger(tx);
      if (!ledgerCheck.healthy) {
        throw new Error(
          `Post-migration inventory ledger reconciliation failed (${ledgerCheck.discrepancyCount} discrepancies)`
        );
      }

      const auditCheck = await verifyAuditChain(tx);
      if (!auditCheck.valid) {
        throw new Error(`Post-migration audit hash chain check failed at seq #${auditCheck.brokenAtSeq}`);
      }

      return {
        sourcePath: sqlitePath,
        targetDatabase,
        tableCounts,
        financialTotals,
        inventoryLedgerHealthy: ledgerCheck.healthy,
        auditChainValid: auditCheck.valid,
        auditEntries: auditCheck.totalEntries,
      } satisfies MigrationSummary;
    });

    return summary;
  } finally {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const sourceIdx = args.indexOf('--source');
  const sqlitePath = sourceIdx >= 0 && args[sourceIdx + 1] ? args[sourceIdx + 1] : undefined;

  try {
    const result = await migrateSqliteToPostgres({ sqlitePath, force });
    console.log('=== MediNest SQLite -> PostgreSQL Migration Verified ===');
    console.log(`Source (read-only staged): ${result.sourcePath}`);
    console.log(`Target PostgreSQL DB:      ${result.targetDatabase}`);
    console.log('Financial & Stock Sums:', JSON.stringify(result.financialTotals, null, 2));
    console.log(
      `Inventory Ledger Healthy: ${result.inventoryLedgerHealthy} | Audit Chain Valid: ${result.auditChainValid} (${result.auditEntries} entries)`
    );
    const nonZero = Object.entries(result.tableCounts)
      .filter(([, v]) => v.sqlite > 0 || v.postgres > 0)
      .map(([k, v]) => `${k}: ${v.sqlite} -> ${v.postgres}`);
    console.log('Migrated Non-Empty Tables:', nonZero.join(', '));
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((err) => {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
