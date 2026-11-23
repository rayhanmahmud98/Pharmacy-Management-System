import crypto from 'node:crypto';
import os from 'node:os';
import Decimal from 'decimal.js';
import express from 'express';
import { getDb, nowIso, todayDate, uuid, withTransaction } from './db.ts';
import {
  SESSION_COOKIE_NAME,
  checkLoginRateLimit,
  clearLoginAttempts,
  createSession,
  deleteSession,
  extractClientIp,
  getUserEffectivePermissions,
  hashPassword,
  loadAuthUserById,
  recordFailedLoginAttempt,
  requireAuth,
  requireAuthenticatedSession,
  requireCsrfProtection,
  requirePermission,
  requireWritableLicense,
  verifyPassword,
} from './auth.ts';
import { exportAuditLogsExcelBuffer, queryAuditLogs, recordAudit, verifyAuditChain } from './audit.ts';
import { getCurrentLicenseStatus, installLicenseFile, type SignedLicenseFile } from './licensing.ts';
import {
  adjustStock,
  changeBatchStatus,
  createMedicine,
  listMedicines,
  reconcileInventoryLedger,
  updateMedicine,
  upsertMedicineUnit,
} from './services/inventoryService.ts';
import {
  cancelDraftPurchase,
  createPurchase,
  createPurchaseReturn,
  receiveDraftPurchase,
  reversePurchase,
} from './services/purchaseService.ts';
import { completeSale, createSalesReturn, reverseSale } from './services/salesService.ts';
import {
  closeCashSession,
  createExpense,
  getActiveCashSessionId,
  getCashSessionSummary,
  openCashSession,
  recordPartyPayment,
  reverseExpense,
  reversePayment,
} from './services/financeService.ts';
import {
  buildMedicineImportTemplateBuffer,
  createVerifiedBackup,
  executeExcelImport,
  parseAndValidateExcelImport,
  restoreFromBackup,
} from './services/backupService.ts';
import {
  exportReportToExcelBuffer,
  getComprehensiveReport,
  getDashboardStats,
} from './services/reportService.ts';
import { d, qty, validateCurrencyInput, validateQuantityInput } from '../src/shared/decimalMath.ts';

