import {
  createCliPathTextInput,
  createDelegatedSetupWizardProxy,
  createDelegatedTextInputShouldPrompt,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  DEFAULT_ACCOUNT_ID,
  mergeAllowFromEntries,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type ChannelSetupWizardTextInput,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeE164,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultSignalAccountId, resolveSignalAccount } from "./accounts.js";

const channel = "signal" as const;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";

export function normalizeSignalAccountInput(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeE164(trimmed);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    if (normalizeLowercaseStringOrEmpty(entry).startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (isUuidLike(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalAccountInput(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
}) {
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
  };
}

async function promptSignalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: "Signal allowlist",
    noteLines: [
      "Allowlist Signal DMs by sender id.",
      "Examples:",
      "- +15555550123",
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    message: "Signal allowFrom (E.164 or uuid)",
    placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
    parseEntries: parseSignalAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({
        cfg,
        channel,
        accountId,
        allowFrom,
      }),
  });
}

export const signalDmPolicy = {
  label: "Signal",
  channel,
  policyKey: "channels.signal.dmPolicy",
  allowFromKey: "channels.signal.allowFrom",
  resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) =>
    (accountId ?? resolveDefaultSignalAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.signal.dmPolicy",
          allowFromKey: "channels.signal.allowFrom",
        },
  getCurrent: (cfg: OpenClawConfig, accountId?: string) =>
    resolveSignalAccount({ cfg, accountId: accountId ?? resolveDefaultSignalAccountId(cfg) }).config
      .dmPolicy ?? "pairing",
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) =>
    patchChannelConfigForAccount({
      cfg,
      channel,
      accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveSignalAccount({
                  cfg,
                  accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
                }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    }),
  promptAllowFrom: promptSignalAllowFrom,
};

function resolveSignalCliPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}) {
  return (
    (typeof params.credentialValues.cliPath === "string"
      ? params.credentialValues.cliPath
      : undefined) ??
    resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.cliPath ??
    "signal-cli"
  );
}

export function createSignalCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return createCliPathTextInput({
    inputKey: "cliPath",
    message: "signal-cli path",
    resolvePath: ({ cfg, accountId, credentialValues }) =>
      resolveSignalCliPath({ cfg, accountId, credentialValues }),
    shouldPrompt,
    helpTitle: "Signal",
    helpLines: [
      "signal-cli not found. Install it, then rerun this step or set channels.signal.cliPath.",
    ],
  });
}

export const signalNumberTextInput: ChannelSetupWizardTextInput = {
  inputKey: "signalNumber",
  message: "Signal bot number (E.164)",
  currentValue: ({ cfg, accountId }) =>
    normalizeSignalAccountInput(resolveSignalAccount({ cfg, accountId }).config.account) ??
    undefined,
  keepPrompt: (value) => `Signal account set (${value}). Keep it?`,
  validate: ({ value }) =>
    normalizeSignalAccountInput(value) ? undefined : INVALID_SIGNAL_ACCOUNT_ERROR,
  normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value,
};

export const signalCompletionNote = {
  title: "Signal next steps",
  lines: [
    'Link device with: signal-cli link -n "OpenClaw"',
    "Scan QR in Signal -> Linked Devices",
    `Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
    `Docs: ${formatDocsLink("/signal", "signal")}`,
  ],
};

export const signalSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    validate: ({ input }) => {
      if (
        !input.signalNumber &&
        !input.httpUrl &&
        !input.httpHost &&
        !input.httpPort &&
        !input.cliPath
      ) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
  }),
  buildPatch: (input) => buildSignalSetupPatch(input),
});

export function createSignalSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: "configured",
      unconfiguredLabel: "needs setup",
      configuredHint: "signal-cli found",
      unconfiguredHint: "signal-cli missing",
      configuredScore: 1,
      unconfiguredScore: 0,
    },
    delegatePrepare: true,
    credentials: [],
    textInputs: [
      createSignalCliPathTextInput(
        createDelegatedTextInputShouldPrompt({
          loadWizard,
          inputKey: "cliPath",
        }),
      ),
      signalNumberTextInput,
    ],
    completionNote: signalCompletionNote,
    dmPolicy: signalDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  });
}
