import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { LICENSE_PATH, getDb, nowIso, todayDate } from './db.ts';

// PUBLIC VERIFICATION KEY ONLY — Private signing key NEVER resides in customer software.
export const REAL_ED25519_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAuV3J3nE1C/9K8zK8wE4oT7g8rF2k7b4Q1m0w9p6R4lQ=
-----END PUBLIC KEY-----`;

export interface LicensePayload {
  licenseId: string;
  customerId: string;
  pharmacyName: string;
  licenseType: 'TRIAL' | 'TIME_LIMITED' | 'LIFETIME';
  issueDate: string; // YYYY-MM-DD
  expiryDate: string | null; // YYYY-MM-DD or null for LIFETIME
  deviceFingerprint: string; // '*' or SHA-256 machine fingerprint
}

export interface SignedLicenseFile {
  payload: LicensePayload;
  signatureBase64: string;
}

export interface LicenseStatus {
  status: 'ACTIVE' | 'EXPIRED_READONLY' | 'INVALID_READONLY' | 'UNLICENSED_READONLY';
  writable: boolean;
  message: string;
  deviceFingerprint: string;
  payload: LicensePayload | null;
}

const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

export function getDeviceFingerprint(): string {
  const raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.cpus()?.[0]?.model ?? 'cpu'}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24).toUpperCase();
}

export function canonicalLicensePayload(payload: LicensePayload): string {
  return JSON.stringify({
    licenseId: payload.licenseId,
    customerId: payload.customerId,
    pharmacyName: payload.pharmacyName,
    licenseType: payload.licenseType,
    issueDate: payload.issueDate,
    expiryDate: payload.expiryDate,
    deviceFingerprint: payload.deviceFingerprint,
  });
}

export function getActivePublicKeyPem(): string {
  const overridePub = LICENSE_PATH.replace('license.json', 'license_public.pem');
  if (fs.existsSync(overridePub)) {
    return fs.readFileSync(overridePub, 'utf8');
  }
  return REAL_ED25519_PUBLIC_KEY_PEM;
}

function checkAndAdvanceVerifiedClock(nowUtcIso: string): { rollbackDetected: boolean; lastVerifiedUtc: string | null } {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT last_verified_utc FROM license_state WHERE id = 1')
      .get() as { last_verified_utc: string } | undefined;

    const nowMs = Date.parse(nowUtcIso);
    if (row) {
      const lastMs = Date.parse(row.last_verified_utc);
      if (Number.isFinite(lastMs) && nowMs + CLOCK_ROLLBACK_TOLERANCE_MS < lastMs) {
        return { rollbackDetected: true, lastVerifiedUtc: row.last_verified_utc };
      }
      if (!Number.isFinite(lastMs) || nowMs > lastMs) {
        db.prepare('UPDATE license_state SET last_verified_utc = ?, updated_at = ? WHERE id = 1').run(
          nowUtcIso,
          nowUtcIso
        );
      }
      return { rollbackDetected: false, lastVerifiedUtc: row.last_verified_utc };
    }

    db.prepare('INSERT INTO license_state (id, last_verified_utc, updated_at) VALUES (1, ?, ?)').run(
      nowUtcIso,
      nowUtcIso
    );
    return { rollbackDetected: false, lastVerifiedUtc: null };
  } catch {
    return { rollbackDetected: false, lastVerifiedUtc: null };
  }
}

export function verifySignedLicense(
  signed: SignedLicenseFile,
  publicKeyPem?: string,
  options: { checkClockRollback?: boolean } = {}
): LicenseStatus {
  const deviceFp = getDeviceFingerprint();
  try {
    if (!signed?.payload || !signed?.signatureBase64) {
      return {
        status: 'INVALID_READONLY',
        writable: false,
        message: 'Malformed license structure. Application is in Read-Only recovery mode.',
        deviceFingerprint: deviceFp,
        payload: null,
      };
    }

    const pubPem = publicKeyPem ?? getActivePublicKeyPem();
    const msg = Buffer.from(canonicalLicensePayload(signed.payload), 'utf8');
    const sig = Buffer.from(signed.signatureBase64, 'base64');
    const isValid = crypto.verify(null, msg, pubPem, sig);

    if (!isValid) {
      return {
        status: 'INVALID_READONLY',
        writable: false,
        message: 'Ed25519 signature verification failed. Read-Only mode active; historical data & exports remain accessible.',
        deviceFingerprint: deviceFp,
        payload: signed.payload,
      };
    }

    if (
      signed.payload.deviceFingerprint !== '*' &&
      signed.payload.deviceFingerprint !== deviceFp
    ) {
      return {
        status: 'INVALID_READONLY',
        writable: false,
        message: `License is bound to device ${signed.payload.deviceFingerprint}, not ${deviceFp}. Read-Only mode active.`,
        deviceFingerprint: deviceFp,
        payload: signed.payload,
      };
    }

    if (options.checkClockRollback !== false) {
      const clockCheck = checkAndAdvanceVerifiedClock(nowIso());
      if (clockCheck.rollbackDetected) {
        return {
          status: 'INVALID_READONLY',
          writable: false,
          message: `System clock rollback detected (clock earlier than last verified UTC ${clockCheck.lastVerifiedUtc}). Read-Only mode active; restore accurate system time.`,
          deviceFingerprint: deviceFp,
          payload: signed.payload,
        };
      }
    }

    if (signed.payload.licenseType !== 'LIFETIME' && signed.payload.expiryDate) {
      const today = todayDate();
      if (signed.payload.expiryDate < today) {
        return {
          status: 'EXPIRED_READONLY',
          writable: false,
          message: `License expired on ${signed.payload.expiryDate}. Read-Only mode: historical records, reports, invoice reprints, and exports remain accessible.`,
          deviceFingerprint: deviceFp,
          payload: signed.payload,
        };
      }
    }

    return {
      status: 'ACTIVE',
      writable: true,
      message:
        signed.payload.licenseType === 'LIFETIME'
          ? 'Valid Lifetime Offline License'
          : `Valid ${signed.payload.licenseType} License until ${signed.payload.expiryDate}`,
      deviceFingerprint: deviceFp,
      payload: signed.payload,
    };
  } catch (err) {
    return {
      status: 'INVALID_READONLY',
      writable: false,
      message: `License check error: ${(err as Error).message}. Read-Only mode active.`,
      deviceFingerprint: deviceFp,
      payload: null,
    };
  }
}

export function getCurrentLicenseStatus(): LicenseStatus {
  const deviceFp = getDeviceFingerprint();
  if (!fs.existsSync(LICENSE_PATH)) {
    return {
      status: 'UNLICENSED_READONLY',
      writable: false,
      message: 'No license file installed. Read-Only mode: data export, reports, and invoice reprints remain unlocked.',
      deviceFingerprint: deviceFp,
      payload: null,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8')) as SignedLicenseFile;
    return verifySignedLicense(raw);
  } catch {
    return {
      status: 'INVALID_READONLY',
      writable: false,
      message: 'Corrupted license file. Read-Only mode active.',
      deviceFingerprint: deviceFp,
      payload: null,
    };
  }
}

export function installLicenseFile(signed: SignedLicenseFile): LicenseStatus {
  const check = verifySignedLicense(signed);
  if (!check.writable && check.status === 'INVALID_READONLY') {
    throw new Error(check.message);
  }
  fs.writeFileSync(LICENSE_PATH, JSON.stringify(signed, null, 2), 'utf8');
  return check;
}
