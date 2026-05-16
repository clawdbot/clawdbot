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
  createSetupTranslator,
  type ChannelSetupAdapter,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectSlackAccount } from "./account-inspect.js";
import { resolveSlackAccount } from "./accounts.js";
import {
  buildSlackManifest,
  buildSlackSetupLines,
  isSlackSetupAccountConfigured,
  SLACK_CHANNEL as channel,
  setSlackChannelAllowlist,
} from "./setup-shared.js";

const t = createSetupTranslator();

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
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsTokens"),
      configuredHint: t("wizard.channels.statusConfigured"),
      unconfiguredHint: t("wizard.channels.statusNeedsTokens"),
      configuredScore: 2,
      unconfiguredScore: 1,
      resolveConfigured: ({ cfg, accountId }) => inspectSlackAccount({ cfg, accountId }).configured,
    }),
    introNote: {
      title: t("wizard.slack.socketModeTokensTitle"),
      lines: buildSlackSetupLines(),
      shouldShow: ({ cfg, accountId }) =>
        !isSlackSetupAccountConfigured(resolveSlackAccount({ cfg, accountId })),
    },
    prepare: async ({ cfg, accountId, prompter }) => {
      if (isSlackSetupAccountConfigured(resolveSlackAccount({ cfg, accountId }))) {
        return;
      }
      const manifest = buildSlackManifest();
      if (prompter.plain) {
        await prompter.plain(manifest);
      } else {
        await prompter.note(manifest, "Slack manifest JSON");
      }
    },
    envShortcut: {
      prompt: t("wizard.slack.envPrompt"),
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
        credentialLabel: t("wizard.slack.botToken"),
        preferredEnvVar: "SLACK_BOT_TOKEN",
        keepPrompt: t("wizard.slack.botTokenKeep"),
        inputPrompt: t("wizard.slack.botTokenInput"),
      }),
      createSlackTokenCredential({
        inputKey: "appToken",
        providerHint: "slack-app",
        credentialLabel: t("wizard.slack.appToken"),
        preferredEnvVar: "SLACK_APP_TOKEN",
        keepPrompt: t("wizard.slack.appTokenKeep"),
        inputPrompt: t("wizard.slack.appTokenInput"),
      }),
    ],
    dmPolicy: slackDmPolicy,
    allowFrom: createAccountScopedAllowFromSection({
      channel,
      credentialInputKey: "botToken",
      helpTitle: t("wizard.slack.allowlistTitle"),
      helpLines: [
        t("wizard.slack.allowlistIntro"),
        t("wizard.slack.examples"),
        "- U12345678",
        "- @alice",
        t("wizard.slack.multipleEntries"),
        t("wizard.channels.docs", { link: formatDocsLink("/slack", "slack") }),
      ],
      message: t("wizard.slack.allowFromPrompt"),
      placeholder: "@alice, U12345678",
      invalidWithoutCredentialNote: t("wizard.slack.allowFromInvalidWithoutToken"),
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
      label: t("wizard.slack.channelsLabel"),
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
        message: t("wizard.slack.interactiveRepliesPrompt"),
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
