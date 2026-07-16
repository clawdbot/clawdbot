import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveBlueBubblesAccount, resolveDefaultBlueBubblesAccountId } from "./accounts.js";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./secret-input.js";
import {
  blueBubblesSetupAdapter,
  setBlueBubblesAllowFrom,
  setBlueBubblesDmPolicy,
} from "./setup-core.js";
import { parseBlueBubblesAllowTarget } from "./targets.js";
import { normalizeBlueBubblesServerUrl } from "./types.js";
import { DEFAULT_WEBHOOK_PATH } from "./webhook-shared.js";

const channel = "bluebubbles" as const;
const CONFIGURE_CUSTOM_WEBHOOK_FLAG = "__bluebubblesConfigureCustomWebhookPath";

function parseBlueBubblesAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateBlueBubblesAllowFromEntry(value: string): string | null {
  try {
    if (value === "*") {
      return value;
    }
    const parsed = parseBlueBubblesAllowTarget(value);
    if (parsed.kind === "handle" && !parsed.handle) {
      return null;
    }
    return normalizeOptionalString(value) ?? null;
  } catch {
    return null;
  }
}

const promptBlueBubblesAllowFrom = createPromptParsedAllowFromForAccount({
  defaultAccountId: (cfg) => resolveDefaultBlueBubblesAccountId(cfg),
  noteTitle: "BlueBubbles allowlist",
  noteLines: [
    "Allowlist BlueBubbles DMs by handle or chat target.",
    "Examples:",
    "- +15555550123",
    "- user@example.com",
    "- chat_id:123",
    "- chat_guid:iMessage;-;+15555550123",
    "Multiple entries: comma- or newline-separated.",
    `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
  ],
  message: "BlueBubbles allowFrom (handle or chat_id)",
  placeholder: "+15555550123, user@example.com, chat_id:123",
  parseEntries: (raw) => {
    const entries = parseBlueBubblesAllowFromInput(raw);
    for (const entry of entries) {
      if (!validateBlueBubblesAllowFromEntry(entry)) {
        return { entries: [], error: `Invalid entry: ${entry}` };
      }
    }
    return { entries };
  },
  getExistingAllowFrom: ({ cfg, accountId }) =>
    resolveBlueBubblesAccount({ cfg, accountId }).config.allowFrom ?? [],
  applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
    setBlueBubblesAllowFrom(cfg, accountId, allowFrom),
});

function validateBlueBubblesServerUrlInput(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return "Required";
  }
  try {
    const normalized = normalizeBlueBubblesServerUrl(trimmed);
    if (!URL.canParse(normalized)) {
      return "Invalid URL format";
    }
    return undefined;
  } catch {
    return "Invalid URL format";
  }
}

function applyBlueBubblesSetupPatch(
  cfg: OpenClawConfig,
  accountId: string,
  patch: {
    serverUrl?: string;
    password?: unknown;
    webhookPath?: string;
  },
): OpenClawConfig {
  return applyBlueBubblesConnectionConfig({
    cfg,
    accountId,
    patch,
    onlyDefinedFields: true,
    accountEnabled: "preserve-or-true",
  });
}

function validateBlueBubblesWebhookPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Required";
  }
  if (!trimmed.startsWith("/")) {
    return "Path must start with /";
  }
  return undefined;
}

const dmPolicy: ChannelSetupDmPolicy = {
  label: "BlueBubbles",
  channel,
  policyKey: "channels.bluebubbles.dmPolicy",
  allowFromKey: "channels.bluebubbles.allowFrom",
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultBlueBubblesAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.bluebubbles.accounts.${accountId ?? resolveDefaultBlueBubblesAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.bluebubbles.accounts.${accountId ?? resolveDefaultBlueBubblesAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.bluebubbles.dmPolicy",
          allowFromKey: "channels.bluebubbles.allowFrom",
        },
  getCurrent: (cfg, accountId) =>
    resolveBlueBubblesAccount({
      cfg,
      accountId: accountId ?? resolveDefaultBlueBubblesAccountId(cfg),
    }).config.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy, accountId) =>
    setBlueBubblesDmPolicy(cfg, accountId ?? resolveDefaultBlueBubblesAccountId(cfg), policy),
  promptAllowFrom: promptBlueBubblesAllowFrom,
};

export const blueBubblesSetupWizard: ChannelSetupWizard = {
  channel,
  stepOrder: "text-first",
  status: {
    ...createStandardChannelSetupStatus({
      channelLabel: "BlueBubbles",
      configuredLabel: "configured",
      unconfiguredLabel: "needs setup",
      configuredHint: "configured",
      unconfiguredHint: "iMessage via BlueBubbles app",
      configuredScore: 1,
      unconfiguredScore: 0,
      includeStatusLine: true,
      resolveConfigured: ({ cfg, accountId }) =>
        resolveBlueBubblesAccount({ cfg, accountId }).configured,
    }),
    resolveSelectionHint: ({ configured }) =>
      configured ? "configured" : "iMessage via BlueBubbles app",
  },
  prepare: async ({ cfg, accountId, prompter, credentialValues }) => {
    const existingWebhookPath = normalizeOptionalString(
      resolveBlueBubblesAccount({ cfg, accountId }).config.webhookPath,
    );
    const wantsCustomWebhook = await prompter.confirm({
      message: `Configure a custom webhook path? (default: ${DEFAULT_WEBHOOK_PATH})`,
      initialValue: Boolean(existingWebhookPath && existingWebhookPath !== DEFAULT_WEBHOOK_PATH),
    });
    return {
      cfg: wantsCustomWebhook
        ? cfg
        : applyBlueBubblesSetupPatch(cfg, accountId, { webhookPath: DEFAULT_WEBHOOK_PATH }),
      credentialValues: {
        ...credentialValues,
        [CONFIGURE_CUSTOM_WEBHOOK_FLAG]: wantsCustomWebhook ? "1" : "0",
      },
    };
  },
  credentials: [
    {
      inputKey: "password",
      providerHint: channel,
      credentialLabel: "server password",
      helpTitle: "BlueBubbles password",
      helpLines: [
        "Enter the BlueBubbles server password.",
        "Find this in the BlueBubbles Server app under Settings.",
      ],
      envPrompt: "",
      keepPrompt: "BlueBubbles password already set. Keep it?",
      inputPrompt: "BlueBubbles password",
      inspect: ({ cfg, accountId }) => {
        const existingPassword = resolveBlueBubblesAccount({ cfg, accountId }).config.password;
        return {
          accountConfigured: resolveBlueBubblesAccount({ cfg, accountId }).configured,
          hasConfiguredValue: hasConfiguredSecretInput(existingPassword),
          resolvedValue: normalizeSecretInputString(existingPassword) ?? undefined,
        };
      },
      applySet: async ({ cfg, accountId, value }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          password: value,
        }),
    },
  ],
  textInputs: [
    {
      inputKey: "httpUrl",
      message: "BlueBubbles server URL",
      placeholder: "http://192.168.1.100:1234",
      helpTitle: "BlueBubbles server URL",
      helpLines: [
        "Enter the BlueBubbles server URL (e.g., http://192.168.1.100:1234).",
        "Find this in the BlueBubbles Server app under Connection.",
        `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
      ],
      currentValue: ({ cfg, accountId }) =>
        normalizeOptionalString(resolveBlueBubblesAccount({ cfg, accountId }).config.serverUrl),
      validate: ({ value }) => validateBlueBubblesServerUrlInput(value),
      normalizeValue: ({ value }) => value.trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          serverUrl: value,
        }),
    },
    {
      inputKey: "webhookPath",
      message: "Webhook path",
      placeholder: DEFAULT_WEBHOOK_PATH,
      currentValue: ({ cfg, accountId }) => {
        const value = normalizeOptionalString(
          resolveBlueBubblesAccount({ cfg, accountId }).config.webhookPath,
        );
        return value && value !== DEFAULT_WEBHOOK_PATH ? value : undefined;
      },
      shouldPrompt: ({ credentialValues }) =>
        credentialValues[CONFIGURE_CUSTOM_WEBHOOK_FLAG] === "1",
      validate: ({ value }) => validateBlueBubblesWebhookPath(value),
      normalizeValue: ({ value }) => value.trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          webhookPath: value,
        }),
    },
  ],
  completionNote: {
    title: "BlueBubbles next steps",
    lines: [
      "Configure the webhook URL in BlueBubbles Server:",
      "1. Open BlueBubbles Server -> Settings -> Webhooks",
      "2. Add your OpenClaw gateway URL + webhook path",
      `   Example: https://your-gateway-host:3000${DEFAULT_WEBHOOK_PATH}`,
      "3. Enable the webhook and save",
      "",
      `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
    ],
  },
  dmPolicy,
  allowFrom: createAllowFromSection({
    helpTitle: "BlueBubbles allowlist",
    helpLines: [
      "Allowlist BlueBubbles DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:iMessage;-;+15555550123",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
    ],
    message: "BlueBubbles allowFrom (handle or chat_id)",
    placeholder: "+15555550123, user@example.com, chat_id:123",
    invalidWithoutCredentialNote:
      "Use a BlueBubbles handle or chat target like +15555550123 or chat_id:123.",
    parseInputs: parseBlueBubblesAllowFromInput,
    parseId: (raw) => validateBlueBubblesAllowFromEntry(raw),
    apply: async ({ cfg, accountId, allowFrom }) =>
      setBlueBubblesAllowFrom(cfg, accountId, allowFrom),
  }),
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      bluebubbles: {
        ...cfg.channels?.bluebubbles,
        enabled: false,
      },
    },
  }),
};

export { blueBubblesSetupAdapter };
