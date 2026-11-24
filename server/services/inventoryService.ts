import Decimal from 'decimal.js';
import {
  generateDocNumber,
  generateSequentialCode,
  getDb,
  nowIso,
  todayDate,
  uuid,
  withTransaction,
  type DbExecutor,
} from '../db.ts';
import { recordAudit } from '../audit.ts';
import type { AuthUser } from '../auth.ts';
import { d, qty, ratio, roundQty, validateQuantityInput } from '../../src/shared/decimalMath.ts';

export async function listMedicines(search = '', includeInactive = false) {
  const db = await getDb();
  const term = `%${search.trim().toLowerCase()}%`;
  const activeClause = includeInactive ? '' : 'AND m.is_active = TRUE';
  const today = todayDate();

  const meds = await db.query<Record<string, unknown>>(
    `SELECT m.*, c.name AS category_name, mf.name AS manufacturer_name
     FROM medicines m
     LEFT JOIN categories c ON c.id = m.category_id
     LEFT JOIN manufacturers mf ON mf.id = m.manufacturer_id
     WHERE (
       LOWER(m.brand_name) LIKE $1 OR
       LOWER(m.generic_name) LIKE $1 OR
       LOWER(m.medicine_code) LIKE $1 OR
       LOWER(m.barcode) LIKE $1 OR
       LOWER(m.alternative_names) LIKE $1 OR
       LOWER(m.strength) LIKE $1 OR
       LOWER(m.storage_info) LIKE $1 OR
       LOWER(COALESCE(c.name, '')) LIKE $1 OR
       LOWER(COALESCE(mf.name, '')) LIKE $1
     ) ${activeClause}
     ORDER BY m.brand_name ASC`,
    [term]
  );

  if (meds.length === 0) return [];

  const medIds = meds.map((m) => String(m.id));
  const [allUnits, allBatches] = await Promise.all([
    db.query<Record<string, unknown>>('SELECT * FROM medicine_units WHERE medicine_id = ANY($1::text[])', [medIds]),
    db.query<Record<string, unknown>>(
      `SELECT b.*, s.name AS supplier_name
       FROM batches b
       LEFT JOIN suppliers s ON s.id = b.supplier_id
       WHERE b.medicine_id = ANY($1::text[])
       ORDER BY b.expiry_date ASC`,
      [medIds]
    ),
  ]);

  const unitsByMed = new Map<string, Array<Record<string, unknown>>>();
  for (const u of allUnits) {
    const k = String(u.medicine_id);
    const list = unitsByMed.get(k) || [];
    list.push(u);
    unitsByMed.set(k, list);
  }

  const batchesByMed = new Map<string, Array<Record<string, unknown>>>();
  for (const b of allBatches) {
    const k = String(b.medicine_id);
    const list = batchesByMed.get(k) || [];
    list.push(b);
    batchesByMed.set(k, list);
  }

  return meds.map((m) => {
    const medId = String(m.id);
    const units = (unitsByMed.get(medId) || []).sort((a, b) =>
      d(String(a.conversion_to_base)).cmp(d(String(b.conversion_to_base)))
    );
    const medBatches = batchesByMed.get(medId) || [];

    let sellableStock = new Decimal(0);
    let totalPhysical = new Decimal(0);
    const positiveBatches: Array<Record<string, unknown>> = [];

    for (const b of medBatches) {
      const curQty = qty(String(b.current_qty_base));
      if (curQty.gt(0)) {
        positiveBatches.push(b);
        const st = String(b.status);
        if (st === 'ACTIVE' && String(b.expiry_date) > today) {
          sellableStock = sellableStock.add(curQty);
        }
        if (st === 'ACTIVE' || st === 'QUARANTINED') {
          totalPhysical = totalPhysical.add(curQty);
        }
      }
    }

    return {
      ...m,
      sellable_stock_base: roundQty(sellableStock).toNumber(),
      sellable_stock_base_str: roundQty(sellableStock).toFixed(6),
      total_physical_base: roundQty(totalPhysical).toNumber(),
      total_physical_base_str: roundQty(totalPhysical).toFixed(6),
      units,
      batches: positiveBatches,
    };
  });
}

