import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowlistSetupWizardProxy,
  createEnvPatchedAccountSetupAdapter,
  createLegacyCompatChannelDmPolicy,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
  type ChannelSetupAdapter,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { inspectSlackAccount } from "./account-inspect.js";
import { resolveSlackAccount } from "./accounts.js";
import {
  buildSlackSetupLines,
  SLACK_CHANNEL as channel,
  isSlackSetupAccountConfigured,
  setSlackChannelAllowlist,
} from "./shared.js";

function enableSlackAccount(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  return patchChannelConfigForAccount({
    cfg,
    channel,
    accountId,
    patch: { enabled: true },
  });
}

function hasSlackInteractiveRepliesConfig(cfg: OpenClawConfig, accountId: string): boolean {
  const capabilities = resolveSlackAccount({ cfg, accountId }).config.capabilities;
  if (Array.isArray(capabilities)) {
    return capabilities.some(
      (entry) => normalizeLowercaseStringOrEmpty(entry) === "interactivereplies",
    );
  }
  if (!capabilities || typeof capabilities !== "object") {
    return false;
  }
  return "interactiveReplies" in capabilities;
}

function setSlackInteractiveReplies(
  cfg: OpenClawConfig,
  accountId: string,
  interactiveReplies: boolean,
): OpenClawConfig {
  const capabilities = resolveSlackAccount({ cfg, accountId }).config.capabilities;
  const nextCapabilities = Array.isArray(capabilities)
    ? interactiveReplies
      ? [...new Set([...capabilities, "interactiveReplies"])]
      : capabilities.filter(
          (entry) => normalizeLowercaseStringOrEmpty(entry) !== "interactivereplies",
        )
    : {
        ...((capabilities && typeof capabilities === "object" ? capabilities : {}) as Record<
          string,
          unknown
        >),
        interactiveReplies,
      };
  return patchChannelConfigForAccount({
    cfg,
    channel,
    accountId,
    patch: { capabilities: nextCapabilities },
  });
}

function createSlackTokenCredential(params: {
  inputKey: "botToken" | "appToken";
  providerHint: "slack-bot" | "slack-app";
  credentialLabel: string;
  preferredEnvVar: "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN";
  keepPrompt: string;
  inputPrompt: string;
}) {
  return {
    inputKey: params.inputKey,
    providerHint: params.providerHint,
    credentialLabel: params.credentialLabel,
    preferredEnvVar: params.preferredEnvVar,
    envPrompt: `${params.preferredEnvVar} detected. Use env var?`,
    keepPrompt: params.keepPrompt,
    inputPrompt: params.inputPrompt,
    allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
    inspect: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
      const resolved = resolveSlackAccount({ cfg, accountId });
      const configuredValue =
        params.inputKey === "botToken" ? resolved.config.botToken : resolved.config.appToken;
      const resolvedValue = params.inputKey === "botToken" ? resolved.botToken : resolved.appToken;
      return {
        accountConfigured: Boolean(resolvedValue) || hasConfiguredSecretInput(configuredValue),
        hasConfiguredValue: hasConfiguredSecretInput(configuredValue),
        resolvedValue: normalizeOptionalString(resolvedValue),
        envValue:
          accountId === DEFAULT_ACCOUNT_ID
            ? normalizeOptionalString(process.env[params.preferredEnvVar])
            : undefined,
      };
    },
    applyUseEnv: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
      enableSlackAccount(cfg, accountId),
    applySet: ({
      cfg,
      accountId,
      value,
    }: {
      cfg: OpenClawConfig;
      accountId: string;
      value: unknown;
    }) =>
      patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: {
          enabled: true,
          [params.inputKey]: value,
        },
      }),
  };
}

export const slackSetupAdapter: ChannelSetupAdapter = createEnvPatchedAccountSetupAdapter({
  channelKey: channel,
  defaultAccountOnlyEnvError: "Slack env tokens can only be used for the default account.",
  missingCredentialError: "Slack requires --bot-token and --app-token (or --use-env).",
  hasCredentials: (input) => Boolean(input.botToken && input.appToken),
  buildPatch: (input) => ({
    ...(input.botToken ? { botToken: input.botToken } : {}),
    ...(input.appToken ? { appToken: input.appToken } : {}),
  }),
});

