import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso, uuid } from './db.ts';

export interface AuditInput {
  userId: string | null;
  username: string;
  action: string;
  module: string;
  targetType: string;
  targetId: string;
  transactionRef?: string;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string;
}

function computeEntryHash(payload: {
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

export function recordAudit(db: DatabaseSync, input: AuditInput): void {
  const last = db
    .prepare('SELECT seq, entry_hash FROM audit_logs ORDER BY seq DESC LIMIT 1')
    .get() as { seq: number; entry_hash: string } | undefined;

  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.entry_hash ?? 'GENESIS';
  const createdAt = nowIso();
  const beforeStr = JSON.stringify(input.beforeState ?? {});
  const afterStr = JSON.stringify(input.afterState ?? {});
  const txRef = input.transactionRef ?? '';
  const reason = input.reason ?? '';

  const entryHash = computeEntryHash({
    seq,
    userId: input.userId,
    action: input.action,
    module: input.module,
    targetType: input.targetType,
    targetId: input.targetId,
    transactionRef: txRef,
    beforeState: beforeStr,
    afterState: afterStr,
    reason,
    prevHash,
    createdAt,
  });

  db.prepare(
    `INSERT INTO audit_logs (
      id, seq, user_id, username, action, module, target_type, target_id,
      transaction_ref, before_state, after_state, reason, prev_hash, entry_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    seq,
    input.userId,
    input.username,
    input.action,
    input.module,
    input.targetType,
    input.targetId,
    txRef,
    beforeStr,
    afterStr,
    reason,
    prevHash,
    entryHash,
    createdAt
  );
}

export function verifyAuditChain(db: DatabaseSync): {
  valid: boolean;
  totalEntries: number;
  brokenAtSeq: number | null;
} {
  const rows = db
    .prepare(
      `SELECT seq, user_id, action, module, target_type, target_id, transaction_ref,
              before_state, after_state, reason, prev_hash, entry_hash, created_at
       FROM audit_logs ORDER BY seq ASC`
    )
    .all() as Array<{
    seq: number;
    user_id: string | null;
    action: string;
    module: string;
    target_type: string;
    target_id: string;
    transaction_ref: string;
    before_state: string;
    after_state: string;
    reason: string;
    prev_hash: string;
    entry_hash: string;
    created_at: string;
  }>;

  let expectedPrev = 'GENESIS';
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, totalEntries: rows.length, brokenAtSeq: row.seq };
    }
    const recomputed = computeEntryHash({
      seq: row.seq,
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
    if (recomputed !== row.entry_hash) {
      return { valid: false, totalEntries: rows.length, brokenAtSeq: row.seq };
    }
    expectedPrev = row.entry_hash;
  }

  return { valid: true, totalEntries: rows.length, brokenAtSeq: null };
}
