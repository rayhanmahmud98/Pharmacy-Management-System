import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { getDb, nowIso } from './db.ts';
import { getCurrentLicenseStatus } from './licensing.ts';
import { resolvePermission } from '../src/shared/decimalMath.ts';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  phone: string;
  email: string;
  roleId: string;
  roleName: string;
  isSuperAdmin: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  permissions: Record<string, boolean>;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      sessionToken?: string;
    }
  }
}

export const SESSION_COOKIE_NAME = 'medinest_session';
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function extractClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

export function checkLoginRateLimit(username: string, ipAddress: string): {
  blocked: boolean;
  retryAfterMinutes: number;
} {
  const db = getDb();
  const key = username.trim().toLowerCase();
  const row = db
    .prepare('SELECT attempt_count, first_attempt_at, locked_until FROM login_attempts WHERE username_key = ? AND ip_address = ?')
    .get(key, ipAddress) as
    | { attempt_count: number; first_attempt_at: string; locked_until: string | null }
    | undefined;

  if (!row) return { blocked: false, retryAfterMinutes: 0 };

  const nowMs = Date.now();
  if (row.locked_until) {
    const lockUntilMs = Date.parse(row.locked_until);
    if (Number.isFinite(lockUntilMs) && lockUntilMs > nowMs) {
      const retryAfterMinutes = Math.max(1, Math.ceil((lockUntilMs - nowMs) / 60000));
      return { blocked: true, retryAfterMinutes };
    }
  }

  // Expire stale windows older than LOCK_DURATION_MS
  const firstMs = Date.parse(row.first_attempt_at);
  if (Number.isFinite(firstMs) && nowMs - firstMs > LOCK_DURATION_MS) {
    db.prepare('DELETE FROM login_attempts WHERE username_key = ? AND ip_address = ?').run(key, ipAddress);
    return { blocked: false, retryAfterMinutes: 0 };
  }

  return { blocked: false, retryAfterMinutes: 0 };
}

export function recordFailedLoginAttempt(username: string, ipAddress: string): {
  attemptCount: number;
  locked: boolean;
} {
  const db = getDb();
  const key = username.trim().toLowerCase();
  const nowMs = Date.now();
  const nowStr = new Date(nowMs).toISOString();

  const existing = db
    .prepare('SELECT attempt_count, first_attempt_at FROM login_attempts WHERE username_key = ? AND ip_address = ?')
    .get(key, ipAddress) as { attempt_count: number; first_attempt_at: string } | undefined;

  let nextCount = 1;
  let firstAttemptAt = nowStr;

  if (existing) {
    const firstMs = Date.parse(existing.first_attempt_at);
    if (Number.isFinite(firstMs) && nowMs - firstMs <= LOCK_DURATION_MS) {
      nextCount = existing.attempt_count + 1;
      firstAttemptAt = existing.first_attempt_at;
    }
  }

  const lockedUntil =
    nextCount >= MAX_LOGIN_ATTEMPTS ? new Date(nowMs + LOCK_DURATION_MS).toISOString() : null;

  db.prepare(
    `INSERT INTO login_attempts (username_key, ip_address, attempt_count, first_attempt_at, locked_until)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username_key, ip_address) DO UPDATE SET
       attempt_count = excluded.attempt_count,
       first_attempt_at = excluded.first_attempt_at,
       locked_until = excluded.locked_until`
  ).run(key, ipAddress, nextCount, firstAttemptAt, lockedUntil);

  return { attemptCount: nextCount, locked: Boolean(lockedUntil) };
}

export function clearLoginAttempts(username: string, ipAddress: string): void {
  const db = getDb();
  db.prepare('DELETE FROM login_attempts WHERE username_key = ? AND ip_address = ?').run(
    username.trim().toLowerCase(),
    ipAddress
  );
}

export function getUserEffectivePermissions(userId: string): Record<string, boolean> {
  const db = getDb();
  const user = db
    .prepare('SELECT id, role_id, is_super_admin, is_active FROM users WHERE id = ?')
    .get(userId) as
    | { id: string; role_id: string; is_super_admin: number; is_active: number }
    | undefined;

  if (!user) return {};

  const allPerms = db.prepare('SELECT code FROM permissions').all() as Array<{ code: string }>;
  const rolePerms = new Set(
    (
      db
        .prepare('SELECT permission_code FROM role_permissions WHERE role_id = ?')
        .all(user.role_id) as Array<{ permission_code: string }>
    ).map((r) => r.permission_code)
  );
  const overrides = new Map<string, 'ALLOW' | 'DENY'>(
    (
      db
        .prepare('SELECT permission_code, effect FROM user_permission_overrides WHERE user_id = ?')
        .all(userId) as Array<{ permission_code: string; effect: 'ALLOW' | 'DENY' }>
    ).map((o) => [o.permission_code, o.effect])
  );

  const map: Record<string, boolean> = {};
  for (const p of allPerms) {
    map[p.code] = resolvePermission({
      isActive: Boolean(user.is_active),
      isSuperAdmin: Boolean(user.is_super_admin),
      userOverride: overrides.get(p.code) ?? null,
      roleAllows: rolePerms.has(p.code),
    });
  }
  return map;
}

