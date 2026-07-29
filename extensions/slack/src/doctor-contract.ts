// Slack plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  defineKeyMoveMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
} from "openclaw/plugin-sdk/runtime-doctor";
import { resolveSlackNativeStreaming, resolveSlackStreamingMode } from "./streaming-compat.js";

const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "slack",
  streaming: {
    // Slack maps its legacy draft stream modes (replace/status_final/append)
    // through its own resolver instead of the generic mode parser.
    defaultMode: "partial",
    resolveMode: resolveSlackStreamingMode,
    resolveNativeTransport: resolveSlackNativeStreaming,
  },
  dm: { root: true, accounts: true },
});

const dmReplyModeMigration = defineKeyMoveMigration({
  from: ["dm", "replyToMode"],
  to: ["replyToModeByChatType", "direct"],
});

const threadMentionPolicyMigration = defineKeyMoveMigration({
  from: ["thread", "requireExplicitMention"],
  to: ["implicitMentions", "threadParticipation"],
  // The retired boolean controlled only participated threads; the canonical
  // setting expresses the inverse while reply-to-bot policy stays independent.
  map: (value) => (typeof value === "boolean" ? { value: !value } : null),
  pruneEmptySource: true,
  movedMessage: ({ sourcePath, targetPath, mappedValue }) =>
    `Moved ${sourcePath} → ${targetPath} (${String(mappedValue)}).`,
});

const channelAllowMigration = defineKeyMoveMigration({
  scope: ["channels", "*"],
  from: ["allow"],
  to: ["enabled"],
});

function hasInteractiveRepliesCapability(value: unknown): boolean {
  const capabilities = asObjectRecord(value)?.capabilities;
  if (Array.isArray(capabilities)) {
    return capabilities.some(
      (entry) => typeof entry === "string" && entry.trim().toLowerCase() === "interactivereplies",
    );
  }
  const capabilitiesRecord = asObjectRecord(capabilities);
  return Boolean(
    capabilitiesRecord &&
    (Object.keys(capabilitiesRecord).length === 0 ||
      Object.hasOwn(capabilitiesRecord, "interactiveReplies")),
  );
}

function removeInteractiveRepliesCapability(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const capabilities = params.entry.capabilities;
  let nextCapabilities: unknown[] | Record<string, unknown>;
  let removedEmptyObject = false;
  if (Array.isArray(capabilities)) {
    nextCapabilities = capabilities.filter(
      (entry) =>
        !(typeof entry === "string" && entry.trim().toLowerCase() === "interactivereplies"),
    );
    if (nextCapabilities.length === capabilities.length) {
      return { entry: params.entry, changed: false };
    }
  } else {
    const capabilitiesRecord = asObjectRecord(capabilities);
    if (
      !capabilitiesRecord ||
      (Object.keys(capabilitiesRecord).length > 0 &&
        !Object.hasOwn(capabilitiesRecord, "interactiveReplies"))
    ) {
      return { entry: params.entry, changed: false };
    }
    removedEmptyObject = Object.keys(capabilitiesRecord).length === 0;
    const { interactiveReplies: _retired, ...rest } = capabilitiesRecord;
    nextCapabilities = rest;
  }

  const entry = { ...params.entry };
  const isEmpty = Array.isArray(nextCapabilities)
    ? nextCapabilities.length === 0
    : Object.keys(nextCapabilities).length === 0;
  if (isEmpty) {
    delete entry.capabilities;
  } else {
    entry.capabilities = nextCapabilities;
  }
  params.changes.push(
    removedEmptyObject
      ? `Removed retired empty ${params.pathPrefix}.capabilities object; use typed presentation actions instead.`
      : `Removed retired ${params.pathPrefix}.capabilities.interactiveReplies; use typed presentation actions instead.`,
  );
  return { entry, changed: true };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.capabilities.interactiveReplies is retired; use typed presentation actions instead. Run "openclaw doctor --fix".',
    match: hasInteractiveRepliesCapability,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.capabilities.interactiveReplies is retired; use typed presentation actions instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasInteractiveRepliesCapability),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.dm.replyToMode moved to replyToModeByChatType.direct. Run "openclaw doctor --fix".',
    match: dmReplyModeMigration.hasLegacy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.dm.replyToMode moved to replyToModeByChatType.direct. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, dmReplyModeMigration.hasLegacy),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.thread.requireExplicitMention is legacy; use channels.slack.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: threadMentionPolicyMigration.hasLegacy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.thread.requireExplicitMention is legacy; use channels.slack.accounts.<id>.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, threadMentionPolicyMigration.hasLegacy),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.channels.<id>.allow is legacy; use channels.slack.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: channelAllowMigration.hasLegacy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.channels.<id>.allow is legacy; use channels.slack.accounts.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, channelAllowMigration.hasLegacy),
  },
];

function normalizeSlackEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const retiredInteractiveReplies = removeInteractiveRepliesCapability(params);
  const dm = dmReplyModeMigration.normalize({
    ...params,
    entry: retiredInteractiveReplies.entry,
  });
  const thread = threadMentionPolicyMigration.normalize({ ...params, entry: dm.entry });
  const channels = channelAllowMigration.normalize({ ...params, entry: thread.entry });
  return {
    entry: channels.entry,
    changed: retiredInteractiveReplies.changed || dm.changed || thread.changed || channels.changed,
  };
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg, changes });
  return normalizeChannelConfigEntries({
    cfg: aliases.config,
    channelId: "slack",
    changes,
    normalizeEntry: normalizeSlackEntry,
  });
}
