import Decimal from 'decimal.js';
import type { DatabaseSync } from 'node:sqlite';
import { generateDocNumber, getDb, nowIso, todayDate, uuid, withTransaction } from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import { d, qty, ratio } from '../../src/shared/decimalMath.ts';

export function listMedicines(search = '', includeInactive = false) {
  const db = getDb();
  const term = `%${search.trim().toLowerCase()}%`;
  const activeClause = includeInactive ? '' : 'AND m.is_active = 1';
  const today = todayDate();

  const meds = db
    .prepare(
      `SELECT m.*, c.name as category_name, mf.name as manufacturer_name,
              COALESCE((
                SELECT SUM(CAST(b.current_qty_base AS REAL))
                FROM batches b
                WHERE b.medicine_id = m.id AND b.status = 'ACTIVE' AND b.expiry_date > ?
              ), 0) as sellable_stock_base,
              COALESCE((
                SELECT SUM(CAST(b.current_qty_base AS REAL))
                FROM batches b
                WHERE b.medicine_id = m.id AND b.status IN ('ACTIVE', 'QUARANTINED')
              ), 0) as total_physical_base
       FROM medicines m
       LEFT JOIN categories c ON c.id = m.category_id
       LEFT JOIN manufacturers mf ON mf.id = m.manufacturer_id
       WHERE (
         LOWER(m.brand_name) LIKE ? OR
         LOWER(m.generic_name) LIKE ? OR
         LOWER(m.bangla_name) LIKE ? OR
         LOWER(m.alternative_names) LIKE ? OR
         LOWER(m.strength) LIKE ? OR
         LOWER(COALESCE(c.name, '')) LIKE ? OR
         LOWER(COALESCE(mf.name, '')) LIKE ?
       ) ${activeClause}
       ORDER BY m.brand_name ASC`
    )
    .all(today, term, term, term, term, term, term, term) as Array<Record<string, unknown>>;

  const unitsStmt = db.prepare(
    'SELECT * FROM medicine_units WHERE medicine_id = ? ORDER BY CAST(conversion_to_base AS REAL) ASC'
  );
  const batchesStmt = db.prepare(
    `SELECT b.*, s.name as supplier_name
     FROM batches b
     LEFT JOIN suppliers s ON s.id = b.supplier_id
     WHERE b.medicine_id = ? AND CAST(b.current_qty_base AS REAL) > 0
     ORDER BY b.expiry_date ASC`
  );

  return meds.map((m) => ({
    ...m,
    units: unitsStmt.all(String(m.id)),
    batches: batchesStmt.all(String(m.id)),
  }));
}

