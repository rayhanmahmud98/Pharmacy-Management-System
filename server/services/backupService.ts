import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';
import { BACKUP_DIR, DB_PATH, closeDb, getDb, nowIso, todayDate, uuid, withTransaction } from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import { d, money, qty, ratio } from '../../src/shared/decimalMath.ts';

export async function createVerifiedBackup(
  user: AuthUser | null,
  backupType: 'MANUAL' | 'AUTO_DAILY' | 'PRE_UPDATE' | 'PRE_RESTORE' = 'MANUAL'
) {
  const db = getDb();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `shifarx-backup-${backupType.toLowerCase()}-${stamp}.sqlite`;
  const targetPath = path.join(BACKUP_DIR, filename);
  const ts = nowIso();
  const id = uuid();

  try {
    // Native SQLite Online Backup API (safe even in WAL mode with active connections)
    await backup(db, targetPath);

    // Verify backup integrity before marking successful
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

    // Enforce retention policy (keep newest N verified backups)
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
    db.prepare(
      `INSERT INTO backup_records (id, filename, file_path, size_bytes, sha256, integrity_check_result, backup_type, status, error_message, created_by, created_at)
       VALUES (?, ?, ?, 0, '', 'FAILED', ?, 'FAILED', ?, ?, ?)`
    ).run(id, filename, targetPath, backupType, msg, user?.id || null, ts);
    throw err;
  }
}

export async function restoreFromBackup(user: AuthUser, backupId: string) {
  const db = getDb();
  const rec = db.prepare('SELECT * FROM backup_records WHERE id = ?').get(backupId) as
    | { id: string; filename: string; file_path: string; status: string }
    | undefined;
  if (!rec || rec.status !== 'VERIFIED') throw new Error('Selected backup record is missing or unverified');
  if (!fs.existsSync(rec.file_path)) throw new Error('Backup file does not exist on disk');

  // Verify integrity of target backup again before touching live DB
  const checkDb = new DatabaseSync(rec.file_path, { readOnly: true });
  try {
    const res = checkDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
    if (res?.integrity_check?.toLowerCase() !== 'ok') {
      throw new Error(`Backup file failed integrity check: ${res?.integrity_check}`);
    }
  } finally {
    checkDb.close();
  }

  // Mandatory pre-restore safety backup
  await createVerifiedBackup(user, 'PRE_RESTORE');

  closeDb();
  fs.copyFileSync(rec.file_path, DB_PATH);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + suffix)) fs.unlinkSync(DB_PATH + suffix);
  }

  // Reopen & verify restored DB
  const restored = getDb();
  const postCheck = restored.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
  if (postCheck?.integrity_check?.toLowerCase() !== 'ok') {
    throw new Error('Post-restore integrity verification failed');
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
      reason: `Restored database from verified backup ${rec.filename}`,
    });
  });

  return { restoredFrom: rec.filename, integrity: postCheck.integrity_check };
}

export function buildMedicineImportTemplateBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  const sampleRows = [
    {
      brand_name: 'Fexo 120',
      generic_name: 'Fexofenadine HCl',
      bangla_name: 'ফেক্সো ১২০',
      strength: '120 mg',
      dosage_form: 'Tablet',
      category: 'Respiratory & Anti-Allergic',
      manufacturer: 'Square Pharmaceuticals PLC',
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
  brandName: string;
  genericName: string;
  banglaName: string;
  strength: string;
  dosageForm: string;
  category: string;
  manufacturer: string;
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

  return rows.map((raw, idx) => {
    const errors: string[] = [];
    const brandName = String(raw.brand_name || '').trim();
    const genericName = String(raw.generic_name || '').trim();
    const strength = String(raw.strength || '').trim();
    const baseUnit = String(raw.base_unit || '').trim();
    const secondaryUnit = String(raw.secondary_unit || '').trim();
    const secondaryConvRaw = String(raw.secondary_conversion ?? '').trim();
    const boxUnit = String(raw.box_unit || '').trim();
    const boxConvRaw = String(raw.box_conversion ?? '').trim();
    const openingBatch = String(raw.opening_batch_number || '').trim();
    const openingExp = String(raw.opening_expiry_date || '').trim();
    const openingQtyRaw = String(raw.opening_qty_base ?? '').trim();
    const costRaw = String(raw.cost_per_base ?? '').trim();
    const priceRaw = String(raw.selling_price_per_base ?? '').trim();

    if (!brandName) errors.push('brand_name is required');
    if (!genericName) errors.push('generic_name is required');
    if (!baseUnit) errors.push('base_unit is required');

    let secondaryConversion = '';
    if (secondaryUnit) {
      try {
        secondaryConversion = ratio(secondaryConvRaw).toFixed(4);
      } catch {
        errors.push(`Invalid secondary_conversion '${secondaryConvRaw}'`);
      }
    }

    let boxConversion = '';
    if (boxUnit) {
      try {
        boxConversion = ratio(boxConvRaw).toFixed(4);
      } catch {
        errors.push(`Invalid box_conversion '${boxConvRaw}'`);
      }
    }

    let openingQtyBase = '0.0000';
    let costPerBase = '0.0000';
    let sellingPricePerBase = '0.00';

    if (openingBatch || openingQtyRaw) {
      if (!openingBatch) errors.push('opening_batch_number required when opening stock provided');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(openingExp) || openingExp <= today) {
        errors.push(`opening_expiry_date '${openingExp}' must be future YYYY-MM-DD`);
      }
      try {
        const q = qty(openingQtyRaw);
        if (q.lte(0)) errors.push('opening_qty_base must be > 0');
        openingQtyBase = q.toFixed(4);
      } catch {
        errors.push(`Invalid opening_qty_base '${openingQtyRaw}'`);
      }
      try {
        const c = d(costRaw);
        if (c.lt(0)) errors.push('cost_per_base cannot be negative');
        costPerBase = c.toFixed(4);
      } catch {
        errors.push(`Invalid cost_per_base '${costRaw}'`);
      }
      try {
        const p = money(priceRaw);
        if (p.lte(0)) errors.push('selling_price_per_base must be > 0');
        sellingPricePerBase = p.toFixed(2);
      } catch {
        errors.push(`Invalid selling_price_per_base '${priceRaw}'`);
      }
    }

    const dup = db
      .prepare('SELECT id FROM medicines WHERE LOWER(brand_name) = LOWER(?) AND LOWER(strength) = LOWER(?)')
      .get(brandName, strength) as { id: string } | undefined;

    return {
      rowIndex: idx + 2,
      raw,
      brandName,
      genericName,
      banglaName: String(raw.bangla_name || '').trim(),
      strength,
      dosageForm: String(raw.dosage_form || '').trim(),
      category: String(raw.category || '').trim(),
      manufacturer: String(raw.manufacturer || '').trim(),
      baseUnit,
      secondaryUnit,
      secondaryConversion,
      boxUnit,
      boxConversion,
      minStockLevel: String(raw.min_stock_level || '0').trim(),
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

        medId = uuid();
        tx.prepare(
          `INSERT INTO medicines (
            id, brand_name, generic_name, bangla_name, strength, dosage_form,
            category_id, manufacturer_id, base_unit_name, min_stock_level, rx_required,
            is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(
          medId,
          r.brandName,
          r.genericName,
          r.banglaName,
          r.strength,
          r.dosageForm,
          catId,
          mfgId,
          r.baseUnit,
          qty(r.minStockLevel || '0').toFixed(4),
          r.rxRequired ? 1 : 0,
          ts,
          ts
        );

        tx.prepare(
          `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
           VALUES (?, ?, ?, '1.0000', 1, 1, 1, 1, ?, ?)`
        ).run(uuid(), medId, r.baseUnit, ts, ts);

        if (r.secondaryUnit && r.secondaryConversion) {
          tx.prepare(
            `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 1, 1, 1, ?, ?)`
          ).run(uuid(), medId, r.secondaryUnit, r.secondaryConversion, ts, ts);
        }
        if (r.boxUnit && r.boxConversion && r.boxUnit.toLowerCase() !== r.secondaryUnit.toLowerCase()) {
          tx.prepare(
            `INSERT INTO medicine_units (id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 1, 1, 1, ?, ?)`
          ).run(uuid(), medId, r.boxUnit, r.boxConversion, ts, ts);
        }
        createdMeds++;
      }

      if (r.openingBatchNumber && qty(r.openingQtyBase).gt(0)) {
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
          r.costPerBase,
          r.sellingPricePerBase,
          r.openingQtyBase,
          r.openingQtyBase,
          r.baseUnit,
          ts,
          ts
        );
        tx.prepare(
          `INSERT INTO stock_movements (
            id, medicine_id, batch_id, qty_change_base, movement_type, reference_type, reference_id,
            cost_per_base_snapshot, reason, created_by, created_at
          ) VALUES (?, ?, ?, ?, 'OPENING_STOCK', 'EXCEL_IMPORT', ?, ?, 'Excel opening stock import', ?, ?)`
        ).run(uuid(), medId, batchId, r.openingQtyBase, batchId, r.costPerBase, user.id, ts);
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
