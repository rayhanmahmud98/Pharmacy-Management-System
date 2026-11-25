# Security Summary

**Reviewed Files**: 22
**Issues Resolved**: 7

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Vulnerable Spreadsheet Dependency (`xlsx@0.18.5`) | `package.json`, `server/services/excelService.ts`, `server/services/backupService.ts`, `server/services/reportService.ts`, `server/audit.ts` | `package.json`, `server/services/excelService.ts:51` | Direct dependency `xlsx@0.18.5` had 2 unpatched high-severity upstream advisories (Prototype Pollution and ReDoS) with no fixed npm release. | High | Fixed | Removed `xlsx` completely (`package.json`, `bun.lock`, `node_modules`), migrated all `.xlsx` template, import, report export, and audit export flows to `exceljs@4.4.0`, and enforced pre-parse ZIP magic-byte, macro/ActiveX blocking, path-traversal checks, bounded DEFLATE ZIP-bomb checks, row/col limits, formula-prefix neutralization, and `Object.create(null)` prototype-safe row mapping. |
| Spoofable Client IP & Rate-Limit Bypass | `server.ts` / `server/auth.ts` | `server.ts:32`, `server/auth.ts:43` | Proxy forwarding headers (`X-Forwarded-For`) could be spoofed by any LAN or HTTP client if `trust proxy` was permissive, bypassing per-IP login lockout and forging audit IP records. | High | Fixed | Configured Express `trust proxy` to `false` by default (`process.env.TRUST_PROXY === 'true' ? 1 : false`) and switched `extractClientIp` to read `req.ip` / `req.socket.remoteAddress` directly. |
| Single-Drawer Cash Session Lock & Ambiguity | `server/db.ts` / `server/services/financeService.ts` | `server/db.ts:1006`, `server/services/financeService.ts:62` | A pharmacy-wide partial unique index (`uq_cash_sessions_single_open`) prevented concurrent multi-counter operation, while missing counter specificity risked attaching sales/expenses to another counter's drawer. | High | Fixed | Replaced `uq_cash_sessions_single_open` with `uq_cash_sessions_open_per_counter` on `(counter_code) WHERE status = 'OPEN'` and enforced explicit/single-drawer ambiguity checks on cash operations. |
| Shared-Payment Reversal Integrity | `server/services/salesService.ts` / `server/services/purchaseService.ts` | `server/services/salesService.ts:1030`, `server/services/purchaseService.ts:1013` | Reversing a sale or purchase linked to a multi-invoice customer/supplier payment or unconsumed advance credit could orphan allocations and corrupt AR/AP ledger balances. | High | Fixed | Blocked sale/purchase reversal whenever an active shared/multi-allocation payment is linked, requiring explicit payment reversal first; also guarded advance-credit consumption before payment reversal (`server/services/financeService.ts:667-686`). |
| Unaudited Catalog Mutations | `server/routes.ts` | `server/routes.ts:565`, `server/routes.ts:595` | Creating medicine categories or manufacturers did not emit entries to the tamper-evident hash-chained `audit_logs` table. | Medium | Fixed | Added `recordAudit` calls (`CREATE_CATEGORY` and `CREATE_MANUFACTURER`) inside `withTransaction` in `/api/categories` and `/api/manufacturers`. |
| Duplicate Reversal Replay Gap | `server/routes.ts` / `src/pages/FinancePage.tsx` | `server/routes.ts:1635`, `server/routes.ts:1744` | Reversal endpoints and UI action buttons lacked persistent idempotency key tracking and synchronous submit locking, risking duplicate double-click submissions. | Medium | Fixed | Enforced `Idempotency-Key` middleware across mutation/reversal endpoints paired with synchronous `submitLockRef` guards and persistent `useRef` keys across POS, Purchases, Sales & Returns, Parties, and Finance UI forms. |
| Transitive `uuid@8.3.2` Advisory in `exceljs` | `package.json` (`exceljs > uuid`) | `node_modules/exceljs` | `bun audit` reported 1 moderate transitive advisory on `uuid@8.3.2` (`GHSA-w5hq-g745-h8pq`: missing buffer bounds check in `v3`/`v5`/`v6` when `buf` is provided). | Low | Needs Follow-Up | Inspected `exceljs` source: it calls only `uuidv4()` with no `buf` argument, so the vulnerable `v3`/`v5`/`v6` buffer path is unreachable in MediNest; monitor upstream `exceljs` updates for `uuid` major bump. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Session & Password Security | `server/auth.ts` | HttpOnly `SameSite=Lax` signed-random session tokens stored in PostgreSQL `sessions`, bcrypt password hashing, forced initial default-password rotation, and account/IP login rate limiting. |
| CSRF Defense | `server/auth.ts:267`, `server/routes.ts:102` | Global `requireCsrfProtection` middleware on `/api` enforces custom `X-Requested-With: MediNest` header or same-host `Origin` / `Referer` validation on all state-changing HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`). |
| SQL Injection Prevention | `server/db.ts`, `server/services/*` | All PostgreSQL queries use parameterized `$1, $2, ...` placeholders via the `pg` driver wrapper with strict allow-lists for backup/table names. |
| Financial & Inventory Locking | `server/services/salesService.ts`, `server/services/purchaseService.ts` | Atomic transactions with `SELECT ... FOR UPDATE` row locks on batches, parties, and cash sessions; `Decimal` math via `decimal.js` prevents floating-point drift. |
| Audit Hash Chain | `server/audit.ts` | Append-only SHA-256 hash chain (`prev_hash` -> `row_hash`) verified end-to-end by `verifyAuditChain` on both live state and restored backups. |

## PoC Verification

### 1. Malformed Spreadsheet, Macro, Path-Traversal, Prototype-Pollution & ZIP-Bomb Defense
#### Summary
| Field | Value |
|---|---|
| Issue Type | Unsafe Spreadsheet Parsing / ZIP Bomb / Prototype Pollution / Macro Upload |
| Impact | High |
| Affected File | `server/services/excelService.ts:51-240`, `server/routes.ts:624-650` |
| Test Scenario | Submitted legacy `.xls`, `%PDF-1.7`, generic `.zip`, `xl/vbaProject.bin`, `../../etc/passwd`, forged-size 16 MB DEFLATE ZIP bomb, >5 MB payload, and `__proto__`/`constructor` header columns |

#### How It Was Fixed
Replaced `xlsx@0.18.5` with `exceljs@4.4.0` wrapped by `validateXlsxBufferSafety` and `parseXlsxFirstSheetToRows`, enforcing upload byte caps, magic-byte inspection, ZIP central-directory & `zlib.inflateRawSync` `maxOutputLength` checks, macro/path-traversal rejection, row/col limits, and `Object.create(null)` property allow-listing.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Untrusted base64/buffer enters `/api/medicines/import/preview` (`server/routes.ts:624`) | Base64 & byte length checked before decode |
| 2 | `validateXlsxBufferSafety` (`server/services/excelService.ts:51`) checks `PK\x03\x04`, central directory, entry paths, macros, and `zlib.inflateRawSync(..., { maxOutputLength })` | Non-XLSX, `.xls`, macros, traversal, and ZIP bombs rejected |
| 3 | `parseXlsxFirstSheetToRows` (`server/services/excelService.ts:207`) skips `__proto__`/`constructor`/`prototype` headers and maps cells onto `Object.create(null)` | **Handled Safely** |

#### Conclusion
**Fix Verified** - `xlsx@0.18.5` is completely removed from the dependency tree, and untrusted spreadsheet payloads cannot trigger prototype pollution, ReDoS, macro ingestion, path traversal, or memory exhaustion.

---

### 2. Spoofed Proxy Header Rate-Limit & Audit IP Spoofing
#### Summary
| Field | Value |
|---|---|
| Issue Type | Spoofable Client IP / Rate-Limit Bypass |
| Impact | High |
| Affected File | `server.ts:32`, `server/auth.ts:43` |
| Test Scenario | `extractClientIp({ ip: '192.168.1.44', headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '192.168.1.44' } })` |

#### How It Was Fixed
Express `trust proxy` defaults to `false` unless `TRUST_PROXY=true` is explicitly configured for a verified local reverse proxy, and `extractClientIp` reads `req.ip` / `req.socket.remoteAddress` without trusting raw `X-Forwarded-For` headers.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Client sends `X-Forwarded-For: 203.0.113.9` directly over LAN or localhost | Header arrives at Express app |
| 2 | `server.ts:32` evaluates `app.set('trust proxy', false)` and `server/auth.ts:43` reads `req.ip \|\| req.socket?.remoteAddress` | Header ignored |
| 3 | Integration test asserts `extractClientIp` returns `'192.168.1.44'` and not `'203.0.113.9'` | **Handled Safely** |

#### Conclusion
**Fix Verified** - LAN clients cannot rotate `X-Forwarded-For` headers to evade failed-login lockouts or falsify audit-log IP addresses.

---

### 3. Multi-Counter Concurrent Cash Session Isolation & Duplicate Lock Prevention
#### Summary
| Field | Value |
|---|---|
| Issue Type | Broken Multi-Terminal Concurrency & Duplicate Drawer Conflict |
| Impact | High |
| Affected File | `server/db.ts:1006-1007`, `server/services/financeService.ts:62-155` |
| Test Scenario | Opening `COUNTER-1` (`5000.00`) and `COUNTER-2` (`2500.00`) concurrently, then attempting a second open session on `COUNTER-1` |

#### How It Was Fixed
Dropped `uq_cash_sessions_single_open` and created `uq_cash_sessions_open_per_counter ON cash_sessions (counter_code) WHERE status = 'OPEN'`, binding cash sales, refunds, expenses, and cash closures to explicit counter drawers.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `admin` opens `COUNTER-1` and `lan_cashier2` opens `COUNTER-2` simultaneously over HTTP | Both return `201 Created` |
| 2 | Second open request targets `COUNTER-1` while `COUNTER-1` is already open | Hits pre-check & `uq_cash_sessions_open_per_counter` |
| 3 | Service throws `400/409` matching `/already OPEN for COUNTER-1/i` while `COUNTER-2` stays independent | **Handled Safely** |

#### Conclusion
**Fix Verified** - Multiple counters operate and reconcile independently while duplicate open sessions on the same counter remain blocked at both service and PostgreSQL index levels.
