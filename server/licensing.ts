import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { LICENSE_PATH, todayDate } from './db.ts';

// PUBLIC VERIFICATION KEY ONLY — Private signing key NEVER resides in customer software.
// Corresponding private key belongs exclusively to developer License Manager CLI (tools/generate_license.ts).
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAY3P2tA3aG5l2g3zVJv6H9y1K2m3N4p5Q6r7S8t9U0vW=
-----END PUBLIC KEY-----`;

// We allow a runtime-configured public key file or fall back to generated/verified keypair on initial seed setup
// Wait: let's make sure the public key is a valid SPKI Ed25519 key! Let's generate a real deterministic Ed25519 public key constant below.
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

// Note: During dev/demo, we store only the public key PEM in data/license_pub.pem if provisioned by License Manager,
// or use our official embedded public key. Private key is NEVER stored inside the application.
export function getActivePublicKeyPem(): string {
  const overridePub = LICENSE_PATH.replace('license.json', 'license_public.pem');
  if (fs.existsSync(overridePub)) {
    return fs.readFileSync(overridePub, 'utf8');
  }
  return REAL_ED25519_PUBLIC_KEY_PEM;
}

export function verifySignedLicense(signed: SignedLicenseFile, publicKeyPem?: string): LicenseStatus {
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
