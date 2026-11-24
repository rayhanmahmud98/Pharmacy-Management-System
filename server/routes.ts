import crypto from 'node:crypto';
import os from 'node:os';
import Decimal from 'decimal.js';
import express from 'express';
import {
  type DbExecutor,
  checkDbHealth,
  generateSequentialCode,
  getDb,
  nowIso,
  sanitizeHttpError,
  todayDate,
  uuid,
  withTransaction,
} from './db.ts';
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
  verifyPassword,
} from './auth.ts';
import { exportAuditLogsExcelBuffer, queryAuditLogs, recordAudit, verifyAuditChain } from './audit.ts';
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
        const sanitized = sanitizeHttpError(err);
        res.status(sanitized.status).json({ error: sanitized.message });
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
    fn: (tx: DbExecutor) => Promise<unknown> | unknown
  ) => {
    const headerKey = req.get('x-idempotency-key') || req.get('idempotency-key');
    const bodyKey =
      req.body && typeof req.body === 'object' && typeof (req.body as Record<string, unknown>).idempotencyKey === 'string'
        ? String((req.body as Record<string, unknown>).idempotencyKey)
        : '';
    const key = (headerKey || bodyKey || '').trim();

    if (!key) {
      const payload = await withTransaction((tx) => fn(tx));
      res.status(defaultStatus).json(payload);
      return;
    }

    const userId = req.authUser?.id || 'anonymous';
    const bodyClone = req.body && typeof req.body === 'object' ? { ...(req.body as Record<string, unknown>) } : {};
    delete bodyClone.idempotencyKey;
    const requestHash = crypto.createHash('sha256').update(canonicalJson(bodyClone)).digest('hex');

    const outcome = await withTransaction(async (tx) => {
      await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1))', [`idemp:${userId}:${endpoint}:${key}`]);

      const existing = await tx.queryOne<{
        request_hash: string;
        response_status: number;
        response_json: string;
      }>(
        'SELECT request_hash, response_status, response_json FROM idempotency_keys WHERE idempotency_key = $1 AND endpoint = $2 AND user_id = $3',
        [key, endpoint, userId]
      );

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

      const result = await fn(tx);
      const serialized = JSON.stringify(result);
      await tx.execute(
        `INSERT INTO idempotency_keys (idempotency_key, endpoint, user_id, request_hash, response_status, response_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [key, endpoint, userId, requestHash, defaultStatus, serialized, nowIso()]
      );

      return { status: defaultStatus, body: result };
    });

    res.status(outcome.status).json(outcome.body);
  };

  // --- HEALTH ---
  router.get('/health', async (_req, res) => {
    try {
      const health = await checkDbHealth();
      res.json(health);
    } catch {
      res.status(503).json({ ok: false, error: 'Database unavailable' });
    }
  });

  // --- AUTH & BOOTSTRAP ---
  router.get(
    '/auth/me',
    handle(async (req, res) => {
      const db = await getDb();
      const settings = await db.queryOne('SELECT * FROM pharmacy_settings WHERE id = 1');
      if (!req.authUser) {
        res.json({ authenticated: false, user: null, settings });
        return;
      }
      req.authUser.permissions = await getUserEffectivePermissions(req.authUser.id);
      res.json({ authenticated: true, user: req.authUser, settings });
    })
  );

  router.post(
    '/auth/login',
    handle(async (req, res) => {
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username?.trim() || !password) {
        res.status(400).json({ error: 'Username and password are required' });
        return;
      }
      const ipAddress = extractClientIp(req);
      const rate = await checkLoginRateLimit(username, ipAddress);
      if (rate.blocked) {
        await withTransaction(async (tx) => {
          await recordAudit(tx, {
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

      const db = await getDb();
      const row = await db.queryOne<{
        id: string;
        username: string;
        password_hash: string;
        is_active: boolean;
      }>('SELECT id, username, password_hash, is_active FROM users WHERE LOWER(username) = LOWER($1)', [
        username.trim(),
      ]);

      if (!row || !verifyPassword(password, row.password_hash)) {
        const failInfo = await recordFailedLoginAttempt(username, ipAddress);
        await withTransaction(async (tx) => {
          await recordAudit(tx, {
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
        await withTransaction(async (tx) => {
          await recordAudit(tx, {
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

      await clearLoginAttempts(username, ipAddress);
      const { token, ttlMs } = await createSession(row.id);
      const sessionHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
      const ts = nowIso();
      await withTransaction(async (tx) => {
        await tx.execute('UPDATE users SET last_login_at = $1, updated_at = $2 WHERE id = $3', [ts, ts, row.id]);
        await recordAudit(tx, {
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

      const user = await loadAuthUserById(row.id);
      const isHttps = req.secure || process.env.COOKIE_SECURE === 'true';
      res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isHttps,
        maxAge: ttlMs,
      });
      res.json({ user });
    })
  );

  router.post(
    '/auth/logout',
    handle(async (req, res) => {
      const ipAddress = extractClientIp(req);
      const sessionHash = req.sessionToken
        ? crypto.createHash('sha256').update(req.sessionToken).digest('hex').slice(0, 16)
        : '';
      if (req.sessionToken) {
        await deleteSession(req.sessionToken);
      }
      if (req.authUser) {
        await withTransaction(async (tx) => {
          await recordAudit(tx, {
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
    handle(async (req, res) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string;
        newPassword?: string;
      };
      if (!newPassword || newPassword.length < 6) {
        throw new Error('New password must be at least 6 characters');
      }
      const db = await getDb();
      const row = await db.queryOne<{ password_hash: string; must_change_password: boolean }>(
        'SELECT password_hash, must_change_password FROM users WHERE id = $1',
        [req.authUser!.id]
      );
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
      await withTransaction(async (tx) => {
        const ts = nowIso();
        await tx.execute(
          'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = $2 WHERE id = $3',
          [hashPassword(newPassword), ts, req.authUser!.id]
        );
        if (req.sessionToken) {
          await tx.execute('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [
            req.authUser!.id,
            req.sessionToken,
          ]);
        } else {
          await tx.execute('DELETE FROM sessions WHERE user_id = $1', [req.authUser!.id]);
        }
        await recordAudit(tx, {
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

      res.json({ user: await loadAuthUserById(req.authUser!.id) });
    })
  );

  router.put(
    '/auth/profile',
    requireAuth,
    handle(async (req, res) => {
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
        const db = await getDb();
        const row = await db.queryOne<{ password_hash: string }>(
          'SELECT password_hash FROM users WHERE id = $1',
          [req.authUser!.id]
        );
        if (!row) throw new Error('User not found');
        if (!currentPassword || !verifyPassword(currentPassword, row.password_hash)) {
          throw new Error('Current password is required and must match to set a new password');
        }
      }

      await withTransaction(async (tx) => {
        const ts = nowIso();
        await tx.execute('UPDATE users SET full_name = $1, phone = $2, email = $3, updated_at = $4 WHERE id = $5', [
          fullName.trim(),
          (phone || '').trim(),
          (email || '').trim(),
          ts,
          req.authUser!.id,
        ]);
        if (newPassword && newPassword.length >= 6) {
          await tx.execute('UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3', [
            hashPassword(newPassword),
            ts,
            req.authUser!.id,
          ]);
          if (req.sessionToken) {
            await tx.execute('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [
              req.authUser!.id,
              req.sessionToken,
            ]);
          } else {
            await tx.execute('DELETE FROM sessions WHERE user_id = $1', [req.authUser!.id]);
          }
        }
        await recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'UPDATE_OWN_PROFILE',
          module: 'accounts',
          targetType: 'USER',
          targetId: req.authUser!.id,
        });
      });
      res.json({ user: await loadAuthUserById(req.authUser!.id) });
    })
  );

  // --- DASHBOARD ---
  router.get(
    '/dashboard',
    requireAuth,
    handle(async (_req, res) => {
      res.json(await getDashboardStats());
    })
  );

  // --- MEDICINES & MANUAL UNITS ---
  router.get(
    '/medicines',
    requireAuth,
    requirePermission('medicines.view'),
    handle(async (req, res) => {
      const search = String(req.query.search || '');
      const includeInactive = req.query.includeInactive === '1';
      const db = await getDb();
      const [categories, manufacturers, medicines] = await Promise.all([
        db.query('SELECT * FROM categories ORDER BY name ASC'),
        db.query('SELECT * FROM manufacturers ORDER BY name ASC'),
        listMedicines(search, includeInactive),
      ]);
      res.json({
        medicines,
        categories,
        manufacturers,
      });
    })
  );

  router.post(
    '/medicines',
    requireAuth,
    requirePermission('medicines.manage'),
    handle(async (req, res) => {
      const id = await createMedicine(req.authUser!, req.body);
      res.status(201).json({ id });
    })
  );

  router.put(
    '/medicines/:id',
    requireAuth,
    requirePermission('medicines.manage'),
    handle(async (req, res) => {
      await updateMedicine(req.authUser!, String(req.params.id), req.body);
      res.json({ ok: true });
    })
  );

  router.post(
    '/medicines/:id/units',
    requireAuth,
    requirePermission('medicines.units'),
    handle(async (req, res) => {
      const unitId = await upsertMedicineUnit(req.authUser!, String(req.params.id), req.body);
      res.json({ unitId });
    })
  );

  router.post(
    '/categories',
    requireAuth,
    requirePermission('medicines.manage'),
    handle(async (req, res) => {
      const name = String(req.body.name || '').trim();
      if (!name) throw new Error('Category name is required');
      const id = uuid();
      const db = await getDb();
      await db.execute('INSERT INTO categories (id, name, description) VALUES ($1, $2, $3)', [
        id,
        name,
        String(req.body.description || ''),
      ]);
      res.status(201).json({ id, name });
    })
  );

  router.post(
    '/manufacturers',
    requireAuth,
    requirePermission('medicines.manage'),
    handle(async (req, res) => {
      const name = String(req.body.name || '').trim();
      if (!name) throw new Error('Manufacturer name is required');
      const id = uuid();
      const db = await getDb();
      await db.execute('INSERT INTO manufacturers (id, name, country, phone) VALUES ($1, $2, $3, $4)', [
        id,
        name,
        String(req.body.country || 'Bangladesh'),
        String(req.body.phone || ''),
      ]);
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
    handle(async (req, res) => {
      const { fileBase64 } = req.body as { fileBase64?: string };
      if (!fileBase64) throw new Error('Excel file payload is required');
      const buf = Buffer.from(fileBase64, 'base64');
      const preview = await parseAndValidateExcelImport(buf);
      res.json({ rows: preview });
    })
  );

  router.post(
    '/medicines/import/execute',
    requireAuth,
    requirePermission('medicines.manage'),
    handle(async (req, res) => {
      const { rows } = req.body as { rows?: Parameters<typeof executeExcelImport>[1] };
      if (!rows || !Array.isArray(rows)) throw new Error('Rows array required');
      const result = await executeExcelImport(req.authUser!, rows);
      res.json(result);
    })
  );

  // --- INVENTORY, BATCHES, ADJUSTMENTS, EXPIRY, RECONCILIATION ---
  router.get(
    '/inventory',
    requireAuth,
    requirePermission('inventory.view'),
    handle(async (req, res) => {
      const db = await getDb();
      const today = todayDate();
      const search = String(req.query.search || '').trim().toLowerCase();
      const settings = await db.queryOne<{ expiry_warning_days: number }>(
        'SELECT expiry_warning_days FROM pharmacy_settings WHERE id = 1'
      );

      const whereClause = search
        ? `WHERE (LOWER(b.batch_number) LIKE $1 OR LOWER(m.brand_name) LIKE $2 OR LOWER(m.generic_name) LIKE $3 OR LOWER(m.medicine_code) LIKE $4 OR LOWER(m.barcode) LIKE $5)`
        : '';
      const likeVal = `%${search}%`;
      const searchParams = search ? [likeVal, likeVal, likeVal, likeVal, likeVal] : [];

      const [batches, movements, adjustments, reconciliation] = await Promise.all([
        db.query(
          `SELECT b.*, m.brand_name, m.generic_name, m.strength, m.medicine_code, m.barcode, m.storage_info, s.name as supplier_name
           FROM batches b
           JOIN medicines m ON m.id = b.medicine_id
           LEFT JOIN suppliers s ON s.id = b.supplier_id
           ${whereClause}
           ORDER BY b.expiry_date ASC`,
          searchParams
        ),
        db.query(
          `SELECT sm.*, m.brand_name, b.batch_number, u.username
           FROM stock_movements sm
           JOIN medicines m ON m.id = sm.medicine_id
           JOIN batches b ON b.id = sm.batch_id
           JOIN users u ON u.id = sm.created_by
           ORDER BY sm.created_at DESC LIMIT 200`
        ),
        db.query(
          `SELECT sa.*, m.brand_name, b.batch_number, u.full_name as user_name
           FROM stock_adjustments sa
           JOIN medicines m ON m.id = sa.medicine_id
           JOIN batches b ON b.id = sa.batch_id
           JOIN users u ON u.id = sa.created_by
           ORDER BY sa.created_at DESC LIMIT 100`
        ),
        reconcileInventoryLedger(db),
      ]);
      res.json({
        today,
        expiryWarningDays: settings?.expiry_warning_days ?? 90,
        batches,
        movements,
        adjustments,
        reconciliation,
      });
    })
  );

  router.post(
    '/inventory/adjust',
    requireAuth,
    requirePermission('inventory.adjust'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/inventory/adjust', 200, (tx) => adjustStock(req.authUser!, req.body, tx));
    })
  );

  router.post(
    '/inventory/batches/:id/status',
    requireAuth,
    requirePermission('inventory.expiry'),
    handle(async (req, res) => {
      const { status, reason } = req.body as {
        status: 'ACTIVE' | 'QUARANTINED' | 'EXPIRED' | 'WRITTEN_OFF' | 'DAMAGED';
        reason: string;
      };
      await changeBatchStatus(req.authUser!, String(req.params.id), status, reason);
      res.json({ ok: true });
    })
  );

  // --- PURCHASES & PURCHASE RETURNS ---
  router.get(
    '/purchases',
    requireAuth,
    requirePermission('purchases.view'),
    handle(async (req, res) => {
      const db = await getDb();
      const search = String(req.query.search || '').trim().toLowerCase();
      const limit = Math.min(250, Math.max(1, Number(req.query.limit || 100)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const whereClause = search
        ? `WHERE (LOWER(p.purchase_number) LIKE $1 OR LOWER(p.supplier_invoice_no) LIKE $2 OR LOWER(s.name) LIKE $3)`
        : '';
      const params: unknown[] = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;

      const [purchases, returns] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT p.*, s.name as supplier_name, u.full_name as created_by_name
           FROM purchases p
           JOIN suppliers s ON s.id = p.supplier_id
           JOIN users u ON u.id = p.created_by
           ${whereClause}
           ORDER BY p.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          [...params, limit, offset]
        ),
        db.query(
          `SELECT pr.*, p.purchase_number, s.name as supplier_name
           FROM purchase_returns pr
           JOIN purchases p ON p.id = pr.purchase_id
           JOIN suppliers s ON s.id = pr.supplier_id
           ORDER BY pr.created_at DESC LIMIT 50`
        ),
      ]);

      const purchaseIds = purchases.map((p) => String(p.id));
      const lineMap = new Map<string, Array<Record<string, unknown>>>();
      if (purchaseIds.length > 0) {
        const allLines = await db.query<Record<string, unknown>>(
          `SELECT pl.*, m.brand_name, m.strength, m.base_unit_name, b.current_qty_base as batch_current_qty
           FROM purchase_lines pl
           JOIN medicines m ON m.id = pl.medicine_id
           LEFT JOIN batches b ON b.id = pl.batch_id
           WHERE pl.purchase_id = ANY($1::text[])
           ORDER BY pl.id ASC`,
          [purchaseIds]
        );
        for (const l of allLines) {
          const pid = String(l.purchase_id);
          const list = lineMap.get(pid) || [];
          list.push(l);
          lineMap.set(pid, list);
        }
      }

      res.json({
        purchases: purchases.map((p) => ({ ...p, lines: lineMap.get(String(p.id)) || [] })),
        returns,
      });
    })
  );

  router.post(
    '/purchases',
    requireAuth,
    requirePermission('purchases.create'),
    handle(async (req, res) => {
      if (req.body.status === 'RECEIVED' && !req.authUser!.permissions['purchases.receive']) {
        throw new Error('Permission denied: receiving stock requires purchases.receive');
      }
      await withIdempotency(req, res, 'POST:/purchases', 201, (tx) => createPurchase(req.authUser!, req.body, tx));
    })
  );

  router.post(
    '/purchases/:id/receive',
    requireAuth,
    requirePermission('purchases.receive'),
    handle(async (req, res) => {
      const id = String(req.params.id);
      await withIdempotency(req, res, `POST:/purchases/${id}/receive`, 200, async (tx) => {
        const { paidAmount, paymentMethod, applyAdvance } = req.body as {
          paidAmount?: string;
          paymentMethod?: 'CASH' | 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK' | 'CARD' | 'OTHER';
          applyAdvance?: boolean;
        };
        await receiveDraftPurchase(req.authUser!, id, paidAmount, paymentMethod, applyAdvance, tx);
        return { ok: true };
      });
    })
  );

  router.post(
    '/purchases/:id/cancel',
    requireAuth,
    requirePermission('purchases.create'),
    handle(async (req, res) => {
      await cancelDraftPurchase(req.authUser!, String(req.params.id), String(req.body.reason || 'Draft cancelled'));
      res.json({ ok: true });
    })
  );

  router.post(
    '/purchases/:id/reverse',
    requireAuth,
    requirePermission('purchases.reverse'),
    handle(async (req, res) => {
      await reversePurchase(req.authUser!, String(req.params.id), String(req.body.reason || ''));
      res.json({ ok: true });
    })
  );

  router.post(
    '/purchase-returns',
    requireAuth,
    requirePermission('purchases.return'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/purchase-returns', 201, (tx) =>
        createPurchaseReturn(req.authUser!, req.body, tx)
      );
    })
  );

  // --- SALES, POS & SALES RETURNS ---
  router.get(
    '/sales',
    requireAuth,
    requirePermission('sales.view'),
    handle(async (req, res) => {
      const db = await getDb();
      const search = String(req.query.search || '').trim().toLowerCase();
      const limit = Math.min(250, Math.max(1, Number(req.query.limit || 120)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const whereClause = search
        ? `WHERE (LOWER(s.invoice_number) LIKE $1 OR LOWER(COALESCE(c.name, 'Walk-in Customer')) LIKE $2 OR LOWER(COALESCE(c.phone, '')) LIKE $3)`
        : '';
      const params: unknown[] = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;

      const [sales, returns] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT s.*, COALESCE(c.name, 'Walk-in Customer') as customer_name, c.phone as customer_phone, u.full_name as cashier_name
           FROM sales s
           LEFT JOIN customers c ON c.id = s.customer_id
           JOIN users u ON u.id = s.created_by
           ${whereClause}
           ORDER BY s.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          [...params, limit, offset]
        ),
        db.query<Record<string, unknown>>(
          `SELECT sr.*, s.invoice_number, COALESCE(c.name, 'Walk-in Customer') as customer_name, u.full_name as created_by_name
           FROM sales_returns sr
           JOIN sales s ON s.id = sr.sale_id
           LEFT JOIN customers c ON c.id = sr.customer_id
           JOIN users u ON u.id = sr.created_by
           ORDER BY sr.created_at DESC LIMIT 60`
        ),
      ]);

      const saleIds = sales.map((s) => String(s.id));
      const returnIds = returns.map((r) => String(r.id));

      const [allSaleLines, allPayments, allReturnLines] = await Promise.all([
        saleIds.length > 0
          ? db.query<Record<string, unknown>>(
              `SELECT sl.*, m.brand_name, m.generic_name, m.medicine_code, m.barcode, m.strength, m.base_unit_name
               FROM sale_lines sl
               JOIN medicines m ON m.id = sl.medicine_id
               WHERE sl.sale_id = ANY($1::text[])
               ORDER BY sl.id ASC`,
              [saleIds]
            )
          : Promise.resolve([]),
        saleIds.length > 0
          ? db.query<Record<string, unknown>>(
              `SELECT pa.target_id, p.payment_number, p.method, p.amount, p.reference_no, p.status
               FROM payment_allocations pa
               JOIN payments p ON p.id = pa.payment_id
               WHERE pa.target_type = 'SALE' AND pa.target_id = ANY($1::text[])`,
              [saleIds]
            )
          : Promise.resolve([]),
        returnIds.length > 0
          ? db.query<Record<string, unknown>>(
              `SELECT srl.*, m.brand_name, b.batch_number
               FROM sales_return_lines srl
               JOIN medicines m ON m.id = srl.medicine_id
               JOIN batches b ON b.id = srl.batch_id
               WHERE srl.sales_return_id = ANY($1::text[])
               ORDER BY srl.id ASC`,
              [returnIds]
            )
          : Promise.resolve([]),
      ]);

      const saleLineIds = allSaleLines.map((l) => String(l.id));
      const [retQtyRows, allocRows] = await Promise.all([
        saleLineIds.length > 0
          ? db.query<{ sale_line_id: string; qty_base: string }>(
              'SELECT sale_line_id, qty_base FROM sales_return_lines WHERE sale_line_id = ANY($1::text[])',
              [saleLineIds]
            )
          : Promise.resolve([]),
        saleLineIds.length > 0
          ? db.query<Record<string, unknown>>(
              `SELECT sba.*, b.batch_number, b.expiry_date
               FROM sale_batch_allocations sba
               JOIN batches b ON b.id = sba.batch_id
               WHERE sba.sale_line_id = ANY($1::text[])
               ORDER BY sba.id ASC`,
              [saleLineIds]
            )
          : Promise.resolve([]),
      ]);

      const retQtyMap = new Map<string, Decimal>();
      for (const rr of retQtyRows) {
        const prev = retQtyMap.get(rr.sale_line_id) || new Decimal(0);
        retQtyMap.set(rr.sale_line_id, prev.add(qty(rr.qty_base)));
      }

      const allocMap = new Map<string, Array<Record<string, unknown>>>();
      for (const a of allocRows) {
        const lid = String(a.sale_line_id);
        const list = allocMap.get(lid) || [];
        list.push(a);
        allocMap.set(lid, list);
      }

      const saleLinesMap = new Map<string, Array<Record<string, unknown>>>();
      for (const l of allSaleLines) {
        const lid = String(l.id);
        const returnedQty = retQtyMap.get(lid) || new Decimal(0);
        const sid = String(l.sale_id);
        const list = saleLinesMap.get(sid) || [];
        list.push({
          ...l,
          returned_qty_base: returnedQty.toNumber(),
          returned_qty_base_str: returnedQty.toFixed(6),
          allocations: allocMap.get(lid) || [],
        });
        saleLinesMap.set(sid, list);
      }

      const paymentMap = new Map<string, Array<Record<string, unknown>>>();
      for (const p of allPayments) {
        const sid = String(p.target_id);
        const list = paymentMap.get(sid) || [];
        list.push(p);
        paymentMap.set(sid, list);
      }

      const retLinesMap = new Map<string, Array<Record<string, unknown>>>();
      for (const rl of allReturnLines) {
        const rid = String(rl.sales_return_id);
        const list = retLinesMap.get(rid) || [];
        list.push(rl);
        retLinesMap.set(rid, list);
      }

      res.json({
        sales: sales.map((s) => ({
          ...s,
          lines: saleLinesMap.get(String(s.id)) || [],
          payments: paymentMap.get(String(s.id)) || [],
        })),
        returns: returns.map((r) => ({
          ...r,
          lines: retLinesMap.get(String(r.id)) || [],
        })),
      });
    })
  );

  router.post(
    '/sales',
    requireAuth,
    requirePermission('pos.sell'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/sales', 201, (tx) => completeSale(req.authUser!, req.body, tx));
    })
  );

  router.post(
    '/sales/:id/reverse',
    requireAuth,
    requirePermission('sales.reverse'),
    handle(async (req, res) => {
      await reverseSale(req.authUser!, String(req.params.id), String(req.body.reason || ''));
      res.json({ ok: true });
    })
  );

  router.post(
    '/sales-returns',
    requireAuth,
    requirePermission('sales.return'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/sales-returns', 201, (tx) =>
        createSalesReturn(req.authUser!, req.body, tx)
      );
    })
  );

  // --- CUSTOMERS & SUPPLIERS ---
  router.get(
    '/parties',
    requireAuth,
    requirePermission('parties.view'),
    handle(async (_req, res) => {
      const db = await getDb();
      const [customers, suppliers, payments, advanceLedger] = await Promise.all([
        db.query('SELECT * FROM customers ORDER BY name ASC'),
        db.query('SELECT * FROM suppliers ORDER BY name ASC'),
        db.query(
          `SELECT p.*, u.full_name as user_name
           FROM payments p
           JOIN users u ON u.id = p.created_by
           ORDER BY p.created_at DESC LIMIT 100`
        ),
        db.query(
          `SELECT pal.*, u.full_name as user_name
           FROM party_advance_ledger pal
           JOIN users u ON u.id = pal.created_by
           ORDER BY pal.created_at DESC LIMIT 150`
        ),
      ]);
      res.json({ customers, suppliers, payments, advanceLedger });
    })
  );

  router.post(
    '/customers',
    requireAuth,
    requirePermission('parties.manage'),
    handle(async (req, res) => {
      const { name, phone, address, creditLimit, notes } = req.body as {
        name?: string;
        phone?: string;
        address?: string;
        creditLimit?: string;
        notes?: string;
      };
      if (!name?.trim()) throw new Error('Customer name is required');
      const validatedLimit = validateCurrencyInput(creditLimit || '0', 'Credit limit', { allowZero: true });
      const id = uuid();
      const ts = nowIso();
      const code = await withTransaction(async (tx) => {
        const nextCode = await generateSequentialCode(tx, 'CODE-CUST', 'CUST', 3, 'customers', 'code');
        await tx.execute(
          `INSERT INTO customers (id, code, name, phone, address, opening_balance, current_balance, credit_limit, notes, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, '0.00', '0.00', $6, $7, TRUE, $8, $9)`,
          [
            id,
            nextCode,
            name.trim(),
            (phone || '').trim(),
            (address || '').trim(),
            validatedLimit.toFixed(2),
            (notes || '').trim(),
            ts,
            ts,
          ]
        );
        await recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          action: 'CREATE_CUSTOMER',
          module: 'customers',
          targetType: 'CUSTOMER',
          targetId: id,
          afterState: { code: nextCode, name: name.trim() },
        });
        return nextCode;
      });
      res.status(201).json({ id, code });
    })
  );

  router.post(
    '/suppliers',
    requireAuth,
    requirePermission('parties.manage'),
    handle(async (req, res) => {
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
      const id = uuid();
      const ts = nowIso();
      const code = await withTransaction(async (tx) => {
        const nextCode = await generateSequentialCode(tx, 'CODE-SUP', 'SUP', 3, 'suppliers', 'code');
        await tx.execute(
          `INSERT INTO suppliers (id, code, name, contact_person, phone, address, return_policy_days, return_policy_notes, opening_balance, current_balance, notes, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '0.00', '0.00', $9, TRUE, $10, $11)`,
          [
            id,
            nextCode,
            name.trim(),
            (contactPerson || '').trim(),
            (phone || '').trim(),
            (address || '').trim(),
            Number(returnPolicyDays ?? 30),
            (returnPolicyNotes || '').trim(),
            (notes || '').trim(),
            ts,
            ts,
          ]
        );
        await recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          action: 'CREATE_SUPPLIER',
          module: 'suppliers',
          targetType: 'SUPPLIER',
          targetId: id,
          afterState: { code: nextCode, name: name.trim() },
        });
        return nextCode;
      });
      res.status(201).json({ id, code });
    })
  );

  router.post(
    '/customers/:id/credit-adjustment',
    requireAuth,
    requirePermission('parties.manage'),
    handle(async (req, res) => {
      const { amountDelta, reason } = req.body as { amountDelta?: string; reason?: string };
      if (!reason?.trim()) throw new Error('Mandatory reason is required for customer balance adjustment');
      const delta = validateCurrencyInput(amountDelta || '0', 'Balance adjustment', { allowNegative: true });
      if (delta.eq(0)) throw new Error('Adjustment amount cannot be zero');

      await withTransaction(async (tx) => {
        const cust = await tx.queryOne<{ id: string; name: string; current_balance: string }>(
          'SELECT id, name, current_balance FROM customers WHERE id = $1 FOR UPDATE',
          [String(req.params.id)]
        );
        if (!cust) throw new Error('Customer not found');
        const nextBal = d(cust.current_balance).add(delta).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        await tx.execute('UPDATE customers SET current_balance = $1, updated_at = $2 WHERE id = $3', [
          nextBal.toFixed(2),
          nowIso(),
          cust.id,
        ]);
        await recordAudit(tx, {
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
    requirePermission('payments.record'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/payments', 201, (tx) => recordPartyPayment(req.authUser!, req.body, tx));
    })
  );

  router.post(
    '/payments/:id/reverse',
    requireAuth,
    requirePermission('payments.reverse'),
    handle(async (req, res) => {
      await reversePayment(req.authUser!, String(req.params.id), String(req.body.reason || ''));
      res.json({ ok: true });
    })
  );

  // --- CASH SESSIONS & EXPENSES ---
  router.get(
    '/finance',
    requireAuth,
    handle(async (_req, res) => {
      const db = await getDb();
      const activeId = await getActiveCashSessionId(db);
      const [activeSummary, sessions, expenseCategories, expenses] = await Promise.all([
        activeId ? getCashSessionSummary(activeId, db) : Promise.resolve(null),
        db.query(
          `SELECT cs.*, u1.full_name as opened_by_name, u2.full_name as closed_by_name
           FROM cash_sessions cs
           JOIN users u1 ON u1.id = cs.opened_by
           LEFT JOIN users u2 ON u2.id = cs.closed_by
           ORDER BY cs.opened_at DESC LIMIT 30`
        ),
        db.query('SELECT * FROM expense_categories ORDER BY name ASC'),
        db.query(
          `SELECT e.*, ec.name as category_name, u.full_name as created_by_name
           FROM expenses e
           JOIN expense_categories ec ON ec.id = e.category_id
           JOIN users u ON u.id = e.created_by
           ORDER BY e.created_at DESC LIMIT 100`
        ),
      ]);
      res.json({ activeSummary, sessions, expenseCategories, expenses });
    })
  );

  router.post(
    '/cash-sessions/open',
    requireAuth,
    requirePermission('cash.open'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/cash-sessions/open', 201, (tx) => {
        const { openingCash, notes } = req.body as { openingCash?: string; notes?: string };
        return openCashSession(req.authUser!, openingCash || '0', notes || '', tx);
      });
    })
  );

  router.post(
    '/cash-sessions/:id/close',
    requireAuth,
    requirePermission('cash.close'),
    handle(async (req, res) => {
      const id = String(req.params.id);
      await withIdempotency(req, res, `POST:/cash-sessions/${id}/close`, 200, (tx) =>
        closeCashSession(req.authUser!, id, req.body, tx)
      );
    })
  );

  router.post(
    '/expenses',
    requireAuth,
    requirePermission('expenses.manage'),
    handle(async (req, res) => {
      await withIdempotency(req, res, 'POST:/expenses', 201, (tx) => createExpense(req.authUser!, req.body, tx));
    })
  );

  router.post(
    '/expenses/:id/reverse',
    requireAuth,
    requirePermission('expenses.reverse'),
    handle(async (req, res) => {
      await reverseExpense(req.authUser!, String(req.params.id), String(req.body.reason || ''));
      res.json({ ok: true });
    })
  );

  // --- REPORTS & EXCEL EXPORT ---
  router.get(
    '/reports',
    requireAuth,
    requirePermission('reports.view'),
    handle(async (req, res) => {
      const data = await getComprehensiveReport({
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
    handle(async (req, res) => {
      const buf = await exportReportToExcelBuffer({
        fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
        toDate: req.query.toDate ? String(req.query.toDate) : undefined,
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="medinest-report-${todayDate()}.xlsx"`);
      res.send(buf);
    })
  );

  // --- ADMIN: USERS, ROLES, OVERRIDES, SETTINGS, AUDIT, BACKUP, LAN ---
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
    handle(async (req, res) => {
      const db = await getDb();
      const [result, auditChain] = await Promise.all([
        queryAuditLogs(db, {
          search: req.query.search ? String(req.query.search) : undefined,
          action: req.query.action ? String(req.query.action) : undefined,
          module: req.query.module ? String(req.query.module) : undefined,
          userId: req.query.userId ? String(req.query.userId) : undefined,
          status: req.query.status ? String(req.query.status) : undefined,
          fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
          toDate: req.query.toDate ? String(req.query.toDate) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : 100,
          offset: req.query.offset ? Number(req.query.offset) : 0,
        }),
        verifyAuditChain(db),
      ]);
      res.json({
        ...result,
        rows: result.logs,
        auditChain,
      });
    })
  );

  router.get(
    '/admin/audit/export',
    requireAuth,
    requirePermission('admin.audit'),
    handle(async (req, res) => {
      const db = await getDb();
      const buf = await exportAuditLogsExcelBuffer(db, {
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
    handle(async (req, res) => {
      const db = await getDb();
      const canUsers = req.authUser!.permissions['admin.users'] || req.authUser!.permissions['admin.permissions'];
      const canAudit = req.authUser!.permissions['admin.audit'];
      const canBackup = req.authUser!.permissions['admin.backup'];

      const [
        roles,
        permissions,
        rolePermissions,
        users,
        overrides,
        auditLogs,
        auditChain,
        backups,
        settings,
      ] = await Promise.all([
        canUsers ? db.query('SELECT * FROM roles ORDER BY name ASC') : Promise.resolve([]),
        canUsers ? db.query('SELECT * FROM permissions ORDER BY module, code') : Promise.resolve([]),
        canUsers ? db.query('SELECT * FROM role_permissions') : Promise.resolve([]),
        canUsers
          ? db.query(
              `SELECT u.id, u.username, u.full_name, u.phone, u.email, u.role_id, r.name as role_name,
                      u.is_super_admin, u.is_active, u.must_change_password, u.last_login_at, u.created_at
               FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username ASC`
            )
          : Promise.resolve([]),
        canUsers ? db.query('SELECT * FROM user_permission_overrides') : Promise.resolve([]),
        canAudit ? db.query('SELECT * FROM audit_logs ORDER BY seq DESC LIMIT 150') : Promise.resolve([]),
        canAudit ? verifyAuditChain(db) : Promise.resolve(null),
        canBackup ? db.query('SELECT * FROM backup_records ORDER BY created_at DESC LIMIT 30') : Promise.resolve([]),
        db.queryOne('SELECT * FROM pharmacy_settings WHERE id = 1'),
      ]);

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
    requirePermission('admin.users'),
    handle(async (req, res) => {
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
      await withTransaction(async (tx) => {
        await tx.execute(
          `INSERT INTO users (id, username, full_name, phone, email, password_hash, role_id, is_super_admin, is_active, must_change_password, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, FALSE, $9, $10)`,
          [
            id,
            username.trim(),
            fullName.trim(),
            (phone || '').trim(),
            (email || '').trim(),
            hashPassword(password),
            roleId,
            Boolean(isSuperAdmin),
            ts,
            ts,
          ]
        );
        await recordAudit(tx, {
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
    requirePermission('admin.users'),
    handle(async (req, res) => {
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
      await withTransaction(async (tx) => {
        const before = await tx.queryOne<Record<string, unknown>>(
          'SELECT id, username, full_name, phone, email, role_id, is_super_admin FROM users WHERE id = $1 FOR UPDATE',
          [targetId]
        );
        if (!before) throw new Error('User not found');

        await tx.execute(
          `UPDATE users SET full_name = $1, phone = $2, email = $3, role_id = $4, is_super_admin = $5, updated_at = $6 WHERE id = $7`,
          [
            fullName.trim(),
            (phone || '').trim(),
            (email || '').trim(),
            roleId,
            Boolean(isSuperAdmin),
            nowIso(),
            targetId,
          ]
        );
        await recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: 'UPDATE_USER',
          module: 'accounts',
          targetType: 'USER',
          targetId,
          beforeState: before,
          afterState: {
            fullName: fullName.trim(),
            phone: (phone || '').trim(),
            email: (email || '').trim(),
            roleId,
            isSuperAdmin: Boolean(isSuperAdmin),
          },
        });
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/users/:id/toggle-active',
    requireAuth,
    requirePermission('admin.users'),
    handle(async (req, res) => {
      const targetId = String(req.params.id);
      if (targetId === req.authUser!.id) throw new Error('Cannot deactivate your own active account');
      await withTransaction(async (tx) => {
        const u = await tx.queryOne<{ id: string; username: string; is_active: boolean }>(
          'SELECT id, username, is_active FROM users WHERE id = $1 FOR UPDATE',
          [targetId]
        );
        if (!u) throw new Error('User not found');
        const next = !u.is_active;
        await tx.execute('UPDATE users SET is_active = $1, updated_at = $2 WHERE id = $3', [next, nowIso(), targetId]);
        if (!next) {
          await tx.execute('DELETE FROM sessions WHERE user_id = $1', [targetId]);
        }
        await recordAudit(tx, {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          ipAddress: extractClientIp(req),
          action: next ? 'REACTIVATE_USER' : 'DEACTIVATE_USER',
          module: 'accounts',
          targetType: 'USER',
          targetId,
          beforeState: { is_active: Boolean(u.is_active) },
          afterState: { is_active: next },
        });
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/users/:id/reset-password',
    requireAuth,
    requirePermission('admin.users'),
    handle(async (req, res) => {
      const { newPassword, forceChange } = req.body as { newPassword?: string; forceChange?: boolean };
      if (!newPassword || newPassword.length < 6) throw new Error('Password must be at least 6 characters');
      const targetId = String(req.params.id);
      await withTransaction(async (tx) => {
        const u = await tx.queryOne<{ id: string; username: string }>(
          'SELECT id, username FROM users WHERE id = $1 FOR UPDATE',
          [targetId]
        );
        if (!u) throw new Error('User not found');
        await tx.execute('UPDATE users SET password_hash = $1, must_change_password = $2, updated_at = $3 WHERE id = $4', [
          hashPassword(newPassword),
          forceChange !== false,
          nowIso(),
          targetId,
        ]);
        await tx.execute('DELETE FROM sessions WHERE user_id = $1', [targetId]);
        await recordAudit(tx, {
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
    requirePermission('admin.permissions'),
    handle(async (req, res) => {
      const { permissionCodes } = req.body as { permissionCodes?: string[] };
      if (!Array.isArray(permissionCodes)) throw new Error('permissionCodes array required');
      const roleId = String(req.params.id);
      await withTransaction(async (tx) => {
        await tx.execute('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
        for (const c of permissionCodes) {
          await tx.execute('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, c]);
        }
        await recordAudit(tx, {
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
    requirePermission('admin.permissions'),
    handle(async (req, res) => {
      const userId = String(req.params.id);
      const { permissionCode, effect, reason } = req.body as {
        permissionCode: string;
        effect: 'ALLOW' | 'DENY' | 'INHERIT';
        reason?: string;
      };
      await withTransaction(async (tx) => {
        if (effect === 'INHERIT') {
          await tx.execute('DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_code = $2', [
            userId,
            permissionCode,
          ]);
        } else {
          await tx.execute(
            `INSERT INTO user_permission_overrides (user_id, permission_code, effect, reason, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, permission_code) DO UPDATE SET
               effect = EXCLUDED.effect,
               reason = EXCLUDED.reason,
               updated_by = EXCLUDED.updated_by,
               updated_at = EXCLUDED.updated_at`,
            [userId, permissionCode, effect, (reason || '').trim(), req.authUser!.id, nowIso()]
          );
        }
        await recordAudit(tx, {
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
    requirePermission('admin.settings'),
    handle(async (req, res) => {
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

      await withTransaction(async (tx) => {
        const before = await tx.queryOne('SELECT * FROM pharmacy_settings WHERE id = 1 FOR UPDATE');
        await tx.execute(
          `UPDATE pharmacy_settings SET
            pharmacy_name = $1, pharmacy_name_bn = '', drug_license_no = $2, address = $3, phone = $4, email = $5,
            website = $6, currency = $7, currency_symbol = $8, timezone = $9, default_low_stock_threshold = $10,
            session_timeout_minutes = $11, logo_data_url = COALESCE($12, logo_data_url), receipt_footer = $13,
            expiry_warning_days = $14, backup_retention_count = $15, printer_type = $16, setup_completed = $17, updated_at = $18
           WHERE id = 1`,
          [
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
            s.setupCompleted !== false,
            nowIso(),
          ]
        );
        await recordAudit(tx, {
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

  return router;
}
