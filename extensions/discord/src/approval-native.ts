import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { DiscordExecApprovalConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
export { shouldHandleDiscordApprovalRequest } from "./approval-shared.js";
import { listDiscordAccountIds, resolveDiscordAccount } from "./accounts.js";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
} from "./approval-runtime.js";
import { shouldHandleDiscordApprovalRequest } from "./approval-shared.js";
import {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
} from "./exec-approvals.js";

// Legacy export kept for monitor test/support surfaces; native routing now uses
// the shared session-conversation fallback helper instead.
export function extractDiscordChannelId(sessionKey?: string | null): string | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/discord:(?:channel|group):(\d+)/);
  return match ? match[1] : null;
}

export function extractDiscordThreadId(sessionKey?: string | null): string | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/discord:(?:channel|group):\d+:thread:(\d+)/);
  return match ? match[1] : null;
}

function extractDiscordSessionKind(sessionKey?: string | null): "channel" | "group" | "dm" | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/discord:(channel|group|dm):/);
  if (!match) {
    return null;
  }
  return match[1] as "channel" | "group" | "dm";
}

function normalizeDiscordOriginChannelId(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const prefixed = trimmed.match(/^(?:channel|group):(\d+)$/i);
  if (prefixed) {
    return prefixed[1];
  }
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function normalizeDiscordThreadId(value?: string | number | null): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

function createDiscordOriginTargetResolver(configOverride?: DiscordExecApprovalConfig | null) {
  return createChannelNativeOriginTargetResolver({
    channel: "discord",
    shouldHandleRequest: ({ cfg, accountId, request }) =>
      shouldHandleDiscordApprovalRequest({
        cfg,
        accountId,
        request,
        configOverride,
      }),
    resolveTurnSourceTarget: (request) => {
      const sessionConversation = resolveApprovalRequestSessionConversation({
        request,
        channel: "discord",
        bundledFallback: false,
      });
      const sessionKind = extractDiscordSessionKind(
        normalizeOptionalString(request.request.sessionKey) ?? null,
      );
      const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
      const rawTurnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
      const turnSourceTo = normalizeDiscordOriginChannelId(rawTurnSourceTo);
      const threadId =
        normalizeDiscordThreadId(request.request.turnSourceThreadId) ??
        normalizeDiscordThreadId(sessionConversation?.threadId) ??
        undefined;
      const hasExplicitOriginTarget = /^(?:channel|group):/i.test(rawTurnSourceTo);
      if (turnSourceChannel !== "discord" || !turnSourceTo || sessionKind === "dm") {
        return null;
      }
      return hasExplicitOriginTarget || sessionKind === "channel" || sessionKind === "group"
        ? { to: turnSourceTo, threadId }
        : null;
    },
    resolveSessionTarget: (sessionTarget, request) => {
      const sessionConversation = resolveApprovalRequestSessionConversation({
        request,
        channel: "discord",
        bundledFallback: false,
      });
      const sessionKind = extractDiscordSessionKind(request.request.sessionKey?.trim() || null);
      if (sessionKind === "dm") {
        return null;
      }
      const targetTo = normalizeDiscordOriginChannelId(sessionTarget.to);
      return targetTo
        ? {
            to: targetTo,
            threadId:
              normalizeDiscordThreadId(sessionTarget.threadId) ??
              normalizeDiscordThreadId(sessionConversation?.threadId) ??
              undefined,
          }
        : null;
    },
    targetsMatch: (a, b) => a.to === b.to && a.threadId === b.threadId,
    resolveFallbackTarget: (request) => {
      const sessionConversation = resolveApprovalRequestSessionConversation({
        request,
        channel: "discord",
        bundledFallback: false,
      });
      const sessionKind = extractDiscordSessionKind(request.request.sessionKey?.trim() || null);
      if (sessionKind === "dm") {
        return null;
      }
      const fallbackChannelId = normalizeDiscordOriginChannelId(sessionConversation?.id);
      return fallbackChannelId
        ? {
            to: fallbackChannelId,
            threadId: normalizeDiscordThreadId(sessionConversation?.threadId) ?? undefined,
          }
        : null;
    },
  });
}

function createDiscordApproverDmTargetResolver(configOverride?: DiscordExecApprovalConfig | null) {
  return createChannelApproverDmTargetResolver({
    shouldHandleRequest: ({ cfg, accountId, request }) =>
      shouldHandleDiscordApprovalRequest({
        cfg,
        accountId,
        request,
        configOverride,
      }),
    resolveApprovers: ({ cfg, accountId }) =>
      getDiscordExecApprovalApprovers({ cfg, accountId, configOverride }),
    mapApprover: (approver) => ({ to: approver }),
  });
}

export function createDiscordApprovalCapability(configOverride?: DiscordExecApprovalConfig | null) {
  return createApproverRestrictedNativeApprovalCapability({
    channel: "discord",
    channelLabel: "Discord",
    describeExecApprovalSetup: ({
      accountId,
    }: Parameters<NonNullable<ChannelApprovalCapability["describeExecApprovalSetup"]>>[0]) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.discord.accounts.${accountId}`
          : "channels.discord";
      return `Approve it from the Web UI or terminal UI for now. Discord supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
    },
    listAccountIds: listDiscordAccountIds,
    hasApprovers: ({ cfg, accountId }) =>
      getDiscordExecApprovalApprovers({ cfg, accountId, configOverride }).length > 0,
    isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
      isDiscordExecApprovalApprover({ cfg, accountId, senderId, configOverride }),
    isNativeDeliveryEnabled: ({ cfg, accountId }) =>
      isDiscordExecApprovalClientEnabled({ cfg, accountId, configOverride }),
    resolveNativeDeliveryMode: ({ cfg, accountId }) =>
      configOverride?.target ??
      resolveDiscordAccount({ cfg, accountId }).config.execApprovals?.target ??
      "dm",
    resolveOriginTarget: createDiscordOriginTargetResolver(configOverride),
    resolveApproverDmTargets: createDiscordApproverDmTargetResolver(configOverride),
    notifyOriginWhenDmOnly: true,
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin"],
      isConfigured: ({ cfg, accountId }) =>
        isDiscordExecApprovalClientEnabled({ cfg, accountId, configOverride }),
      shouldHandle: ({ cfg, accountId, request }) =>
        shouldHandleDiscordApprovalRequest({
          cfg,
          accountId,
          request,
          configOverride,
        }),
      load: async () =>
        (await import("./approval-handler.runtime.js"))
          .discordApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });
}

export function createDiscordNativeApprovalAdapter(
  configOverride?: DiscordExecApprovalConfig | null,
) {
  return splitChannelApprovalCapability(createDiscordApprovalCapability(configOverride));
}

let cachedDiscordApprovalCapability: ReturnType<typeof createDiscordApprovalCapability> | undefined;
let cachedDiscordNativeApprovalAdapter:
  | ReturnType<typeof createDiscordNativeApprovalAdapter>
  | undefined;

export function getDiscordApprovalCapability() {
  cachedDiscordApprovalCapability ??= createDiscordApprovalCapability();
  return cachedDiscordApprovalCapability;
}

export function getDiscordNativeApprovalAdapter() {
  cachedDiscordNativeApprovalAdapter ??= createDiscordNativeApprovalAdapter();
  return cachedDiscordNativeApprovalAdapter;
}
