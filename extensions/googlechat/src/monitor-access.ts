import {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { ChannelBotLoopProtectionConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  createChannelPairingController,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OpenClawConfig,
} from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import type { GoogleChatCoreRuntime } from "./monitor-types.js";
import type { GoogleChatAnnotation, GoogleChatMessage, GoogleChatSpace } from "./types.js";

function normalizeUserId(raw?: string | null): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(trimmed.replace(/^users\//i, ""));
}

const GOOGLECHAT_EMAIL_KIND = "plugin:googlechat-email" as const;

function normalizeEntryValue(raw?: string | null): string {
  return normalizeLowercaseStringOrEmpty(raw ?? "");
}

function normalizeGoogleChatStableEntry(entry: string): string | null {
  const withoutProvider = normalizeEntryValue(entry).replace(
    /^(googlechat|google-chat|gchat):/i,
    "",
  );
  if (!withoutProvider) {
    return null;
  }
  return withoutProvider.startsWith("users/") ? normalizeUserId(withoutProvider) : withoutProvider;
}

function normalizeGoogleChatEmailEntry(entry: string): string | null {
  const withoutProvider = normalizeEntryValue(entry).replace(
    /^(googlechat|google-chat|gchat):/i,
    "",
  );
  if (withoutProvider.startsWith("users/")) {
    return null;
  }
  const stable = normalizeGoogleChatStableEntry(entry);
  return stable?.includes("@") ? stable : null;
}

const googleChatIngressIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  normalizeEntry: normalizeGoogleChatStableEntry,
  normalizeSubject: normalizeUserId,
  aliases: [
    {
      key: "email",
      kind: GOOGLECHAT_EMAIL_KIND,
      normalizeEntry: normalizeGoogleChatEmailEntry,
      normalizeSubject: normalizeEntryValue,
      dangerous: true,
    },
  ],
  isWildcardEntry: (entry) => normalizeEntryValue(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    fieldKey === "stableId"
      ? `entry-${entryIndex + 1}:user`
      : `entry-${entryIndex + 1}:${fieldKey}`,
});

type GoogleChatGroupEntry = {
  requireMention?: boolean;
  enabled?: boolean;
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  users?: Array<string | number>;
  systemPrompt?: string;
};

function resolveGroupConfig(params: {
  groupId: string;
  groupName?: string | null;
  groups?: Record<string, GoogleChatGroupEntry>;
}) {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { entry: undefined, allowlistConfigured: false, deprecatedNameMatch: false };
  }
  const entry = entries[groupId];
  const normalizedGroupName = normalizeLowercaseStringOrEmpty(groupName ?? "");
  const deprecatedNameMatch =
    !entry &&
    Boolean(
      groupName &&
      keys.some((key) => {
        const trimmed = key.trim();
        if (!trimmed || trimmed === "*" || /^spaces\//i.test(trimmed)) {
          return false;
        }
        return (
          trimmed === groupName || normalizeLowercaseStringOrEmpty(trimmed) === normalizedGroupName
        );
      }),
    );
  const fallback = entries["*"];
  return {
    entry: deprecatedNameMatch ? undefined : (entry ?? fallback),
    allowlistConfigured: true,
    fallback,
    deprecatedNameMatch,
  };
}

function extractMentionInfo(annotations: GoogleChatAnnotation[], botUser?: string | null) {
  const mentionAnnotations = annotations.filter((entry) => entry.type === "USER_MENTION");
  const hasAnyMention = mentionAnnotations.length > 0;
  const botTargets = new Set(["users/app", botUser?.trim()].filter(Boolean) as string[]);
  const wasMentioned = mentionAnnotations.some((entry) => {
    const userName = entry.userMention?.user?.name;
    if (!userName) {
      return false;
    }
    if (botTargets.has(userName)) {
      return true;
    }
    return normalizeUserId(userName) === "app";
  });
  return { hasAnyMention, wasMentioned };
}

const warnedDeprecatedUsersEmailAllowFrom = new Set<string>();
const warnedMutableGroupKeys = new Set<string>();

function warnDeprecatedUsersEmailEntries(logVerbose: (message: string) => void, entries: string[]) {
  const deprecated = entries
    .map((v) => normalizeOptionalString(v))
    .filter((v): v is string => Boolean(v))
    .filter((v) => /^users\/.+@.+/i.test(v));
  if (deprecated.length === 0) {
    return;
  }
  const key = deprecated
    .map((v) => normalizeLowercaseStringOrEmpty(v))
    .toSorted((a, b) => a.localeCompare(b))
    .join(",");
  if (warnedDeprecatedUsersEmailAllowFrom.has(key)) {
    return;
  }
  warnedDeprecatedUsersEmailAllowFrom.add(key);
  logVerbose(
    `Deprecated allowFrom entry detected: "users/<email>" is no longer treated as an email allowlist. Use raw email (alice@example.com) or immutable user id (users/<id>). entries=${deprecated.join(", ")}`,
  );
}