export async function createMedicine(
  user: AuthUser,
  input: {
    medicineCode?: string;
    barcode?: string;
    brandName: string;
    genericName: string;
    alternativeNames?: string;
    strength?: string;
    dosageForm?: string;
    categoryId?: string | null;
    manufacturerId?: string | null;
    storageInfo?: string;
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
  },
  existingTx?: DbExecutor
) {
  if (!input.brandName?.trim() || !input.genericName?.trim() || !input.baseUnitName?.trim()) {
    throw new Error('Brand name, generic name, and base stock unit are required');
  }

  const minStock = validateQuantityInput(input.minStockLevel ?? '0', 'Minimum stock level', { allowZero: true });

  return withTransaction(async (tx) => {
    const id = uuid();
    const ts = nowIso();
    const baseUnit = input.baseUnitName.trim();

    let medCode = (input.medicineCode || '').trim();
    if (!medCode) {
      medCode = await generateSequentialCode(tx, 'CODE-MED', 'MED', 4, 'medicines', 'medicine_code');
    }
    const barcode = (input.barcode || '').trim();
    if (barcode) {
      const dupBarcode = await tx.queryOne<{ id: string }>(
        "SELECT id FROM medicines WHERE LOWER(barcode) = LOWER($1) AND barcode != ''",
        [barcode]
      );
      if (dupBarcode) throw new Error(`Barcode '${barcode}' is already assigned to another medicine`);
    }

    await tx.execute(
      `INSERT INTO medicines (
        id, medicine_code, barcode, brand_name, generic_name, bangla_name, alternative_names, strength, dosage_form,
        category_id, manufacturer_id, storage_info, description, base_unit_name, min_stock_level, rx_required,
        is_active, notes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, $16, $17, $18)`,
      [
        id,
        medCode,
        barcode,
        input.brandName.trim(),
        input.genericName.trim(),
        (input.alternativeNames || '').trim(),
        (input.strength || '').trim(),
        (input.dosageForm || '').trim(),
        input.categoryId || null,
        input.manufacturerId || null,
        (input.storageInfo || '').trim(),
        (input.description || '').trim(),
        baseUnit,
        minStock.toFixed(6),
        Boolean(input.rxRequired),
        (input.notes || '').trim(),
        ts,
        ts,
      ]
    );

    await tx.execute(
      `INSERT INTO medicine_units (
        id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, '1.000000', TRUE, TRUE, TRUE, TRUE, $4, $5)`,
      [uuid(), id, baseUnit, ts, ts]
    );

    const seen = new Set([baseUnit.toLowerCase()]);
    for (const u of input.units || []) {
      const name = u.unitName?.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      const conv = ratio(u.conversionToBase, `Conversion ratio for ${name}`);
      seen.add(name.toLowerCase());
      await tx.execute(
        `INSERT INTO medicine_units (
          id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, FALSE, $5, $6, TRUE, $7, $8)`,
        [uuid(), id, name, conv.toFixed(6), u.allowPurchase !== false, u.allowSale !== false, ts, ts]
      );
    }

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'CREATE_MEDICINE',
      module: 'medicines',
      targetType: 'MEDICINE',
      targetId: id,
      afterState: { medicineCode: medCode, barcode, brandName: input.brandName.trim(), baseUnit },
    });

    return id;
  }, existingTx);
}

