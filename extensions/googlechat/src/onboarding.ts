import type { MoltbotConfig, DmPolicy } from "clawdbot/plugin-sdk";
import {
  addWildcardAllowFrom,
  formatDocsLink,
  promptAccountId,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type WizardPrompter,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  migrateBaseNameToDefaultAccount,
} from "clawdbot/plugin-sdk";

import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
} from "./accounts.js";

const channel = "googlechat" as const;

const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";

function setGoogleChatDmPolicy(cfg: MoltbotConfig, policy: DmPolicy) {
  const allowFrom =
    policy === "open"
      ? addWildcardAllowFrom(cfg.channels?.["googlechat"]?.dm?.allowFrom)
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "googlechat": {
        ...(cfg.channels?.["googlechat"] ?? {}),
        dm: {
          ...(cfg.channels?.["googlechat"]?.dm ?? {}),
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptAllowFrom(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
}): Promise<MoltbotConfig> {
  const current = params.cfg.channels?.["googlechat"]?.dm?.allowFrom ?? [];
  const entry = await params.prompter.text({
    message: "Google Chat allowFrom (user id or email)",
    placeholder: "users/123456789, name@example.com",
    initialValue: current[0] ? String(current[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  const parts = parseAllowFromInput(String(entry));
  const unique = [...new Set(parts)];
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      "googlechat": {
        ...(params.cfg.channels?.["googlechat"] ?? {}),
        enabled: true,
        dm: {
          ...(params.cfg.channels?.["googlechat"]?.dm ?? {}),
          policy: "allowlist",
          allowFrom: unique,
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Google Chat",
  channel,
  policyKey: "channels.googlechat.dm.policy",
  allowFromKey: "channels.googlechat.dm.allowFrom",
  getCurrent: (cfg) => cfg.channels?.["googlechat"]?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setGoogleChatDmPolicy(cfg, policy),
  promptAllowFrom,
};

function applyAccountConfig(params: {
  cfg: MoltbotConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): MoltbotConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        "googlechat": {
          ...(cfg.channels?.["googlechat"] ?? {}),
          enabled: true,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "googlechat": {
        ...(cfg.channels?.["googlechat"] ?? {}),
        enabled: true,
        accounts: {
          ...(cfg.channels?.["googlechat"]?.accounts ?? {}),
          [accountId]: {
            ...(cfg.channels?.["googlechat"]?.accounts?.[accountId] ?? {}),
            enabled: true,
            ...patch,
          },
        },
      },
    },
  };
}

async function promptCredentials(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<MoltbotConfig> {
  const { cfg, prompter, accountId } = params;
  const envReady =
    accountId === DEFAULT_ACCOUNT_ID &&
    (Boolean(process.env[ENV_SERVICE_ACCOUNT]) ||
      Boolean(process.env[ENV_SERVICE_ACCOUNT_FILE]));
  if (envReady) {
    const useEnv = await prompter.confirm({
      message: "Use GOOGLE_CHAT_SERVICE_ACCOUNT env vars?",
      initialValue: true,
    });
    if (useEnv) {
      return applyAccountConfig({ cfg, accountId, patch: {} });
    }
  }

  const method = await prompter.select({
    message: "Google Chat auth method",
    options: [
      { value: "file", label: "Service account JSON file" },
      { value: "inline", label: "Paste service account JSON" },
    ],
    initialValue: "file",
  });

  if (method === "file") {
    const path = await prompter.text({
      message: "Service account JSON path",
      placeholder: "/path/to/service-account.json",
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    return applyAccountConfig({
      cfg,
      accountId,
      patch: { serviceAccountFile: String(path).trim() },
    });
  }

  const json = await prompter.text({
    message: "Service account JSON (single line)",
    placeholder: "{\"type\":\"service_account\", ... }",
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  return applyAccountConfig({
    cfg,
    accountId,
    patch: { serviceAccount: String(json).trim() },
  });
}

async function promptAudience(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<MoltbotConfig> {
  const account = resolveGoogleChatAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const currentType = account.config.audienceType ?? "app-url";
  const currentAudience = account.config.audience ?? "";
  const audienceType = (await params.prompter.select({
    message: "Webhook audience type",
    options: [
      { value: "app-url", label: "App URL (recommended)" },
      { value: "project-number", label: "Project number" },
    ],
    initialValue: currentType === "project-number" ? "project-number" : "app-url",
  })) as "app-url" | "project-number";
  const audience = await params.prompter.text({
    message: audienceType === "project-number" ? "Project number" : "App URL",
    placeholder: audienceType === "project-number" ? "1234567890" : "https://your.host/googlechat",
    initialValue: currentAudience || undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  return applyAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: { audienceType, audience: String(audience).trim() },
  });
}

async function noteGoogleChatSetup(prompter: WizardPrompter) {
  await prompter.note(
    [
      "Google Chat apps use service-account auth and an HTTPS webhook.",
      "Set the Chat API scopes in your service account and configure the Chat app URL.",
      "Webhook verification requires audience type + audience value.",
      `Docs: ${formatDocsLink("/channels/googlechat", "channels/googlechat")}`,
    ].join("\n"),
    "Google Chat setup",
  );
}

export const googlechatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listGoogleChatAccountIds(cfg).some(
      (accountId) => resolveGoogleChatAccount({ cfg, accountId }).credentialSource !== "none",
    );
    return {
      channel,
      configured,
      statusLines: [
        `Google Chat: ${configured ? "configured" : "needs service account"}`,
      ],
      selectionHint: configured ? "configured" : "needs auth",
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }) => {
    const override = accountOverrides["googlechat"]?.trim();
    const defaultAccountId = resolveDefaultGoogleChatAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Google Chat",
        currentId: accountId,
        listAccountIds: listGoogleChatAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    await noteGoogleChatSetup(prompter);
    next = await promptCredentials({ cfg: next, prompter, accountId });
    next = await promptAudience({ cfg: next, prompter, accountId });

    const namedConfig = migrateBaseNameToDefaultAccount({
      cfg: next,
      channelKey: "googlechat",
    });

    return { cfg: namedConfig, accountId };
  },
};
