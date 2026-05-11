import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry as SdkHistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveQQBotEffectivePolicies } from "../engine/access/resolve-policy.js";
import { normalizeQQBotAllowFrom, normalizeQQBotSenderId } from "../engine/access/sender-match.js";
import type { HistoryPort, HistoryEntryLike } from "../engine/adapter/history.port.js";
import type { AccessPort } from "../engine/adapter/index.js";
import type { MentionGatePort } from "../engine/adapter/mention-gate.port.js";

const qqbotIngressIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  normalize: normalizeQQBotSenderId,
  isWildcardEntry: (entry) => normalizeQQBotSenderId(entry) === "*",
});

function asSdkMap<T>(map: Map<string, T[]>): Map<string, SdkHistoryEntry[]> {
  return map as unknown as Map<string, SdkHistoryEntry[]>;
}

export function createSdkHistoryAdapter(): HistoryPort {
  return {
    recordPendingHistoryEntry<T extends HistoryEntryLike>(params: {
      historyMap: Map<string, T[]>;
      historyKey: string;
      entry?: T | null;
      limit: number;
    }) {
      return recordPendingHistoryEntryIfEnabled({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        entry: params.entry as SdkHistoryEntry | undefined,
        limit: params.limit,
      }) as T[];
    },

    buildPendingHistoryContext(params) {
      return buildPendingHistoryContextFromMap({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        limit: params.limit,
        currentMessage: params.currentMessage,
        formatEntry: params.formatEntry as (entry: SdkHistoryEntry) => string,
        lineBreak: params.lineBreak,
      });
    },

    clearPendingHistory(params) {
      clearHistoryEntriesIfEnabled({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        limit: params.limit,
      });
    },
  };
}

export function createSdkMentionGateAdapter(): MentionGatePort {
  return {
    resolveInboundMentionDecision(params) {
      return resolveInboundMentionDecision(params);
    },
  };
}

export function createSdkAccessAdapter(): AccessPort {
  return {
    async resolveInboundAccess(input) {
      const { dmPolicy, groupPolicy } = resolveQQBotEffectivePolicies(input);
      const rawGroupAllowFrom =
        input.groupAllowFrom && input.groupAllowFrom.length > 0
          ? input.groupAllowFrom
          : (input.allowFrom ?? []);
      const normalizedAllowFrom = normalizeQQBotAllowFrom(input.allowFrom);
      const dmAllowFromForIngress =
        dmPolicy === "open" && normalizedAllowFrom.length === 0 ? ["*"] : (input.allowFrom ?? []);

      const commandOwnerAllowFrom = input.isGroup
        ? []
        : input.allowFrom && input.allowFrom.length > 0
          ? input.allowFrom
          : ["*"];
      const resolved = await createChannelIngressResolver({
        channelId: "qqbot",
        accountId: input.accountId,
        identity: qqbotIngressIdentity,
        cfg: input.cfg as OpenClawConfig,
      }).message({
        subject: { stableId: input.senderId },
        conversation: {
          kind: input.isGroup ? "group" : "direct",
          id: input.conversationId,
        },
        event: {
          mayPair: false,
        },
        dmPolicy,
        groupPolicy,
        policy: {
          groupAllowFromFallbackToAllowFrom: false,
        },
        allowFrom: dmAllowFromForIngress,
        groupAllowFrom: rawGroupAllowFrom,
        command: {
          commandOwnerAllowFrom,
        },
      });
      return resolved;
    },
    async resolveSlashCommandAuthorization(input) {
      return await resolveQQBotSlashCommandAuthorized(input);
    },
  };
}

async function resolveQQBotSlashCommandAuthorized(params: {
  cfg: unknown;
  accountId: string;
  isGroup: boolean;
  senderId: string;
  conversationId: string;
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  commandsAllowFrom?: Array<string | number> | null;
}): Promise<boolean> {
  const rawAllowFrom =
    params.commandsAllowFrom ??
    (params.isGroup && params.groupAllowFrom && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : params.allowFrom);
  const explicitAllowFrom = normalizeQQBotAllowFrom(rawAllowFrom).filter((entry) => entry !== "*");
  if (explicitAllowFrom.length === 0) {
    return false;
  }
  const resolved = await createChannelIngressResolver({
    channelId: "qqbot",
    accountId: params.accountId,
    identity: qqbotIngressIdentity,
    cfg: params.cfg as OpenClawConfig,
  }).message({
    subject: { stableId: params.senderId },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
    },
    event: {
      kind: "slash-command",
      authMode: "none",
      mayPair: false,
    },
    dmPolicy: "allowlist",
    groupPolicy: "open",
    allowFrom: explicitAllowFrom,
    command: {
      modeWhenAccessGroupsOff: "configured",
    },
  });
  return resolved.commandAccess.authorized;
}