export function createSlackSetupWizardBase(handlers: {
  promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
  resolveAllowFromEntries: NonNullable<
    NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]
  >;
  resolveGroupAllowlist: NonNullable<
    NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
  >;
}) {
  const slackDmPolicy: ChannelSetupDmPolicy = createLegacyCompatChannelDmPolicy({
    label: "Slack",
    channel,
    promptAllowFrom: handlers.promptAllowFrom,
  });

  return {
    channel,
    status: createStandardChannelSetupStatus({
      channelLabel: "Slack",
      configuredLabel: "configured",
      unconfiguredLabel: "needs tokens",
      configuredHint: "configured",
      unconfiguredHint: "needs tokens",
      configuredScore: 2,
      unconfiguredScore: 1,
      resolveConfigured: ({ cfg, accountId }) => inspectSlackAccount({ cfg, accountId }).configured,
    }),
    introNote: {
      title: "Slack socket mode tokens",
      lines: buildSlackSetupLines(),
      shouldShow: ({ cfg, accountId }) =>
        !isSlackSetupAccountConfigured(resolveSlackAccount({ cfg, accountId })),
    },
    envShortcut: {
      prompt: "SLACK_BOT_TOKEN + SLACK_APP_TOKEN detected. Use env vars?",
      preferredEnvVar: "SLACK_BOT_TOKEN",
      isAvailable: ({ cfg, accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID &&
        Boolean(process.env.SLACK_BOT_TOKEN?.trim()) &&
        Boolean(process.env.SLACK_APP_TOKEN?.trim()) &&
        !isSlackSetupAccountConfigured(resolveSlackAccount({ cfg, accountId })),
      apply: ({ cfg, accountId }) => enableSlackAccount(cfg, accountId),
    },
    credentials: [
      createSlackTokenCredential({
        inputKey: "botToken",
        providerHint: "slack-bot",
        credentialLabel: "Slack bot token",
        preferredEnvVar: "SLACK_BOT_TOKEN",
        keepPrompt: "Slack bot token already configured. Keep it?",
        inputPrompt: "Enter Slack bot token (xoxb-...)",
      }),
      createSlackTokenCredential({
        inputKey: "appToken",
        providerHint: "slack-app",
        credentialLabel: "Slack app token",
        preferredEnvVar: "SLACK_APP_TOKEN",
        keepPrompt: "Slack app token already configured. Keep it?",
        inputPrompt: "Enter Slack app token (xapp-...)",
      }),
    ],
    dmPolicy: slackDmPolicy,
    allowFrom: createAccountScopedAllowFromSection({
      channel,
      credentialInputKey: "botToken",
      helpTitle: "Slack allowlist",
      helpLines: [
        "Allowlist Slack DMs by username (we resolve to user ids).",
        "Examples:",
        "- U12345678",
        "- @alice",
        "Multiple entries: comma-separated.",
        `Docs: ${formatDocsLink("/slack", "slack")}`,
      ],
      message: "Slack allowFrom (usernames or ids)",
      placeholder: "@alice, U12345678",
      invalidWithoutCredentialNote: "Slack token missing; use user ids (or mention form) only.",
      parseId: (value: string) =>
        parseMentionOrPrefixedId({
          value,
          mentionPattern: /^<@([A-Z0-9]+)>$/i,
          prefixPattern: /^(slack:|user:)/i,
          idPattern: /^[A-Z][A-Z0-9]+$/i,
          normalizeId: (id) => id.toUpperCase(),
        }),
      resolveEntries: handlers.resolveAllowFromEntries,
    }),
    groupAccess: createAccountScopedGroupAccessSection({
      channel,
      label: "Slack channels",
      placeholder: "#general, #private, C123",
      currentPolicy: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        resolveSlackAccount({ cfg, accountId }).config.groupPolicy ?? "allowlist",
      currentEntries: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Object.entries(resolveSlackAccount({ cfg, accountId }).config.channels ?? {})
          .filter(([, value]) => value?.enabled !== false)
          .map(([key]) => key),
      updatePrompt: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Boolean(resolveSlackAccount({ cfg, accountId }).config.channels),
      resolveAllowlist: handlers.resolveGroupAllowlist,
      fallbackResolved: (entries) => entries,
      applyAllowlist: ({
        cfg,
        accountId,
        resolved,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        resolved: unknown;
      }) => setSlackChannelAllowlist(cfg, accountId, resolved as string[]),
    }),
    finalize: async ({ cfg, accountId, options, prompter }) => {
      if (hasSlackInteractiveRepliesConfig(cfg, accountId)) {
        return undefined;
      }
      if (options?.quickstartDefaults) {
        return {
          cfg: setSlackInteractiveReplies(cfg, accountId, true),
        };
      }
      const enableInteractiveReplies = await prompter.confirm({
        message: "Enable Slack interactive replies (buttons/selects) for agent responses?",
        initialValue: true,
      });
      return {
        cfg: setSlackInteractiveReplies(cfg, accountId, enableInteractiveReplies),
      };
    },
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  } satisfies ChannelSetupWizard;
}
export function createSlackSetupWizardProxy(
  loadWizard: () => Promise<{ slackSetupWizard: ChannelSetupWizard }>,
) {
  return createAllowlistSetupWizardProxy({
    loadWizard: async () => (await loadWizard()).slackSetupWizard,
    createBase: createSlackSetupWizardBase,
    fallbackResolvedGroupAllowlist: (entries) => entries,
  });
}
