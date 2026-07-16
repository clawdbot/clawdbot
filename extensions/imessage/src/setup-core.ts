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
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultIMessageAccountId, resolveIMessageAccount } from "./accounts.js";
import { normalizeIMessageHandle } from "./targets.js";

const channel = "imessage" as const;

export function parseIMessageAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    const lower = normalizeLowercaseStringOrEmpty(entry);
    if (lower.startsWith("chat_id:")) {
      const id = entry.slice("chat_id:".length).trim();
      if (!/^\d+$/.test(id)) {
        return { error: `Invalid chat_id: ${entry}` };
      }
      return { value: entry };
    }
    if (lower.startsWith("chat_guid:")) {
      if (!entry.slice("chat_guid:".length).trim()) {
        return { error: "Invalid chat_guid entry" };
      }
      return { value: entry };
    }
    if (lower.startsWith("chat_identifier:")) {
      if (!entry.slice("chat_identifier:".length).trim()) {
        return { error: "Invalid chat_identifier entry" };
      }
      return { value: entry };
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

export async function promptIMessageAllowFrom(params: {
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
      "Allowlist iMessage DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:... or chat_identifier:...",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/imessage", "imessage")}`,
    ],
    message: "iMessage allowFrom (handle or chat_id)",
    placeholder: "+15555550123, user@example.com, chat_id:123",
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
    "This is still a work in progress.",
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
