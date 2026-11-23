import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';
import { BACKUP_DIR, DB_PATH, closeDb, getDb, nowIso, todayDate, uuid, withTransaction } from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import {
  qty,
  validateConversionInput,
  validateCostInput,
  validateCurrencyInput,
  validateQuantityInput,
} from '../../src/shared/decimalMath.ts';

export async function createVerifiedBackup(
  user: AuthUser | null,
  backupType: 'MANUAL' | 'AUTO_DAILY' | 'PRE_UPDATE' | 'PRE_RESTORE' = 'MANUAL'
) {
  const db = getDb();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `medinest-backup-${backupType.toLowerCase()}-${stamp}.sqlite`;
  const targetPath = path.join(BACKUP_DIR, filename);
  const ts = nowIso();
  const id = uuid();

  try {
    await backup(db, targetPath);

    const verifyDb = new DatabaseSync(targetPath, { readOnly: true });
    let integrityResult = 'failed';
    try {
      const checkRow = verifyDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
      integrityResult = checkRow?.integrity_check || 'unknown';
    } finally {
      verifyDb.close();
    }

    if (integrityResult.toLowerCase() !== 'ok') {
      throw new Error(`SQLite integrity_check returned '${integrityResult}'`);
    }

    const stat = fs.statSync(targetPath);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');

    withTransaction((tx) => {
      tx.prepare(
        `INSERT INTO backup_records (id, filename, file_path, size_bytes, sha256, integrity_check_result, backup_type, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?)`
      ).run(id, filename, targetPath, stat.size, sha256, integrityResult, backupType, user?.id || null, ts);

      recordAudit(tx, {
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

    const settings = db.prepare('SELECT backup_retention_count FROM pharmacy_settings WHERE id = 1').get() as
      | { backup_retention_count: number }
      | undefined;
    const retain = Math.max(3, settings?.backup_retention_count || 14);
    const oldBackups = db
      .prepare("SELECT id, file_path FROM backup_records WHERE status = 'VERIFIED' ORDER BY created_at DESC LIMIT -1 OFFSET ?")
      .all(retain) as Array<{ id: string; file_path: string }>;
    for (const old of oldBackups) {
      if (fs.existsSync(old.file_path)) {
        fs.unlinkSync(old.file_path);
      }
      db.prepare('DELETE FROM backup_records WHERE id = ?').run(old.id);
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
      withTransaction((tx) => {
        tx.prepare(
          `INSERT INTO backup_records (id, filename, file_path, size_bytes, sha256, integrity_check_result, backup_type, status, error_message, created_by, created_at)
           VALUES (?, ?, ?, 0, '', 'FAILED', ?, 'FAILED', ?, ?, ?)`
        ).run(id, filename, targetPath, backupType, msg, user?.id || null, ts);

        recordAudit(tx, {
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
      // If DB itself is unreachable during error recording, preserve original error
    }
    throw err;
  }
}

function recordRestoreFailureAudit(user: AuthUser, backupId: string, filename: string, reason: string) {
  try {
    withTransaction((tx) => {
      recordAudit(tx, {
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
    // Do not mask original restore error if audit logging fails
  }
}

export async function restoreFromBackup(user: AuthUser, backupId: string) {
  const db = getDb();
  const rec = db
    .prepare('SELECT id, filename, file_path, sha256, status FROM backup_records WHERE id = ?')
    .get(backupId) as
    | { id: string; filename: string; file_path: string; sha256: string; status: string }
    | undefined;

  if (!rec || rec.status !== 'VERIFIED') {
    const msg = 'Selected backup record is missing or unverified';
    recordRestoreFailureAudit(user, backupId, rec?.filename || backupId, msg);
    throw new Error(msg);
  }
  if (!rec.sha256 || !/^[a-f0-9]{64}$/i.test(rec.sha256)) {
    const msg = 'Selected backup record is missing a valid expected SHA-256 checksum';
    recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }
  if (!fs.existsSync(rec.file_path)) {
    const msg = 'Backup file does not exist on disk';
    recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }

  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(rec.file_path)).digest('hex');
  const expectedBuf = Buffer.from(rec.sha256.toLowerCase(), 'utf8');
  const actualBuf = Buffer.from(actualSha256.toLowerCase(), 'utf8');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    const msg = `Backup SHA-256 checksum mismatch for ${rec.filename}. Restore aborted to prevent corrupted or tampered recovery.`;
    recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }

  let checkDb: DatabaseSync | null = null;
  try {
    checkDb = new DatabaseSync(rec.file_path, { readOnly: true });
    const res = checkDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
    if (res?.integrity_check?.toLowerCase() !== 'ok') {
      throw new Error(`Backup file failed integrity check: ${res?.integrity_check}`);
    }
  } catch (err) {
    const msg = (err as Error).message || 'Backup file failed SQLite integrity verification';
    recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  } finally {
    try {
      checkDb?.close();
    } catch {
      // ignore close failure
    }
  }

  let preRestore: Awaited<ReturnType<typeof createVerifiedBackup>>;
  try {
    preRestore = await createVerifiedBackup(user, 'PRE_RESTORE');
  } catch (err) {
    const msg = `Pre-restore safety backup failed: ${(err as Error).message}`;
    recordRestoreFailureAudit(user, rec.id, rec.filename, msg);
    throw new Error(msg);
  }

  const preRestorePath = path.join(BACKUP_DIR, preRestore.filename);

  closeDb();
  try {
    fs.copyFileSync(rec.file_path, DB_PATH);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(DB_PATH + suffix)) fs.unlinkSync(DB_PATH + suffix);
    }

    const restored = getDb();
    const postCheck = restored.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
    if (postCheck?.integrity_check?.toLowerCase() !== 'ok') {
      throw new Error(`Post-restore integrity verification failed: ${postCheck?.integrity_check}`);
    }

    withTransaction((tx) => {
      recordAudit(tx, {
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
          integrity: postCheck.integrity_check,
        },
        reason: `Restored database from SHA-256 verified backup ${rec.filename}`,
      });
    });

    return {
      restoredFrom: rec.filename,
      sha256: actualSha256,
      preRestoreBackup: preRestore.filename,
      integrity: postCheck.integrity_check,
    };
  } catch (restoreErr) {
    const msg = (restoreErr as Error).message;
    try {
      closeDb();
      if (fs.existsSync(preRestorePath)) {
        fs.copyFileSync(preRestorePath, DB_PATH);
        for (const suffix of ['-wal', '-shm']) {
          if (fs.existsSync(DB_PATH + suffix)) fs.unlinkSync(DB_PATH + suffix);
        }
        getDb();
        recordRestoreFailureAudit(
          user,
          rec.id,
          rec.filename,
          `Restore failed and rolled back to ${preRestore.filename}: ${msg}`
        );
      }
    } catch {
      // Preserve primary restore failure error
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

export function parseAndValidateExcelImport(buffer: Buffer): ParsedImportRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Excel workbook contains no sheets');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: '' });
  const db = getDb();
  const today = todayDate();
  const seenBarcodes = new Set<string>();

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
      const existingBc = db
        .prepare("SELECT id FROM medicines WHERE LOWER(barcode) = LOWER(?) AND barcode != ''")
        .get(barcode) as { id: string } | undefined;
      if (existingBc) {
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

    const dup = db
      .prepare('SELECT id FROM medicines WHERE LOWER(brand_name) = LOWER(?) AND LOWER(strength) = LOWER(?)')
      .get(brandName, strength) as { id: string } | undefined;

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
      duplicateMedicineId: dup?.id || null,
      errors,
    };
  });
}

export function executeExcelImport(
  user: AuthUser,
  rows: Array<ParsedImportRow & { duplicateAction?: 'SKIP' | 'USE_EXISTING' | 'CREATE_NEW' }>
) {
  return withTransaction((tx) => {
    const ts = nowIso();
    const today = todayDate();
    let createdMeds = 0;
    let addedBatches = 0;
    let skipped = 0;

    let medCodeCounter = (tx.prepare('SELECT COUNT(*) as cnt FROM medicines').get() as { cnt: number }).cnt;

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
          const cat = tx.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)').get(r.category) as { id: string } | undefined;
          if (cat) catId = cat.id;
          else {
            catId = uuid();
            tx.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(catId, r.category);
          }
        }
        let mfgId: string | null = null;
        if (r.manufacturer) {
          const mfg = tx.prepare('SELECT id FROM manufacturers WHERE LOWER(name) = LOWER(?)').get(r.manufacturer) as { id: string } | undefined;
          if (mfg) mfgId = mfg.id;
          else {
            mfgId = uuid();
            tx.prepare('INSERT INTO manufacturers (id, name) VALUES (?, ?)').run(mfgId, r.manufacturer);
          }
        }

        medCodeCounter++;
        const medCode = r.medicineCode?.trim() || `MED-${String(medCodeCounter).padStart(4, '0')}`;
        const minStock = validateQuantityInput(r.minStockLevel || '0', 'min_stock_level', { allowZero: true });

        medId = uuid();
        tx.prepare(
          `INSERT INTO medicines (
            id, medicine_code, barcode, brand_name, generic_name, bangla_name, strength, dosage_form,
            category_id, manufacturer_id, storage_info, base_unit_name, min_stock_level, rx_required,
            is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(
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
          r.rxRequired ? 1 : 0,
          ts,
          ts
        );

        tx.prepare(
          `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
           VALUES (?, ?, ?, '1.000000', 1, 1, 1, 1, ?, ?)`
        ).run(uuid(), medId, r.baseUnit, ts, ts);

        if (r.secondaryUnit && r.secondaryConversion) {
          const secConv = validateConversionInput(r.secondaryConversion, 'secondary_conversion');
          tx.prepare(
            `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 1, 1, 1, ?, ?)`
          ).run(uuid(), medId, r.secondaryUnit, secConv.toFixed(6), ts, ts);
        }
        if (r.boxUnit && r.boxConversion && r.boxUnit.toLowerCase() !== r.secondaryUnit.toLowerCase()) {
          const boxConv = validateConversionInput(r.boxConversion, 'box_conversion');
          tx.prepare(
            `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 1, 1, 1, ?, ?)`
          ).run(uuid(), medId, r.boxUnit, boxConv.toFixed(6), ts, ts);
        }
        createdMeds++;
      }

      if (r.openingBatchNumber && qty(r.openingQtyBase).gt(0)) {
        const openQty = validateQuantityInput(r.openingQtyBase, 'opening_qty_base');
        const openCost = validateCostInput(r.costPerBase || '0', 'cost_per_base', { allowZero: true });
        const openPrice = validateCurrencyInput(r.sellingPricePerBase, 'selling_price_per_base');
        const batchId = uuid();
        tx.prepare(
          `INSERT INTO batches (
            id, medicine_id, batch_number, expiry_date, received_date,
            purchase_cost_per_base, selling_price_per_base, initial_qty_base, current_qty_base,
            base_unit_name, status, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'Imported via Excel', ?, ?)`
        ).run(
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
          ts
        );
        tx.prepare(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id,
            cost_per_base_snapshot, reason, created_by, created_at
          ) VALUES (?, ?, ?, ?, 'OPENING_STOCK', 'EXCEL_IMPORT', ?, ?, 'Excel opening stock import', ?, ?)`
        ).run(uuid(), medId, batchId, openQty.toFixed(6), batchId, openCost.toFixed(6), user.id, ts);
        addedBatches++;
      }
    }

    recordAudit(tx, {
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
