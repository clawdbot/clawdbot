import type {
  ChannelSetupAdapter,
  ChannelSetupWizard,
  ChannelSetupWizardTextInput,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  createCliPathTextInput,
  createDelegatedSetupWizardProxy,
  createDelegatedTextInputShouldPrompt,
  createPatchedAccountSetupAdapter,
  mergeAllowFromEntries,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultIMessageAccountId, resolveIMessageAccount } from "./accounts.js";
import { normalizeIMessageHandle } from "./targets.js";

const channel = "imessage" as const;

const CHAT_TARGET_ALLOWFROM_PREFIXES = [
  "chat_id:",
  "chatid:",
  "chat:",
  "chat_guid:",
  "chatguid:",
  "guid:",
  "chat_identifier:",
  "chatidentifier:",
  "chatident:",
];
const SERVICE_ALLOWFROM_PREFIXES = ["imessage:", "sms:", "auto:"];

function normalizeAllowFromEntryForPrefixCheck(entry: string): string {
  let lower = normalizeLowercaseStringOrEmpty(entry);
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of SERVICE_ALLOWFROM_PREFIXES) {
      if (lower.startsWith(prefix)) {
        lower = lower.slice(prefix.length).trim();
        stripped = true;
      }
    }
  }
  return lower;
}

export function parseIMessageAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    const lower = normalizeAllowFromEntryForPrefixCheck(entry);
    if (CHAT_TARGET_ALLOWFROM_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      return { error: `iMessage allowFrom entries must be sender handles: ${entry}` };
    }
    if (!normalizeIMessageHandle(entry)) {
      return { error: `Invalid handle: ${entry}` };
    }
    return { value: entry };
  });
}

function buildIMessageSetupPatch(input: {
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
}) {
  return {
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.dbPath ? { dbPath: input.dbPath } : {}),
    ...(input.service ? { service: input.service } : {}),
    ...(input.region ? { region: input.region } : {}),
  };
}

async function promptIMessageAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultIMessageAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: "iMessage allowlist",
    noteLines: [
      "Allowlist iMessage DMs by sender handle.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/imessage", "imessage")}`,
    ],
    message: "iMessage allowFrom (sender handle)",
    placeholder: "+15555550123, user@example.com",
    parseEntries: parseIMessageAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveIMessageAccount({ cfg, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({
        cfg,
        channel,
        accountId,
        allowFrom,
      }),
  });
}

export const imessageDmPolicy = {
  label: "iMessage",
  channel,
  policyKey: "channels.imessage.dmPolicy",
  allowFromKey: "channels.imessage.allowFrom",
  resolveConfigKeys: (_cfg: OpenClawConfig, accountId?: string) => {
    const targetAccountId = accountId ?? resolveDefaultIMessageAccountId(_cfg);
    return targetAccountId !== "default"
      ? {
          policyKey: `channels.imessage.accounts.${targetAccountId}.dmPolicy`,
          allowFromKey: `channels.imessage.accounts.${targetAccountId}.allowFrom`,
        }
      : {
          policyKey: "channels.imessage.dmPolicy",
          allowFromKey: "channels.imessage.allowFrom",
        };
  },
  getCurrent: (cfg: OpenClawConfig, accountId?: string) => {
    const targetAccountId = accountId ?? resolveDefaultIMessageAccountId(cfg);
    return resolveIMessageAccount({ cfg, accountId: targetAccountId }).config.dmPolicy ?? "pairing";
  },
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) => {
    const targetAccountId = accountId ?? resolveDefaultIMessageAccountId(cfg);
    return patchChannelConfigForAccount({
      cfg,
      channel,
      accountId: targetAccountId,
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveIMessageAccount({ cfg, accountId: targetAccountId }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    });
  },
  promptAllowFrom: promptIMessageAllowFrom,
};

function resolveIMessageCliPath(params: { cfg: OpenClawConfig; accountId: string }) {
  return resolveIMessageAccount(params).config.cliPath ?? "imsg";
}

export function createIMessageCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return createCliPathTextInput({
    inputKey: "cliPath",
    message: "imsg CLI path",
    resolvePath: ({ cfg, accountId }) => resolveIMessageCliPath({ cfg, accountId }),
    shouldPrompt,
    helpTitle: "iMessage",
    helpLines: ["imsg CLI path required to enable iMessage."],
  });
}

export const imessageCompletionNote = {
  title: "iMessage next steps",
  lines: [
    "Run OpenClaw on the Mac signed into Messages, or set cliPath to an SSH wrapper that runs imsg on that Mac.",
    "Linux/Windows hosts cannot run the default local imsg path directly.",
    "Run `imsg launch`, then `openclaw channels status --probe` to verify private API actions.",
    "Ensure OpenClaw has Full Disk Access to Messages DB.",
    "Grant Automation permission for Messages when prompted.",
    "List chats with: imsg chats --limit 20",
    `Docs: ${formatDocsLink("/imessage", "imessage")}`,
  ],
};

export const imessageSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  buildPatch: (input) => buildIMessageSetupPatch(input),
});

export const imessageSetupStatusBase = {
  configuredLabel: "configured",
  unconfiguredLabel: "needs setup",
  configuredHint: "imsg found",
  unconfiguredHint: "imsg missing",
  configuredScore: 1,
  unconfiguredScore: 0,
  resolveConfigured: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
    resolveIMessageAccount({ cfg, accountId }).configured,
};

export function createIMessageSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: imessageSetupStatusBase.configuredLabel,
      unconfiguredLabel: imessageSetupStatusBase.unconfiguredLabel,
      configuredHint: imessageSetupStatusBase.configuredHint,
      unconfiguredHint: imessageSetupStatusBase.unconfiguredHint,
      configuredScore: imessageSetupStatusBase.configuredScore,
      unconfiguredScore: imessageSetupStatusBase.unconfiguredScore,
    },
    credentials: [],
    textInputs: [
      createIMessageCliPathTextInput(
        createDelegatedTextInputShouldPrompt({
          loadWizard,
          inputKey: "cliPath",
        }),
      ),
    ],
    completionNote: imessageCompletionNote,
    dmPolicy: imessageDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  });
}
