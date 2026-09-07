import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveThreadBindingConversationIdFromBindingId } from "../../channels/thread-binding-id.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPluginOwnedBindingMetadata } from "../../plugins/conversation-binding-metadata.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  deleteCurrentConversationBindingRecordsBySession,
  listCurrentConversationBindingRecordsBySession,
  resolveCurrentConversationBindingRecord,
  updateCurrentConversationBindingRecord,
} from "./current-conversation-bindings.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";

/** Binding record scoped to one channel account and conversation id. */
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
};

function getState<TKind extends string>(
  stateKey: symbol,
): AccountScopedConversationBindingsState<TKind> {
  return resolveGlobalSingleton(stateKey, () => ({
    managersByAccountId: new Map(),
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
  metadata?: Record<string, unknown>;
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
      ...params.metadata,
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
  const existingManager = state.managersByAccountId.get(accountId);
  if (existingManager) {
    // Manager state is account-scoped and process-global so repeated channel
    // setup calls reuse the same binding adapter instead of double-registering.
    return existingManager;
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
    metadata?: Record<string, unknown>,
  ): SessionBindingRecord =>
    toSessionBindingRecord({
      channel: params.channel,
      record,
      idleTimeoutMs,
      maxAgeMs,
      toSessionBindingTargetKind: params.toSessionBindingTargetKind,
      metadata,
    });
  const conversationRef = (conversationId: string) => ({
    channel: params.channel,
    accountId,
    conversationId,
  });
  const asAccountBindingRecord = (
    record: SessionBindingRecord,
  ): AccountScopedConversationBindingRecord<TKind> => {
    const metadata = record.metadata;
    return {
      accountId,
      conversationId: record.conversation.conversationId,
      targetKind: params.toStoredTargetKind(record.targetKind),
      targetSessionKey: record.targetSessionKey,
      agentId: typeof metadata?.agentId === "string" ? metadata.agentId : undefined,
      label: typeof metadata?.label === "string" ? metadata.label : undefined,
      boundBy: typeof metadata?.boundBy === "string" ? metadata.boundBy : undefined,
      boundAt: record.boundAt,
      lastActivityAt:
        typeof metadata?.lastActivityAt === "number" ? metadata.lastActivityAt : record.boundAt,
    };
  };
  const bindConversationRecord = (input: {
    conversationId: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }): SessionBindingRecord | null => {
    const normalizedConversationId = input.conversationId.trim();
    const normalizedTargetSessionKey = input.targetSessionKey.trim();
    if (!normalizedConversationId || !normalizedTargetSessionKey) {
      return null;
    }
    const now = Date.now();
    const { current } = updateCurrentConversationBindingRecord(
      conversationRef(normalizedConversationId),
      (existing) => {
        const previous =
          existing?.targetSessionKey === normalizedTargetSessionKey &&
          existing.targetKind === input.targetKind
            ? existing
            : undefined;
        const existingLocal = previous ? asAccountBindingRecord(previous) : undefined;
        // Preserve plugin ownership on refresh without assigning its opaque target an agent.
        const metadata = { ...previous?.metadata, ...input.metadata };
        const record: AccountScopedConversationBindingRecord<TKind> = {
          accountId,
          conversationId: normalizedConversationId,
          targetKind: params.toStoredTargetKind(input.targetKind),
          targetSessionKey: normalizedTargetSessionKey,
          agentId:
            normalizeOptionalString(input.metadata?.agentId) ??
            existingLocal?.agentId ??
            (isPluginOwnedBindingMetadata(metadata)
              ? undefined
              : resolveSessionAgentId({
                  config: params.cfg,
                  sessionKey: normalizedTargetSessionKey,
                })),
          label: normalizeOptionalString(input.metadata?.label) ?? existingLocal?.label,
          boundBy: normalizeOptionalString(input.metadata?.boundBy) ?? existingLocal?.boundBy,
          boundAt: now,
          lastActivityAt: now,
        };
        return asSessionBindingRecord(record, metadata);
      },
    );
    return current;
  };
  const accountScope = { channel: params.channel, accountId };
  const manager: AccountScopedConversationBindingManager<TKind> = {
    accountId,
    getByConversationId: (conversationId) => {
      const record = resolveCurrentConversationBindingRecord(conversationRef(conversationId));
      return record ? asAccountBindingRecord(record) : undefined;
    },
    listBySessionKey: (targetSessionKey) =>
      listCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope).map(
        asAccountBindingRecord,
      ),
    bindConversation: (input) => {
      const record = bindConversationRecord(input);
      return record ? asAccountBindingRecord(record) : null;
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const { current } = updateCurrentConversationBindingRecord(
        conversationRef(conversationId),
        (existing) => {
          if (!existing) {
            return null;
          }
          const updated = { ...asAccountBindingRecord(existing), lastActivityAt: at };
          return asSessionBindingRecord(updated, existing.metadata);
        },
      );
      return current ? asAccountBindingRecord(current) : null;
    },
    unbindConversation: (conversationId) => {
      const { previous } = updateCurrentConversationBindingRecord(
        conversationRef(conversationId),
        () => null,
      );
      return previous ? asAccountBindingRecord(previous) : null;
    },
    unbindBySessionKey: (targetSessionKey) =>
      deleteCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope).map(
        asAccountBindingRecord,
      ),
    stop: () => {
      // Registrations are process-local; SQLite-owned bindings must survive manager shutdown.
      if (state.managersByAccountId.get(accountId) === manager) {
        state.managersByAccountId.delete(accountId);
      }
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
      return bindConversationRecord({
        conversationId: input.conversation.conversationId,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        metadata: input.metadata,
      });
    },
    listBySession: (targetSessionKey) =>
      listCurrentConversationBindingRecordsBySession(targetSessionKey, accountScope),
    resolveByConversation: (ref) => {
      if (ref.channel !== params.channel) {
        return null;
      }
      return resolveCurrentConversationBindingRecord(conversationRef(ref.conversationId));
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
        return deleteCurrentConversationBindingRecordsBySession(
          input.targetSessionKey.trim(),
          accountScope,
        );
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const { previous } = updateCurrentConversationBindingRecord(
        conversationRef(conversationId),
        () => null,
      );
      return previous ? [previous] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);
  state.managersByAccountId.set(accountId, manager);
  return manager;
}

/** Stops registered account-scoped adapters for one test key without clearing durable bindings. */
export function resetAccountScopedConversationBindingsForTests(params: { stateKey: symbol }) {
  const state = getState(params.stateKey);
  for (const manager of state.managersByAccountId.values()) {
    manager.stop();
  }
  state.managersByAccountId.clear();
}