export function createMedicine(
  user: AuthUser,
  input: {
    brandName: string;
    genericName: string;
    banglaName?: string;
    alternativeNames?: string;
    strength?: string;
    dosageForm?: string;
    categoryId?: string | null;
    manufacturerId?: string | null;
    description?: string;
    baseUnitName: string;
    minStockLevel?: string;
    rxRequired?: boolean;
    notes?: string;
    units?: Array<{
      unitName: string;
      conversionToBase: string;
      allowPurchase?: boolean;
      allowSale?: boolean;
    }>;
  }
) {
  if (!input.brandName?.trim() || !input.genericName?.trim() || !input.baseUnitName?.trim()) {
    throw new Error('Brand name, generic name, and base stock unit are required');
  }

  return withTransaction((tx) => {
    const id = uuid();
    const ts = nowIso();
    const minStock = qty(input.minStockLevel || '0').toFixed(4);
    const baseUnit = input.baseUnitName.trim();

    tx.prepare(
      `INSERT INTO medicines (
        id, brand_name, generic_name, bangla_name, alternative_names, strength, dosage_form,
        category_id, manufacturer_id, description, base_unit_name, min_stock_level, rx_required,
        is_active, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(
      id,
      input.brandName.trim(),
      input.genericName.trim(),
      (input.banglaName || '').trim(),
      (input.alternativeNames || '').trim(),
      (input.strength || '').trim(),
      (input.dosageForm || '').trim(),
      input.categoryId || null,
      input.manufacturerId || null,
      (input.description || '').trim(),
      baseUnit,
      minStock,
      input.rxRequired ? 1 : 0,
      (input.notes || '').trim(),
      ts,
      ts
    );

    // Always create base unit (ratio 1)
    tx.prepare(
      `INSERT INTO medicine_units (
        id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, '1.0000', 1, 1, 1, 1, ?, ?)`
    ).run(uuid(), id, baseUnit, ts, ts);

    const seen = new Set([baseUnit.toLowerCase()]);
    for (const u of input.units || []) {
      const name = u.unitName?.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      const conv = ratio(u.conversionToBase); // rejects <= 0
      seen.add(name.toLowerCase());
      tx.prepare(
        `INSERT INTO medicine_units (
          id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`
      ).run(uuid(), id, name, conv.toFixed(4), u.allowPurchase === false ? 0 : 1, u.allowSale === false ? 0 : 1, ts, ts);
    }

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'CREATE_MEDICINE',
      module: 'medicines',
      targetType: 'MEDICINE',
      targetId: id,
      afterState: { brandName: input.brandName, baseUnit },
    });

    return id;
  });
}

export function updateMedicine(
  user: AuthUser,
  medicineId: string,
  input: {
    brandName: string;
    genericName: string;
    banglaName?: string;
    alternativeNames?: string;
    strength?: string;
    dosageForm?: string;
    categoryId?: string | null;
    manufacturerId?: string | null;
    description?: string;
    minStockLevel?: string;
    rxRequired?: boolean;
    isActive?: boolean;
    notes?: string;
  }
) {
  return withTransaction((tx) => {
    const before = tx.prepare('SELECT * FROM medicines WHERE id = ?').get(medicineId);
    if (!before) throw new Error('Medicine not found');
    const ts = nowIso();
    const minStock = qty(input.minStockLevel || '0').toFixed(4);

    tx.prepare(
      `UPDATE medicines SET
        brand_name = ?, generic_name = ?, bangla_name = ?, alternative_names = ?,
        strength = ?, dosage_form = ?, category_id = ?, manufacturer_id = ?,
        description = ?, min_stock_level = ?, rx_required = ?, is_active = ?,
        notes = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.brandName.trim(),
      input.genericName.trim(),
      (input.banglaName || '').trim(),
      (input.alternativeNames || '').trim(),
      (input.strength || '').trim(),
      (input.dosageForm || '').trim(),
      input.categoryId || null,
      input.manufacturerId || null,
      (input.description || '').trim(),
      minStock,
      input.rxRequired ? 1 : 0,
      input.isActive === false ? 0 : 1,
      (input.notes || '').trim(),
      ts,
      medicineId
    );

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'UPDATE_MEDICINE',
      module: 'medicines',
      targetType: 'MEDICINE',
      targetId: medicineId,
      beforeState: before,
      afterState: input,
    });
  });
}

