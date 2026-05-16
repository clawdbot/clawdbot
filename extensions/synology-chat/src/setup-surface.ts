import {
  createAllowFromSection,
  createSetupTranslator,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  mergeAllowFromEntries,
  normalizeAccountId,
  setSetupChannelEnabled,
  splitSetupEntries,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listAccountIds, resolveAccount } from "./accounts.js";
import type { SynologyChatAccountRaw, SynologyChatChannelConfig } from "./types.js";

const t = createSetupTranslator();

const channel = "synology-chat" as const;
const DEFAULT_WEBHOOK_PATH = "/webhook/synology";

const SYNOLOGY_SETUP_HELP_LINES = [
  t("wizard.synologyChat.helpIncomingWebhook"),
  t("wizard.synologyChat.helpOutgoingWebhook"),
  t("wizard.synologyChat.helpPointWebhook", { path: DEFAULT_WEBHOOK_PATH }),
  t("wizard.synologyChat.helpAllowedUsers"),
  `Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`,
];

const SYNOLOGY_ALLOW_FROM_HELP_LINES = [
  t("wizard.synologyChat.allowlistIntro"),
  t("wizard.synologyChat.examples"),
  "- 123456",
  "- synology-chat:123456",
  t("wizard.synologyChat.multipleEntries"),
  `Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`,
];

function getChannelConfig(cfg: OpenClawConfig): SynologyChatChannelConfig {
  return (cfg.channels?.[channel] as SynologyChatChannelConfig | undefined) ?? {};
}

function getRawAccountConfig(cfg: OpenClawConfig, accountId: string): SynologyChatAccountRaw {
  const channelConfig = getChannelConfig(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return channelConfig;
  }
  return channelConfig.accounts?.[accountId] ?? {};
}

function patchSynologyChatAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const channelConfig = getChannelConfig(params.cfg);
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    const nextChannelConfig = { ...channelConfig } as Record<string, unknown>;
    for (const field of params.clearFields ?? []) {
      delete nextChannelConfig[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [channel]: {
          ...nextChannelConfig,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const nextAccounts = { ...channelConfig.accounts } as Record<string, Record<string, unknown>>;
  const nextAccountConfig = { ...nextAccounts[params.accountId] };
  for (const field of params.clearFields ?? []) {
    delete nextAccountConfig[field];
  }
  nextAccounts[params.accountId] = {
    ...nextAccountConfig,
    ...(params.enabled ? { enabled: true } : {}),
    ...params.patch,
  };

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [channel]: {
        ...channelConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: nextAccounts,
      },
    },
  };
}

function isSynologyChatConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const account = resolveAccount(cfg, accountId);
  return Boolean(account.token.trim() && account.incomingUrl.trim());
}

function validateWebhookUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Incoming webhook must use http:// or https://.";
    }
  } catch {
    return "Incoming webhook must be a valid URL.";
  }
  return undefined;
}

function validateWebhookPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("/") ? undefined : "Webhook path must start with /.";
}

