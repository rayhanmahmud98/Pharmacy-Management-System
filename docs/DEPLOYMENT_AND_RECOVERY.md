# MediNest — Windows Production Deployment, Storage, Security & Recovery Guide

This guide covers end-to-end production deployment of **MediNest** on a Windows Host PC serving multiple counter PCs on a local area network (LAN), backed by a central **PostgreSQL 15+** database.

---

## Section A — Clean Windows Installation Guide (Step-by-Step)

1. **Confirm Host Machine Prerequisites**:
   - OS: Windows Server 2019/2022 or Windows 10/11 Pro (64-bit), connected to a UPS battery backup.
   - Install **Node.js v22 LTS** (64-bit Windows installer; `server.ts` executes natively under Node 22). Verify with `node -v`.
   - Install **PostgreSQL 15 or 16** for Windows (keep *Command Line Tools* checked so `pg_dump.exe` and `pg_restore.exe` are installed in `C:\Program Files\PostgreSQL\15\bin`).
   - Install **NSSM (Non-Sucking Service Manager)** and place `nssm.exe` in `C:\Tools\nssm\` (or on system `PATH`).
2. **Create Least-Privilege PostgreSQL Database & Role**:
   Open `psql` (as `postgres`) and run:
   ```sql
   CREATE ROLE medinest_app WITH LOGIN PASSWORD 'STRONG_UNIQUE_PASSWORD';
   CREATE DATABASE medinest OWNER medinest_app ENCODING 'UTF8';
   ```
   Verify `pg_hba.conf` uses `scram-sha-256` authentication and `postgresql.conf` keeps `listen_addresses = 'localhost'` (so PostgreSQL port `5432` stays local to the host).
3. **Prepare Persistent Data & Application Folders**:
   - Place the MediNest application in `C:\MediNest`.
   - Create persistent storage root `C:\ProgramData\MediNest` (outside `C:\MediNest` so app upgrades never touch backups or uploads).
4. **Configure `.env`**:
   Copy `.env.example` to `C:\MediNest\.env` and set:
   ```ini
   PORT=3000
   BIND_HOST=0.0.0.0
   NODE_ENV=production
   COOKIE_SECURE=false
   TRUST_PROXY=false

   PGHOST=127.0.0.1
   PGPORT=5432
   PGDATABASE=medinest
   PGUSER=medinest_app
   PGPASSWORD=STRONG_UNIQUE_PASSWORD
   PGSSL=disable
   PGPOOL_MAX=20
   PG_CONNECT_RETRIES=6

   PHARMACY_DATA_DIR=C:\ProgramData\MediNest
   # Optional if PostgreSQL bin is in a non-default location:
   # PG_BIN_DIR=C:\Program Files\PostgreSQL\15\bin
   ```
   > Only set `COOKIE_SECURE=true` and `TRUST_PROXY=true` if terminating HTTPS behind a trusted local reverse proxy (Caddy/Nginx/IIS). On direct HTTP LAN, keep both `false`.
5. **Install Dependencies & Build Production Frontend**:
   From `C:\MediNest`:
   ```powershell
   npm ci --omit=dev
   # Or if vite devDependency is needed for building:
   npm install
   npm run build
   ```
6. **Verify First Startup**:
   Run a quick foreground test:
   ```powershell
   $env:NODE_ENV="production"
   npm start
   ```
   Confirm console prints `MediNest Pharmacy Management Server running on 0.0.0.0:3000` and `http://<LAN-IP>:3000`, and `http://127.0.0.1:3000/api/health` returns `{"ok":true,...}`. Press `Ctrl+C`.
7. **Configure Static LAN IP / DHCP Reservation**:
   Assign a static IPv4 address (e.g., `192.168.1.25`) to the host server via Windows Network Adapter settings or router DHCP reservation (see LAN guide below).
8. **Register Windows Service & Configure Firewall**:
   Run as Administrator:
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\MediNest\tools\windows-install-service.ps1
   ```
   This registers `MediNestServer` via NSSM with `NODE_ENV=production`, `DependOnService postgresql-x64-*`, auto-restart (`5000 ms`), 10 MB log rotation, and a Private-profile Windows Defender Firewall rule allowing TCP port `3000`.
9. **First-Time Pharmacy Onboarding**:
   Open `http://192.168.1.25:3000` in a browser, log in with default seeded `admin` credentials (`Admin@123`), immediately set a strong new admin password (forced via `must_change_password`), and save Pharmacy Profile & printer settings (`A5` default).
