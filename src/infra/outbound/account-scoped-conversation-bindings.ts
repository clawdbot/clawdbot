import { resolveThreadBindingConversationIdFromBindingId } from "../../channels/thread-binding-id.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";

export type AccountScopedConversationBindingRecord<TKind extends string = string> = {
  accountId: string;
  conversationId: string;
  targetKind: TKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
};

export type AccountScopedConversationBindingManager<TKind extends string = string> = {
  accountId: string;
  getByConversationId: (
    conversationId: string,
  ) => AccountScopedConversationBindingRecord<TKind> | undefined;
  listBySessionKey: (targetSessionKey: string) => AccountScopedConversationBindingRecord<TKind>[];
  bindConversation: (params: {
    conversationId: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => AccountScopedConversationBindingRecord<TKind> | null;
  touchConversation: (
    conversationId: string,
    at?: number,
  ) => AccountScopedConversationBindingRecord<TKind> | null;
  unbindConversation: (
    conversationId: string,
  ) => AccountScopedConversationBindingRecord<TKind> | null;
  unbindBySessionKey: (targetSessionKey: string) => AccountScopedConversationBindingRecord<TKind>[];
  stop: () => void;
};

type AccountScopedConversationBindingsState<TKind extends string> = {
  managersByAccountId: Map<string, AccountScopedConversationBindingManager<TKind>>;
  bindingsByAccountConversation: Map<string, AccountScopedConversationBindingRecord<TKind>>;
};

function getState<TKind extends string>(
  stateKey: symbol,
): AccountScopedConversationBindingsState<TKind> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[stateKey] as
    | AccountScopedConversationBindingsState<TKind>
    | undefined;
  if (existing) {
    return existing;
  }
  const next: AccountScopedConversationBindingsState<TKind> = {
    managersByAccountId: new Map(),
    bindingsByAccountConversation: new Map(),
  };
  globalStore[stateKey] = next;
  return next;
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingRecord<TKind extends string>(params: {
  channel: string;
  record: AccountScopedConversationBindingRecord<TKind>;
  idleTimeoutMs: number;
  maxAgeMs: number;
  toSessionBindingTargetKind: (raw: TKind) => BindingTargetKind;
}): SessionBindingRecord {
  const idleExpiresAt =
    params.idleTimeoutMs > 0 ? params.record.lastActivityAt + params.idleTimeoutMs : undefined;
  const maxAgeExpiresAt = params.maxAgeMs > 0 ? params.record.boundAt + params.maxAgeMs : undefined;
  const expiresAt =
    idleExpiresAt != null && maxAgeExpiresAt != null
      ? Math.min(idleExpiresAt, maxAgeExpiresAt)
      : (idleExpiresAt ?? maxAgeExpiresAt);
  return {
    bindingId: resolveBindingKey({
      accountId: params.record.accountId,
      conversationId: params.record.conversationId,
    }),
    targetSessionKey: params.record.targetSessionKey,
    targetKind: params.toSessionBindingTargetKind(params.record.targetKind),
    conversation: {
      channel: params.channel,
      accountId: params.record.accountId,
      conversationId: params.record.conversationId,
    },
    status: "active",
    boundAt: params.record.boundAt,
    expiresAt,
    metadata: {
      agentId: params.record.agentId,
      label: params.record.label,
      boundBy: params.record.boundBy,
      lastActivityAt: params.record.lastActivityAt,
      idleTimeoutMs: params.idleTimeoutMs,
      maxAgeMs: params.maxAgeMs,
    },
  };
}

export function createAccountScopedConversationBindingManager<TKind extends string>(params: {
  channel: string;
  cfg: OpenClawConfig;
  stateKey: symbol;
  accountId?: string | null;
  toStoredTargetKind: (raw: BindingTargetKind) => TKind;
  toSessionBindingTargetKind: (raw: TKind) => BindingTargetKind;
}): AccountScopedConversationBindingManager<TKind> {
  const accountId = normalizeAccountId(params.accountId);
  const state = getState<TKind>(params.stateKey);
  const existing = state.managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg: params.cfg,
    channel: params.channel,
    accountId,
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg: params.cfg,
    channel: params.channel,
    accountId,
  });

  let sessionBindingAdapter: SessionBindingAdapter;
  const manager: AccountScopedConversationBindingManager<TKind> = {
    accountId,
    getByConversationId: (conversationId) =>
      getState<TKind>(params.stateKey).bindingsByAccountConversation.get(
        resolveBindingKey({ accountId, conversationId }),
      ),
    listBySessionKey: (targetSessionKey) =>
      [...getState<TKind>(params.stateKey).bindingsByAccountConversation.values()].filter(
        (record) => record.accountId === accountId && record.targetSessionKey === targetSessionKey,
      ),
    bindConversation: ({ conversationId, targetKind, targetSessionKey, metadata }) => {
      const normalizedConversationId = conversationId.trim();
      const normalizedTargetSessionKey = targetSessionKey.trim();
      if (!normalizedConversationId || !normalizedTargetSessionKey) {
        return null;
      }
      const existing = getState<TKind>(params.stateKey).bindingsByAccountConversation.get(
        resolveBindingKey({ accountId, conversationId: normalizedConversationId }),
      );
      const now = Date.now();
      const record: AccountScopedConversationBindingRecord<TKind> = {
        accountId,
        conversationId: normalizedConversationId,
        targetKind: params.toStoredTargetKind(targetKind),
        targetSessionKey: normalizedTargetSessionKey,
        agentId:
          typeof metadata?.agentId === "string" && metadata.agentId.trim()
            ? metadata.agentId.trim()
            : (existing?.agentId ?? resolveAgentIdFromSessionKey(normalizedTargetSessionKey)),
        label:
          typeof metadata?.label === "string" && metadata.label.trim()
            ? metadata.label.trim()
            : existing?.label,
        boundBy:
          typeof metadata?.boundBy === "string" && metadata.boundBy.trim()
            ? metadata.boundBy.trim()
            : existing?.boundBy,
        boundAt: now,
        lastActivityAt: now,
      };
      getState<TKind>(params.stateKey).bindingsByAccountConversation.set(
        resolveBindingKey({ accountId, conversationId: normalizedConversationId }),
        record,
      );
      return record;
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = getState<TKind>(params.stateKey).bindingsByAccountConversation.get(
        key,
      );
      if (!existingRecord) {
        return null;
      }
      const updated = { ...existingRecord, lastActivityAt: at };
      getState<TKind>(params.stateKey).bindingsByAccountConversation.set(key, updated);
      return updated;
    },
    unbindConversation: (conversationId) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = getState<TKind>(params.stateKey).bindingsByAccountConversation.get(
        key,
      );
      if (!existingRecord) {
        return null;
      }
      getState<TKind>(params.stateKey).bindingsByAccountConversation.delete(key);
      return existingRecord;
    },
    unbindBySessionKey: (targetSessionKey) => {
      const removed: AccountScopedConversationBindingRecord<TKind>[] = [];
      for (const record of getState<TKind>(
        params.stateKey,
      ).bindingsByAccountConversation.values()) {
        if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) {
          continue;
        }
        getState<TKind>(params.stateKey).bindingsByAccountConversation.delete(
          resolveBindingKey({ accountId, conversationId: record.conversationId }),
        );
        removed.push(record);
      }
      return removed;
    },
    stop: () => {
      for (const key of getState<TKind>(params.stateKey).bindingsByAccountConversation.keys()) {
        if (key.startsWith(`${accountId}:`)) {
          getState<TKind>(params.stateKey).bindingsByAccountConversation.delete(key);
        }
      }
      getState<TKind>(params.stateKey).managersByAccountId.delete(accountId);
      unregisterSessionBindingAdapter({
        channel: params.channel,
        accountId,
        adapter: sessionBindingAdapter,
      });
    },
  };

  sessionBindingAdapter = {
    channel: params.channel,
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== params.channel || input.placement === "child") {
        return null;
      }
      const bound = manager.bindConversation({
        conversationId: input.conversation.conversationId,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        metadata: input.metadata,
      });
      return bound
        ? toSessionBindingRecord({
            channel: params.channel,
            record: bound,
            idleTimeoutMs,
            maxAgeMs,
            toSessionBindingTargetKind: params.toSessionBindingTargetKind,
          })
        : null;
    },
    listBySession: (targetSessionKey) =>
      manager.listBySessionKey(targetSessionKey).map((entry) =>
        toSessionBindingRecord({
          channel: params.channel,
          record: entry,
          idleTimeoutMs,
          maxAgeMs,
          toSessionBindingTargetKind: params.toSessionBindingTargetKind,
        }),
      ),
    resolveByConversation: (ref) => {
      if (ref.channel !== params.channel) {
        return null;
      }
      const found = manager.getByConversationId(ref.conversationId);
      return found
        ? toSessionBindingRecord({
            channel: params.channel,
            record: found,
            idleTimeoutMs,
            maxAgeMs,
            toSessionBindingTargetKind: params.toSessionBindingTargetKind,
          })
        : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (conversationId) {
        manager.touchConversation(conversationId, at);
      }
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        return manager.unbindBySessionKey(input.targetSessionKey.trim()).map((entry) =>
          toSessionBindingRecord({
            channel: params.channel,
            record: entry,
            idleTimeoutMs,
            maxAgeMs,
            toSessionBindingTargetKind: params.toSessionBindingTargetKind,
          }),
        );
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation(conversationId);
      return removed
        ? [
            toSessionBindingRecord({
              channel: params.channel,
              record: removed,
              idleTimeoutMs,
              maxAgeMs,
              toSessionBindingTargetKind: params.toSessionBindingTargetKind,
            }),
          ]
        : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);
  getState<TKind>(params.stateKey).managersByAccountId.set(accountId, manager);
  return manager;
}

export function resetAccountScopedConversationBindingsForTests(params: { stateKey: symbol }) {
  const state = getState(params.stateKey);
  for (const manager of state.managersByAccountId.values()) {
    manager.stop();
  }
  state.managersByAccountId.clear();
  state.bindingsByAccountConversation.clear();
}
