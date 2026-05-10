import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";

const EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX = "exec-approval-followup:";
const EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_NONCE_MARKER = ":nonce:";
const EXEC_APPROVAL_FOLLOWUP_RUNTIME_HANDOFF_TTL_MS = 5 * 60 * 1000;

export type ExecApprovalFollowupRuntimeHandoff = {
  kind: "exec-approval-followup";
  approvalId: string;
  sessionKey: string;
  idempotencyKey: string;
  bashElevated: ExecElevatedDefaults;
};

export type ExecApprovalFollowupRuntimeHandoffRegistration = {
  handoffId: string;
  idempotencyKey: string;
};

type ExecApprovalFollowupRuntimeHandoffEntry = ExecApprovalFollowupRuntimeHandoff & {
  expiresAtMs: number;
};

const execApprovalFollowupRuntimeHandoffs = new Map<
  string,
  ExecApprovalFollowupRuntimeHandoffEntry
>();

function cloneExecElevatedDefaults(value: ExecElevatedDefaults): ExecElevatedDefaults {
  return {
    enabled: value.enabled,
    allowed: value.allowed,
    defaultLevel: value.defaultLevel,
    ...(value.fullAccessAvailable !== undefined
      ? { fullAccessAvailable: value.fullAccessAvailable }
      : {}),
    ...(value.fullAccessBlockedReason !== undefined
      ? { fullAccessBlockedReason: value.fullAccessBlockedReason }
      : {}),
  };
}

function cloneExecApprovalFollowupRuntimeHandoff(
  value: ExecApprovalFollowupRuntimeHandoff,
): ExecApprovalFollowupRuntimeHandoff {
  return {
    kind: value.kind,
    approvalId: value.approvalId,
    sessionKey: value.sessionKey,
    idempotencyKey: value.idempotencyKey,
    bashElevated: cloneExecElevatedDefaults(value.bashElevated),
  };
}

function pruneExpiredExecApprovalFollowupRuntimeHandoffs(nowMs: number): void {
  for (const [handoffId, entry] of execApprovalFollowupRuntimeHandoffs) {
    if (entry.expiresAtMs <= nowMs) {
      execApprovalFollowupRuntimeHandoffs.delete(handoffId);
    }
  }
}

export function buildExecApprovalFollowupIdempotencyKey(params: {
  approvalId: string;
  nonce?: string;
}): string {
  const base = `${EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX}${params.approvalId}`;
  const nonce = normalizeOptionalString(params.nonce);
  return nonce ? `${base}${EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_NONCE_MARKER}${nonce}` : base;
}

export function parseExecApprovalFollowupApprovalId(idempotencyKey: string): string | undefined {
  const normalized = normalizeOptionalString(idempotencyKey);
  if (!normalized?.startsWith(EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX)) {
    return undefined;
  }
  const body = normalized.slice(EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX.length);
  const nonceMarker = body.lastIndexOf(EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_NONCE_MARKER);
  return normalizeOptionalString(nonceMarker >= 0 ? body.slice(0, nonceMarker) : body);
}

export function registerExecApprovalFollowupRuntimeHandoff(params: {
  approvalId: string;
  sessionKey: string;
  bashElevated?: ExecElevatedDefaults;
  nowMs?: number;
}): ExecApprovalFollowupRuntimeHandoffRegistration | undefined {
  const approvalId = normalizeOptionalString(params.approvalId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!approvalId || !sessionKey || !params.bashElevated) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredExecApprovalFollowupRuntimeHandoffs(nowMs);
  const handoffId = randomUUID();
  const idempotencyKey = buildExecApprovalFollowupIdempotencyKey({
    approvalId,
    nonce: randomUUID(),
  });
  execApprovalFollowupRuntimeHandoffs.set(handoffId, {
    kind: "exec-approval-followup",
    approvalId,
    sessionKey,
    idempotencyKey,
    bashElevated: cloneExecElevatedDefaults(params.bashElevated),
    expiresAtMs: nowMs + EXEC_APPROVAL_FOLLOWUP_RUNTIME_HANDOFF_TTL_MS,
  });
  return { handoffId, idempotencyKey };
}

export function consumeExecApprovalFollowupRuntimeHandoff(params: {
  handoffId?: string;
  approvalId?: string;
  idempotencyKey?: string;
  sessionKey?: string;
  nowMs?: number;
}): ExecApprovalFollowupRuntimeHandoff | undefined {
  const handoffId = normalizeOptionalString(params.handoffId);
  const approvalId = normalizeOptionalString(params.approvalId);
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  if (!handoffId || !approvalId || !idempotencyKey) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredExecApprovalFollowupRuntimeHandoffs(nowMs);
  const entry = execApprovalFollowupRuntimeHandoffs.get(handoffId);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAtMs <= nowMs) {
    execApprovalFollowupRuntimeHandoffs.delete(handoffId);
    return undefined;
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (
    entry.approvalId !== approvalId ||
    entry.idempotencyKey !== idempotencyKey ||
    entry.sessionKey !== sessionKey
  ) {
    return undefined;
  }
  execApprovalFollowupRuntimeHandoffs.delete(handoffId);
  return cloneExecApprovalFollowupRuntimeHandoff(entry);
}

export function resetExecApprovalFollowupRuntimeHandoffsForTests(): void {
  execApprovalFollowupRuntimeHandoffs.clear();
}