10. **Connect Counter Terminals (`COUNTER-1`, `COUNTER-2`, `COUNTER-3`)**:
    Bookmark `http://192.168.1.25:3000` on each counter PC browser, select the terminal's Counter ID in POS/Finance (`COUNTER-1`, `COUNTER-2`, etc.), and open independent counter cash drawers before billing.

---

## Section B — Windows Service Management

Once installed with `tools\windows-install-service.ps1`, manage `MediNestServer` from an elevated PowerShell or Command Prompt:

- **Check service status**:
  ```powershell
  Get-Service MediNestServer, postgresql*
  nssm status MediNestServer
  ```
- **Start / Stop / Restart**:
  ```powershell
  nssm start MediNestServer
  nssm stop MediNestServer
  nssm restart MediNestServer
  ```
- **Inspect Logs**:
  - Standard output: `C:\ProgramData\MediNest\logs\medinest-stdout.log`
  - Errors / crash stack traces: `C:\ProgramData\MediNest\logs\medinest-stderr.log`
  - Live tail in PowerShell:
    ```powershell
    Get-Content C:\ProgramData\MediNest\logs\medinest-stderr.log -Tail 50 -Wait
    ```
- **Log Rotation**:
  Configured in NSSM (`AppRotateFiles=1`, `AppRotateOnline=1`, `AppRotateBytes=10485760` = 10 MB per file).

---

## Section C — Multi-PC LAN & Firewall Hardening

1. **Static IP & DNS Stability**:
   - Assign a fixed IPv4 (e.g., `192.168.1.25`) on the host Ethernet adapter or bind a DHCP reservation to the host's MAC address in the pharmacy router. Avoid relying on Wi-Fi or DHCP-changing leases on the server PC.
   - Counter PCs connect via `http://192.168.1.25:3000` (or internal hostname if local DNS resolves cleanly).
   - `getLanUrls()` automatically ignores `169.254.x.x` link-local APIPA addresses and prioritizes RFC1918 LAN IPv4 addresses.
2. **Windows Defender Firewall Rules**:
   - **Allow**: Inbound TCP port `3000` scoped to `-Profile Private` (LAN subnet only).
   - **Do NOT expose**: PostgreSQL TCP port `5432` to Public or external LAN networks unless remote DB tools are strictly required over a segmented admin VLAN.
   - Verify active rules:
     ```powershell
     Get-NetFirewallRule -DisplayName "MediNest*" | Format-Table DisplayName, Profile, Enabled, Action
     ```
3. **Browser & Session Behavior Across LAN**:
   - `express-rate-limit` / login attempt throttling uses real socket IP (`TRUST_PROXY=false`) so clients cannot spoof `X-Forwarded-For`.
   - `localStorage` stores only non-sensitive UI counter preference (`medinest_counter_code`); auth cookies are HttpOnly `SameSite=Lax`.
   - Note for HTTPS upgrades later: if a local Caddy/Nginx TLS reverse proxy is placed in front of Node on port `443`, set `COOKIE_SECURE=true` and `TRUST_PROXY=true` in `.env` and restart `MediNestServer`.

---

## Section D — Storage, Disk Management & Backups

