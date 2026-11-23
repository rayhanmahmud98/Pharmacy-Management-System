/**
 * DEVELOPER-ONLY OFFLINE LICENSE MANAGER UTILITY
 * ----------------------------------------------
 * This script runs strictly on the developer workstation (never bundled into customer installs).
 * It generates an Ed25519 keypair and signs offline pharmacy license files.
 *
 * Usage:
 *   npx tsx tools/generate_license.ts --pharmacy "Dhaka Care Pharmacy" --type LIFETIME --device "*"
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalLicensePayload, type LicensePayload, type SignedLicenseFile } from '../server/licensing.ts';

const DEV_KEY_DIR = path.resolve(process.cwd(), 'tools/.dev_keys');
const PRIV_PATH = path.join(DEV_KEY_DIR, 'developer_ed25519_private.pem');
const PUB_PATH = path.join(DEV_KEY_DIR, 'developer_ed25519_public.pem');

export function ensureDevKeypair(): { privateKeyPem: string; publicKeyPem: string } {
  if (!fs.existsSync(DEV_KEY_DIR)) {
    fs.mkdirSync(DEV_KEY_DIR, { recursive: true });
  }
  if (fs.existsSync(PRIV_PATH) && fs.existsSync(PUB_PATH)) {
    return {
      privateKeyPem: fs.readFileSync(PRIV_PATH, 'utf8'),
      publicKeyPem: fs.readFileSync(PUB_PATH, 'utf8'),
    };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(PRIV_PATH, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUB_PATH, publicKey, 'utf8');
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export function issueSignedLicense(payload: LicensePayload, privateKeyPem: string): SignedLicenseFile {
  const msg = Buffer.from(canonicalLicensePayload(payload), 'utf8');
  const signature = crypto.sign(null, msg, privateKeyPem);
  return {
    payload,
    signatureBase64: signature.toString('base64'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { privateKeyPem, publicKeyPem } = ensureDevKeypair();
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 365 * 86400 * 1000).toISOString().slice(0, 10);
  const signed = issueSignedLicense(
    {
      licenseId: `LIC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      customerId: 'PHARM-BD-0001',
      pharmacyName: 'Dhaka Care Pharmacy',
      licenseType: 'TIME_LIMITED',
      issueDate: today,
      expiryDate: nextYear,
      deviceFingerprint: '*',
    },
    privateKeyPem
  );
  console.log('=== PUBLIC KEY (Embed in customer app) ===');
  console.log(publicKeyPem);
  console.log('=== SIGNED LICENSE JSON ===');
  console.log(JSON.stringify(signed, null, 2));
}