function parseSynologyUserId(value: string): string | null {
  const cleaned = value.replace(/^synology(?:[-_]?chat)?:/i, "").trim();
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

function normalizeSynologyAllowedUserId(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`.trim();
  }
  return "";
}

function resolveExistingAllowedUserIds(cfg: OpenClawConfig, accountId: string): string[] {
  const raw = getRawAccountConfig(cfg, accountId).allowedUserIds;
  if (Array.isArray(raw)) {
    return raw.map(normalizeSynologyAllowedUserId).filter(Boolean);
  }
  return normalizeSynologyAllowedUserId(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const synologyChatSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID,
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "Synology Chat env credentials only support the default account.";
    }
    if (!input.useEnv && !input.token?.trim()) {
      return "Synology Chat requires --token or --use-env.";
    }
    if (!input.url?.trim()) {
      return "Synology Chat requires --url for the incoming webhook.";
    }
    const urlError = validateWebhookUrl(input.url.trim());
    if (urlError) {
      return urlError;
    }
    if (input.webhookPath?.trim()) {
      return validateWebhookPath(input.webhookPath.trim()) ?? null;
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) =>
    patchSynologyChatAccountConfig({
      cfg,
      accountId,
      enabled: true,
      clearFields: input.useEnv ? ["token"] : undefined,
      patch: {
        ...(input.useEnv ? {} : { token: input.token?.trim() }),
        incomingUrl: input.url?.trim(),
        ...(input.webhookPath?.trim() ? { webhookPath: input.webhookPath.trim() } : {}),
      },
    }),
};

export const synologyChatSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Synology Chat",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsTokenIncomingWebhook"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsTokenIncomingWebhook"),
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      accountId
        ? isSynologyChatConfigured(cfg, accountId)
        : listAccountIds(cfg).some((candidateAccountId) =>
            isSynologyChatConfigured(cfg, candidateAccountId),
          ),
    resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listAccountIds(cfg).length || 0}`],
  }),
  introNote: {
    title: t("wizard.synologyChat.setupTitle"),
    lines: SYNOLOGY_SETUP_HELP_LINES,
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "outgoing webhook token",
      preferredEnvVar: "SYNOLOGY_CHAT_TOKEN",
      helpTitle: t("wizard.synologyChat.webhookTokenTitle"),
      helpLines: SYNOLOGY_SETUP_HELP_LINES,
      envPrompt: t("wizard.synologyChat.tokenEnvPrompt"),
      keepPrompt: t("wizard.synologyChat.tokenKeep"),
      inputPrompt: t("wizard.synologyChat.tokenInput"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const account = resolveAccount(cfg, accountId);
        const raw = getRawAccountConfig(cfg, accountId);
        return {
          accountConfigured: isSynologyChatConfigured(cfg, accountId),
          hasConfiguredValue: Boolean(normalizeOptionalString(raw.token)),
          resolvedValue: normalizeOptionalString(account.token),
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.SYNOLOGY_CHAT_TOKEN)
              : undefined,
        };
      },
      applyUseEnv: async ({ cfg, accountId }) =>
        patchSynologyChatAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["token"],
          patch: {},
        }),
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        patchSynologyChatAccountConfig({
          cfg,
          accountId,
          enabled: true,
          patch: { token: resolvedValue },
        }),
    },
  ],
  textInputs: [
    {
      inputKey: "url",
      message: t("wizard.synologyChat.incomingWebhookUrlPrompt"),
      placeholder:
        "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming...",
      helpTitle: t("wizard.synologyChat.incomingWebhookTitle"),
      helpLines: [
        t("wizard.synologyChat.incomingWebhookHelpUseUrl"),
        t("wizard.synologyChat.incomingWebhookHelpReplies"),
      ],
      currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).incomingUrl?.trim(),
      keepPrompt: (value) => t("wizard.synologyChat.incomingWebhookKeep", { value }),
      validate: ({ value }) => validateWebhookUrl(value),
      applySet: async ({ cfg, accountId, value }) =>
        patchSynologyChatAccountConfig({
          cfg,
          accountId,
          enabled: true,
          patch: { incomingUrl: value.trim() },
        }),
    },
    {
      inputKey: "webhookPath",
      message: t("wizard.synologyChat.outgoingWebhookPathPrompt"),
      placeholder: DEFAULT_WEBHOOK_PATH,
      required: false,
      applyEmptyValue: true,
      helpTitle: t("wizard.synologyChat.outgoingWebhookPathTitle"),
      helpLines: [
        t("wizard.synologyChat.defaultPath", { path: DEFAULT_WEBHOOK_PATH }),
        t("wizard.synologyChat.outgoingWebhookPathHelp"),
      ],
      currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).webhookPath?.trim(),
      keepPrompt: (value) => t("wizard.synologyChat.outgoingWebhookPathKeep", { value }),
      validate: ({ value }) => validateWebhookPath(value),
      applySet: async ({ cfg, accountId, value }) =>
        patchSynologyChatAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: value.trim() ? undefined : ["webhookPath"],
          patch: value.trim() ? { webhookPath: value.trim() } : {},
        }),
    },
  ],
  allowFrom: createAllowFromSection({
    helpTitle: t("wizard.synologyChat.allowlistTitle"),
    helpLines: SYNOLOGY_ALLOW_FROM_HELP_LINES,
    message: t("wizard.synologyChat.allowedUserIdsPrompt"),
    placeholder: "123456, 987654",
    invalidWithoutCredentialNote: t("wizard.synologyChat.allowedUserIdsInvalid"),
    parseInputs: splitSetupEntries,
    parseId: parseSynologyUserId,
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchSynologyChatAccountConfig({
        cfg,
        accountId,
        enabled: true,
        patch: {
          dmPolicy: "allowlist",
          allowedUserIds: mergeAllowFromEntries(
            resolveExistingAllowedUserIds(cfg, accountId),
            allowFrom,
          ),
        },
      }),
  }),
  completionNote: {
    title: t("wizard.synologyChat.accessControlTitle"),
    lines: [
      `Default outgoing webhook path: ${DEFAULT_WEBHOOK_PATH}`,
      'Set allowed user IDs, or manually switch `channels.synology-chat.dmPolicy` to `"open"` with `allowedUserIds: ["*"]` for public DMs.',
      'With `dmPolicy="allowlist"`, an empty allowedUserIds list blocks the route from starting.',
      `Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`,
    ],
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
