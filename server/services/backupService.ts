import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as XLSX from 'xlsx';
import {
  BACKUP_DIR,
  closeDb,
  generateSequentialCode,
  getDb,
  getPgConnectionDetails,
  nowIso,
  todayDate,
  uuid,
  withTransaction,
} from '../db.ts';
import { recordAudit, verifyAuditChain } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import {
  qty,
  validateConversionInput,
  validateCostInput,
  validateCurrencyInput,
  validateQuantityInput,
} from '../../src/shared/decimalMath.ts';
import { reconcileInventoryLedger } from './inventoryService.ts';

const execFileAsync = promisify(execFile);

function resolvePgBinary(tool: 'pg_dump' | 'pg_restore' | 'psql'): string {
  const candidates: string[] = [
    tool,
    `/usr/local/bin/${tool}`,
    `/usr/bin/${tool}`,
  ];

  // Check standard Debian/Ubuntu PostgreSQL versioned paths
  if (fs.existsSync('/usr/lib/postgresql')) {
    for (const dir of fs.readdirSync('/usr/lib/postgresql').sort().reverse()) {
      candidates.push(`/usr/lib/postgresql/${dir}/bin/${tool}`);
    }
  }

  // Check standard Windows PostgreSQL installation paths
  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
      if (fs.existsSync(base)) {
        for (const dir of fs.readdirSync(base).sort().reverse()) {
          candidates.push(path.join(base, dir, 'bin', `${tool}.exe`));
        }
      }
    }
  }

  for (const c of candidates) {
    if (c === tool) continue;
    if (fs.existsSync(c)) return c;
  }
  return tool;
}

function buildPgToolEnv(): NodeJS.ProcessEnv {
  const cfg = getPgConnectionDetails();
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PGHOST = cfg.host;
  env.PGPORT = String(cfg.port);
  env.PGDATABASE = cfg.database;
  env.PGUSER = cfg.user;
  if (cfg.password) {
    env.PGPASSWORD = cfg.password;
  } else {
    delete env.PGPASSWORD;
  }
  if (cfg.ssl) {
    env.PGSSLMODE = typeof cfg.ssl === 'object' && cfg.ssl.rejectUnauthorized ? 'verify-full' : 'require';
  }
  return env;
}

async function verifyDumpArchiveToc(filePath: string): Promise<string> {
  const pgRestoreBin = resolvePgBinary('pg_restore');
  const { stdout } = await execFileAsync(pgRestoreBin, ['--list', filePath], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';'));

  const requiredTables = ['users', 'medicines', 'batches', 'sales', 'audit_logs'];
  for (const tbl of requiredTables) {
    if (!stdout.includes(tbl)) {
      throw new Error(`Backup archive verification failed: missing table '${tbl}' in dump TOC`);
    }
  }
  return `pg_restore TOC verified (${lines.length} objects)`;
}

