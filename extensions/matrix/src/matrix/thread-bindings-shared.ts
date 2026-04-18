import type {
  BindingTargetKind,
  SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { resolveThreadBindingLifecycle } from "openclaw/plugin-sdk/thread-bindings-session-runtime";

export type MatrixThreadBindingTargetKind = "subagent" | "acp";

export type MatrixThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetKind: MatrixThreadBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

export type MatrixThreadBindingManager = {
  accountId: string;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
  }) => MatrixThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => MatrixThreadBindingRecord[];
  listBindings: () => MatrixThreadBindingRecord[];
  touchBinding: (bindingId: string, at?: number) => MatrixThreadBindingRecord | null;
  setIdleTimeoutBySessionKey: (params: {
    targetSessionKey: string;
    idleTimeoutMs: number;
  }) => MatrixThreadBindingRecord[];
  setMaxAgeBySessionKey: (params: {
    targetSessionKey: string;
    maxAgeMs: number;
  }) => MatrixThreadBindingRecord[];
  persist: () => Promise<void>;
  stop: () => void;
};

export type MatrixThreadBindingManagerCacheEntry = {
  filePath: string;
  manager: MatrixThreadBindingManager;
};

const MANAGERS_BY_ACCOUNT_ID = new Map<string, MatrixThreadBindingManagerCacheEntry>();
const BINDINGS_BY_ACCOUNT_CONVERSATION = new Map<string, MatrixThreadBindingRecord>();

export function resolveBindingKey(params: {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string {
  return `${params.accountId}:${params.parentConversationId?.trim() || "-"}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: MatrixThreadBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

export function toMatrixBindingTargetKind(raw: BindingTargetKind): MatrixThreadBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

export function resolveEffectiveBindingExpiry(params: {
  record: MatrixThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): {
  expiresAt?: number;
  reason?: "idle-expired" | "max-age-expired";
} {
  return resolveThreadBindingLifecycle(params);
}

export function toSessionBindingRecord(
  record: MatrixThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const lifecycle = resolveEffectiveBindingExpiry({
    record,
    defaultIdleTimeoutMs: defaults.idleTimeoutMs,
    defaultMaxAgeMs: defaults.maxAgeMs,
  });
  const idleTimeoutMs =
    typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
  const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
  return {
    bindingId: resolveBindingKey(record),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "matrix",
      accountId: record.accountId,
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: lifecycle.expiresAt,
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs,
      maxAgeMs,
    },
  };
}

export function setBindingRecord(record: MatrixThreadBindingRecord): void {
  BINDINGS_BY_ACCOUNT_CONVERSATION.set(resolveBindingKey(record), record);
}

export function removeBindingRecord(
  record: MatrixThreadBindingRecord,
): MatrixThreadBindingRecord | null {
  const key = resolveBindingKey(record);
  const removed = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key) ?? null;
  if (removed) {
    BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
  }
  return removed;
}

export function listBindingsForAccount(accountId: string): MatrixThreadBindingRecord[] {
  return [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter(
    (entry) => entry.accountId === accountId,
  );
}

export function listAllBindings(): MatrixThreadBindingRecord[] {
  return [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()];
}

export function getMatrixThreadBindingManagerEntry(
  accountId: string,
): MatrixThreadBindingManagerCacheEntry | null {
  return MANAGERS_BY_ACCOUNT_ID.get(accountId) ?? null;
}

export function setMatrixThreadBindingManagerEntry(
  accountId: string,
  entry: MatrixThreadBindingManagerCacheEntry,
): void {
  MANAGERS_BY_ACCOUNT_ID.set(accountId, entry);
}

export function deleteMatrixThreadBindingManagerEntry(accountId: string): void {
  MANAGERS_BY_ACCOUNT_ID.delete(accountId);
}

export function getMatrixThreadBindingManager(
  accountId: string,
): MatrixThreadBindingManager | null {
  return MANAGERS_BY_ACCOUNT_ID.get(accountId)?.manager ?? null;
}

export function setMatrixThreadBindingIdleTimeoutBySessionKey(params: {
  accountId: string;
  targetSessionKey: string;
  idleTimeoutMs: number;
}): SessionBindingRecord[] {
  const manager = MANAGERS_BY_ACCOUNT_ID.get(params.accountId)?.manager;
  if (!manager) {
    return [];
  }
  return manager.setIdleTimeoutBySessionKey(params).map((record) =>
    toSessionBindingRecord(record, {
      idleTimeoutMs: manager.getIdleTimeoutMs(),
      maxAgeMs: manager.getMaxAgeMs(),
    }),
  );
}

export function setMatrixThreadBindingMaxAgeBySessionKey(params: {
  accountId: string;
  targetSessionKey: string;
  maxAgeMs: number;
}): SessionBindingRecord[] {
  const manager = MANAGERS_BY_ACCOUNT_ID.get(params.accountId)?.manager;
  if (!manager) {
    return [];
  }
  return manager.setMaxAgeBySessionKey(params).map((record) =>
    toSessionBindingRecord(record, {
      idleTimeoutMs: manager.getIdleTimeoutMs(),
      maxAgeMs: manager.getMaxAgeMs(),
    }),
  );
}

export function resetMatrixThreadBindingsForTests(): void {
  for (const { manager } of MANAGERS_BY_ACCOUNT_ID.values()) {
    manager.stop();
  }
  MANAGERS_BY_ACCOUNT_ID.clear();
  BINDINGS_BY_ACCOUNT_CONVERSATION.clear();
}
