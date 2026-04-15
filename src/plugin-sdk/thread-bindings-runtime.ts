import { formatThreadBindingDurationLabel } from "../channels/thread-bindings-messages.js";
import { resolveThreadBindingConversationIdFromBindingId } from "../channels/thread-binding-id.js";

export type { BindingTargetKind, SessionBindingRecord } from "../infra/outbound/session-binding-service.js";

export { formatThreadBindingDurationLabel, resolveThreadBindingConversationIdFromBindingId };

export type ThreadLifecycleRecord = {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

export function resolveThreadBindingEffectiveExpiresAt(params: {
  record: ThreadLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const lifecycle = resolveThreadBindingLifecycle(params);
  return lifecycle.expiresAt;
}

export function resolveThreadBindingLifecycle(params: {
  record: ThreadLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): {
  expiresAt?: number;
  reason?: "idle-expired" | "max-age-expired";
} {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : Math.max(0, Math.floor(params.defaultIdleTimeoutMs));
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : Math.max(0, Math.floor(params.defaultMaxAgeMs));

  const idleExpiresAt =
    idleTimeoutMs > 0
      ? Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
      : undefined;
  const maxAgeExpiresAt = maxAgeMs > 0 ? params.record.boundAt + maxAgeMs : undefined;

  if (idleExpiresAt == null) {
    return maxAgeExpiresAt == null ? {} : { expiresAt: maxAgeExpiresAt };
  }
  if (maxAgeExpiresAt == null) {
    return { expiresAt: idleExpiresAt };
  }
  return { expiresAt: Math.min(idleExpiresAt, maxAgeExpiresAt) };
}

type GenericBindingTargetKind = "subagent" | "session";

export type AccountScopedConversationBindingManager<TTargetKind extends string> = {
  accountId: string;
  getByConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
  }) => {
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    targetKind: TTargetKind;
    targetSessionKey: string;
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    agentId?: string;
    label?: string;
    boundBy?: string;
  } | undefined;
  listBySessionKey: (targetSessionKey: string) => Array<{
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    targetKind: TTargetKind;
    targetSessionKey: string;
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    agentId?: string;
    label?: string;
    boundBy?: string;
  }>;
  listBindings: () => Array<{
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    targetKind: TTargetKind;
    targetSessionKey: string;
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    agentId?: string;
    label?: string;
    boundBy?: string;
  }>;
  touchBinding: (bindingId: string, at?: number) => unknown | null;
  setIdleTimeoutBySessionKey: (params: { targetSessionKey: string; idleTimeoutMs: number }) => unknown[];
  setMaxAgeBySessionKey: (params: { targetSessionKey: string; maxAgeMs: number }) => unknown[];
  stop: () => void;
};

type BindingEntry<TTargetKind extends string> = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetKind: TTargetKind;
  targetSessionKey: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  agentId?: string;
  label?: string;
  boundBy?: string;
};

function getScopedStore<TTargetKind extends string>(stateKey: symbol): Map<string, BindingEntry<TTargetKind>> {
  const root = globalThis as Record<PropertyKey, unknown>;
  const existing = root[stateKey];
  if (existing instanceof Map) {
    return existing as Map<string, BindingEntry<TTargetKind>>;
  }
  const created = new Map<string, BindingEntry<TTargetKind>>();
  root[stateKey] = created;
  return created;
}

function bindingKey(params: { conversationId: string; parentConversationId?: string }): string {
  return `${params.parentConversationId?.trim() || "-"}:${params.conversationId}`;
}

export function createAccountScopedConversationBindingManager<TTargetKind extends string>(params: {
  channel: string;
  cfg: unknown;
  accountId?: string;
  stateKey: symbol;
  toStoredTargetKind: (raw: GenericBindingTargetKind) => TTargetKind;
  toSessionBindingTargetKind: (raw: TTargetKind) => GenericBindingTargetKind;
}): AccountScopedConversationBindingManager<TTargetKind> {
  const accountId = params.accountId?.trim() || "default";
  const store = getScopedStore<TTargetKind>(params.stateKey);
  return {
    accountId,
    getByConversation: ({ conversationId, parentConversationId }) =>
      store.get(bindingKey({ conversationId, parentConversationId })),
    listBySessionKey: (targetSessionKey) =>
      [...store.values()].filter((entry) => entry.targetSessionKey === targetSessionKey),
    listBindings: () => [...store.values()],
    touchBinding: (bindingId, at) => {
      const entry = store.get(bindingId);
      if (!entry) {
        return null;
      }
      entry.lastActivityAt = at ?? Date.now();
      return entry;
    },
    setIdleTimeoutBySessionKey: ({ targetSessionKey, idleTimeoutMs }) => {
      const updated: BindingEntry<TTargetKind>[] = [];
      for (const entry of store.values()) {
        if (entry.targetSessionKey !== targetSessionKey) {
          continue;
        }
        entry.idleTimeoutMs = idleTimeoutMs;
        updated.push(entry);
      }
      return updated;
    },
    setMaxAgeBySessionKey: ({ targetSessionKey, maxAgeMs }) => {
      const updated: BindingEntry<TTargetKind>[] = [];
      for (const entry of store.values()) {
        if (entry.targetSessionKey !== targetSessionKey) {
          continue;
        }
        entry.maxAgeMs = maxAgeMs;
        updated.push(entry);
      }
      return updated;
    },
    stop: () => {},
  };
}

export function resetAccountScopedConversationBindingsForTests(params: { stateKey: symbol }): void {
  const root = globalThis as Record<PropertyKey, unknown>;
  delete root[params.stateKey];
}