function getLanAddresses(port: number): string[] {
  const ifaces = os.networkInterfaces();
  const urls: string[] = [`http://localhost:${port}`];
  for (const entries of Object.values(ifaces)) {
    for (const iface of entries || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:${port}`);
      }
    }
  }
  return urls;
}

export function buildApiRouter() {
  const router = express.Router();
  router.use(requireCsrfProtection);

  const handle =
    (fn: (req: express.Request, res: express.Response) => Promise<void> | void) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unexpected server error';
        res.status(400).json({ error: msg });
      }
    };

  function canonicalJson(val: unknown): string {
    if (val === null || typeof val !== 'object') {
      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      return '[' + val.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
    }
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
  }

  const withIdempotency = async (
    req: express.Request,
    res: express.Response,
    endpoint: string,
    defaultStatus: number,
    fn: () => unknown
  ) => {
    const headerKey = req.get('x-idempotency-key') || req.get('idempotency-key');
    const bodyKey =
      req.body && typeof req.body === 'object' && typeof (req.body as Record<string, unknown>).idempotencyKey === 'string'
        ? String((req.body as Record<string, unknown>).idempotencyKey)
        : '';
    const key = (headerKey || bodyKey || '').trim();

    if (!key) {
      const payload = await fn();
      res.status(defaultStatus).json(payload);
      return;
    }

    const userId = req.authUser?.id || 'anonymous';
    const bodyClone = req.body && typeof req.body === 'object' ? { ...(req.body as Record<string, unknown>) } : {};
    delete bodyClone.idempotencyKey;
    const requestHash = crypto.createHash('sha256').update(canonicalJson(bodyClone)).digest('hex');

    const outcome = withTransaction((tx) => {
      const existing = tx
        .prepare(
          'SELECT request_hash, response_status, response_json FROM idempotency_keys WHERE idempotency_key = ? AND endpoint = ? AND user_id = ?'
        )
        .get(key, endpoint, userId) as
        | { request_hash: string; response_status: number; response_json: string }
        | undefined;

      if (existing) {
        if (existing.request_hash !== requestHash) {
          return {
            status: 409,
            body: {
              error: 'Idempotency key was already used with a different request payload. Start a new submission.',
            },
          };
        }
        return {
          status: existing.response_status,
          body: JSON.parse(existing.response_json) as unknown,
        };
      }

      const result = fn();
      if (result instanceof Promise) {
        throw new Error('Idempotent handlers must be synchronous to remain atomic within SQLite transactions');
      }
      const serialized = JSON.stringify(result);
      tx.prepare(
        `INSERT INTO idempotency_keys (idempotency_key, endpoint, user_id, request_hash, response_status, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(key, endpoint, userId, requestHash, defaultStatus, serialized, nowIso());

      return { status: defaultStatus, body: result };
    });

    res.status(outcome.status).json(outcome.body);
  };

  // --- AUTH & BOOTSTRAP ---
  router.get('/auth/me', (req, res) => {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM pharmacy_settings WHERE id = 1').get();
    const license = getCurrentLicenseStatus();
    if (!req.authUser) {
      res.json({ authenticated: false, user: null, settings, license });
      return;
    }
    req.authUser.permissions = getUserEffectivePermissions(req.authUser.id);
    res.json({ authenticated: true, user: req.authUser, settings, license });
  });

  router.post(
    '/auth/login',
    handle((req, res) => {
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username?.trim() || !password) {
        res.status(400).json({ error: 'Username and password are required' });
        return;
      }
      const ipAddress = extractClientIp(req);
      const rate = checkLoginRateLimit(username, ipAddress);
      if (rate.blocked) {
        withTransaction((tx) => {
          recordAudit(tx, {
            userId: null,
            username: username.trim(),
            ipAddress,
            action: 'FAILED_LOGIN',
            module: 'accounts',
            targetType: 'USER',
            targetId: username.trim(),
            status: 'FAILURE',
            reason: `Rate-limited for ${rate.retryAfterMinutes} minute(s)`,
          });
        });
        res.status(429).json({
          error: `Too many failed login attempts. Try again in ${rate.retryAfterMinutes} minute(s).`,
        });
        return;
      }

      const db = getDb();
      const row = db
        .prepare('SELECT id, username, password_hash, is_active FROM users WHERE LOWER(username) = LOWER(?)')
        .get(username.trim()) as { id: string; username: string; password_hash: string; is_active: number } | undefined;

      if (!row || !verifyPassword(password, row.password_hash)) {
        const failInfo = recordFailedLoginAttempt(username, ipAddress);
        withTransaction((tx) => {
          recordAudit(tx, {
            userId: row?.id || null,
            username: username.trim(),
            ipAddress,
            action: 'FAILED_LOGIN',
            module: 'accounts',
            targetType: 'USER',
            targetId: row?.id || username.trim(),
            status: 'FAILURE',
            reason: failInfo.locked ? 'Invalid credentials — account temporarily rate-locked' : 'Invalid credentials',
          });
        });
        res.status(401).json({
          error: failInfo.locked
            ? 'Invalid username or password. Account login locked for 15 minutes.'
            : 'Invalid username or password',
        });
        return;
      }
      if (!row.is_active) {
        withTransaction((tx) => {
          recordAudit(tx, {
            userId: row.id,
            username: row.username,
            ipAddress,
            action: 'FAILED_LOGIN',
            module: 'accounts',
            targetType: 'USER',
            targetId: row.id,
            status: 'FAILURE',
            reason: 'Deactivated account login attempt',
          });
        });
        res.status(403).json({ error: 'User account is deactivated. Contact your Pharmacy Admin.' });
        return;
      }

      clearLoginAttempts(username, ipAddress);
      const { token, ttlMs } = createSession(row.id);
      const sessionHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
      const ts = nowIso();
      withTransaction((tx) => {
        tx.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, row.id);
        recordAudit(tx, {
          userId: row.id,
          username: row.username,
          sessionId: sessionHash,
          ipAddress,
          action: 'USER_LOGIN',
          module: 'accounts',
          targetType: 'USER',
          targetId: row.id,
          status: 'SUCCESS',
        });
      });

      const user = loadAuthUserById(row.id);
      res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: ttlMs,
      });
      res.json({ user });
    })
  );

  router.post(
    '/auth/logout',
    handle((req, res) => {
      const ipAddress = extractClientIp(req);
      const sessionHash = req.sessionToken
        ? crypto.createHash('sha256').update(req.sessionToken).digest('hex').slice(0, 16)
        : '';
      if (req.sessionToken) {
        deleteSession(req.sessionToken);
      }
      if (req.authUser) {
        withTransaction((tx) => {
          recordAudit(tx, {
            userId: req.authUser!.id,
            username: req.authUser!.username,
            sessionId: sessionHash,
            ipAddress,
            action: 'USER_LOGOUT',
            module: 'accounts',
            targetType: 'USER',
            targetId: req.authUser!.id,
            status: 'SUCCESS',
          });
        });
      }
      res.clearCookie(SESSION_COOKIE_NAME);
      res.clearCookie('shifarx_session');
      res.json({ ok: true });
    })
  );

  router.post(
    '/auth/change-password',
    requireAuthenticatedSession,
    handle((req, res) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string;
        newPassword?: string;
      };
      if (!newPassword || newPassword.length < 6) {
        throw new Error('New password must be at least 6 characters');
      }
      const db = getDb();
      const row = db
        .prepare('SELECT password_hash, must_change_password FROM users WHERE id = ?')
        .get(req.authUser!.id) as { password_hash: string; must_change_password: number } | undefined;
      if (!row) throw new Error('User not found');

      if (!row.must_change_password) {
        if (!currentPassword || !verifyPassword(currentPassword, row.password_hash)) {
          throw new Error('Current password is incorrect');
        }
      } else {
        if (currentPassword && !verifyPassword(currentPassword, row.password_hash)) {
          throw new Error('Current password is incorrect');
        }
        if (verifyPassword(newPassword, row.password_hash)) {
          throw new Error('New password must be different from your temporary or default password');
        }
      }

      const ipAddress = extractClientIp(req);
      withTransaction((tx) => {
        const ts = nowIso();
        tx.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(
          hashPassword(newPassword),
          ts,
          req.authUser!.id
        );
        if (req.sessionToken) {
          tx.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.authUser!.id, req.sessionToken);
        } else {
          tx.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.authUser!.id);
        }
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress,
          action: 'CHANGE_PASSWORD',
          module: 'accounts',
          targetType: 'USER',
          targetId: req.authUser!.id,
          status: 'SUCCESS',
        });
      });

      res.json({ user: loadAuthUserById(req.authUser!.id) });
    })
  );

  router.put(
    '/auth/profile',
    requireAuth,
    handle((req, res) => {
      const { fullName, phone, email, currentPassword, newPassword } = req.body as {
        fullName?: string;
        phone?: string;
        email?: string;
        currentPassword?: string;
        newPassword?: string;
      };
      if (!fullName?.trim()) throw new Error('Full name is required');
      if (newPassword && newPassword.length < 6) {
        throw new Error('New password must be at least 6 characters');
      }

      if (newPassword && newPassword.length >= 6) {
        const row = getDb()
          .prepare('SELECT password_hash FROM users WHERE id = ?')
          .get(req.authUser!.id) as { password_hash: string } | undefined;
        if (!row) throw new Error('User not found');
        if (!currentPassword || !verifyPassword(currentPassword, row.password_hash)) {
          throw new Error('Current password is required and must match to set a new password');
        }
      }

      withTransaction((tx) => {
        const ts = nowIso();
        tx.prepare('UPDATE users SET full_name = ?, phone = ?, email = ?, updated_at = ? WHERE id = ?').run(
          fullName.trim(),
          (phone || '').trim(),
          (email || '').trim(),
          ts,
          req.authUser!.id
        );
        if (newPassword && newPassword.length >= 6) {
          tx.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
            hashPassword(newPassword),
            ts,
            req.authUser!.id
          );
          if (req.sessionToken) {
            tx.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.authUser!.id, req.sessionToken);
          } else {
            tx.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.authUser!.id);
          }
        }
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'UPDATE_OWN_PROFILE',
          module: 'accounts',
          targetType: 'USER',
          targetId: req.authUser!.id,
        });
      });
      res.json({ user: loadAuthUserById(req.authUser!.id) });
    })
  );

  // --- DASHBOARD ---
  router.get(
    '/dashboard',
    requireAuth,
    handle((_req, res) => {
      res.json(getDashboardStats());
    })
  );

  // --- MEDICINES & MANUAL UNITS ---
  router.get(
    '/medicines',
    requireAuth,
    requirePermission('medicines.view'),
    handle((req, res) => {
      const search = String(req.query.search || '');
      const includeInactive = req.query.includeInactive === '1';
      const db = getDb();
      const categories = db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
      const manufacturers = db.prepare('SELECT * FROM manufacturers ORDER BY name ASC').all();
      res.json({
        medicines: listMedicines(search, includeInactive),
        categories,
        manufacturers,
      });
    })
  );

  router.post(
    '/medicines',
    requireAuth,
    requireWritableLicense,
    requirePermission('medicines.manage'),
    handle((req, res) => {
      const id = createMedicine(req.authUser!, req.body);
      res.status(201).json({ id });
    })
  );

  router.put(
    '/medicines/:id',
    requireAuth,
    requireWritableLicense,
    requirePermission('medicines.manage'),
    handle((req, res) => {
      updateMedicine(req.authUser!, String(req.params.id), req.body);
      res.json({ ok: true });
    })
  );

  router.post(
    '/medicines/:id/units',
    requireAuth,
    requireWritableLicense,
    requirePermission('medicines.units'),
    handle((req, res) => {
      const unitId = upsertMedicineUnit(req.authUser!, String(req.params.id), req.body);
      res.json({ unitId });
    })
  );

  router.post(
    '/categories',
    requireAuth,
    requireWritableLicense,
    requirePermission('medicines.manage'),
    handle((req, res) => {
      const name = String(req.body.name || '').trim();
      if (!name) throw new Error('Category name is required');
      const id = uuid();
      getDb().prepare('INSERT INTO categories (id, name, description) VALUES (?, ?, ?)').run(
        id,
        name,
        String(req.body.description || '')
      );
      res.status(201).json({ id, name });
    })
  );

  router.post(
    '/manufacturers',
    requireAuth,
    requireWritableLicense,
    requirePermission('medicines.manage'),
    handle((req, res) => {
      const name = String(req.body.name || '').trim();
      if (!name) throw new Error('Manufacturer name is required');
      const id = uuid();
      getDb().prepare('INSERT INTO manufacturers (id, name, country, phone) VALUES (?, ?, ?, ?)').run(
        id,
        name,
        String(req.body.country || 'Bangladesh'),
        String(req.body.phone || '')
      );
      res.status(201).json({ id, name });
    })
  );

  // --- EXCEL IMPORT ---
  router.get(
    '/medicines/import/template',
    requireAuth,
    requirePermission('medicines.manage'),
    handle((_req, res) => {
      const buf = buildMedicineImportTemplateBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="medinest_medicine_import_template.xlsx"');
      res.send(buf);
    })
  );

  router.post(
    '/medicines/import/preview',
    requireAuth,
    requirePermission('medicines.manage'),
    handle((req, res) => {
      const { fileBase64 } = req.body as { fileBase64?: string };
      if (!fileBase64) throw new Error('Excel file payload is required');
      const buf = Buffer.from(fileBase64, 'base64');
      const preview = parseAndValidateExcelImport(buf);
      res.json({ rows: preview });
    })
  );

  router.post(
    '/medicines/import/execute',
    requireAuth,
    requireWritableLicense,
    requirePermission('medicines.manage'),
    handle((req, res) => {
      const { rows } = req.body as { rows?: Parameters<typeof executeExcelImport>[1] };
      if (!rows || !Array.isArray(rows)) throw new Error('Rows array required');
      const result = executeExcelImport(req.authUser!, rows);
      res.json(result);
    })
  );

  // --- INVENTORY, BATCHES, ADJUSTMENTS, EXPIRY, RECONCILIATION ---
  router.get(
    '/inventory',
    requireAuth,
    requirePermission('inventory.view'),
    handle((req, res) => {
      const db = getDb();
      const today = todayDate();
      const search = String(req.query.search || '').trim().toLowerCase();
      const settings = db.prepare('SELECT expiry_warning_days FROM pharmacy_settings WHERE id = 1').get() as {
        expiry_warning_days: number;
      };

      const whereClause = search
        ? `WHERE (LOWER(b.batch_number) LIKE ? OR LOWER(m.brand_name) LIKE ? OR LOWER(m.generic_name) LIKE ? OR LOWER(m.medicine_code) LIKE ? OR LOWER(m.barcode) LIKE ?)`
        : '';
      const searchParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : [];

      const batches = db
        .prepare(
          `SELECT b.*, m.brand_name, m.generic_name, m.strength, m.medicine_code, m.barcode, m.storage_info, s.name as supplier_name
           FROM batches b
           JOIN medicines m ON m.id = b.medicine_id
           LEFT JOIN suppliers s ON s.id = b.supplier_id
           ${whereClause}
           ORDER BY b.expiry_date ASC`
        )
        .all(...searchParams);
      const movements = db
        .prepare(
          `SELECT sm.*, m.brand_name, b.batch_number, u.username
           FROM stock_movements sm
           JOIN medicines m ON m.id = sm.medicine_id
           JOIN batches b ON b.id = sm.batch_id
           JOIN users u ON u.id = sm.created_by
           ORDER BY sm.created_at DESC LIMIT 200`
        )
        .all();
      const adjustments = db
        .prepare(
          `SELECT sa.*, m.brand_name, b.batch_number, u.full_name as user_name
           FROM stock_adjustments sa
           JOIN medicines m ON m.id = sa.medicine_id
           JOIN batches b ON b.id = sa.batch_id
           JOIN users u ON u.id = sa.created_by
           ORDER BY sa.created_at DESC LIMIT 100`
        )
        .all();
      res.json({
        today,
        expiryWarningDays: settings?.expiry_warning_days ?? 90,
        batches,
        movements,
        adjustments,
        reconciliation: reconcileInventoryLedger(),
      });
    })
  );

  router.post(
    '/inventory/adjust',
    requireAuth,
    requireWritableLicense,
    requirePermission('inventory.adjust'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/inventory/adjust', 200, () => adjustStock(req.authUser!, req.body));
    })
  );

  router.post(
    '/inventory/batches/:id/status',
    requireAuth,
    requireWritableLicense,
    requirePermission('inventory.expiry'),
    handle((req, res) => {
      const { status, reason } = req.body as {
        status: 'ACTIVE' | 'QUARANTINED' | 'EXPIRED' | 'WRITTEN_OFF' | 'DAMAGED';
        reason: string;
      };
      changeBatchStatus(req.authUser!, String(req.params.id), status, reason);
      res.json({ ok: true });
    })
  );

  // --- PURCHASES & PURCHASE RETURNS ---
  router.get(
    '/purchases',
    requireAuth,
    requirePermission('purchases.view'),
    handle((req, res) => {
      const db = getDb();
      const search = String(req.query.search || '').trim().toLowerCase();
      const limit = Math.min(250, Math.max(1, Number(req.query.limit || 100)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const whereClause = search
        ? `WHERE (LOWER(p.purchase_number) LIKE ? OR LOWER(p.supplier_invoice_no) LIKE ? OR LOWER(s.name) LIKE ?)`
        : '';
      const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

      const purchases = db
        .prepare(
          `SELECT p.*, s.name as supplier_name, u.full_name as created_by_name
           FROM purchases p
           JOIN suppliers s ON s.id = p.supplier_id
           JOIN users u ON u.id = p.created_by
           ${whereClause}
           ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset) as Array<Record<string, unknown>>;

      const lineStmt = db.prepare(
        `SELECT pl.*, m.brand_name, m.strength, m.base_unit_name, b.current_qty_base as batch_current_qty
         FROM purchase_lines pl
         JOIN medicines m ON m.id = pl.medicine_id
         LEFT JOIN batches b ON b.id = pl.batch_id
         WHERE pl.purchase_id = ?`
      );
      const returns = db
        .prepare(
          `SELECT pr.*, p.purchase_number, s.name as supplier_name
           FROM purchase_returns pr
           JOIN purchases p ON p.id = pr.purchase_id
           JOIN suppliers s ON s.id = pr.supplier_id
           ORDER BY pr.created_at DESC LIMIT 50`
        )
        .all();

      res.json({
        purchases: purchases.map((p) => ({ ...p, lines: lineStmt.all(String(p.id)) })),
        returns,
      });
    })
  );

  router.post(
    '/purchases',
    requireAuth,
    requireWritableLicense,
    requirePermission('purchases.create'),
    handle(async (req, res) => {
      if (req.body.status === 'RECEIVED' && !req.authUser!.permissions['purchases.receive']) {
        throw new Error('Permission denied: receiving stock requires purchases.receive');
      }
      await withIdempotency(req, res, 'POST:/purchases', 201, () => createPurchase(req.authUser!, req.body));
    })
  );

  router.post(
    '/purchases/:id/receive',
    requireAuth,
    requireWritableLicense,
    requirePermission('purchases.receive'),
    handle(async (req, res) => {
      const id = String(req.params.id);
      await withIdempotency(req, res, `POST:/purchases/${id}/receive`, 200, () => {
        const { paidAmount, paymentMethod, applyAdvance } = req.body as {
          paidAmount?: string;
          paymentMethod?: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
          applyAdvance?: boolean;
        };
        receiveDraftPurchase(req.authUser!, id, paidAmount, paymentMethod, applyAdvance);
        return { ok: true };
      });
    })
  );

  router.post(
    '/purchases/:id/cancel',
    requireAuth,
    requireWritableLicense,
    requirePermission('purchases.create'),
    handle((req, res) => {
      cancelDraftPurchase(req.authUser!, String(req.params.id), String(req.body.reason || 'Draft cancelled'));
      res.json({ ok: true });
    })
  );

  router.post(
    '/purchases/:id/reverse',
    requireAuth,
    requireWritableLicense,
    requirePermission('purchases.reverse'),
    handle((req, res) => {
      reversePurchase(req.authUser!, String(req.params.id), String(req.body.reason || ''));
      res.json({ ok: true });
    })
  );

  router.post(
    '/purchase-returns',
    requireAuth,
    requireWritableLicense,
    requirePermission('purchases.return'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/purchase-returns', 201, () => createPurchaseReturn(req.authUser!, req.body));
    })
  );

  // --- SALES, POS & SALES RETURNS ---
  router.get(
    '/sales',
    requireAuth,
    requirePermission('sales.view'),
    handle((req, res) => {
      const db = getDb();
      const search = String(req.query.search || '').trim().toLowerCase();
      const limit = Math.min(250, Math.max(1, Number(req.query.limit || 120)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const whereClause = search
        ? `WHERE (LOWER(s.invoice_number) LIKE ? OR LOWER(COALESCE(c.name, 'Walk-in Customer')) LIKE ? OR LOWER(COALESCE(c.phone, '')) LIKE ?)`
        : '';
      const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

      const sales = db
        .prepare(
          `SELECT s.*, COALESCE(c.name, 'Walk-in Customer') as customer_name, c.phone as customer_phone, u.full_name as cashier_name
           FROM sales s
           LEFT JOIN customers c ON c.id = s.customer_id
           JOIN users u ON u.id = s.created_by
           ${whereClause}
           ORDER BY s.created_at DESC LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset) as Array<Record<string, unknown>>;

      const lineStmt = db.prepare(
        `SELECT sl.*, m.brand_name, m.generic_name, m.medicine_code, m.barcode, m.strength, m.base_unit_name
         FROM sale_lines sl
         JOIN medicines m ON m.id = sl.medicine_id
         WHERE sl.sale_id = ?`
      );
      const retQtyStmt = db.prepare('SELECT qty_base FROM sales_return_lines WHERE sale_line_id = ?');
      const allocStmt = db.prepare(
        `SELECT sba.*, b.batch_number, b.expiry_date
         FROM sale_batch_allocations sba
         JOIN batches b ON b.id = sba.batch_id
         WHERE sba.sale_line_id = ?`
      );
      const paymentStmt = db.prepare(
        `SELECT p.payment_number, p.method, p.amount, p.reference_no, p.status
         FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id
         WHERE pa.target_type = 'SALE' AND pa.target_id = ?`
      );

      const returns = db
        .prepare(
          `SELECT sr.*, s.invoice_number, COALESCE(c.name, 'Walk-in Customer') as customer_name, u.full_name as created_by_name
           FROM sales_returns sr
           JOIN sales s ON s.id = sr.sale_id
           LEFT JOIN customers c ON c.id = sr.customer_id
           JOIN users u ON u.id = sr.created_by
           ORDER BY sr.created_at DESC LIMIT 60`
        )
        .all() as Array<Record<string, unknown>>;

      const retLineStmt = db.prepare(
        `SELECT srl.*, m.brand_name, b.batch_number
         FROM sales_return_lines srl
         JOIN medicines m ON m.id = srl.medicine_id
         JOIN batches b ON b.id = srl.batch_id
         WHERE srl.sales_return_id = ?`
      );

      res.json({
        sales: sales.map((s) => {
          const lines = (lineStmt.all(String(s.id)) as Array<Record<string, unknown>>).map((l) => {
            const retRows = retQtyStmt.all(String(l.id)) as Array<{ qty_base: string }>;
            let returnedQty = new Decimal(0);
            for (const rr of retRows) returnedQty = returnedQty.add(qty(rr.qty_base));
            return {
              ...l,
              returned_qty_base: returnedQty.toNumber(),
              returned_qty_base_str: returnedQty.toFixed(6),
              allocations: allocStmt.all(String(l.id)),
            };
          });
          return {
            ...s,
            lines,
            payments: paymentStmt.all(String(s.id)),
          };
        }),
        returns: returns.map((r) => ({ ...r, lines: retLineStmt.all(String(r.id)) })),
      });
    })
  );

  router.post(
    '/sales',
    requireAuth,
    requireWritableLicense,
    requirePermission('pos.sell'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/sales', 201, () => completeSale(req.authUser!, req.body));
    })
  );

  router.post(
    '/sales/:id/reverse',
    requireAuth,
    requireWritableLicense,
    requirePermission('sales.reverse'),
    handle((req, res) => {
      reverseSale(req.authUser!, String(req.params.id), String(req.body.reason || ''));
      res.json({ ok: true });
    })
  );

  router.post(
    '/sales-returns',
    requireAuth,
    requireWritableLicense,
    requirePermission('sales.return'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/sales-returns', 201, () => createSalesReturn(req.authUser!, req.body));
    })
  );

  // --- CUSTOMERS & SUPPLIERS ---
  router.get(
    '/parties',
    requireAuth,
    requirePermission('parties.view'),
    handle((_req, res) => {
      const db = getDb();
      const customers = db.prepare('SELECT * FROM customers ORDER BY name ASC').all();
      const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name ASC').all();
      const payments = db
        .prepare(
          `SELECT p.*, u.full_name as user_name
           FROM payments p
           JOIN users u ON u.id = p.created_by
           ORDER BY p.created_at DESC LIMIT 100`
        )
        .all();
      const advanceLedger = db
        .prepare(
          `SELECT pal.*, u.full_name as user_name
           FROM party_advance_ledger pal
           JOIN users u ON u.id = pal.created_by
           ORDER BY pal.created_at DESC LIMIT 150`
        )
        .all();
      res.json({ customers, suppliers, payments, advanceLedger });
    })
  );

  router.post(
    '/customers',
    requireAuth,
    requireWritableLicense,
    requirePermission('parties.manage'),
    handle((req, res) => {
      const { name, phone, address, creditLimit, notes } = req.body as {
        name?: string;
        phone?: string;
        address?: string;
        creditLimit?: string;
        notes?: string;
      };
      if (!name?.trim()) throw new Error('Customer name is required');
      const validatedLimit = validateCurrencyInput(creditLimit || '0', 'Credit limit', { allowZero: true });
      const db = getDb();
      const cnt = (db.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number }).cnt + 1;
      const code = `CUST-${String(cnt).padStart(3, '0')}`;
      const id = uuid();
      const ts = nowIso();
      withTransaction((tx) => {
        tx.prepare(
          `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, credit_limit, notes, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '0.00', '0.00', ?, ?, 1, ?, ?)`
        ).run(id, code, name.trim(), (phone || '').trim(), (address || '').trim(), validatedLimit.toFixed(2), (notes || '').trim(), ts, ts);
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          action: 'CREATE_CUSTOMER',
          module: 'customers',
          targetType: 'CUSTOMER',
          targetId: id,
          afterState: { code, name: name.trim() },
        });
      });
      res.status(201).json({ id, code });
    })
  );

  router.post(
    '/suppliers',
    requireAuth,
    requireWritableLicense,
    requirePermission('parties.manage'),
    handle((req, res) => {
      const { name, contactPerson, phone, address, returnPolicyDays, returnPolicyNotes, notes } = req.body as {
        name?: string;
        contactPerson?: string;
        phone?: string;
        address?: string;
        returnPolicyDays?: number;
        returnPolicyNotes?: string;
        notes?: string;
      };
      if (!name?.trim()) throw new Error('Supplier name is required');
      const db = getDb();
      const cnt = (db.prepare('SELECT COUNT(*) as cnt FROM suppliers').get() as { cnt: number }).cnt + 1;
      const code = `SUP-${String(cnt).padStart(3, '0')}`;
      const id = uuid();
      const ts = nowIso();
      withTransaction((tx) => {
        tx.prepare(
          `INSERT INTO suppliers (id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes, opening_balance, current_balance, notes, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0.00', '0.00', ?, 1, ?, ?)`
        ).run(
          id,
          code,
          name.trim(),
          (contactPerson || '').trim(),
          (phone || '').trim(),
          (address || '').trim(),
          Number(returnPolicyDays ?? 30),
          (returnPolicyNotes || '').trim(),
          (notes || '').trim(),
          ts,
          ts
        );
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          action: 'CREATE_SUPPLIER',
          module: 'suppliers',
          targetType: 'SUPPLIER',
          targetId: id,
          afterState: { code, name: name.trim() },
        });
      });
      res.status(201).json({ id, code });
    })
  );

  router.post(
    '/customers/:id/credit-adjustment',
    requireAuth,
    requireWritableLicense,
    requirePermission('parties.manage'),
    handle((req, res) => {
      const { amountDelta, reason } = req.body as { amountDelta?: string; reason?: string };
      if (!reason?.trim()) throw new Error('Mandatory reason is required for customer balance adjustment');
      const delta = validateCurrencyInput(amountDelta || '0', 'Balance adjustment', { allowNegative: true });
      if (delta.eq(0)) throw new Error('Adjustment amount cannot be zero');

      withTransaction((tx) => {
        const cust = tx.prepare('SELECT id, name, current_balance FROM customers WHERE id = ?').get(String(req.params.id)) as
          | { id: string; name: string; current_balance: string }
          | undefined;
        if (!cust) throw new Error('Customer not found');
        const nextBal = d(cust.current_balance).add(delta).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        tx.prepare('UPDATE customers SET current_balance = ?, updated_at = ? WHERE id = ?').run(
          nextBal.toFixed(2),
          nowIso(),
          cust.id
        );
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          action: 'CUSTOMER_CREDIT_ADJUSTMENT',
          module: 'customers',
          targetType: 'CUSTOMER',
          targetId: cust.id,
          beforeState: { current_balance: cust.current_balance },
          afterState: { current_balance: nextBal.toFixed(2), delta: delta.toFixed(2) },
          reason: reason.trim(),
        });
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/payments',
    requireAuth,
    requireWritableLicense,
    requirePermission('payments.record'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/payments', 201, () => recordPartyPayment(req.authUser!, req.body));
    })
  );

  router.post(
    '/payments/:id/reverse',
    requireAuth,
    requireWritableLicense,
    requirePermission('payments.reverse'),
    handle((req, res) => {
      reversePayment(req.authUser!, String(req.params.id), String(req.body.reason || ''));
      res.json({ ok: true });
    })
  );

  // --- CASH SESSIONS & EXPENSES ---
  router.get(
    '/finance',
    requireAuth,
    handle((_req, res) => {
      const db = getDb();
      const activeId = getActiveCashSessionId();
      const activeSummary = activeId ? getCashSessionSummary(activeId) : null;
      const sessions = db
        .prepare(
          `SELECT cs.*, u1.full_name as opened_by_name, u2.full_name as closed_by_name
           FROM cash_sessions cs
           JOIN users u1 ON u1.id = cs.opened_by
           LEFT JOIN users u2 ON u2.id = cs.closed_by
           ORDER BY cs.opened_at DESC LIMIT 30`
        )
        .all();
      const expenseCategories = db.prepare('SELECT * FROM expense_categories ORDER BY name ASC').all();
      const expenses = db
        .prepare(
          `SELECT e.*, ec.name as category_name, u.full_name as created_by_name
           FROM expenses e
           JOIN expense_categories ec ON ec.id = e.category_id
           JOIN users u ON u.id = e.created_by
           ORDER BY e.created_at DESC LIMIT 100`
        )
        .all();
      res.json({ activeSummary, sessions, expenseCategories, expenses });
    })
  );

  router.post(
    '/cash-sessions/open',
    requireAuth,
    requireWritableLicense,
    requirePermission('cash.open'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/cash-sessions/open', 201, () => {
        const { openingCash, notes } = req.body as { openingCash?: string; notes?: string };
        return openCashSession(req.authUser!, openingCash || '0', notes || '');
      });
    })
  );

  router.post(
    '/cash-sessions/:id/close',
    requireAuth,
    requireWritableLicense,
    requirePermission('cash.close'),
    handle(async (req, res) => {
      const id = String(req.params.id);
      await withIdempotency(req, res, `POST:/cash-sessions/${id}/close`, 200, () =>
        closeCashSession(req.authUser!, id, req.body)
      );
    })
  );

  router.post(
    '/expenses',
    requireAuth,
    requireWritableLicense,
    requirePermission('expenses.manage'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/expenses', 201, () => createExpense(req.authUser!, req.body));
    })
  );

  router.post(
    '/expenses/:id/reverse',
    requireAuth,
    requireWritableLicense,
    requirePermission('expenses.reverse'),
    handle((req, res) => {
      reverseExpense(req.authUser!, String(req.params.id), String(req.body.reason || ''));
      res.json({ ok: true });
    })
  );

  // --- REPORTS & EXCEL EXPORT ---
  router.get(
    '/reports',
    requireAuth,
    requirePermission('reports.view'),
    handle((req, res) => {
      const data = getComprehensiveReport({
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
        categoryId: req.query.categoryId ? String(req.query.categoryId) : undefined,
        supplierId: req.query.supplierId ? String(req.query.supplierId) : undefined,
        customerId: req.query.customerId ? String(req.query.customerId) : undefined,
      });
      if (!req.authUser!.permissions['reports.profit']) {
        data.profitSummary = {
          ...data.profitSummary,
          cogs: 'RESTRICTED',
          cogsReversedOnReturns: 'RESTRICTED',
          netCogs: 'RESTRICTED',
          grossProfit: 'RESTRICTED',
          netProfit: 'RESTRICTED',
        };
      }
      res.json(data);
    })
  );

  router.get(
    '/reports/export',
    requireAuth,
    requirePermission('reports.view'),
    handle((req, res) => {
      const buf = exportReportToExcelBuffer({
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="medinest-report-${todayDate()}.xlsx"`);
      res.send(buf);
    })
  );

  // --- ADMIN: USERS, ROLES, OVERRIDES, SETTINGS, AUDIT, BACKUP, LICENSING, LAN ---
  router.get(
    '/admin/network-info',
    requireAuth,
    handle((_req, res) => {
      const port = Number(process.env.PORT || 3000);
      res.json({
        port,
        hostname: os.hostname(),
        urls: getLanAddresses(port),
      });
    })
  );

  router.get(
    '/admin/audit',
    requireAuth,
    requirePermission('admin.audit'),
    handle((req, res) => {
      const db = getDb();
      const result = queryAuditLogs(db, {
        search: req.query.search ? String(req.query.search) : undefined,
        action: req.query.action ? String(req.query.action) : undefined,
        module: req.query.module ? String(req.query.module) : undefined,
        userId: req.query.userId ? String(req.query.userId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 100,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      });
      res.json({
        ...result,
        auditChain: verifyAuditChain(db),
      });
    })
  );

  router.get(
    '/admin/audit/export',
    requireAuth,
    requirePermission('admin.audit'),
    handle((req, res) => {
      const db = getDb();
      const buf = exportAuditLogsExcelBuffer(db, {
        search: req.query.search ? String(req.query.search) : undefined,
        action: req.query.action ? String(req.query.action) : undefined,
        module: req.query.module ? String(req.query.module) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="medinest-audit-logs-${todayDate()}.xlsx"`);
      res.send(buf);
    })
  );

  router.get(
    '/admin/overview',
    requireAuth,
    handle((req, res) => {
      const db = getDb();
      const canUsers = req.authUser!.permissions['admin.users'] || req.authUser!.permissions['admin.permissions'];
      const canAudit = req.authUser!.permissions['admin.audit'];
      const canBackup = req.authUser!.permissions['admin.backup'];

      const roles = canUsers ? db.prepare('SELECT * FROM roles ORDER BY name ASC').all() : [];
      const permissions = canUsers ? db.prepare('SELECT * FROM permissions ORDER BY module, code').all() : [];
      const rolePermissions = canUsers ? db.prepare('SELECT * FROM role_permissions').all() : [];
      const users = canUsers
        ? db
            .prepare(
              `SELECT u.id, u.username, u.full_name, u.phone, u.email, u.role_id, r.name as role_name,
                      u.is_super_admin, u.is_active, u.must_change_password, u.last_login_at, u.created_at
               FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username ASC`
            )
            .all()
        : [];
      const overrides = canUsers ? db.prepare('SELECT * FROM user_permission_overrides').all() : [];
      const auditLogs = canAudit
        ? db.prepare('SELECT * FROM audit_logs ORDER BY seq DESC LIMIT 150').all()
        : [];
      const auditChain = canAudit ? verifyAuditChain(db) : null;
      const backups = canBackup
        ? db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC LIMIT 30').all()
        : [];
      const settings = db.prepare('SELECT * FROM pharmacy_settings WHERE id = 1').get();
      const license = getCurrentLicenseStatus();
      const port = Number(process.env.PORT || 3000);

      res.json({
        roles,
        permissions,
        rolePermissions,
        users,
        overrides,
        auditLogs,
        auditChain,
        backups,
        settings,
        license,
        networkInfo: {
          port,
          hostname: os.hostname(),
          urls: getLanAddresses(port),
        },
      });
    })
  );

  router.post(
    '/admin/users',
    requireAuth,
    requireWritableLicense,
    requirePermission('admin.users'),
    handle((req, res) => {
      const { username, fullName, phone, email, password, roleId, isSuperAdmin } = req.body as {
        username?: string;
        fullName?: string;
        phone?: string;
        email?: string;
        password?: string;
        roleId?: string;
        isSuperAdmin?: boolean;
      };
      if (!username?.trim() || !fullName?.trim() || !password || password.length < 6 || !roleId) {
        throw new Error('Username, full name, role, and password (>= 6 chars) are required');
      }
      const id = uuid();
      const ts = nowIso();
      withTransaction((tx) => {
        tx.prepare(
          `INSERT INTO users (id, username, full_name, phone, email, password_hash, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
        ).run(id, username.trim(), fullName.trim(), (phone || '').trim(), (email || '').trim(), hashPassword(password), roleId, isSuperAdmin ? 1 : 0, ts, ts);
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'CREATE_USER',
          module: 'accounts',
          targetType: 'USER',
          targetId: id,
          afterState: { username: username.trim(), fullName: fullName.trim(), roleId },
        });
      });
      res.status(201).json({ id });
    })
  );

  router.put(
    '/admin/users/:id',
    requireAuth,
    requireWritableLicense,
    requirePermission('admin.users'),
    handle((req, res) => {
      const targetId = String(req.params.id);
      const { fullName, phone, email, roleId, isSuperAdmin } = req.body as {
        fullName?: string;
        phone?: string;
        email?: string;
        roleId?: string;
        isSuperAdmin?: boolean;
      };
      if (!fullName?.trim() || !roleId) {
        throw new Error('Full name and role are required');
      }
      withTransaction((tx) => {
        const before = tx
          .prepare('SELECT id, username, full_name, phone, email, role_id, is_super_admin FROM users WHERE id = ?')
          .get(targetId) as Record<string, unknown> | undefined;
        if (!before) throw new Error('User not found');

        tx.prepare(
          `UPDATE users SET full_name = ?, phone = ?, email = ?, role_id = ?, is_super_admin = ?, updated_at = ? WHERE id = ?`
        ).run(
          fullName.trim(),
          (phone || '').trim(),
          (email || '').trim(),
          roleId,
          isSuperAdmin ? 1 : 0,
          nowIso(),
          targetId
        );
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'UPDATE_USER',
          module: 'accounts',
          targetType: 'USER',
          targetId,
          beforeState: before,
          afterState: { fullName: fullName.trim(), phone: (phone || '').trim(), email: (email || '').trim(), roleId, isSuperAdmin: Boolean(isSuperAdmin) },
        });
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/users/:id/toggle-active',
    requireAuth,
    requireWritableLicense,
    requirePermission('admin.users'),
    handle((req, res) => {
      const targetId = String(req.params.id);
      if (targetId === req.authUser!.id) throw new Error('Cannot deactivate your own active account');
      withTransaction((tx) => {
        const u = tx.prepare('SELECT id, username, is_active FROM users WHERE id = ?').get(targetId) as
          | { id: string; username: string; is_active: number }
          | undefined;
        if (!u) throw new Error('User not found');
        const next = u.is_active ? 0 : 1;
        tx.prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), targetId);
        if (!next) {
          tx.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
        }
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: next ? 'REACTIVATE_USER' : 'DEACTIVATE_USER',
          module: 'accounts',
          targetType: 'USER',
          targetId,
          beforeState: { is_active: Boolean(u.is_active) },
          afterState: { is_active: Boolean(next) },
        });
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/users/:id/reset-password',
    requireAuth,
    requireWritableLicense,
    requirePermission('admin.users'),
    handle((req, res) => {
      const { newPassword, forceChange } = req.body as { newPassword?: string; forceChange?: boolean };
      if (!newPassword || newPassword.length < 6) throw new Error('Password must be at least 6 characters');
      const targetId = String(req.params.id);
      withTransaction((tx) => {
        const u = tx.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId) as
          | { id: string; username: string }
          | undefined;
        if (!u) throw new Error('User not found');
        tx.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?').run(
          hashPassword(newPassword),
          forceChange === false ? 0 : 1,
          nowIso(),
          targetId
        );
        tx.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'ADMIN_RESET_PASSWORD',
          module: 'accounts',
          targetType: 'USER',
          targetId,
          afterState: { mustChangePassword: forceChange !== false },
        });
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/roles/:id/permissions',
    requireAuth,
    requireWritableLicense,
    requirePermission('admin.permissions'),
    handle((req, res) => {
      const { permissionCodes } = req.body as { permissionCodes?: string[] };
      if (!Array.isArray(permissionCodes)) throw new Error('permissionCodes array required');
      const roleId = String(req.params.id);
      withTransaction((tx) => {
        tx.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
        const ins = tx.prepare('INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)');
        for (const c of permissionCodes) ins.run(roleId, c);
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'UPDATE_ROLE_PERMISSIONS',
          module: 'permissions',
          targetType: 'ROLE',
          targetId: roleId,
          afterState: { count: permissionCodes.length },
        });
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/users/:id/override',
    requireAuth,
    requireWritableLicense,
    requirePermission('admin.permissions'),
    handle((req, res) => {
      const userId = String(req.params.id);
      const { permissionCode, effect, reason } = req.body as {
        permissionCode: string;
        effect: 'ALLOW' | 'DENY' | 'INHERIT';
        reason?: string;
      };
      withTransaction((tx) => {
        if (effect === 'INHERIT') {
          tx.prepare('DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_code = ?').run(
            userId,
            permissionCode
          );
        } else {
          tx.prepare(
            `INSERT INTO user_permission_overrides (user_id, permission_code, effect, reason, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, permission_code) DO UPDATE SET effect = excluded.effect, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
          ).run(userId, permissionCode, effect, (reason || '').trim(), req.authUser!.id, nowIso());
        }
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'SET_USER_PERMISSION_OVERRIDE',
          module: 'permissions',
          targetType: 'USER',
          targetId: userId,
          afterState: { permissionCode, effect },
          reason: reason || '',
        });
      });
      res.json({ ok: true });
    })
  );

  router.put(
    '/admin/settings',
    requireAuth,
    requireWritableLicense,
    requirePermission('admin.settings'),
    handle((req, res) => {
      const s = req.body as {
        pharmacyName: string;
        drugLicenseNo: string;
        address: string;
        phone: string;
        email: string;
        website?: string;
        currency?: string;
        currencySymbol?: string;
        timezone?: string;
        defaultLowStockThreshold?: string;
        sessionTimeoutMinutes?: number;
        logoDataUrl?: string;
        receiptFooter: string;
        expiryWarningDays: number;
        backupRetentionCount: number;
        printerType: string;
        setupCompleted?: boolean;
      };
      if (!s.pharmacyName?.trim()) throw new Error('Pharmacy name is required');
      const threshold = validateQuantityInput(String(s.defaultLowStockThreshold ?? '10'), 'Default low-stock threshold', {
        allowZero: true,
      });

      withTransaction((tx) => {
        const before = tx.prepare('SELECT * FROM pharmacy_settings WHERE id = 1').get();
        tx.prepare(
          `UPDATE pharmacy_settings SET
            pharmacy_name = ?, pharmacy_name_bn = '', drug_license_no = ?, address = ?, phone = ?, email = ?,
            website = ?, currency = ?, currency_symbol = ?, timezone = ?, default_low_stock_threshold = ?,
            session_timeout_minutes = ?, logo_data_url = COALESCE(?, logo_data_url), receipt_footer = ?,
            expiry_warning_days = ?, backup_retention_count = ?, printer_type = ?, setup_completed = ?, updated_at = ?
           WHERE id = 1`
        ).run(
          s.pharmacyName.trim(),
          (s.drugLicenseNo || '').trim(),
          (s.address || '').trim(),
          (s.phone || '').trim(),
          (s.email || '').trim(),
          (s.website || '').trim(),
          (s.currency || 'BDT').trim().toUpperCase(),
          (s.currencySymbol || '৳').trim(),
          (s.timezone || 'Asia/Dhaka').trim(),
          threshold.toFixed(6),
          Math.min(1440, Math.max(15, Number(s.sessionTimeoutMinutes || 960))),
          s.logoDataUrl !== undefined ? s.logoDataUrl : null,
          (s.receiptFooter || '').trim(),
          Math.max(7, Number(s.expiryWarningDays || 90)),
          Math.max(3, Number(s.backupRetentionCount || 14)),
          s.printerType || 'A5',
          s.setupCompleted === false ? 0 : 1,
          nowIso()
        );
        recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'UPDATE_SETTINGS',
          module: 'settings',
          targetType: 'PHARMACY_SETTINGS',
          targetId: '1',
          beforeState: before,
          afterState: {
            pharmacyName: s.pharmacyName.trim(),
            currency: s.currency || 'BDT',
            printerType: s.printerType || 'A5',
            expiryWarningDays: s.expiryWarningDays,
          },
        });
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/backups',
    requireAuth,
    requirePermission('admin.backup'),
    handle(async (req, res) => {
      const result = await createVerifiedBackup(req.authUser!, 'MANUAL');
      res.status(201).json(result);
    })
  );

  router.post(
    '/admin/backups/:id/restore',
    requireAuth,
    requirePermission('admin.backup'),
    handle(async (req, res) => {
      const result = await restoreFromBackup(req.authUser!, String(req.params.id));
      res.json(result);
    })
  );

  router.post(
    '/admin/license/install',
    requireAuth,
    requirePermission('admin.license'),
    handle((req, res) => {
      const signed = req.body as SignedLicenseFile;
      try {
        const status = installLicenseFile(signed);
        withTransaction((tx) => {
          recordAudit(tx, {
            userId: req.authUser!.id,
            username: req.authUser!.username,
            ipAddress: extractClientIp(req),
            action: 'INSTALL_LICENSE',
            module: 'licensing',
            targetType: 'LICENSE',
            targetId: status.payload?.licenseId || 'UNKNOWN',
            status: 'SUCCESS',
            afterState: { status: status.status, pharmacyName: status.payload?.pharmacyName },
          });
        });
        res.json(status);
      } catch (err) {
        const msg = (err as Error).message || 'Invalid license payload';
        withTransaction((tx) => {
          recordAudit(tx, {
            userId: req.authUser!.id,
            username: req.authUser!.username,
            ipAddress: extractClientIp(req),
            action: 'INSTALL_LICENSE',
            module: 'licensing',
            targetType: 'LICENSE',
            targetId: signed?.payload?.licenseId || 'INVALID',
            status: 'FAILURE',
            reason: msg,
          });
        });
        throw err;
      }
    })
  );

  return router;
}