function warnMutableGroupKeysConfigured(
  logVerbose: (message: string) => void,
  groups?: Record<string, GoogleChatGroupEntry>,
) {
  const mutableKeys = Object.keys(groups ?? {})
    .map((key) => key.trim())
    .filter((key) => key && key !== "*" && !/^spaces\//i.test(key));
  if (mutableKeys.length === 0) {
    return;
  }
  const warningKey = mutableKeys
    .map((key) => normalizeLowercaseStringOrEmpty(key))
    .toSorted((a, b) => a.localeCompare(b))
    .join(",");
  if (warnedMutableGroupKeys.has(warningKey)) {
    return;
  }
  warnedMutableGroupKeys.add(warningKey);
  logVerbose(
    `Deprecated Google Chat group key detected: group routing now requires stable space ids (spaces/<spaceId>). Update channels.googlechat.groups keys: ${mutableKeys.join(", ")}`,
  );
}

export async function applyGoogleChatInboundAccessPolicy(params: {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  core: GoogleChatCoreRuntime;
  space: GoogleChatSpace;
  message: GoogleChatMessage;
  isGroup: boolean;
  senderId: string;
  senderName: string;
  senderEmail?: string;
  rawBody: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  logVerbose: (message: string) => void;
}): Promise<
  | {
      ok: true;
      commandAuthorized: boolean | undefined;
      effectiveWasMentioned: boolean | undefined;
      groupBotLoopProtection: ChannelBotLoopProtectionConfig | undefined;
      groupSystemPrompt: string | undefined;
    }
  | { ok: false }
> {
  const {
    account,
    config,
    core,
    space,
    message,
    isGroup,
    senderId,
    senderName,
    senderEmail,
    rawBody,
    statusSink,
    logVerbose,
  } = params;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const spaceId = space.name ?? "";
  const pairing = createChannelPairingController({
    core,
    channel: "googlechat",
    accountId: account.accountId,
  });

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.googlechat !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "googlechat",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.space,
    log: logVerbose,
  });
  warnMutableGroupKeysConfigured(logVerbose, account.config.groups ?? undefined);
  const groupConfigResolved = resolveGroupConfig({
    groupId: spaceId,
    groupName: space.displayName ?? null,
    groups: account.config.groups ?? undefined,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];
  let effectiveWasMentioned: boolean | undefined;
  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const rawConfigAllowFrom = normalizeStringEntries(account.config.dm?.allowFrom);
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const groupActivation = (() => {
    if (!isGroup) {
      return undefined;
    }
    const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
    const mentionInfo = extractMentionInfo(message.annotations ?? [], account.config.botUser);
    return {
      requireMention,
      allowTextCommands: core.channel.commands.shouldHandleTextCommands({
        cfg: config,
        surface: "googlechat",
      }),
      hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
      wasMentioned: mentionInfo.wasMentioned,
      hasAnyMention: mentionInfo.hasAnyMention,
    };
  })();
  const command = {
    hasControlCommand: groupActivation?.hasControlCommand ?? shouldComputeAuth,
    groupOwnerAllowFrom: "none" as const,
  };
  const groupAllowFrom = normalizeStringEntries(groupUsers);
  const senderGroupPolicy =
    groupConfigResolved.allowlistConfigured && groupAllowFrom.length === 0
      ? groupPolicy
      : groupPolicy === "disabled"
        ? "disabled"
        : groupAllowFrom.length > 0
          ? "allowlist"
          : "open";
  const route = channelIngressRoutes(
    isGroup &&
      groupPolicy !== "disabled" &&
      groupEntry?.enabled === false && {
        id: "googlechat:space",
        enabled: false,
        matched: true,
        matchId: "googlechat-space",
        blockReason: "route_disabled",
      },
    isGroup &&
      groupPolicy === "allowlist" &&
      groupEntry?.enabled !== false &&
      !groupConfigResolved.allowlistConfigured && {
        id: "googlechat:space",
        allowed: false,
        blockReason: "empty_allowlist",
      },
    isGroup &&
      groupPolicy === "allowlist" &&
      groupEntry?.enabled !== false &&
      groupConfigResolved.allowlistConfigured && {
        id: "googlechat:space",
        senderPolicy: "deny-when-empty" as const,
        ...(groupEntry ? { senderAllowFromSource: "effective-group" as const } : {}),
        allowed: Boolean(groupEntry),
        matchId: "googlechat-space",
        blockReason: groupEntry ? "sender_empty_allowlist" : "route_not_allowlisted",
      },
  );
  const resolvedAccess = await createChannelIngressResolver({
    channelId: "googlechat",
    accountId: account.accountId,
    identity: googleChatIngressIdentity,
    cfg: config,
    readStoreAllowFrom: pairing.readAllowFromStore,
  }).message({
    subject: {
      stableId: senderId,
      aliases: { email: senderEmail },
    },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: spaceId,
    },
    route,
    allowFrom: rawConfigAllowFrom,
    groupAllowFrom,
    dmPolicy,
    groupPolicy: senderGroupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
      ...(groupActivation
        ? {
            activation: {
              requireMention: groupActivation.requireMention,
              allowTextCommands: groupActivation.allowTextCommands,
            },
          }
        : {}),
    },
    ...(groupActivation == null
      ? {}
      : {
          mentionFacts: {
            canDetectMention: true,
            wasMentioned: groupActivation.wasMentioned,
            hasAnyMention: groupActivation.hasAnyMention,
            implicitMentionKinds: [],
          },
        }),
    command,
  });
  const senderAccess = resolvedAccess.senderAccess;
  const commandAuthorized = resolvedAccess.commandAccess.requested
    ? resolvedAccess.commandAccess.authorized
    : undefined;

  if (isGroup) {
    if (groupConfigResolved.deprecatedNameMatch) {
      logVerbose(`drop group message (deprecated mutable group key matched, space=${spaceId})`);
      return { ok: false };
    }
    const routeBlockReason = resolvedAccess.routeAccess.reason;
    if (routeBlockReason && routeBlockReason !== "sender_empty_allowlist") {
      if (routeBlockReason === "empty_allowlist") {
        logVerbose(`drop group message (groupPolicy=allowlist, no allowlist, space=${spaceId})`);
      } else if (routeBlockReason === "route_not_allowlisted") {
        logVerbose(`drop group message (not allowlisted, space=${spaceId})`);
      } else if (routeBlockReason === "route_disabled") {
        logVerbose(`drop group message (space disabled, space=${spaceId})`);
      }
      return { ok: false };
    }

    if (senderAccess.effectiveGroupAllowFrom.length > 0 && senderAccess.decision !== "allow") {
      warnDeprecatedUsersEmailEntries(logVerbose, senderAccess.effectiveGroupAllowFrom);
      logVerbose(`drop group message (sender not allowed, ${senderId})`);
      return { ok: false };
    }
  }

  const effectiveAllowFrom = senderAccess.effectiveAllowFrom;
  warnDeprecatedUsersEmailEntries(logVerbose, effectiveAllowFrom);

  if (isGroup && resolvedAccess.activationAccess.ran) {
    effectiveWasMentioned = resolvedAccess.activationAccess.effectiveWasMentioned;
    if (resolvedAccess.activationAccess.shouldSkip) {
      logVerbose(`drop group message (mention required, space=${spaceId})`);
      return { ok: false };
    }
  }

  if (isGroup && senderAccess.decision !== "allow") {
    const reason =
      resolvedAccess.ingress.reasonCode === "route_sender_empty"
        ? "groupPolicy=allowlist (empty allowlist)"
        : senderAccess.reasonCode;
    logVerbose(`drop group message (sender policy blocked, reason=${reason}, space=${spaceId})`);
    return { ok: false };
  }

  if (!isGroup) {
    if (account.config.dm?.enabled === false) {
      logVerbose(`Blocked Google Chat DM from ${senderId} (dmPolicy=disabled)`);
      return { ok: false };
    }

    if (senderAccess.decision !== "allow") {
      if (senderAccess.decision === "pairing") {
        await pairing.issueChallenge({
          senderId,
          senderIdLine: `Your Google Chat user id: ${senderId}`,
          meta: { name: senderName || undefined, email: senderEmail },
          onCreated: () => {
            logVerbose(`googlechat pairing request sender=${senderId}`);
          },
          sendPairingReply: async (text) => {
            await sendGoogleChatMessage({
              account,
              space: spaceId,
              text,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (err) => {
            logVerbose(`pairing reply failed for ${senderId}: ${String(err)}`);
          },
        });
      } else {
        logVerbose(`Blocked unauthorized Google Chat sender ${senderId} (dmPolicy=${dmPolicy})`);
      }
      return { ok: false };
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(`googlechat: drop control command from ${senderId}`);
    return { ok: false };
  }

  return {
    ok: true,
    commandAuthorized,
    effectiveWasMentioned,
    groupBotLoopProtection: groupEntry?.botLoopProtection,
    groupSystemPrompt: normalizeOptionalString(groupEntry?.systemPrompt),
  };
}
