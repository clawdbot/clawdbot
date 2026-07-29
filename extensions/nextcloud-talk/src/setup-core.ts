import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
// Nextcloud Talk plugin module implements setup core behavior.
import {
  defineChannelSetupContract,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  applyAccountNameToChannelSection,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import {
  createSetupInputPresenceValidator,
  mergeAllowFromEntries,
  promptParsedAllowFromForAccount,
  resolveSetupAccountId,
  createSetupTranslator,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultNextcloudTalkAccountId, resolveNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

const t = createSetupTranslator();

const channel = "nextcloud-talk" as const;

type NextcloudSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  secret?: string;
  secretFile?: string;
  url?: string;
  password?: string;
};

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeNextcloudTalkBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

export function validateNextcloudTalkBaseUrl(value: string): string | undefined {
  if (!value) {
    return "Required";
  }
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return "URL must start with http:// or https://";
  }
  return undefined;
}

export function setNextcloudTalkAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  updates: Record<string, unknown>,
  clearFields?: readonly string[],
): CoreConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: updates,
    ...(clearFields ? { clearFields } : {}),
  }) as CoreConfig;
}

async function promptNextcloudTalkAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  return await promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: params.accountId,
    prompter: params.prompter,
    noteTitle: t("wizard.nextcloudTalk.userIdTitle"),
    noteLines: [
      t("wizard.nextcloudTalk.userIdHelpAdmin"),
      t("wizard.nextcloudTalk.userIdHelpLogs"),
      t("wizard.nextcloudTalk.userIdHelpLowercase"),
      t("wizard.channels.docs", {
        link: formatDocsLink("/channels/nextcloud-talk", "nextcloud-talk"),
      }),
    ],
    message: t("wizard.nextcloudTalk.allowFromPrompt"),
    placeholder: "username",
    parseEntries: (raw) => ({
      entries: raw
        .split(/[\n,;]+/g)
        .map(normalizeLowercaseStringOrEmpty)
        .filter(Boolean),
    }),
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveNextcloudTalkAccount({ cfg, accountId }).config.allowFrom ?? [],
    mergeEntries: ({ existing, parsed }) =>
      mergeAllowFromEntries(
        existing.map((value) => normalizeLowercaseStringOrEmpty(String(value))),
        parsed,
      ),
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setNextcloudTalkAccountConfig(cfg, accountId, {
        dmPolicy: "allowlist",
        allowFrom,
      }),
  });
}

async function promptNextcloudTalkAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultNextcloudTalkAccountId(params.cfg as CoreConfig),
  });
  return await promptNextcloudTalkAllowFrom({
    cfg: params.cfg as CoreConfig,
    prompter: params.prompter,
    accountId,
  });
}

export const nextcloudTalkDmPolicy = createChannelDmPolicy({
  label: "Nextcloud Talk",
  channel,
  resolveAccount: (cfg, accountId) =>
    resolveNextcloudTalkAccount({
      cfg: cfg as CoreConfig,
      accountId: accountId ?? resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig),
    }),
  applyPatch: ({ cfg, account, patch }) =>
    setNextcloudTalkAccountConfig(cfg as CoreConfig, account.accountId, patch),
  promptAllowFrom: promptNextcloudTalkAllowFromForAccount,
});

export const nextcloudTalkSetupAdapter: ChannelSetupAdapter = {
  singleAccountKeysToMove: ["rooms"],
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  prepareAccountConfigInput: ({ input }) => {
    const setupInput = input as NextcloudSetupInput;
    return {
      ...setupInput,
      baseUrl: setupInput.baseUrl ?? readOptionalString(setupInput.url),
      secret:
        setupInput.secret ??
        readOptionalString(setupInput.token) ??
        readOptionalString(setupInput.password),
      secretFile: setupInput.secretFile ?? readOptionalString(setupInput.tokenFile),
    };
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.",
    validate: ({ input }) => {
      const setupInput = input as NextcloudSetupInput;
      if (!setupInput.useEnv && !setupInput.secret && !setupInput.secretFile) {
        return "Nextcloud Talk requires bot secret or --secret-file (or --use-env).";
      }
      if (!setupInput.baseUrl) {
        return "Nextcloud Talk requires --base-url.";
      }
      return null;
    },
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as NextcloudSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: setupInput.name,
    });
    const patch = {
      baseUrl: normalizeNextcloudTalkBaseUrl(setupInput.baseUrl),
      ...(setupInput.useEnv
        ? {}
        : setupInput.secretFile
          ? { botSecretFile: setupInput.secretFile }
          : setupInput.secret
            ? { botSecret: setupInput.secret }
            : {}),
    };
    return setNextcloudTalkAccountConfig(
      namedConfig as CoreConfig,
      accountId,
      patch,
      setupInput.useEnv ? ["botSecret", "botSecretFile"] : undefined,
    );
  },
};

export const nextcloudTalkSetupContract = defineChannelSetupContract({
  fields: {
    baseUrl: {
      kind: "string",
      cli: { flags: "--base-url <url>", description: "Nextcloud base URL" },
    },
    url: {
      kind: "string",
      cli: { flags: "--url <url>", description: "Legacy Nextcloud base URL alias" },
    },
    secret: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--secret <secret>", description: "Nextcloud Talk bot secret" },
    },
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <secret>", description: "Legacy Nextcloud bot secret alias" },
    },
    password: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--password <secret>", description: "Legacy Nextcloud bot secret alias" },
    },
    secretFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--secret-file <path>", description: "Nextcloud Talk bot secret file" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "Legacy Nextcloud bot secret file alias" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use Nextcloud Talk environment credentials" },
    },
  },
  legacyAdapter: nextcloudTalkSetupAdapter,
});
