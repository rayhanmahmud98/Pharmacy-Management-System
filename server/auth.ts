import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { getDb, nowIso, uuid } from './db.ts';
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

export const SESSION_COOKIE_NAME = 'shifarx_session';

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
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
              u.is_super_admin, u.is_active
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
    permissions: getUserEffectivePermissions(row.id),
  };
}

export function createSession(userId: string): { token: string; expiresAt: string } {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 16).toISOString(); // 16 hours
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    expiresAt,
    nowIso()
  );
  return { token, expiresAt };
}

export function deleteSession(token: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function resolveSessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const token = (req.cookies?.[SESSION_COOKIE_NAME] as string | undefined) || '';
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

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required' });
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
    // Always re-evaluate dynamically from DB so permission changes apply immediately without restart
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
