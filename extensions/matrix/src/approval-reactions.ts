// Matrix plugin module implements approval reactions behavior.
import { createApprovalReactionTargetStore } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";
import { normalizeAccountId, normalizeOptionalAccountId } from "openclaw/plugin-sdk/routing";
import { getOptionalMatrixRuntime } from "./runtime.js";

// Matrix keeps its own reaction emoji set (checkmark/cross render reliably across
// Matrix clients), so decision resolution stays local instead of using the SDK bindings.
const MATRIX_APPROVAL_REACTION_META = {
  "allow-once": {
    emoji: "✅",
    label: "Allow once",
  },
  "allow-always": {
    emoji: "♾️",
    label: "Allow always",
  },
  deny: {
    emoji: "❌",
    label: "Deny",
  },
} satisfies Record<ExecApprovalReplyDecision, { emoji: string; label: string }>;

const MATRIX_APPROVAL_REACTION_ORDER = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalReplyDecision[];

const PERSISTENT_NAMESPACE = "matrix.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

type MatrixApprovalReactionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

type MatrixApprovalReactionResolution = {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  decision: ExecApprovalReplyDecision;
};

type MatrixApprovalReactionTarget = {
  accountId: string;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  roomId: string;
  eventId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};

type PersistedMatrixApprovalReactionTarget = {
  version: 1;
  target: MatrixApprovalReactionTarget;
};

type IndexedMatrixApprovalReactionTarget = {
  target: MatrixApprovalReactionTarget;
  expiresAtMs: number;
};

type MatrixApprovalReactionTargetRef = {
  accountId: string;
  roomId: string;
  eventId: string;
};

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalMatrixRuntime()
      ?.logging.getChildLogger({ plugin: "matrix", feature: "approval-reaction-state" })
      .warn("Matrix persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Matrix reactions.
  }
}

function readPersistedTarget(target: unknown): MatrixApprovalReactionTarget | null {
  const value = target as Partial<MatrixApprovalReactionTarget> | null | undefined;
  const accountId =
    typeof value?.accountId === "string" ? normalizeOptionalAccountId(value.accountId) : undefined;
  const approvalId = typeof value?.approvalId === "string" ? value.approvalId.trim() : "";
  const roomId = typeof value?.roomId === "string" ? value.roomId.trim() : "";
  const eventId = typeof value?.eventId === "string" ? value.eventId.trim() : "";
  if (
    !value ||
    !accountId ||
    !approvalId ||
    !Array.isArray(value.allowedDecisions) ||
    !roomId ||
    !eventId ||
    (value.approvalKind !== "exec" && value.approvalKind !== "plugin")
  ) {
    return null;
  }
  return {
    accountId,
    approvalId,
    approvalKind: value.approvalKind,
    roomId,
    eventId,
    allowedDecisions: value.allowedDecisions,
  };
}

function openPersistentMatrixApprovalReactionStore() {
  return getOptionalMatrixRuntime()?.state.openKeyedStore<PersistedMatrixApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
  });
}

const matrixApprovalReactionTargets =
  createApprovalReactionTargetStore<MatrixApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: openPersistentMatrixApprovalReactionStore,
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

const matrixApprovalReactionTargetIndex = new Map<string, IndexedMatrixApprovalReactionTarget>();

function pruneMatrixApprovalReactionTargetIndex(): void {
  const nowMs = Date.now();
  for (const [key, entry] of matrixApprovalReactionTargetIndex) {
    if (entry.expiresAtMs <= nowMs) {
      matrixApprovalReactionTargetIndex.delete(key);
    }
  }
  while (matrixApprovalReactionTargetIndex.size > PERSISTENT_MAX_ENTRIES) {
    const oldestKey = matrixApprovalReactionTargetIndex.keys().next().value;
    if (!oldestKey) {
      return;
    }
    matrixApprovalReactionTargetIndex.delete(oldestKey);
  }
}

function buildReactionTargetKey(accountId: string, roomId: string, eventId: string): string | null {
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedRoomId = roomId.trim();
  const normalizedEventId = eventId.trim();
  if (!normalizedAccountId || !normalizedRoomId || !normalizedEventId) {
    return null;
  }
  return JSON.stringify([normalizedAccountId, normalizedRoomId, normalizedEventId]);
}

export function listMatrixApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): MatrixApprovalReactionBinding[] {
  const allowed = new Set(allowedDecisions);
  return MATRIX_APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision)).map(
    (decision) => ({
      decision,
      emoji: MATRIX_APPROVAL_REACTION_META[decision].emoji,
      label: MATRIX_APPROVAL_REACTION_META[decision].label,
    }),
  );
}

export function buildMatrixApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  const bindings = listMatrixApprovalReactionBindings(allowedDecisions);
  if (bindings.length === 0) {
    return null;
  }
  return `React here: ${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join(", ")}`;
}