export async function updateMedicine(
  user: AuthUser,
  medicineId: string,
  input: {
    medicineCode?: string;
    barcode?: string;
    brandName: string;
    genericName: string;
    alternativeNames?: string;
    strength?: string;
    dosageForm?: string;
    categoryId?: string | null;
    manufacturerId?: string | null;
    storageInfo?: string;
    description?: string;
    minStockLevel?: string;
    rxRequired?: boolean;
    isActive?: boolean;
    notes?: string;
  },
  existingTx?: DbExecutor
) {
  if (!input.brandName?.trim() || !input.genericName?.trim()) {
    throw new Error('Brand name and generic name are required');
  }
  const minStock = validateQuantityInput(input.minStockLevel ?? '0', 'Minimum stock level', { allowZero: true });

  return withTransaction(async (tx) => {
    const before = await tx.queryOne<Record<string, unknown>>('SELECT * FROM medicines WHERE id = $1 FOR UPDATE', [
      medicineId,
    ]);
    if (!before) throw new Error('Medicine not found');
    const ts = nowIso();
    const barcode = (input.barcode ?? String(before.barcode || '')).trim();
    if (barcode) {
      const dupBarcode = await tx.queryOne<{ id: string }>(
        "SELECT id FROM medicines WHERE LOWER(barcode) = LOWER($1) AND barcode != '' AND id != $2",
        [barcode, medicineId]
      );
      if (dupBarcode) throw new Error(`Barcode '${barcode}' is already assigned to another medicine`);
    }

    await tx.execute(
      `UPDATE medicines SET
        medicine_code = $1, barcode = $2, brand_name = $3, generic_name = $4, alternative_names = $5,
        strength = $6, dosage_form = $7, category_id = $8, manufacturer_id = $9,
        storage_info = $10, description = $11, min_stock_level = $12, rx_required = $13, is_active = $14,
        notes = $15, updated_at = $16
       WHERE id = $17`,
      [
        (input.medicineCode ?? String(before.medicine_code || '')).trim(),
        barcode,
        input.brandName.trim(),
        input.genericName.trim(),
        (input.alternativeNames || '').trim(),
        (input.strength || '').trim(),
        (input.dosageForm || '').trim(),
        input.categoryId || null,
        input.manufacturerId || null,
        (input.storageInfo || '').trim(),
        (input.description || '').trim(),
        minStock.toFixed(6),
        Boolean(input.rxRequired),
        input.isActive !== false,
        (input.notes || '').trim(),
        ts,
        medicineId,
      ]
    );

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'UPDATE_MEDICINE',
      module: 'medicines',
      targetType: 'MEDICINE',
      targetId: medicineId,
      beforeState: before,
      afterState: input,
    });
  }, existingTx);
}

export async function upsertMedicineUnit(
  user: AuthUser,
  medicineId: string,
  input: {
    unitId?: string;
    unitName: string;
    conversionToBase: string;
    allowPurchase: boolean;
    allowSale: boolean;
    isActive: boolean;
  },
  existingTx?: DbExecutor
) {
  const unitName = input.unitName?.trim();
  if (!unitName) throw new Error('Unit name is required');
  const conv = ratio(input.conversionToBase, 'Conversion ratio');

  return withTransaction(async (tx) => {
    const med = await tx.queryOne<{ id: string; brand_name: string }>(
      'SELECT id, brand_name FROM medicines WHERE id = $1 FOR UPDATE',
      [medicineId]
    );
    if (!med) throw new Error('Medicine not found');
    const ts = nowIso();

    if (input.unitId) {
      const existing = await tx.queryOne<{
        id: string;
        is_base: boolean;
        conversion_to_base: string;
        unit_name: string;
      }>('SELECT id, is_base, conversion_to_base, unit_name FROM medicine_units WHERE id = $1 AND medicine_id = $2 FOR UPDATE', [
        input.unitId,
        medicineId,
      ]);
      if (!existing) throw new Error('Medicine unit not found');

      if (existing.is_base && !conv.eq(1)) {
        throw new Error('Base unit conversion ratio must remain exactly 1');
      }

      const dup = await tx.queryOne<{ id: string }>(
        'SELECT id FROM medicine_units WHERE medicine_id = $1 AND LOWER(unit_name) = LOWER($2) AND id != $3',
        [medicineId, unitName, input.unitId]
      );
      if (dup) throw new Error(`Unit '${unitName}' already exists for this medicine`);

      await tx.execute(
        `UPDATE medicine_units
         SET unit_name = $1, conversion_to_base = $2, allow_purchase = $3, allow_sale = $4, is_active = $5, updated_at = $6
         WHERE id = $7`,
        [unitName, conv.toFixed(6), Boolean(input.allowPurchase), Boolean(input.allowSale), Boolean(input.isActive), ts, input.unitId]
      );

      await recordAudit(tx, {
        userId: user.id,
        username: user.username,
        action: 'UPDATE_MEDICINE_UNIT',
        module: 'medicines',
        targetType: 'MEDICINE_UNIT',
        targetId: input.unitId,
        beforeState: existing,
        afterState: {
          unitName,
          conversionToBase: conv.toFixed(6),
          allowPurchase: input.allowPurchase,
          allowSale: input.allowSale,
          isActive: input.isActive,
        },
        reason: 'Manual unit conversion update (historical snapshots preserved)',
      });
      return input.unitId;
    }

    const dup = await tx.queryOne<{ id: string }>(
      'SELECT id FROM medicine_units WHERE medicine_id = $1 AND LOWER(unit_name) = LOWER($2)',
      [medicineId, unitName]
    );
    if (dup) throw new Error(`Unit '${unitName}' already exists for this medicine`);

    const newId = uuid();
    await tx.execute(
      `INSERT INTO medicine_units (
        id, medicine_id, unit_name, conversion_to_base, is_base, allow_purchase, allow_sale, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, FALSE, $5, $6, TRUE, $7, $8)`,
      [newId, medicineId, unitName, conv.toFixed(6), Boolean(input.allowPurchase), Boolean(input.allowSale), ts, ts]
    );

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'CREATE_MEDICINE_UNIT',
      module: 'medicines',
      targetType: 'MEDICINE_UNIT',
      targetId: newId,
      afterState: { medicineId, unitName, conversionToBase: conv.toFixed(6) },
    });
    return newId;
  }, existingTx);
}

