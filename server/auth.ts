import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { getDb, nowIso } from './db.ts';
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

export async function checkLoginRateLimit(
  username: string,
  ipAddress: string
): Promise<{ blocked: boolean; retryAfterMinutes: number }> {
  const db = await getDb();
  const key = username.trim().toLowerCase();
  const row = await db.queryOne<{ attempt_count: number; first_attempt_at: string; locked_until: string | null }>(
    'SELECT attempt_count, first_attempt_at, locked_until FROM login_attempts WHERE username_key = $1 AND ip_address = $2',
    [key, ipAddress]
  );

  if (!row) return { blocked: false, retryAfterMinutes: 0 };

  const nowMs = Date.now();
  if (row.locked_until) {
    const lockUntilMs = Date.parse(row.locked_until);
    if (Number.isFinite(lockUntilMs) && lockUntilMs > nowMs) {
      const retryAfterMinutes = Math.max(1, Math.ceil((lockUntilMs - nowMs) / 60000));
      return { blocked: true, retryAfterMinutes };
    }
  }

  const firstMs = Date.parse(row.first_attempt_at);
  if (Number.isFinite(firstMs) && nowMs - firstMs > LOCK_DURATION_MS) {
    await db.execute('DELETE FROM login_attempts WHERE username_key = $1 AND ip_address = $2', [key, ipAddress]);
    return { blocked: false, retryAfterMinutes: 0 };
  }

  return { blocked: false, retryAfterMinutes: 0 };
}

export async function recordFailedLoginAttempt(
  username: string,
  ipAddress: string
): Promise<{ attemptCount: number; locked: boolean }> {
  const db = await getDb();
  const key = username.trim().toLowerCase();
  const nowMs = Date.now();
  const nowStr = new Date(nowMs).toISOString();

  const existing = await db.queryOne<{ attempt_count: number; first_attempt_at: string }>(
    'SELECT attempt_count, first_attempt_at FROM login_attempts WHERE username_key = $1 AND ip_address = $2',
    [key, ipAddress]
  );

  let nextCount = 1;
  let firstAttemptAt = nowStr;

  if (existing) {
    const firstMs = Date.parse(existing.first_attempt_at);
    if (Number.isFinite(firstMs) && nowMs - firstMs <= LOCK_DURATION_MS) {
      nextCount = Number(existing.attempt_count) + 1;
      firstAttemptAt = existing.first_attempt_at;
    }
  }

  const lockedUntil =
    nextCount >= MAX_LOGIN_ATTEMPTS ? new Date(nowMs + LOCK_DURATION_MS).toISOString() : null;

  await db.execute(
    `INSERT INTO login_attempts (username_key, ip_address, attempt_count, first_attempt_at, locked_until)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username_key, ip_address) DO UPDATE SET
       attempt_count = EXCLUDED.attempt_count,
       first_attempt_at = EXCLUDED.first_attempt_at,
       locked_until = EXCLUDED.locked_until`,
    [key, ipAddress, nextCount, firstAttemptAt, lockedUntil]
  );

  return { attemptCount: nextCount, locked: Boolean(lockedUntil) };
}

export async function clearLoginAttempts(username: string, ipAddress: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM login_attempts WHERE username_key = $1 AND ip_address = $2', [
    username.trim().toLowerCase(),
    ipAddress,
  ]);
}

export async function getUserEffectivePermissions(userId: string): Promise<Record<string, boolean>> {
  const db = await getDb();
  const user = await db.queryOne<{
    id: string;
    role_id: string;
    is_super_admin: boolean;
    is_active: boolean;
  }>('SELECT id, role_id, is_super_admin, is_active FROM users WHERE id = $1', [userId]);

  if (!user) return {};

  const [allPerms, rolePermsRows, overrideRows] = await Promise.all([
    db.query<{ code: string }>('SELECT code FROM permissions'),
    db.query<{ permission_code: string }>('SELECT permission_code FROM role_permissions WHERE role_id = $1', [
      user.role_id,
    ]),
    db.query<{ permission_code: string; effect: 'ALLOW' | 'DENY' }>(
      'SELECT permission_code, effect FROM user_permission_overrides WHERE user_id = $1',
      [userId]
    ),
  ]);

  const rolePerms = new Set(rolePermsRows.map((r) => r.permission_code));
  const overrides = new Map<string, 'ALLOW' | 'DENY'>(overrideRows.map((o) => [o.permission_code, o.effect]));

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

export async function loadAuthUserById(userId: string): Promise<AuthUser | null> {
  const db = await getDb();
  const row = await db.queryOne<{
    id: string;
    username: string;
    full_name: string;
    phone: string;
    email: string;
    role_id: string;
    role_name: string;
    is_super_admin: boolean;
    is_active: boolean;
    must_change_password: boolean;
    last_login_at: string | null;
  }>(
    `SELECT u.id, u.username, u.full_name, u.phone, u.email, u.role_id, r.name AS role_name,
            u.is_super_admin, u.is_active, u.must_change_password, u.last_login_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );

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
    permissions: await getUserEffectivePermissions(row.id),
  };
}

export async function createSession(
  userId: string
): Promise<{ token: string; expiresAt: string; ttlMs: number }> {
  const db = await getDb();
  const settings = await db.queryOne<{ session_timeout_minutes?: number }>(
    'SELECT session_timeout_minutes FROM pharmacy_settings WHERE id = 1'
  );
  const timeoutMinutes = Math.min(1440, Math.max(15, Number(settings?.session_timeout_minutes || 960)));
  const ttlMs = timeoutMinutes * 60 * 1000;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await db.execute('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)', [
    token,
    userId,
    expiresAt,
    nowIso(),
  ]);
  return { token, expiresAt, ttlMs };
}

export async function deleteSession(token: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function resolveSessionMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token =
      (req.cookies?.[SESSION_COOKIE_NAME] as string | undefined) ||
      (req.cookies?.['shifarx_session'] as string | undefined) ||
      '';
    if (!token) {
      next();
      return;
    }
    const db = await getDb();
    const sess = await db.queryOne<{ token: string; user_id: string; expires_at: string }>(
      'SELECT token, user_id, expires_at FROM sessions WHERE token = $1',
      [token]
    );

    if (!sess || Date.parse(sess.expires_at) < Date.now()) {
      if (sess) await db.execute('DELETE FROM sessions WHERE token = $1', [token]);
      next();
      return;
    }

    const user = await loadAuthUserById(sess.user_id);
    if (user) {
      req.authUser = user;
      req.sessionToken = token;
    }
    next();
  } catch (err) {
    next(err);
  }
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
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
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
      const perms = await getUserEffectivePermissions(req.authUser.id);
      req.authUser.permissions = perms;
      if (!perms[permissionCode]) {
        res.status(403).json({
          error: `Permission denied: requires '${permissionCode}'`,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