export function loadAuthUserById(userId: string): AuthUser | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.phone, u.email, u.role_id, r.name as role_name,
              u.is_super_admin, u.is_active, u.must_change_password, u.last_login_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`
    )
    .get(userId) as
    | {
        id: string;
        username: string;
        full_name: string;
        phone: string;
        email: string;
        role_id: string;
        role_name: string;
        is_super_admin: number;
        is_active: number;
        must_change_password: number;
        last_login_at: string | null;
      }
    | undefined;

  if (!row || !row.is_active) return null;

  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    roleId: row.role_id,
    roleName: row.role_name,
    isSuperAdmin: Boolean(row.is_super_admin),
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at ?? null,
    permissions: getUserEffectivePermissions(row.id),
  };
}

export function createSession(userId: string): { token: string; expiresAt: string; ttlMs: number } {
  const db = getDb();
  const settings = db
    .prepare('SELECT session_timeout_minutes FROM pharmacy_settings WHERE id = 1')
    .get() as { session_timeout_minutes?: number } | undefined;
  const timeoutMinutes = Math.min(1440, Math.max(15, Number(settings?.session_timeout_minutes || 960)));
  const ttlMs = timeoutMinutes * 60 * 1000;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    expiresAt,
    nowIso()
  );
  return { token, expiresAt, ttlMs };
}

export function deleteSession(token: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function resolveSessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const token =
    (req.cookies?.[SESSION_COOKIE_NAME] as string | undefined) ||
    (req.cookies?.['shifarx_session'] as string | undefined) ||
    '';
  if (!token) {
    next();
    return;
  }
  const db = getDb();
  const sess = db
    .prepare('SELECT token, user_id, expires_at FROM sessions WHERE token = ?')
    .get(token) as { token: string; user_id: string; expires_at: string } | undefined;

  if (!sess || sess.expires_at < nowIso()) {
    if (sess) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    next();
    return;
  }

  const user = loadAuthUserById(sess.user_id);
  if (user) {
    req.authUser = user;
    req.sessionToken = token;
  }
  next();
}

/**
 * Protects state-changing API endpoints from cross-site form/script requests
 * while remaining compatible with localhost, LAN HTTP IP access, and iframe preview hosts.
 */
export function requireCsrfProtection(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const customHeader = req.headers['x-requested-with'];
  if (customHeader === 'MediNest' || customHeader === 'XMLHttpRequest') {
    next();
    return;
  }

  const host = (req.get('host') || '').toLowerCase();
  const origin = req.get('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      if (originHost === host) {
        next();
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid Origin header' });
      return;
    }
    res.status(403).json({ error: 'Cross-origin mutation blocked' });
    return;
  }

  const referer = req.get('referer');
  if (referer) {
    try {
      const refHost = new URL(referer).host.toLowerCase();
      if (refHost === host) {
        next();
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid Referer header' });
      return;
    }
    res.status(403).json({ error: 'Cross-site mutation blocked' });
    return;
  }

  // Non-browser local CLI/integration test calls without cookies or Origin/Referer
  if (!req.cookies?.[SESSION_COOKIE_NAME]) {
    next();
    return;
  }

  res.status(403).json({ error: 'Missing CSRF validation header or same-origin Origin' });
}

export function requireAuthenticatedSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.authUser.mustChangePassword) {
    res.status(403).json({
      error: 'Password update required before accessing pharmacy operations',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    return;
  }
  next();
}

export function requirePermission(permissionCode: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.authUser.mustChangePassword) {
      res.status(403).json({
        error: 'Password update required before accessing pharmacy operations',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
      return;
    }
    const perms = getUserEffectivePermissions(req.authUser.id);
    req.authUser.permissions = perms;
    if (!perms[permissionCode]) {
      res.status(403).json({
        error: `Permission denied: requires '${permissionCode}'`,
      });
      return;
    }
    next();
  };
}

export function requireWritableLicense(req: Request, res: Response, next: NextFunction): void {
  const status = getCurrentLicenseStatus();
  if (!status.writable) {
    res.status(403).json({
      error: `Write operations blocked: ${status.message}`,
      licenseStatus: status.status,
    });
    return;
  }
  next();
}