export async function createVerifiedBackup(
  user: AuthUser | null,
  backupType: 'MANUAL' | 'AUTO_DAILY' | 'PRE_UPDATE' | 'PRE_RESTORE' = 'MANUAL'
) {
  const db = await getDb();
  const cfg = getPgConnectionDetails();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `medinest-pg-backup-${backupType.toLowerCase()}-${stamp}.dump`;
  const targetPath = path.join(BACKUP_DIR, filename);
  const ts = nowIso();
  const id = uuid();

  try {
    const pgDumpBin = resolvePgBinary('pg_dump');
    await execFileAsync(
      pgDumpBin,
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--schema=public',
        '--file',
        targetPath,
        cfg.database,
      ],
      {
        env: buildPgToolEnv(),
        maxBuffer: 32 * 1024 * 1024,
      }
    );

    const integrityResult = await verifyDumpArchiveToc(targetPath);
    const stat = fs.statSync(targetPath);
    if (stat.size <= 0) {
      throw new Error('pg_dump produced an empty backup file');
    }
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');

    await withTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO backup_records (id, filename, file_path, size_bytes, sha256, integrity_check_result, backup_type, status, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'VERIFIED', $8, $9)`,
        [id, filename, targetPath, stat.size, sha256, integrityResult, backupType, user?.id || null, ts]
      );

      await recordAudit(tx, {
        userId: user?.id || null,
        username: user?.username || 'system',
        action: 'CREATE_VERIFIED_BACKUP',
        module: 'backup',
        targetType: 'BACKUP',
        targetId: id,
        transactionRef: filename,
        afterState: { sizeBytes: stat.size, sha256, integrity: integrityResult },
      });
    });

    const settings = await db.queryOne<{ backup_retention_count: number }>(
      'SELECT backup_retention_count FROM pharmacy_settings WHERE id = 1'
    );
    const retain = Math.max(3, Number(settings?.backup_retention_count || 14));
    const oldBackups = await db.query<{ id: string; file_path: string }>(
      "SELECT id, file_path FROM backup_records WHERE status = 'VERIFIED' ORDER BY created_at DESC OFFSET $1",
      [retain]
    );
    for (const old of oldBackups) {
      if (fs.existsSync(old.file_path)) {
        fs.unlinkSync(old.file_path);
      }
      await db.execute('DELETE FROM backup_records WHERE id = $1', [old.id]);
    }

    return { id, filename, sizeBytes: stat.size, sha256, integrityCheck: integrityResult };
  } catch (err) {
    const msg = (err as Error).message;
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } catch {
      // ignore cleanup error
    }
    try {
      await withTransaction(async (tx) => {
        await tx.execute(
          `INSERT INTO backup_records (id, filename, file_path, size_bytes, sha256, integrity_check_result, backup_type, status, error_message, created_by, created_at)
           VALUES ($1, $2, $3, 0, '', 'FAILED', $4, 'FAILED', $5, $6, $7)`,
          [id, filename, targetPath, backupType, msg, user?.id || null, ts]
        );

        await recordAudit(tx, {
          userId: user?.id || null,
          username: user?.username || 'system',
          action: 'CREATE_VERIFIED_BACKUP',
          module: 'backup',
          targetType: 'BACKUP',
          targetId: id,
          transactionRef: filename,
          status: 'FAILURE',
          reason: msg,
        });
      });
    } catch {
      // Preserve primary error
    }
    throw err;
  }
}

async function recordRestoreFailureAudit(user: AuthUser, backupId: string, filename: string, reason: string) {
  try {
    await withTransaction(async (tx) => {
      await recordAudit(tx, {
        userId: user.id,
        username: user.username,
        action: 'RESTORE_BACKUP',
        module: 'backup',
        targetType: 'BACKUP',
        targetId: backupId,
        transactionRef: filename,
        status: 'FAILURE',
        reason,
      });
    });
  } catch {
    // Do not mask original restore error
  }
}

async function executePgRestoreArchive(filePath: string): Promise<void> {
  const cfg = getPgConnectionDetails();
  const pgRestoreBin = resolvePgBinary('pg_restore');
  await execFileAsync(
    pgRestoreBin,
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--single-transaction',
      '--dbname',
      cfg.database,
      filePath,
    ],
    {
      env: buildPgToolEnv(),
      maxBuffer: 32 * 1024 * 1024,
    }
  );
}

export async function restoreFromBackup(user: AuthUser, backupId: string) {
  const db = await getDb();
  const rec = await db.queryOne<{
    id: string;
    filename: string;
    file_path: string;
    sha256: string;
    status: string;
  }>('SELECT id, filename, file_path, sha256, status FROM backup_records WHERE id = $1', [backupId]);

  if (!rec || rec.status !== 'VERIFIED') {
    const msg = 'Selected backup record is missing or unverified';
    await recordRestoreFailureAudit(user, backupId, rec?.filename || backupId, msg);
    throw new Error(msg);
  }
  if (!rec.sha256 || !/^[a-f0-9]{64}$/i.test(rec.sha256)) {
    const msg = 'Selected backup record is missing a valid expected SHA-256 checksum';
    await recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }
  if (!fs.existsSync(rec.file_path)) {
    const msg = 'Backup file does not exist on disk';
    await recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }

  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(rec.file_path)).digest('hex');
  const expectedBuf = Buffer.from(rec.sha256.toLowerCase(), 'utf8');
  const actualBuf = Buffer.from(actualSha256.toLowerCase(), 'utf8');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    const msg = `Backup SHA-256 checksum mismatch for ${rec.filename}. Restore aborted to prevent corrupted or tampered recovery.`;
    await recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }

  try {
    await verifyDumpArchiveToc(rec.file_path);
  } catch (err) {
    const msg = (err as Error).message || 'Backup archive failed pg_restore verification';
    await recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }

  let preRestore: Awaited<ReturnType<typeof createVerifiedBackup>>;
  try {
    preRestore = await createVerifiedBackup(user, 'PRE_RESTORE');
  } catch (err) {
    const msg = `Pre-restore safety backup failed: ${(err as Error).message}`;
    await recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }

  const preRestorePath = path.join(BACKUP_DIR, preRestore.filename);

  // Close Node pool before dropping/recreating tables via pg_restore so active sockets do not block DDL
  await closeDb();
  try {
    await executePgRestoreArchive(rec.file_path);

    const restoredDb = await getDb();
    const auditVerification = await verifyAuditChain(restoredDb);
    if (!auditVerification.valid) {
      throw new Error(`Post-restore audit chain check failed at seq #${auditVerification.brokenAtSeq}`);
    }
    const ledgerCheck = await reconcileInventoryLedger(restoredDb);
    if (!ledgerCheck.healthy) {
      throw new Error(`Post-restore inventory ledger reconciliation found ${ledgerCheck.discrepancyCount} discrepancy(ies)`);
    }

    const integritySummary = `ok (audit=${auditVerification.totalEntries}, batches=${ledgerCheck.checkedBatches})`;

    await withTransaction(async (tx) => {
      await recordAudit(tx, {
        userId: user.id,
        username: user.username,
        action: 'RESTORE_BACKUP',
        module: 'backup',
        targetType: 'BACKUP',
        targetId: rec.id,
        transactionRef: rec.filename,
        afterState: {
          restoredFrom: rec.filename,
          sha256Verified: actualSha256,
          preRestoreBackup: preRestore.filename,
          integrity: integritySummary,
        },
        reason: `Restored PostgreSQL database from SHA-256 verified backup ${rec.filename}`,
      });
    });

    return {
      restoredFrom: rec.filename,
      sha256: actualSha256,
      preRestoreBackup: preRestore.filename,
      integrity: 'ok',
      details: integritySummary,
    };
  } catch (restoreErr) {
    const msg = (restoreErr as Error).message;
    try {
      await closeDb();
      if (fs.existsSync(preRestorePath)) {
        await executePgRestoreArchive(preRestorePath);
        await getDb();
        await recordRestoreFailureAudit(
          user,
          rec.id,
          rec.filename,
          `Restore failed and rolled back to ${preRestore.filename}: ${msg}`
        );
      }
    } catch {
      // Preserve primary error
    }
    throw restoreErr;
  }
}

export function buildMedicineImportTemplateBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  const sampleRows = [
    {
      medicine_code: 'MED-0101',
      barcode: '8901234560998',
      brand_name: 'Fexo 120',
      generic_name: 'Fexofenadine HCl',
      strength: '120 mg',
      dosage_form: 'Tablet',
      category: 'Respiratory & Anti-Allergic',
      manufacturer: 'Square Pharmaceuticals PLC',
      storage_info: 'Store below 25°C in a dry place',
      base_unit: 'Tablet',
      secondary_unit: 'Strip',
      secondary_conversion: 10,
      box_unit: 'Box',
      box_conversion: 50,
      min_stock_level: 50,
      rx_required: 'NO',
      opening_batch_number: 'FX-2601',
      opening_expiry_date: '2028-06-30',
      opening_qty_base: 100,
      cost_per_base: 6.5,
      selling_price_per_base: 9.0,
    },
  ];
  const ws = XLSX.utils.json_to_sheet(sampleRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Medicines_Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export interface ParsedImportRow {
  rowIndex: number;
  raw: Record<string, unknown>;
  medicineCode: string;
  barcode: string;
  brandName: string;
  genericName: string;
  strength: string;
  dosageForm: string;
  category: string;
  manufacturer: string;
  storageInfo: string;
  baseUnit: string;
  secondaryUnit: string;
  secondaryConversion: string;
  boxUnit: string;
  boxConversion: string;
  minStockLevel: string;
  rxRequired: boolean;
  openingBatchNumber: string;
  openingExpiryDate: string;
  openingQtyBase: string;
  costPerBase: string;
  sellingPricePerBase: string;
  duplicateMedicineId: string | null;
  errors: string[];
}

export async function parseAndValidateExcelImport(buffer: Buffer): Promise<ParsedImportRow[]> {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Excel workbook contains no sheets');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: '' });
  const db = await getDb();
  const today = todayDate();
  const seenBarcodes = new Set<string>();

  const existingMeds = await db.query<{ id: string; barcode: string; brand_name: string; strength: string }>(
    'SELECT id, barcode, brand_name, strength FROM medicines'
  );
  const barcodeMap = new Map<string, string>();
  const nameStrengthMap = new Map<string, string>();
  for (const m of existingMeds) {
    if (m.barcode) barcodeMap.set(m.barcode.toLowerCase(), m.id);
    nameStrengthMap.set(`${m.brand_name.toLowerCase()}||${m.strength.toLowerCase()}`, m.id);
  }

  return rows.map((raw, idx) => {
    const errors: string[] = [];
    const medicineCode = String(raw.medicine_code || '').trim();
    const barcode = String(raw.barcode || '').trim();
    const brandName = String(raw.brand_name || '').trim();
    const genericName = String(raw.generic_name || '').trim();
    const strength = String(raw.strength || '').trim();
    const storageInfo = String(raw.storage_info || '').trim();
    const baseUnit = String(raw.base_unit || '').trim();
    const secondaryUnit = String(raw.secondary_unit || '').trim();
    const secondaryConvRaw = String(raw.secondary_conversion ?? '').trim();
    const boxUnit = String(raw.box_unit || '').trim();
    const boxConvRaw = String(raw.box_conversion ?? '').trim();
    const minStockRaw = String(raw.min_stock_level ?? '0').trim() || '0';
    const openingBatch = String(raw.opening_batch_number || '').trim();
    const openingExp = String(raw.opening_expiry_date || '').trim();
    const openingQtyRaw = String(raw.opening_qty_base ?? '').trim();
    const costRaw = String(raw.cost_per_base ?? '').trim();
    const priceRaw = String(raw.selling_price_per_base ?? '').trim();

    if (!brandName) errors.push('brand_name is required');
    if (!genericName) errors.push('generic_name is required');
    if (!baseUnit) errors.push('base_unit is required');

    if (barcode) {
      const lowerBc = barcode.toLowerCase();
      if (seenBarcodes.has(lowerBc)) {
        errors.push(`Duplicate barcode '${barcode}' within import file`);
      } else {
        seenBarcodes.add(lowerBc);
      }
      if (barcodeMap.has(lowerBc)) {
        errors.push(`Barcode '${barcode}' already exists in database`);
      }
    }

    let minStockLevel = '0.000000';
    try {
      minStockLevel = validateQuantityInput(minStockRaw, 'min_stock_level', { allowZero: true }).toFixed(6);
    } catch (e) {
      errors.push((e as Error).message);
    }

    let secondaryConversion = '';
    if (secondaryUnit) {
      try {
        secondaryConversion = validateConversionInput(secondaryConvRaw, 'secondary_conversion').toFixed(6);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }

    let boxConversion = '';
    if (boxUnit) {
      try {
        boxConversion = validateConversionInput(boxConvRaw, 'box_conversion').toFixed(6);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }

    let openingQtyBase = '0.000000';
    let costPerBase = '0.000000';
    let sellingPricePerBase = '0.00';

    if (openingBatch || openingQtyRaw) {
      if (!openingBatch) errors.push('opening_batch_number required when opening stock provided');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(openingExp) || openingExp <= today) {
        errors.push(`opening_expiry_date '${openingExp}' must be future YYYY-MM-DD`);
      }
      try {
        const q = validateQuantityInput(openingQtyRaw, 'opening_qty_base');
        openingQtyBase = q.toFixed(6);
      } catch (e) {
        errors.push((e as Error).message);
      }
      try {
        const c = validateCostInput(costRaw || '0', 'cost_per_base', { allowZero: true });
        costPerBase = c.toFixed(6);
      } catch (e) {
        errors.push((e as Error).message);
      }
      try {
        const p = validateCurrencyInput(priceRaw, 'selling_price_per_base');
        sellingPricePerBase = p.toFixed(2);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }

    const dupId = nameStrengthMap.get(`${brandName.toLowerCase()}||${strength.toLowerCase()}`) || null;

    return {
      rowIndex: idx + 2,
      raw,
      medicineCode,
      barcode,
      brandName,
      genericName,
      strength,
      dosageForm: String(raw.dosage_form || '').trim(),
      category: String(raw.category || '').trim(),
      manufacturer: String(raw.manufacturer || '').trim(),
      storageInfo,
      baseUnit,
      secondaryUnit,
      secondaryConversion,
      boxUnit,
      boxConversion,
      minStockLevel,
      rxRequired: ['YES', 'TRUE', '1'].includes(String(raw.rx_required || '').trim().toUpperCase()),
      openingBatchNumber: openingBatch,
      openingExpiryDate: openingExp,
      openingQtyBase,
      costPerBase,
      sellingPricePerBase,
      duplicateMedicineId: dupId,
      errors,
    };
  });
}

export async function executeExcelImport(
  user: AuthUser,
  rows: Array<ParsedImportRow & { duplicateAction?: 'SKIP' | 'USE_EXISTING' | 'CREATE_NEW' }>
) {
  return withTransaction(async (tx) => {
    const ts = nowIso();
    const today = todayDate();
    let createdMeds = 0;
    let addedBatches = 0;
    let skipped = 0;

    for (const r of rows) {
      if (r.errors && r.errors.length > 0) {
        throw new Error(`Row ${r.rowIndex} has validation errors: ${r.errors.join('; ')}`);
      }

      let medId = r.duplicateMedicineId;
      if (medId) {
        const action = r.duplicateAction || 'SKIP';
        if (action === 'SKIP') {
          skipped++;
          continue;
        }
        if (action === 'CREATE_NEW') {
          medId = null;
        }
      }

      if (!medId) {
        let catId: string | null = null;
        if (r.category) {
          const cat = await tx.queryOne<{ id: string }>('SELECT id FROM categories WHERE LOWER(name) = LOWER($1)', [
            r.category,
          ]);
          if (cat) catId = cat.id;
          else {
            catId = uuid();
            await tx.execute('INSERT INTO categories (id, name) VALUES ($1, $2)', [catId, r.category]);
          }
        }
        let mfgId: string | null = null;
        if (r.manufacturer) {
          const mfg = await tx.queryOne<{ id: string }>('SELECT id FROM manufacturers WHERE LOWER(name) = LOWER($1)', [
            r.manufacturer,
          ]);
          if (mfg) mfgId = mfg.id;
          else {
            mfgId = uuid();
            await tx.execute('INSERT INTO manufacturers (id, name) VALUES ($1, $2)', [mfgId, r.manufacturer]);
          }
        }

        const medCode =
          r.medicineCode?.trim() || (await generateSequentialCode(tx, 'CODE-MED', 'MED', 4, 'medicines', 'medicine_code'));
        const minStock = validateQuantityInput(r.minStockLevel || '0', 'min_stock_level', { allowZero: true });

        medId = uuid();
        await tx.execute(
          `INSERT INTO medicines (
            id, medicine_code, barcode, brand_name, generic_name, bangla_name, strength, dosage_form,
            category_id, manufacturer_id, storage_info, base_unit_name, min_stock_level, rx_required,
            is_active, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, $9, $10, $11, $12, $13, TRUE, $14, $15)`,
          [
            medId,
            medCode,
            (r.barcode || '').trim(),
            r.brandName,
            r.genericName,
            r.strength,
            r.dosageForm,
            catId,
            mfgId,
            (r.storageInfo || '').trim(),
            r.baseUnit,
            minStock.toFixed(6),
            Boolean(r.rxRequired),
            ts,
            ts,
          ]
        );

        await tx.execute(
          `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, '1.000000', TRUE, TRUE, TRUE, TRUE, $4, $5)`,
          [uuid(), medId, r.baseUnit, ts, ts]
        );

        if (r.secondaryUnit && r.secondaryConversion) {
          const secConv = validateConversionInput(r.secondaryConversion, 'secondary_conversion');
          await tx.execute(
            `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, FALSE, TRUE, TRUE, TRUE, $5, $6)`,
            [uuid(), medId, r.secondaryUnit, secConv.toFixed(6), ts, ts]
          );
        }
        if (r.boxUnit && r.boxConversion && r.boxUnit.toLowerCase() !== r.secondaryUnit.toLowerCase()) {
          const boxConv = validateConversionInput(r.boxConversion, 'box_conversion');
          await tx.execute(
            `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, FALSE, TRUE, TRUE, TRUE, $5, $6)`,
            [uuid(), medId, r.boxUnit, boxConv.toFixed(6), ts, ts]
          );
        }
        createdMeds++;
      }

      if (r.openingBatchNumber && qty(r.openingQtyBase).gt(0)) {
        const openQty = validateQuantityInput(r.openingQtyBase, 'opening_qty_base');
        const openCost = validateCostInput(r.costPerBase || '0', 'cost_per_base', { allowZero: true });
        const openPrice = validateCurrencyInput(r.sellingPricePerBase, 'selling_price_per_base');
        const batchId = uuid();
        await tx.execute(
          `INSERT INTO batches (
            id, medicine_id, batch_number, expiry_date, received_date,
            purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
            base_unit_name, status, notes, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', 'Imported via Excel', $11, $12)`,
          [
            batchId,
            medId,
            r.openingBatchNumber,
            r.openingExpiryDate,
            today,
            openCost.toFixed(6),
            openPrice.toFixed(2),
            openQty.toFixed(6),
            openQty.toFixed(6),
            r.baseUnit,
            ts,
            ts,
          ]
        );
        await tx.execute(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id,
            cost_per_base_snapshot, reason, created_by, created_at
          ) VALUES ($1, $2, $3, $4, 'OPENING_STOCK', 'EXCEL_IMPORT', $5, $6, 'Excel opening stock import', $7, $8)`,
          [uuid(), medId, batchId, openQty.toFixed(6), batchId, openCost.toFixed(6), user.id, ts]
        );
        addedBatches++;
      }
    }

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'EXCEL_IMPORT',
      module: 'medicines',
      targetType: 'IMPORT',
      targetId: uuid(),
      afterState: { createdMeds, addedBatches, skipped },
    });

    return { createdMeds, addedBatches, skipped };
  });
}