### Persistent Directory Layout (`PHARMACY_DATA_DIR = C:\ProgramData\MediNest`)
| Folder | Purpose | Typical Size / Growth |
| --- | --- | --- |
| `backups\` | Verified `pg_dump` custom archives (`.dump`) | Compact compressed dumps; auto-pruned by `backup_retention_count` (default 14, min 3) |
| `logs\` | NSSM service stdout & stderr logs | Auto-rotated at 10 MB (`AppRotateBytes=10485760`) |
| `uploads\` | Staging directory for Excel imports | Transient / small |
| PostgreSQL `data\` | Central database tables, WAL, indexes | Main DB footprint (plan ≥ 20 GB free SSD space) |

### Automated Session & Idempotency Cleanup
- `cleanupExpiredOperationalState()` runs at server startup and every 6 hours, pruning expired `sessions` (`expires_at < NOW()`) and `idempotency_keys` older than 30 days so PostgreSQL storage stays bounded cleanly over years of operation.
- All financial ledger tables (`sales`, `purchases`, `payments`, `stock_movements`, `audit_logs`) are retained permanently for regulatory and accounting integrity.

### On-Site & Off-Site Backup Strategy
1. **Verified On-Site Backups**:
   - Created from **Admin -> Verified PostgreSQL Backups -> Create Verified Backup Now**.
   - Runs `pg_dump --format=custom --no-owner --no-privileges --schema=public`, validates TOC with `pg_restore --list`, and stores streaming SHA-256 checksums in `backup_records`.
2. **Automated Daily Off-Site Sync (USB / NAS / Network Share)**:
   - Schedule `tools\windows-backup-offsite.ps1` once daily in Windows Task Scheduler (e.g., 23:30 after pharmacy close):
     ```powershell
     powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\MediNest\tools\windows-backup-offsite.ps1" -SourceDir "C:\ProgramData\MediNest\backups" -DestinationDir "E:\MediNestOffsiteBackups" -RetainCount 30
     ```
   - Copies `.dump` files atomically via `.tmp`, verifies SHA-256 parity on destination, writes `.sha256` sidecars, and retains the newest 30 archives off-site.
3. **Low-Disk Space Prevention**:
   - Maintain at least **20% or ≥ 10 GB free SSD space** on both `C:\` and your off-site drive.
   - If disk becomes full during `pg_dump`, temporary dump files are cleaned up automatically, a `FAILED` record + audit event is recorded, and the live database stays unaffected.

---

## Section E — Failure Recovery, Restore & Simple Monitoring

### 1. Health Endpoint & Simple Monitoring
- Probe `http://127.0.0.1:3000/api/health` (unauthenticated, safe summary — exposes only `ok`, timestamp, DB connectivity boolean, and `dbLatencyMs`; returns HTTP `503` if PostgreSQL is unreachable or restoring):
  ```powershell
  Invoke-RestMethod http://127.0.0.1:3000/api/health
  ```
- Optional 5-minute Windows Task Scheduler check: alert or log if `/api/health` does not return HTTP `200`.

### 2. Failure & Recovery Scenarios
| Failure Scenario | Expected Behavior & Automatic Recovery | Operator Verification Step |
| --- | --- | --- |
| **Node.js backend crashes / `SIGKILL`** | NSSM restarts `MediNestServer` within `5s`; uncommitted PostgreSQL transactions roll back automatically; existing logged-in cookies remain valid (`sessions` stored in PG). | Check `Get-Service MediNestServer` and `medinest-stderr.log`; refresh POS browser. |
| **PostgreSQL service stops or restarts** | Active DB calls fail closed with HTTP `503` JSON (`Database temporarily unavailable...`); `pg.Pool` reconnects automatically once PostgreSQL restarts—no Node restart needed. | Check `Get-Service postgresql*`; run `/api/health` until `200 OK`. |
| **LAN cable / Wi-Fi drop during invoice submit** | Frontend locks submit button and preserves the exact `Idempotency-Key` until completion or form edit; retrying sends the same key and receives the original invoice (`201`/`200`) without double billing. | Click Save/Complete again once network returns; confirm only one invoice number exists. |
| **Windows Server host reboot (power outage)** | PostgreSQL starts first, followed by `MediNestServer` (`DependOnService`). Boot takes effect cleanly without manual terminal commands. | Check `/api/health` and inspect open cash sessions on Counter browsers. |
| **Browser closed or refreshed mid-shift** | Cash session remains `OPEN` on server for that `COUNTER-X`; user session cookie remains valid; simply log back in or refresh. | Verify `Counter ID` selector matches terminal and open drawer totals match. |
| **Corrupted data / operator disaster** | Restore via **Admin -> Verified PostgreSQL Backups -> Restore**. System verifies SHA-256 + `pg_restore --list`, captures a `PRE_RESTORE` dump, blocks concurrent requests (`503` maintenance lock), restores atomically (`--single-transaction`), verifies audit hash chain & inventory ledger, or auto-rolls back to `PRE_RESTORE` on failure. | Log back in and verify Audit Chain = `VALID` and Ledger Reconciliation = `HEALTHY`. |

### 3. Manual Disaster Restore (If MediNest Web UI Cannot Boot)
If the server disk failed and you are restoring onto a clean Windows host:
1. Reinstall PostgreSQL 15+, create empty database `medinest` owned by `medinest_app`.
2. Verify off-site archive checksum:
   ```powershell
   Get-FileHash E:\MediNestOffsiteBackups\medinest-pg-backup-*.dump -Algorithm SHA256
   ```
   Compare against `.sha256` sidecar.
3. Verify archive TOC and restore:
   ```powershell
   pg_restore --list E:\MediNestOffsiteBackups\<file>.dump
   pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction -h 127.0.0.1 -U medinest_app -d medinest E:\MediNestOffsiteBackups\<file>.dump
   ```
4. Start `MediNestServer` and confirm `/api/health`, **Audit Chain**, and **Inventory Reconciliation** pass cleanly.
