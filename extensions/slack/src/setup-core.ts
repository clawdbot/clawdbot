import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
// Slack plugin module implements setup core behavior.
import {
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowlistSetupWizardProxy,
  createPatchedAccountSetupAdapter,
  createLegacyCompatChannelDmPolicy,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  defineTokenCredential,
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
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectSlackAccount } from "./account-inspect.js";
import {
  buildSlackManifest,
  buildSlackSetupLines,
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

function setSlackSetupIdentity(params: {
  cfg: OpenClawConfig;
  accountId: string;
  identity: "bot" | "user";
}): OpenClawConfig {
  const next = patchChannelConfigForAccount({
    cfg: params.cfg,
    channel,
    accountId: params.accountId,
    patch: params.identity === "user" ? { identity: "user" } : {},
  });
  if (params.identity === "user") {
    return next;
  }

  const slack = next.channels?.slack as
    | (Record<string, unknown> & { accounts?: Record<string, Record<string, unknown>> })
    | undefined;
  if (!slack) {
    return next;
  }
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    const nextSlack = { ...slack };
    delete nextSlack.identity;
    return {
      ...next,
      channels: {
        ...next.channels,
        slack: nextSlack,
      },
    } as OpenClawConfig;
  }

  const account = slack.accounts?.[params.accountId];
  if (!account) {
    return next;
  }
  const nextAccount = { ...account };
  if (slack.identity === "user") {
    // Named accounts inherit the root identity, so an explicit bot value is
    // required only when overriding a user-identity channel default.
    nextAccount.identity = "bot";
  } else {
    delete nextAccount.identity;
  }
  return {
    ...next,
    channels: {
      ...next.channels,
      slack: {
        ...slack,
        accounts: {
          ...slack.accounts,
          [params.accountId]: nextAccount,
        },
      },
    },
  } as OpenClawConfig;
}

function hasSlackInteractiveRepliesConfig(cfg: OpenClawConfig, accountId: string): boolean {
  const capabilities = inspectSlackAccount({ cfg, accountId }).config.capabilities;
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
  const capabilities = inspectSlackAccount({ cfg, accountId }).config.capabilities;
  const nextCapabilities = Array.isArray(capabilities)
    ? interactiveReplies
      ? uniqueStrings([...capabilities, "interactiveReplies"])
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
  inputKey: "botToken" | "appToken" | "userToken" | "signingSecret";
  providerHint: string;
  credentialLabel: string;
  preferredEnvVar?: "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN" | "SLACK_USER_TOKEN";
  keepPrompt: string;
  inputPrompt: string;
  shouldPrompt: NonNullable<ChannelSetupWizard["credentials"]>[number]["shouldPrompt"];
}) {
  return defineTokenCredential({
    inputKey: params.inputKey,
    configKey: params.inputKey,
    providerHint: params.providerHint,
    credentialLabel: params.credentialLabel,
    preferredEnvVar: params.preferredEnvVar,
    envPrompt: params.preferredEnvVar
      ? `${params.preferredEnvVar} detected. Use env var?`
      : "Use the configured Slack credential?",
    keepPrompt: params.keepPrompt,
    inputPrompt: params.inputPrompt,
    allowEnv: ({ accountId }: { accountId: string }) =>
      Boolean(params.preferredEnvVar) && accountId === DEFAULT_ACCOUNT_ID,
    resolveAccount: ({ cfg, accountId }) => inspectSlackAccount({ cfg, accountId }),
    resolvedValue: (account) => {
      if (params.inputKey === "botToken") {
        return normalizeOptionalString(account.botToken);
      }
      if (params.inputKey === "appToken") {
        return normalizeOptionalString(account.appToken);
      }
      if (params.inputKey === "userToken") {
        return normalizeOptionalString(account.userToken);
      }
      return normalizeSecretInputString(account.config.signingSecret);
    },
    envValue: ({ accountId }) =>
      params.preferredEnvVar && accountId === DEFAULT_ACCOUNT_ID
        ? normalizeOptionalString(process.env[params.preferredEnvVar])
        : undefined,
    patchAccount: ({ cfg, accountId, mode, patch }) =>
      mode === "env"
        ? enableSlackAccount(cfg, accountId)
        : patchChannelConfigForAccount({
            cfg,
            channel,
            accountId,
            patch: { enabled: true, ...patch },
          }),
    useEnv: { clearFields: [] },
    set: {},
    shouldPrompt: params.shouldPrompt,
  });
}

function hasSlackSetupCredentials(params: {
  input: ChannelSetupInput;
  identity: "bot" | "user";
  mode: "socket" | "http" | "relay";
}): boolean {
  if (params.identity !== "user") {
    const { input } = params;
    return Boolean(input.botToken && input.appToken);
  }
  if (params.mode === "http") {
    return Boolean(params.input.userToken && params.input.signingSecret);
  }
  return params.mode === "socket" && Boolean(params.input.userToken && params.input.appToken);
}

const slackSetupAdapterBase = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: ({ cfg, accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "Slack env tokens can only be used for the default account.";
    }
    const account = inspectSlackAccount({ cfg, accountId });
    const identity = input.identity ?? account.config.identity ?? "bot";
    const mode = input.mode ?? account.config.mode ?? "socket";
    if (identity === "user" && mode === "relay") {
      return 'Slack user identity setup supports mode "socket" or "http", not "relay".';
    }
    if (input.useEnv) {
      return identity === "user"
        ? "Slack user identity setup does not support --use-env; configure userToken and the transport credential explicitly."
        : null;
    }
    if (hasSlackSetupCredentials({ input, identity, mode })) {
      return null;
    }
    if (identity === "user") {
      return mode === "http"
        ? "Slack user identity requires --user-token and --signing-secret."
        : "Slack user identity requires --user-token and --app-token.";
    }
    return "Slack requires --bot-token and --app-token (or --use-env).";
  },
  buildPatch: (input) => ({
    ...(input.identity ? { identity: input.identity } : {}),
    ...(input.identity === "user" && input.mode ? { mode: input.mode } : {}),
    ...(input.botToken ? { botToken: input.botToken } : {}),
    ...(input.appToken ? { appToken: input.appToken } : {}),
    ...(input.userToken ? { userToken: input.userToken } : {}),
    ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}),
  }),
});