function resolveMatrixApprovalReactionDecision(
  reactionKey: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalReplyDecision | null {
  const normalizedReaction = reactionKey.trim();
  if (!normalizedReaction) {
    return null;
  }
  const allowed = new Set(allowedDecisions);
  for (const decision of MATRIX_APPROVAL_REACTION_ORDER) {
    if (!allowed.has(decision)) {
      continue;
    }
    if (MATRIX_APPROVAL_REACTION_META[decision].emoji === normalizedReaction) {
      return decision;
    }
  }
  return null;
}

export function registerMatrixApprovalReactionTarget(params: {
  accountId: string;
  roomId: string;
  eventId: string;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): void {
  const accountId = normalizeAccountId(params.accountId);
  const key = buildReactionTargetKey(accountId, params.roomId, params.eventId);
  const approvalId = params.approvalId.trim();
  const allowedDecisions = Array.from(
    new Set(
      params.allowedDecisions.filter(
        (decision): decision is ExecApprovalReplyDecision =>
          decision === "allow-once" || decision === "allow-always" || decision === "deny",
      ),
    ),
  );
  if (
    !key ||
    !approvalId ||
    (params.approvalKind !== "exec" && params.approvalKind !== "plugin") ||
    allowedDecisions.length === 0
  ) {
    return;
  }
  const ttlMs = Math.max(1, params.ttlMs ?? DEFAULT_REACTION_TARGET_TTL_MS);
  const target = {
    accountId,
    approvalId,
    approvalKind: params.approvalKind,
    roomId: params.roomId.trim(),
    eventId: params.eventId.trim(),
    allowedDecisions,
  };
  matrixApprovalReactionTargetIndex.delete(key);
  matrixApprovalReactionTargetIndex.set(key, {
    target,
    expiresAtMs: Date.now() + ttlMs,
  });
  pruneMatrixApprovalReactionTargetIndex();
  matrixApprovalReactionTargets.register(key, target, { ttlMs });
}

export function unregisterMatrixApprovalReactionTarget(params: {
  accountId: string;
  roomId: string;
  eventId: string;
}): void {
  const key = buildReactionTargetKey(params.accountId, params.roomId, params.eventId);
  if (!key) {
    return;
  }
  matrixApprovalReactionTargetIndex.delete(key);
  matrixApprovalReactionTargets.delete(key);
}

/** Retires every Matrix reaction anchor bound to one canonical approval. */
export async function unregisterMatrixApprovalReactionTargetsForApproval(params: {
  accountId: string;
  approvalId: string;
  approvalKind: "exec" | "plugin";
}): Promise<MatrixApprovalReactionTargetRef[]> {
  const accountId = normalizeAccountId(params.accountId);
  const approvalId = params.approvalId.trim();
  if (!approvalId) {
    return [];
  }
  pruneMatrixApprovalReactionTargetIndex();
  const matches = new Map<string, MatrixApprovalReactionTarget>();
  for (const [key, entry] of matrixApprovalReactionTargetIndex) {
    if (
      entry.target.approvalId === approvalId &&
      entry.target.accountId === accountId &&
      entry.target.approvalKind === params.approvalKind
    ) {
      matches.set(key, entry.target);
    }
  }

  let persistentStore: ReturnType<typeof openPersistentMatrixApprovalReactionStore> = undefined;
  try {
    persistentStore = openPersistentMatrixApprovalReactionStore();
    for (const entry of (await persistentStore?.entries()) ?? []) {
      if (entry.value.version !== 1) {
        continue;
      }
      const target = readPersistedTarget(entry.value.target);
      if (
        target?.approvalId === approvalId &&
        target.accountId === accountId &&
        target.approvalKind === params.approvalKind &&
        buildReactionTargetKey(target.accountId, target.roomId, target.eventId) === entry.key
      ) {
        matches.set(entry.key, target);
      }
    }
  } catch (error) {
    reportPersistentApprovalReactionError(error);
  }

  const persistentDeletes: Promise<boolean>[] = [];
  for (const [key] of matches) {
    matrixApprovalReactionTargetIndex.delete(key);
    matrixApprovalReactionTargets.delete(key);
    if (persistentStore) {
      persistentDeletes.push(persistentStore.delete(key));
    }
  }
  await Promise.allSettled(persistentDeletes);
  return Array.from(matches.values(), ({ accountId: ownerAccountId, roomId, eventId }) => ({
    accountId: ownerAccountId,
    roomId,
    eventId,
  }));
}

function resolveTarget(params: {
  target: MatrixApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): MatrixApprovalReactionResolution | null {
  const target = params.target;
  if (!target) {
    return null;
  }
  const decision = resolveMatrixApprovalReactionDecision(
    params.reactionKey,
    target.allowedDecisions,
  );
  if (!decision) {
    return null;
  }
  return {
    approvalId: target.approvalId,
    approvalKind: target.approvalKind,
    decision,
  };
}

export async function resolveMatrixApprovalReactionTargetWithPersistence(params: {
  accountId: string;
  roomId: string;
  eventId: string;
  reactionKey: string;
}): Promise<MatrixApprovalReactionResolution | null> {
  const accountId = normalizeAccountId(params.accountId);
  const key = buildReactionTargetKey(accountId, params.roomId, params.eventId);
  if (!key) {
    return null;
  }
  const target = await matrixApprovalReactionTargets.lookup(key);
  if (
    target &&
    (target.accountId !== accountId ||
      buildReactionTargetKey(target.accountId, target.roomId, target.eventId) !== key)
  ) {
    return null;
  }
  if (target) {
    matrixApprovalReactionTargetIndex.delete(key);
    matrixApprovalReactionTargetIndex.set(key, {
      target,
      expiresAtMs: Date.now() + DEFAULT_REACTION_TARGET_TTL_MS,
    });
    pruneMatrixApprovalReactionTargetIndex();
  }
  return resolveTarget({
    target,
    reactionKey: params.reactionKey,
  });
}
