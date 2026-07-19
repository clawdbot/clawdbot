// Googlechat plugin module implements channel base behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type GoogleChatConfigAccessorAccount,
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatConfigAccessorAccount,
  resolveGoogleChatAccount,
  type ResolvedGoogleChatAccount,
} from "./accounts.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

export const GOOGLECHAT_CHANNEL_ID = "googlechat" as const;

const googlechatMeta = {
  id: GOOGLECHAT_CHANNEL_ID,
  label: "Google Chat",
  selectionLabel: "Google Chat (Chat API)",
  docsPath: "/channels/googlechat",
  docsLabel: "googlechat",
  blurb: "Google Workspace Chat app with HTTP webhook.",
  aliases: ["gchat", "google-chat"],
  order: 55,
  detailLabel: "Google Chat",
  systemImage: "message.badge",
  markdownCapable: true,
};

export const formatGoogleChatAllowFromEntry = (entry: string) =>
  normalizeLowercaseStringOrEmpty(
    entry
      .trim()
      .replace(/^(googlechat|google-chat|gchat):/i, "")
      .replace(/^user:/i, "")
      .replace(/^users\//i, ""),
  );

const googleChatConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedGoogleChatAccount,
  GoogleChatConfigAccessorAccount
>({
  sectionKey: GOOGLECHAT_CHANNEL_ID,
  listAccountIds: listGoogleChatAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
  resolveAccessorAccount: resolveGoogleChatConfigAccessorAccount,
  defaultAccountId: resolveDefaultGoogleChatAccountId,
  clearBaseFields: [
    "serviceAccount",
    "serviceAccountFile",
    "audienceType",
    "audience",
    "webhookPath",
    "webhookUrl",
    "botUser",
    "name",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: formatGoogleChatAllowFromEntry,
    }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});

type GoogleChatPluginBase = Pick<
  ChannelPlugin<ResolvedGoogleChatAccount>,
  | "id"
  | "meta"
  | "setup"
  | "setupWizard"
  | "capabilities"
  | "streaming"
  | "reload"
  | "configSchema"
  | "config"
>;

export function createGoogleChatPluginBase(
  params: {
    configSchema?: ChannelPlugin<ResolvedGoogleChatAccount>["configSchema"];
  } = {},
): GoogleChatPluginBase {
  return {
    id: GOOGLECHAT_CHANNEL_ID,
    meta: { ...googlechatMeta },
    setup: googlechatSetupAdapter,
    setupWizard: googlechatSetupWizard,
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      threads: true,
      // Inbound attachment download remains supported even though service-account
      // authentication cannot use Google Chat's user-auth-only upload endpoint.
      media: true,
      nativeCommands: false,
      blockStreaming: true,
    },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    reload: { configPrefixes: ["channels.googlechat"] },
    ...(params.configSchema ? { configSchema: params.configSchema } : {}),
    config: {
      ...googleChatConfigAdapter,
      isConfigured: (account) => account.credentialSource !== "none",
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.credentialSource !== "none",
          extra: {
            credentialSource: account.credentialSource,
            tokenStatus: account.tokenStatus,
          },
        }),
    },
  };
}
