# MediNest — Pharmacy Management System: Deployment, LAN & Recovery Guide

## 1. Runtime Requirements
- **Node.js**: v22.5.0+ (uses built-in `node:sqlite` WAL mode — zero external C++ compiler required)
- **Operating System**: Windows 10/11 (local store server), macOS, or Linux
- **Printer Support**: Official **A5 (`148 × 210 mm` portrait)** default invoice printing, plus optional `80mm Thermal` and `A4` formats.

## 2. Production Installation & Startup
```bash
npm install
npm run build
NODE_ENV=production PORT=3000 BIND_HOST=0.0.0.0 npm start
```
On Windows PowerShell:
```powershell
npm install
npm run build
$env:NODE_ENV="production"
$env:PORT="3000"
$env:BIND_HOST="0.0.0.0"
npm start
```
On startup, MediNest logs all active LAN IPv4 addresses (for example `http://192.168.1.25:3000`). These URLs are also visible inside **Admin -> Offline License & LAN**.

## 3. Multi-Device Local Network (LAN) Setup
1. Assign a static local IP to the host shop PC (e.g., `192.168.1.25`) in Windows Network Settings or your router DHCP reservation.
2. Allow inbound TCP port `3000` in **Windows Defender Firewall** (`New-NetFirewallRule -DisplayName "MediNest Pharmacy Server" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow`).
3. Open `http://<host-ip>:3000` from counter PCs or tablets on the same local Wi-Fi/LAN.
4. All client mutations carry `X-Requested-With` CSRF protection and `Idempotency-Key` headers so network retries never create duplicate invoices, payments, or stock deductions.

## 4. Numeric Precision & Ledger Invariants
- **Currency**: Exact `Decimal.js` arithmetic, up to 18 integer digits and **2 decimal places** (`ROUND_HALF_UP`).
- **Quantities, Unit Conversions & Per-Base Costs**: Up to 18 integer digits and **6 decimal places**.
- **Document Numbering**: Atomic counter rows inside `doc_sequences` updated exclusively within `BEGIN IMMEDIATE` SQLite transactions.
- **No Float Drift**: Non-numeric strings, `NaN`, `Infinity`, scientific notation (`1e5`), and excess decimal places are rejected strictly without silent rounding.

## 5. SQLite WAL Backups & Disaster Recovery
- Data files are stored under `PHARMACY_DATA_DIR` (defaults to `./data/`):
  - `pharmacy.db`, `pharmacy.db-wal`, `pharmacy.db-shm`
  - `backups/medinest-backup-*.sqlite`
  - `license.json`, `license_public.pem`
- **Creating Backups**: Use **Admin -> Verified SQLite Backups -> Create Verified Backup Now**. MediNest uses native SQLite online backup (`VACUUM INTO` / backup API) and verifies the output file with `PRAGMA integrity_check` plus SHA-256 checksum recording.
- **Restoring Backups**: Restoring from Admin automatically captures a pre-restore safety snapshot before swapping the database file and re-running `PRAGMA integrity_check`.
- **Clean Shutdown**: `SIGINT` and `SIGTERM` run `PRAGMA wal_checkpoint(TRUNCATE)` before closing SQLite cleanly.

## 6. Offline Ed25519 Licensing & Audit Verification
- Licenses are verified completely offline using the bundled Ed25519 public key (`license_public.pem`).
- UTC timestamps are persisted monotonically in `license_state.last_verified_utc` (5-minute tolerance) to detect system clock rollbacks.
- If expired or invalid, the app enters **Read-Only Recovery Mode**: billing and mutations pause while Excel exports, reports, invoice reprints, and verified backups remain accessible.
- Every sensitive action appends to `audit_logs` linked by a local SHA-256 hash chain verifiable in **Admin -> Audit Log & Hash Chain**.