export async function adjustStock(
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
  },
  existingTx?: DbExecutor
) {
  if (!input.reason?.trim()) throw new Error('Mandatory reason is required for stock adjustments');
  const actual = validateQuantityInput(input.actualQtyBase, 'Actual quantity', { allowZero: true });

  return withTransaction(async (tx) => {
    const batch = await tx.queryOne<{
      id: string;
      medicine_id: string;
      batch_number: string;
      current_qty_base: string;
      purchase_cost_per_base: string;
      status: string;
    }>('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [input.batchId]);
    if (!batch) throw new Error('Batch not found');

    const expected = qty(batch.current_qty_base);
    const variance = roundQty(actual.sub(expected));
    if (variance.eq(0)) throw new Error('Actual quantity equals expected quantity; no adjustment needed');

    const ts = nowIso();
    const adjNumber = await generateDocNumber(tx, 'ADJ', 'stock_adjustments', 'adjustment_number');
    const adjId = uuid();

    await tx.execute(
      `INSERT INTO stock_adjustments (
        id, adjustment_number, batch_id, medicine_id, adjustment_type,
        expected_qty_base, actual_qty_base, variance_qty_base, reason, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        adjId,
        adjNumber,
        batch.id,
        batch.medicine_id,
        input.adjustmentType,
        expected.toFixed(6),
        actual.toFixed(6),
        variance.toFixed(6),
        input.reason.trim(),
        user.id,
        ts,
      ]
    );

    let movementType: string = variance.gt(0) ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
    if (input.adjustmentType === 'DAMAGE' && variance.lt(0)) movementType = 'DAMAGE_WRITEOFF';
    if (input.adjustmentType === 'EXPIRY' && variance.lt(0)) movementType = 'EXPIRY_WRITEOFF';

    await tx.execute(
      `INSERT INTO stock_movements (
        id, medicine_id, batch_id, qty_change_base, movement_type,
        reference_type, reference_id, cost_per_base_snapshot, reason, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'STOCK_ADJUSTMENT', $6, $7, $8, $9, $10)`,
      [
        uuid(),
        batch.medicine_id,
        batch.id,
        variance.toFixed(6),
        movementType,
        adjId,
        batch.purchase_cost_per_base,
        input.reason.trim(),
        user.id,
        ts,
      ]
    );

    const newStatus =
      (input.adjustmentType === 'EXPIRY' || input.adjustmentType === 'DAMAGE') && actual.eq(0)
        ? 'WRITTEN_OFF'
        : batch.status;

    await tx.execute('UPDATE batches SET current_qty_base = $1, status = $2, updated_at = $3 WHERE id = $4', [
      actual.toFixed(6),
      newStatus,
      ts,
      batch.id,
    ]);

    await recordAudit(tx, {
      userId: user.id,
      username: user.username,
      action: 'STOCK_ADJUSTMENT',
      module: 'inventory',
      targetType: 'BATCH',
      targetId: batch.id,
      transactionRef: adjNumber,
      beforeState: { current_qty_base: expected.toFixed(6), status: batch.status },
      afterState: { current_qty_base: actual.toFixed(6), status: newStatus, variance: variance.toFixed(6) },
      reason: input.reason.trim(),
    });

    return { adjustmentNumber: adjNumber, variance: variance.toFixed(6) };
  }, existingTx);
}

export async function changeBatchStatus(
  user: AuthUser,
  batchId: string,
  newStatus: 'ACTIVE' | 'QUARANTINED' | 'EXPIRED' | 'WRITTEN_OFF' | 'DAMAGED',
  reason: string,
  existingTx?: DbExecutor
) {
  if (!reason?.trim()) throw new Error('Reason is required to change batch status');
  return withTransaction(async (tx) => {
    const batch = await tx.queryOne<{
      id: string;
      medicine_id: string;
      status: string;
      current_qty_base: string;
      purchase_cost_per_base: string;
      expiry_date: string;
    }>('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [batchId]);
    if (!batch) throw new Error('Batch not found');
    const today = todayDate();
    if (newStatus === 'ACTIVE' && batch.expiry_date <= today) {
      throw new Error('Cannot mark an expired batch as ACTIVE');
    }

    const ts = nowIso();
    if ((newStatus === 'WRITTEN_OFF' || newStatus === 'DAMAGED') && qty(batch.current_qty_base).gt(0)) {
      const rem = qty(batch.current_qty_base);
      const neg = rem.neg().toFixed(6);
      const mvType = batch.expiry_date <= today ? 'EXPIRY_WRITEOFF' : 'DAMAGE_WRITEOFF';
      await tx.execute(
        `INSERT INTO stock_movements (
          id, medicine_id, batch_id, qty_change_base, movement_type,
          reference_type, reference_id, cost_per_base_snapshot, reason, created_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'BATCH_WRITEOFF', $6, $7, $8, $9, $10)`,
        [uuid(), batch.medicine_id, batch.id, neg, mvType, batch.id, batch.purchase_cost_per_base, reason.trim(), user.id, ts]
      );
      await tx.execute("UPDATE batches SET current_qty_base = '0.000000', status = $1, updated_at = $2 WHERE id = $3", [
        newStatus,
        ts,
        batch.id,
      ]);
    } else {
      await tx.execute('UPDATE batches SET status = $1, updated_at = $2 WHERE id = $3', [newStatus, ts, batch.id]);
    }

    await recordAudit(tx, {
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
  }, existingTx);
}

export async function reconcileInventoryLedger(tx?: DbExecutor) {
  const db = tx || (await getDb());
  const batches = await db.query<{
    id: string;
    batch_number: string;
    brand_name: string;
    cached_qty: string;
  }>(
    `SELECT b.id, b.batch_number, m.brand_name, b.current_qty_base AS cached_qty
     FROM batches b
     JOIN medicines m ON m.id = b.medicine_id`
  );
  const movementSums = await db.query<{ batch_id: string; ledger_sum: string }>(
    `SELECT batch_id, COALESCE(SUM(qty_change_base), 0)::text AS ledger_sum
     FROM stock_movements
     GROUP BY batch_id`
  );

  const ledgerMap = new Map<string, Decimal>();
  for (const row of movementSums) {
    ledgerMap.set(row.batch_id, roundQty(d(row.ledger_sum)));
  }

  const discrepancies = [];
  for (const r of batches) {
    const cached = roundQty(d(r.cached_qty));
    const ledger = roundQty(ledgerMap.get(r.id) || new Decimal(0));
    if (!cached.eq(ledger)) {
      discrepancies.push({
        batchId: r.id,
        batchNumber: r.batch_number,
        medicineName: r.brand_name,
        cachedQty: cached.toFixed(6),
        ledgerSum: ledger.toFixed(6),
        diff: roundQty(cached.sub(ledger)).toFixed(6),
      });
    }
  }
  return {
    checkedBatches: batches.length,
    discrepancyCount: discrepancies.length,
    healthy: discrepancies.length === 0,
    discrepancies,
  };
}
