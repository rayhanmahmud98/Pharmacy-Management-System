import crypto from 'node:crypto';
import { writeSheetsToXlsxBuffer } from './services/excelService.ts';
import { nowIso, uuid, type DbExecutor } from './db.ts';

export interface AuditInput {
  userId: string | null;
  username: string;
  sessionId?: string;
  ipAddress?: string;
  action: string;
  module: string;
  targetType: string;
  targetId: string;
  transactionRef?: string;
  status?: 'SUCCESS' | 'FAILURE';
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: unknown;
  reason?: string;
}

function computeEntryHashV1(payload: {
  seq: number;
  userId: string | null;
  action: string;
  module: string;
  targetType: string;
  targetId: string;
  transactionRef: string;
  beforeState: string;
  afterState: string;
  reason: string;
  prevHash: string;
  createdAt: string;
}): string {
  const canonical = JSON.stringify(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function computeEntryHashV2(payload: {
  seq: number;
  userId: string | null;
  username: string;
  sessionId: string;
  ipAddress: string;
  action: string;
  module: string;
  targetType: string;
  targetId: string;
  transactionRef: string;
  status: string;
  beforeState: string;
  afterState: string;
  metadataJson: string;
  reason: string;
  prevHash: string;
  createdAt: string;
}): string {
  const canonical = JSON.stringify(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export async function recordAudit(tx: DbExecutor, input: AuditInput): Promise<void> {
  // Serialize audit chain appends across concurrent counters/transactions
  await tx.execute('SELECT pg_advisory_xact_lock(90421001)');

  const last = await tx.queryOne<{ seq: number; entry_hash: string }>(
    'SELECT seq, entry_hash FROM audit_logs ORDER BY seq DESC LIMIT 1'
  );

  const seq = Number(last?.seq ?? 0) + 1;
  const prevHash = last?.entry_hash ?? 'GENESIS';
  const createdAt = nowIso();
  const beforeStr = JSON.stringify(input.beforeState ?? {});
  const afterStr = JSON.stringify(input.afterState ?? {});
  const metadataStr = JSON.stringify(input.metadata ?? {});
  const txRef = input.transactionRef ?? '';
  const reason = input.reason ?? '';
  const sessionId = input.sessionId ?? '';
  const ipAddress = input.ipAddress ?? '';
  const status = input.status ?? 'SUCCESS';

  const entryHash = computeEntryHashV2({
    seq,
    userId: input.userId,
    username: input.username,
    sessionId,
    ipAddress,
    action: input.action,
    module: input.module,
    targetType: input.targetType,
    targetId: input.targetId,
    transactionRef: txRef,
    status,
    beforeState: beforeStr,
    afterState: afterStr,
    metadataJson: metadataStr,
    reason,
    prevHash,
    createdAt,
  });

  await tx.execute(
    `INSERT INTO audit_logs (
      id, seq, user_id, username, session_id, ip_address, action, module,
      target_type, target_id, transaction_ref, status, before_state, after_state,
      metadata_json, reason, prev_hash, entry_hash, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      uuid(),
      seq,
      input.userId,
      input.username,
      sessionId,
      ipAddress,
      input.action,
      input.module,
      input.targetType,
      input.targetId,
      txRef,
      status,
      beforeStr,
      afterStr,
      metadataStr,
      reason,
      prevHash,
      entryHash,
      createdAt,
    ]
  );
}

export async function verifyAuditChain(db: DbExecutor): Promise<{
  valid: boolean;
  totalEntries: number;
  brokenAtSeq: number | null;
}> {
  const rows = await db.query<{
    seq: number;
    user_id: string | null;
    username: string;
    session_id: string;
    ip_address: string;
    action: string;
    module: string;
    target_type: string;
    target_id: string;
    transaction_ref: string;
    status: string;
    before_state: string;
    after_state: string;
    metadata_json: string;
    reason: string;
    prev_hash: string;
    entry_hash: string;
    created_at: string;
  }>(
    `SELECT seq, user_id, username, session_id, ip_address, action, module, target_type, target_id,
            transaction_ref, status, before_state, after_state, metadata_json, reason,
            prev_hash, entry_hash, created_at
     FROM audit_logs ORDER BY seq ASC`
  );

  let expectedPrev = 'GENESIS';
  for (const row of rows) {
    const seqNum = Number(row.seq);
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, totalEntries: rows.length, brokenAtSeq: seqNum };
    }

    const v2Hash = computeEntryHashV2({
      seq: seqNum,
      userId: row.user_id,
      username: row.username ?? 'system',
      sessionId: row.session_id ?? '',
      ipAddress: row.ip_address ?? '',
      action: row.action,
      module: row.module,
      targetType: row.target_type,
      targetId: row.target_id,
      transactionRef: row.transaction_ref,
      status: row.status ?? 'SUCCESS',
      beforeState: row.before_state,
      afterState: row.after_state,
      metadataJson: row.metadata_json ?? '{}',
      reason: row.reason,
      prevHash: row.prev_hash,
      createdAt: row.created_at,
    });

    let matched = v2Hash === row.entry_hash;
    if (
      !matched &&
      (row.session_id ?? '') === '' &&
      (row.ip_address ?? '') === '' &&
      (row.status ?? 'SUCCESS') === 'SUCCESS' &&
      (row.metadata_json ?? '{}') === '{}'
    ) {
      const v1Hash = computeEntryHashV1({
        seq: seqNum,
        userId: row.user_id,
        action: row.action,
        module: row.module,
        targetType: row.target_type,
        targetId: row.target_id,
        transactionRef: row.transaction_ref,
        beforeState: row.before_state,
        afterState: row.after_state,
        reason: row.reason,
        prevHash: row.prev_hash,
        createdAt: row.created_at,
      });
      matched = v1Hash === row.entry_hash;
    }

    if (!matched) {
      return { valid: false, totalEntries: rows.length, brokenAtSeq: seqNum };
    }
    expectedPrev = row.entry_hash;
  }

  return { valid: true, totalEntries: rows.length, brokenAtSeq: null };
}

export interface AuditQueryFilters {
  search?: string;
  action?: string;
  module?: string;
  userId?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export async function queryAuditLogs(db: DbExecutor, filters: AuditQueryFilters = {}) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  const pushParam = (val: string | number) => {
    params.push(val);
    return `$${params.length}`;
  };

  if (filters.search?.trim()) {
    const p = pushParam(`%${filters.search.trim().toLowerCase()}%`);
    clauses.push(
      `(LOWER(username) LIKE ${p} OR LOWER(action) LIKE ${p} OR LOWER(module) LIKE ${p} OR LOWER(target_id) LIKE ${p} OR LOWER(transaction_ref) LIKE ${p} OR LOWER(reason) LIKE ${p})`
    );
  }
  if (filters.action?.trim()) {
    clauses.push(`action = ${pushParam(filters.action.trim())}`);
  }
  if (filters.module?.trim()) {
    clauses.push(`module = ${pushParam(filters.module.trim())}`);
  }
  if (filters.userId?.trim()) {
    clauses.push(`user_id = ${pushParam(filters.userId.trim())}`);
  }
  if (filters.status?.trim()) {
    clauses.push(`status = ${pushParam(filters.status.trim())}`);
  }
  if (filters.fromDate?.trim()) {
    clauses.push(`(created_at AT TIME ZONE 'UTC')::date >= ${pushParam(filters.fromDate.trim())}::date`);
  }
  if (filters.toDate?.trim()) {
    clauses.push(`(created_at AT TIME ZONE 'UTC')::date <= ${pushParam(filters.toDate.trim())}::date`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(500, Math.max(1, Number(filters.limit ?? 100)));
  const offset = Math.max(0, Number(filters.offset ?? 0));

  const totalRow = await db.queryOne<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM audit_logs ${where}`, params);

  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM audit_logs ${where} ORDER BY seq DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, limit, offset]
  );

  return {
    total: Number(totalRow?.cnt ?? 0),
    limit,
    offset,
    logs: rows,
  };
}

export async function exportAuditLogsExcelBuffer(db: DbExecutor, filters: AuditQueryFilters = {}): Promise<Buffer> {
  const { logs } = await queryAuditLogs(db, { ...filters, limit: 5000, offset: 0 });
  const formatted = logs.map((l) => ({
    Seq: l.seq,
    Timestamp_UTC: l.created_at,
    Username: l.username,
    IP_Address: l.ip_address || '',
    Session_ID: l.session_id || '',
    Module: l.module,
    Action: l.action,
    Status: l.status || 'SUCCESS',
    Target_Type: l.target_type,
    Target_ID: l.target_id,
    Transaction_Ref: l.transaction_ref || '',
    Reason: l.reason || '',
    Before_State: l.before_state,
    After_State: l.after_state,
    Entry_Hash: l.entry_hash,
  }));
  return writeSheetsToXlsxBuffer([{ name: 'Audit_Logs', rows: formatted }]);
}