export const slackSetupAdapter: ChannelSetupAdapter = {
  ...slackSetupAdapterBase,
  singleAccountKeysToMove: ["appToken"],
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const identity = input.identity ?? inspectSlackAccount({ cfg, accountId }).config.identity;
    return slackSetupAdapterBase.applyAccountConfig({
      cfg,
      accountId,
      input: identity === "user" ? { ...input, identity } : input,
    });
  },
};

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
    prepare: async ({ cfg, accountId, prompter }) => {
      const currentAccount = inspectSlackAccount({ cfg, accountId });
      // Configured implicit-bot accounts historically skip this step. An
      // explicit user identity still needs the selector to return to bot.
      if (currentAccount.configured && currentAccount.config.identity !== "user") {
        return { cfg };
      }
      const identity = await prompter.select<"bot" | "user">({
        message: "How should OpenClaw appear in Slack?",
        options: [
          { value: "bot", label: "Slack bot", hint: "Post as the Slack app (default)" },
          { value: "user", label: "Slack user", hint: "Post as the authorizing human" },
        ],
        initialValue: currentAccount.config.identity ?? "bot",
      });
      const next = setSlackSetupIdentity({
        cfg,
        accountId,
        identity,
      });
      if (currentAccount.configured && identity === currentAccount.config.identity) {
        return { cfg: next };
      }
      if (identity === "user") {
        if (currentAccount.config.mode === "relay") {
          throw new Error(
            'Slack user identity setup supports mode "socket" or "http", not "relay".',
          );
        }
        await prompter.note(
          [
            "Use a Slack user OAuth token with the User Token Scopes listed in the Slack docs.",
            "Subscribe the companion app under 'Subscribe to events on behalf of users' using the documented user events.",
            "Socket Mode needs an app-level token; HTTP mode needs the app signing secret.",
            "No bot token or bot user is required.",
            `Docs: ${formatDocsLink(
              "/channels/slack#user-identity-post-as-a-real-person",
              "channels/slack",
            )}`,
          ].join("\n"),
          "Slack user identity",
        );
      } else {
        await prompter.note(
          buildSlackSetupLines().join("\n"),
          t("wizard.slack.socketModeTokensTitle"),
        );
        const manifest = buildSlackManifest();
        if (prompter.plain) {
          await prompter.plain(manifest);
        } else {
          await prompter.note(manifest, "Slack manifest JSON");
        }
      }
      return { cfg: next };
    },
    envShortcut: {
      prompt: t("wizard.slack.envPrompt"),
      preferredEnvVar: "SLACK_BOT_TOKEN",
      isAvailable: ({ cfg, accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID &&
        (inspectSlackAccount({ cfg, accountId }).config.identity ?? "bot") === "bot" &&
        Boolean(process.env.SLACK_BOT_TOKEN?.trim()) &&
        Boolean(process.env.SLACK_APP_TOKEN?.trim()) &&
        !inspectSlackAccount({ cfg, accountId }).configured,
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
        shouldPrompt: ({ cfg, accountId }) =>
          (inspectSlackAccount({ cfg, accountId }).config.identity ?? "bot") === "bot",
      }),
      createSlackTokenCredential({
        inputKey: "userToken",
        providerHint: "slack-user",
        credentialLabel: "Slack user OAuth token",
        preferredEnvVar: "SLACK_USER_TOKEN",
        keepPrompt: "Slack user OAuth token already configured. Keep it?",
        inputPrompt: "Enter Slack user OAuth token",
        shouldPrompt: ({ cfg, accountId }) =>
          inspectSlackAccount({ cfg, accountId }).config.identity === "user",
      }),
      createSlackTokenCredential({
        inputKey: "appToken",
        providerHint: "slack-app",
        credentialLabel: t("wizard.slack.appToken"),
        preferredEnvVar: "SLACK_APP_TOKEN",
        keepPrompt: t("wizard.slack.appTokenKeep"),
        inputPrompt: t("wizard.slack.appTokenInput"),
        shouldPrompt: ({ cfg, accountId }) => {
          const account = inspectSlackAccount({ cfg, accountId });
          return (
            (account.config.identity ?? "bot") === "bot" ||
            (account.config.mode ?? "socket") === "socket"
          );
        },
      }),
      createSlackTokenCredential({
        inputKey: "signingSecret",
        providerHint: "slack-signing-secret",
        credentialLabel: "Slack signing secret",
        keepPrompt: "Slack signing secret already configured. Keep it?",
        inputPrompt: "Enter Slack signing secret",
        shouldPrompt: ({ cfg, accountId }) => {
          const account = inspectSlackAccount({ cfg, accountId });
          return account.config.identity === "user" && account.config.mode === "http";
        },
      }),
    ],
    dmPolicy: slackDmPolicy,
    allowFrom: createAccountScopedAllowFromSection({
      channel,
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
        inspectSlackAccount({ cfg, accountId }).config.groupPolicy ?? "allowlist",
      currentEntries: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Object.entries(inspectSlackAccount({ cfg, accountId }).config.channels ?? {})
          .filter(([, value]) => value?.enabled !== false)
          .map(([key]) => key),
      updatePrompt: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Boolean(inspectSlackAccount({ cfg, accountId }).config.channels),
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
