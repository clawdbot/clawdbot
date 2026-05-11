import {
  resolveThreadBindingConversationIdFromBindingId,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordChannelId } from "../target-parsing.js";
import { resolveChannelIdForBinding } from "./thread-bindings.discord-api.js";
import { resolveBindingRecordKey } from "./thread-bindings.state.js";
import {
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
} from "./thread-bindings.state.js";
import type { ThreadBindingManager, ThreadBindingRecord } from "./thread-bindings.types.js";

type ThreadBindingDefaults = {
  idleTimeoutMs: number;
  maxAgeMs: number;
};

function normalizeChildBindingParentChannelId(raw?: string | null): string | undefined {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed) {
    return undefined;
  }
  try {
    return resolveDiscordChannelId(trimmed);
  } catch {
    return undefined;
  }
}

function toSessionBindingTargetKind(raw: string): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toThreadBindingTargetKind(raw: BindingTargetKind): "subagent" | "acp" {
  return raw === "subagent" ? "subagent" : "acp";
}

function resolveEffectiveBindingExpiresAt(params: {
  record: ThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
    record: params.record,
    defaultIdleTimeoutMs: params.defaultIdleTimeoutMs,
  });
  const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
    record: params.record,
    defaultMaxAgeMs: params.defaultMaxAgeMs,
  });
  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
  }
  return inactivityExpiresAt ?? maxAgeExpiresAt;
}

function toSessionBindingRecord(
  record: ThreadBindingRecord,
  defaults: ThreadBindingDefaults,
): SessionBindingRecord {
  const bindingId =
    resolveBindingRecordKey({
      accountId: record.accountId,
      threadId: record.threadId,
    }) ?? `${record.accountId}:${record.threadId}`;
  return {
    bindingId,
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "discord",
      accountId: record.accountId,
      conversationId: record.threadId,
      parentConversationId: record.channelId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveEffectiveBindingExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      webhookId: record.webhookId,
      webhookToken: record.webhookToken,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
        record,
        defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      }),
      maxAgeMs: resolveThreadBindingMaxAgeMs({
        record,
        defaultMaxAgeMs: defaults.maxAgeMs,
      }),
      ...record.metadata,
    },
  };
}

export function createThreadBindingSessionAdapter(params: {
  accountId: string;
  manager: ThreadBindingManager;
  defaults: ThreadBindingDefaults;
  resolveCurrentCfg: () => OpenClawConfig;
  resolveCurrentToken: () => string | undefined;
}): SessionBindingAdapter {
  const toRecord = (entry: ThreadBindingRecord) => toSessionBindingRecord(entry, params.defaults);

  return {
    channel: "discord",
    accountId: params.accountId,
    capabilities: {
      placements: ["current", "child"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "discord") {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const conversationId = normalizeOptionalString(input.conversation.conversationId) ?? "";
      const placement = input.placement === "child" ? "child" : "current";
      const metadata = input.metadata ?? {};
      const label = normalizeOptionalString(metadata.label);
      const threadName =
        typeof metadata.threadName === "string"
          ? normalizeOptionalString(metadata.threadName)
          : undefined;
      const introText =
        typeof metadata.introText === "string"
          ? normalizeOptionalString(metadata.introText)
          : undefined;
      const boundBy =
        typeof metadata.boundBy === "string"
          ? normalizeOptionalString(metadata.boundBy)
          : undefined;
      const agentId =
        typeof metadata.agentId === "string"
          ? normalizeOptionalString(metadata.agentId)
          : undefined;
      let threadId: string | undefined;
      let channelId: string | undefined;
      let createThread = false;

      if (placement === "child") {
        createThread = true;
        channelId = normalizeChildBindingParentChannelId(input.conversation.parentConversationId);
        if (!channelId && conversationId) {
          channelId =
            (await resolveChannelIdForBinding({
              cfg: params.resolveCurrentCfg(),
              accountId: params.accountId,
              token: params.resolveCurrentToken(),
              threadId: conversationId,
            })) ?? undefined;
        }
      } else {
        threadId = conversationId || undefined;
      }

      const bound = await params.manager.bindTarget({
        threadId,
        channelId,
        createThread,
        threadName,
        targetKind: toThreadBindingTargetKind(input.targetKind),
        targetSessionKey,
        agentId,
        label,
        boundBy,
        introText,
        metadata,
      });
      return bound ? toRecord(bound) : null;
    },
    listBySession: (targetSessionKey) =>
      params.manager.listBySessionKey(targetSessionKey).map(toRecord),
    resolveByConversation: (ref) => {
      if (ref.channel !== "discord") {
        return null;
      }
      const binding = params.manager.getByThreadId(ref.conversationId);
      return binding ? toRecord(binding) : null;
    },
    touch: (bindingId, at) => {
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId: params.accountId,
        bindingId,
      });
      if (!threadId) {
        return;
      }
      params.manager.touchThread({ threadId, at, persist: true });
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = params.manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
        });
        return removed.map(toRecord);
      }
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId: params.accountId,
        bindingId: input.bindingId,
      });
      if (!threadId) {
        return [];
      }
      const removed = params.manager.unbindThread({
        threadId,
        reason: input.reason,
      });
      return removed ? [toRecord(removed)] : [];
    },
  };
}