export function upsertMedicineUnit(
  user: AuthUser,
  medicineId: string,
  input: {
    unitId?: string;
    unitName: string;
    conversionToBase: string;
    allowPurchase: boolean;
    allowSale: boolean;
    isActive: boolean;
  }
) {
  const unitName = input.unitName?.trim();
  if (!unitName) throw new Error('Unit name is required');
  const conv = ratio(input.conversionToBase); // rejects <= 0 or NaN

  return withTransaction((tx) => {
    const med = tx.prepare('SELECT * FROM medicines WHERE id = ?').get(medicineId) as
      | { id: string; brand_name: string }
      | undefined;
    if (!med) throw new Error('Medicine not found');
    const ts = nowIso();

    if (input.unitId) {
      const existing = tx
        .prepare('SELECT * FROM medicine_units WHERE id = ? AND medicine_id = ?')
        .get(input.unitId, medicineId) as
        | { id: string; is_base: number; conversion_to_base: string; unit_name: string }
        | undefined;
      if (!existing) throw new Error('Medicine unit not found');

      if (existing.is_base && !conv.eq(1)) {
        throw new Error('Base unit conversion ratio must remain exactly 1');
      }

      const dup = tx
        .prepare('SELECT id FROM medicine_units WHERE medicine_id = ? AND LOWER(unit_name) = LOWER(?) AND id != ?')
        .get(medicineId, unitName, input.unitId);
      if (dup) throw new Error(`Unit '${unitName}' already exists for this medicine`);

      // Updating conversion ONLY affects future transactions; historical sales/purchases retain conversion_ratio_snapshot!
      tx.prepare(
        `UPDATE medicine_units
         SET unit_name = ?, conversion_to_base = ?, allow_purchase = ?, allow_sale = ?, is_active = ?, updated_at = ?
         WHERE id = ?`
      ).run(unitName, conv.toFixed(4), input.allowPurchase ? 1 : 0, input.allowSale ? 1 : 0, input.isActive ? 1 : 0, ts, input.unitId);

      recordAudit(tx, {
        userId: user.id,
        username: user.username,
        action: 'UPDATE_MEDICINE_UNIT',
        module: 'medicines',
        targetType: 'MEDICINE_UNIT',
        targetId: input.unitId,
        beforeState: existing,
        afterState: { unitName, conversionToBase: conv.toFixed(4), allowPurchase: input.allowPurchase, allowSale: input.allowSale, isActive: input.isActive },
        reason: 'Manual unit conversion update (historical snapshots preserved)',
      });
      return input.unitId;
    }

    const dup = tx
      .prepare('SELECT id FROM medicine_units WHERE medicine_id = ? AND LOWER(unit_name) = LOWER(?)')
      .get(medicineId, unitName);
    if (dup) throw new Error(`Unit '${unitName}' already exists for this medicine`);

    const newId = uuid();
    tx.prepare(
      `INSERT INTO medicine_units (
        id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(newId, medicineId, unitName, conv.toFixed(4), input.allowPurchase ? 1 : 0, input.allowSale ? 1 : 0, input.isActive ? 1 : 1, ts, ts);

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'CREATE_MEDICINE_UNIT',
      module: 'medicines',
      targetType: 'MEDICINE_UNIT',
      targetId: newId,
      afterState: { medicineId, unitName, conversionToBase: conv.toFixed(4) },
    });
    return newId;
  });
}

export function adjustStock(
  user: AuthUser,
  input: {
    batchId: string;
    adjustmentType:
      | 'STOCK_INCREASE'
      | 'STOCK_DECREASE'
      | 'DAMAGE'
      | 'MISSING_STOCK'
      | 'EXPIRY'
      | 'OPENING_CORRECTION'
      | 'RECONCILIATION';
    actualQtyBase: string;
    reason: string;
  }
) {
  if (!input.reason?.trim()) throw new Error('Mandatory reason is required for stock adjustments');
  const actual = qty(input.actualQtyBase);
  if (actual.lt(0)) throw new Error('Actual stock quantity cannot be negative');

  return withTransaction((tx) => {
    const batch = tx.prepare('SELECT * FROM batches WHERE id = ?').get(input.batchId) as
      | {
          id: string;
          medicine_id: string;
          batch_number: string;
          current_qty_base: string;
          purchase_cost_per_base: string;
          status: string;
        }
      | undefined;
    if (!batch) throw new Error('Batch not found');

    const expected = qty(batch.current_qty_base);
    const variance = qty(actual.sub(expected));
    if (variance.eq(0)) throw new Error('Actual quantity equals expected quantity; no adjustment needed');

    const ts = nowIso();
    const adjNumber = generateDocNumber(tx, 'ADJ', 'stock_adjustments', 'adjustment_number');
    const adjId = uuid();

    tx.prepare(
      `INSERT INTO stock_adjustments (
        id, adjustment_number, batch_id, medicine_id, adjustment_type,
        expected_qty_base, actual_qty_base, variance_qty_base, reason, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      adjId,
      adjNumber,
      batch.id,
      batch.medicine_id,
      input.adjustmentType,
      expected.toFixed(4),
      actual.toFixed(4),
      variance.toFixed(4),
      input.reason.trim(),
      user.id,
      ts
    );

    let movementType: string = variance.gt(0) ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
    if (input.adjustmentType === 'DAMAGE' && variance.lt(0)) movementType = 'DAMAGE_WRITEOFF';
    if (input.adjustmentType === 'EXPIRY' && variance.lt(0)) movementType = 'EXPIRY_WRITEOFF';

    tx.prepare(
      `INSERT INTO stock_movements (
        id, medicine_id, batch_id, qty_change_base, movement_type,
        reference_type, reference_id, cost_per_base_snapshot, reason, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, 'STOCK_ADJUSTMENT', ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      batch.medicine_id,
      batch.id,
      variance.toFixed(4),
      movementType,
      adjId,
      batch.purchase_cost_per_base,
      input.reason.trim(),
      user.id,
      ts
    );

    const newStatus =
      input.adjustmentType === 'EXPIRY' && actual.eq(0)
        ? 'WRITTEN_OFF'
        : input.adjustmentType === 'DAMAGE' && actual.eq(0)
        ? 'WRITTEN_OFF'
        : batch.status;

    tx.prepare('UPDATE batches SET current_qty_base = ?, status = ?, updated_at = ? WHERE id = ?').run(
      actual.toFixed(4),
      newStatus,
      ts,
      batch.id
    );

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'STOCK_ADJUSTMENT',
      module: 'inventory',
      targetType: 'BATCH',
      targetId: batch.id,
      transactionRef: adjNumber,
      beforeState: { current_qty_base: expected.toFixed(4), status: batch.status },
      afterState: { current_qty_base: actual.toFixed(4), status: newStatus, variance: variance.toFixed(4) },
      reason: input.reason.trim(),
    });

    return { adjustmentNumber: adjNumber, variance: variance.toFixed(4) };
  });
}

export function changeBatchStatus(
  user: AuthUser,
  batchId: string,
  newStatus: 'ACTIVE' | 'QUARANTINED' | 'EXPIRED' | 'WRITTEN_OFF',
  reason: string
) {
  if (!reason?.trim()) throw new Error('Reason is required to change batch status');
  return withTransaction((tx) => {
    const batch = tx.prepare('SELECT * FROM batches WHERE id = ?').get(batchId) as
      | { id: string; medicine_id: string; status: string; current_qty_base: string; purchase_cost_per_base: string; expiry_date: string }
      | undefined;
    if (!batch) throw new Error('Batch not found');
    const today = todayDate();
    if (newStatus === 'ACTIVE' && batch.expiry_date <= today) {
      throw new Error('Cannot mark an expired batch as ACTIVE');
    }

    const ts = nowIso();
    if (newStatus === 'WRITTEN_OFF' && qty(batch.current_qty_base).gt(0)) {
      const rem = qty(batch.current_qty_base);
      const neg = rem.neg().toFixed(4);
      const mvType = batch.expiry_date <= today ? 'EXPIRY_WRITEOFF' : 'DAMAGE_WRITEOFF';
      tx.prepare(
        `INSERT INTO stock_movements (
          id, medicine_id, batch_id, qty_change_base, movement_type,
          reference_type, reference_id, cost_per_base_snapshot, reason, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, 'BATCH_WRITEOFF', ?, ?, ?, ?, ?)`
      ).run(uuid(), batch.medicine_id, batch.id, neg, mvType, batch.id, batch.purchase_cost_per_base, reason.trim(), user.id, ts);
      tx.prepare('UPDATE batches SET current_qty_base = ?, status = ?, updated_at = ? WHERE id = ?').run(
        '0.0000',
        'WRITTEN_OFF',
        ts,
        batch.id
      );
    } else {
      tx.prepare('UPDATE batches SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, ts, batch.id);
    }

    recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'BATCH_STATUS_CHANGE',
      module: 'inventory',
      targetType: 'BATCH',
      targetId: batch.id,
      beforeState: { status: batch.status, qty: batch.current_qty_base },
      afterState: { status: newStatus },
      reason: reason.trim(),
    });
  });
}

export function reconcileInventoryLedger() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT b.id, b.batch_number, m.brand_name, b.current_qty_base as cached_qty,
              COALESCE((SELECT SUM(CAST(sm.qty_change_base AS REAL)) FROM stock_movements sm WHERE sm.batch_id = b.id), 0) as ledger_sum
       FROM batches b
       JOIN medicines m ON m.id = b.medicine_id`
    )
    .all() as Array<{
    id: string;
    batch_number: string;
    brand_name: string;
    cached_qty: string;
    ledger_sum: number;
  }>;

  const discrepancies = [];
  for (const r of rows) {
    const cached = d(r.cached_qty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const ledger = d(r.ledger_sum).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    if (!cached.eq(ledger)) {
      discrepancies.push({
        batchId: r.id,
        batchNumber: r.batch_number,
        medicineName: r.brand_name,
        cachedQty: cached.toFixed(4),
        ledgerSum: ledger.toFixed(4),
        diff: cached.sub(ledger).toFixed(4),
      });
    }
  }
  return {
    checkedBatches: rows.length,
    discrepancyCount: discrepancies.length,
    healthy: discrepancies.length === 0,
    discrepancies,
  };
}
