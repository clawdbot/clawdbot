import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
// Account-scoped conversation binding managers adapt channel-local thread maps
// into the shared session binding service.
import { resolveThreadBindingConversationIdFromBindingId } from "../../channels/thread-binding-id.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";

/** In-memory binding record scoped to one channel account and conversation id. */
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

/** Account-local binding manager exposed by channel-specific conversation stores. */
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
  return resolveGlobalSingleton(stateKey, () => ({
    managersByAccountId: new Map(),
    bindingsByAccountConversation: new Map(),
  }));
}

function resolveBindingKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
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
    bindingId: resolveBindingKey(params.record.accountId, params.record.conversationId),
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

/** Creates a channel/account binding manager and registers it as a session-binding adapter. */
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
    // Manager state is account-scoped and process-global so repeated channel
    // setup calls reuse the same binding adapter instead of double-registering.
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
  const asSessionBindingRecord = (
    record: AccountScopedConversationBindingRecord<TKind>,
  ): SessionBindingRecord =>
    toSessionBindingRecord({
      channel: params.channel,
      record,
      idleTimeoutMs,
      maxAgeMs,
      toSessionBindingTargetKind: params.toSessionBindingTargetKind,
    });
  const resolveActiveBinding = (
    record: AccountScopedConversationBindingRecord<TKind> | undefined,
    now = Date.now(),
  ): AccountScopedConversationBindingRecord<TKind> | undefined => {
    if (!record) {
      return undefined;
    }
    const { expiresAt } = asSessionBindingRecord(record);
    if (expiresAt === undefined || isFutureDateTimestampMs(expiresAt, { nowMs: now })) {
      return record;
    }

    // Prune at the account owner so SDK lookups and touches cannot revive stale bindings.
    state.bindingsByAccountConversation.delete(resolveBindingKey(accountId, record.conversationId));
    return undefined;
  };
  const manager: AccountScopedConversationBindingManager<TKind> = {
    accountId,
    getByConversationId: (conversationId) =>
      resolveActiveBinding(
        state.bindingsByAccountConversation.get(resolveBindingKey(accountId, conversationId)),
      ),
    listBySessionKey: (targetSessionKey) => {
      const now = Date.now();
      return [...state.bindingsByAccountConversation.values()].filter(
        (record) =>
          record.accountId === accountId &&
          record.targetSessionKey === targetSessionKey &&
          resolveActiveBinding(record, now) !== undefined,
      );
    },
    bindConversation: ({ conversationId, targetKind, targetSessionKey, metadata }) => {
      const normalizedConversationId = conversationId.trim();
      const normalizedTargetSessionKey = targetSessionKey.trim();
      if (!normalizedConversationId || !normalizedTargetSessionKey) {
        return null;
      }
      const existingLocal = manager.getByConversationId(normalizedConversationId);
      const now = Date.now();
      const record: AccountScopedConversationBindingRecord<TKind> = {
        accountId,
        conversationId: normalizedConversationId,
        targetKind: params.toStoredTargetKind(targetKind),
        targetSessionKey: normalizedTargetSessionKey,
        agentId:
          (typeof metadata?.agentId === "string" && metadata.agentId.trim()
            ? metadata.agentId.trim()
            : existingLocal?.agentId) ??
          resolveSessionAgentId({
            config: params.cfg,
            sessionKey: normalizedTargetSessionKey,
          }),
        label:
          typeof metadata?.label === "string" && metadata.label.trim()
            ? metadata.label.trim()
            : existingLocal?.label,
        boundBy:
          typeof metadata?.boundBy === "string" && metadata.boundBy.trim()
            ? metadata.boundBy.trim()
            : existingLocal?.boundBy,
        boundAt: now,
        lastActivityAt: now,
      };
      state.bindingsByAccountConversation.set(
        resolveBindingKey(accountId, normalizedConversationId),
        record,
      );
      return record;
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const key = resolveBindingKey(accountId, conversationId);
      const existingRecord = manager.getByConversationId(conversationId);
      if (!existingRecord) {
        return null;
      }
      const updated = { ...existingRecord, lastActivityAt: at };
      state.bindingsByAccountConversation.set(key, updated);
      return updated;
    },
    unbindConversation: (conversationId) => {
      const key = resolveBindingKey(accountId, conversationId);
      const existingRecord = state.bindingsByAccountConversation.get(key);
      if (!existingRecord) {
        return null;
      }
      state.bindingsByAccountConversation.delete(key);
      return existingRecord;
    },
    unbindBySessionKey: (targetSessionKey) => {
      const removed: AccountScopedConversationBindingRecord<TKind>[] = [];
      for (const record of state.bindingsByAccountConversation.values()) {
        if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) {
          continue;
        }
        state.bindingsByAccountConversation.delete(
          resolveBindingKey(accountId, record.conversationId),
        );
        removed.push(record);
      }
      return removed;
    },
    stop: () => {
      for (const key of state.bindingsByAccountConversation.keys()) {
        if (key.startsWith(`${accountId}:`)) {
          state.bindingsByAccountConversation.delete(key);
        }
      }
      state.managersByAccountId.delete(accountId);
      unregisterSessionBindingAdapter({
        channel: params.channel,
        accountId,
        adapter: sessionBindingAdapter,
      });
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
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
      return bound ? asSessionBindingRecord(bound) : null;
    },
    listBySession: (targetSessionKey) =>
      manager.listBySessionKey(targetSessionKey).map(asSessionBindingRecord),
    resolveByConversation: (ref) => {
      if (ref.channel !== params.channel) {
        return null;
      }
      const found = manager.getByConversationId(ref.conversationId);
      return found ? asSessionBindingRecord(found) : null;
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
        return manager
          .unbindBySessionKey(input.targetSessionKey.trim())
          .map(asSessionBindingRecord);
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation(conversationId);
      return removed ? [asSessionBindingRecord(removed)] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);
  state.managersByAccountId.set(accountId, manager);
  return manager;
}

/** Stops registered managers and clears account-scoped binding state for one test key. */
export function resetAccountScopedConversationBindingsForTests(params: { stateKey: symbol }) {
  const state = getState(params.stateKey);
  for (const manager of state.managersByAccountId.values()) {
    manager.stop();
  }
  state.managersByAccountId.clear();
  state.bindingsByAccountConversation.clear();
}
