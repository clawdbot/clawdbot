// Signal plugin module implements setup core behavior.
import { normalizeAccountId, resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
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
  createSetupTranslator,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import { resolveDefaultSignalAccountId, resolveSignalAccount } from "./accounts.js";
import {
  detectSignalTransport,
  prepareSignalManagedNativeTransport,
  resolveConfiguredSignalTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";
import { isValidSignalManagedNativePort } from "./transport-policy.js";
import { normalizeSignalTransportHost, normalizeSignalTransportUrl } from "./transport-url.js";

const t = createSetupTranslator();

const channel = "signal" as const;

const signalSetupFields = {
  signalNumber: {
    kind: "string",
    cli: { flags: "--signal-number <e164>", description: "Signal account number (E.164)" },
  },
  signalTransport: {
    kind: "choice",
    choices: ["external-native", "container"],
    cli: {
      flags: "--signal-transport <kind>",
      description: "Signal HTTP transport (external-native or container)",
    },
  },
  cliPath: {
    kind: "string",
    cli: { flags: "--cli-path <path>", description: "signal-cli executable path" },
  },
  httpUrl: {
    kind: "string",
    cli: { flags: "--http-url <url>", description: "Signal HTTP service URL" },
  },
  httpHost: {
    kind: "string",
    cli: { flags: "--http-host <host>", description: "Signal HTTP daemon host" },
  },
  httpPort: {
    kind: "string",
    cli: { flags: "--http-port <port>", description: "Signal HTTP daemon port" },
  },
} as const;

type SignalSetupInput = {
  name?: string;
  signalNumber?: string;
  signalTransport?: "external-native" | "container";
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
};
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
  const phoneInput = trimmed.replace(/^signal:/i, "").trim();
  // Setup accepts formatting punctuation, but embedded or duplicate pluses are invalid input.
  const plusCount = phoneInput.match(/\+/g)?.length ?? 0;
  if (plusCount > 1 || (plusCount === 1 && !phoneInput.startsWith("+"))) {
    return null;
  }
  const normalized = normalizeE164(phoneInput);
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

function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
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

export function buildSignalSetupPatch(input: SignalSetupInput) {
  const transport = input.httpUrl
    ? {
        // Bare --http-url is classified once by prepareAccountConfigInput. Keep the historical
        // external-native default for direct adapter callers that already bypass preparation.
        kind: input.signalTransport ?? ("external-native" as const),
        url: normalizeSignalTransportUrl(input.httpUrl),
      }
    : input.cliPath || input.httpHost || input.httpPort
      ? {
          kind: "managed-native" as const,
          ...(input.cliPath ? { cliPath: input.cliPath } : {}),
          ...(input.httpHost ? { httpHost: input.httpHost } : {}),
          ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
        }
      : undefined;
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(transport ? { transport } : {}),
  };
}

async function prepareSignalSetupInput(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: SignalSetupInput;
}): Promise<SignalSetupInput> {
  if (!params.input.httpUrl || params.input.signalTransport) {
    return params.input;
  }
  const account =
    normalizeSignalAccountInput(params.input.signalNumber) ??
    normalizeSignalAccountInput(
      resolveSignalSetupAccount({ cfg: params.cfg, accountId: params.accountId }),
    ) ??
    undefined;
  try {
    const detected = await detectSignalTransport({
      url: params.input.httpUrl,
      ...(account ? { account } : {}),
    });
    return {
      ...params.input,
      signalTransport: detected.kind === "container" ? "container" : "external-native",
    };
  } catch {
    const existing = resolveConfiguredSignalTransport(params.cfg, params.accountId);
    if (existing?.kind === "container" || existing?.kind === "external-native") {
      // Leave the kind unset so applyAccountConfig preserves the established protocol while
      // changing only its URL. A fresh account has no such fact and must choose explicitly.
      return params.input;
    }
    throw new Error(
      "Signal could not detect the HTTP transport; start the endpoint or pass --signal-transport external-native|container.",
    );
  }
}

function managedTransportOverridesFromSetupInput(
  input: SignalSetupInput,
): Omit<Extract<SignalTransportConfig, { kind: "managed-native" }>, "kind"> {
  return {
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
  };
}

function resolveSignalSetupAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string | undefined {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const signal = params.cfg.channels?.signal;
  const account = resolveAccountEntry(signal?.accounts, accountId);
  return account?.account ?? signal?.account;
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
    noteTitle: t("wizard.signal.allowlistTitle"),
    noteLines: [
      t("wizard.signal.allowlistIntro"),
      t("wizard.signal.examples"),
      "- +15555550123",
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      t("wizard.signal.multipleEntries"),
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    message: t("wizard.signal.allowFromPrompt"),
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
        setupSurface: signalSetupAdapter,
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
      setupSurface: signalSetupAdapter,
    }),
  promptAllowFrom: promptSignalAllowFrom,
};

function resolveSignalCliPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}) {
  const transport = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).transport;
  if (transport.kind !== "managed-native") {
    return undefined;
  }
  return typeof params.credentialValues.cliPath === "string"
    ? params.credentialValues.cliPath
    : transport.cliPath;
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
  });
}

export const signalNumberTextInput: ChannelSetupWizardTextInput = {
  inputKey: "signalNumber",
  message: t("wizard.signal.botNumberPrompt"),
  currentValue: ({ cfg, accountId }) =>
    normalizeSignalAccountInput(resolveSignalAccount({ cfg, accountId }).config.account) ??
    undefined,
  keepPrompt: (value) => t("wizard.signal.accountKeep", { value }),
  validate: ({ value }) =>
    normalizeSignalAccountInput(value) ? undefined : INVALID_SIGNAL_ACCOUNT_ERROR,
  normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value,
};

export const signalCompletionNote = {
  title: t("wizard.signal.nextStepsTitle"),
  lines: [
    t("wizard.signal.nextLinkDevice"),
    t("wizard.signal.nextScanQr"),
    `Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
    `Docs: ${formatDocsLink("/signal", "signal")}`,
  ],
};

const signalSetupAdapterBase = createPatchedAccountSetupAdapter<SignalSetupInput>({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator<SignalSetupInput>({
    validate: ({ cfg, accountId, input }) => {
      if (
        input.signalTransport &&
        input.signalTransport !== "external-native" &&
        input.signalTransport !== "container"
      ) {
        return "Signal --signal-transport must be external-native or container.";
      }
      if (input.signalTransport && !input.httpUrl) {
        return "Signal --signal-transport requires --http-url.";
      }
      if (input.httpPort !== undefined && !isValidSignalManagedNativePort(Number(input.httpPort))) {
        return "Signal --http-port must be an integer between 1 and 65535.";
      }
      if (input.httpHost) {
        try {
          normalizeSignalTransportHost(input.httpHost);
        } catch {
          return "Signal --http-host must be a hostname or IP address.";
        }
      }
      if (
        input.signalTransport === "container" &&
        !normalizeSignalAccountInput(input.signalNumber) &&
        !normalizeSignalAccountInput(resolveSignalSetupAccount({ cfg, accountId }))
      ) {
        return "Signal container transport requires --signal-number or an existing account.";
      }
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

function restorePromotedSignalDefaultAccount(cfg: OpenClawConfig): OpenClawConfig {
  const signal = cfg.channels?.signal;
  const promoted = signal?.accounts?.[DEFAULT_ACCOUNT_ID];
  if (!signal?.transport || signal.account || !promoted?.account) {
    return cfg;
  }
  const { account, transport: _shadowedTransport, ...remainingDefault } = promoted;
  const accounts = { ...signal.accounts };
  if (Object.keys(remainingDefault).length === 0) {
    delete accounts[DEFAULT_ACCOUNT_ID];
  } else {
    accounts[DEFAULT_ACCOUNT_ID] = remainingDefault;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      signal: {
        ...signal,
        account,
        accounts,
      },
    },
  };
}

export const signalSetupAdapter: ChannelSetupAdapter<SignalSetupInput> = {
  ...signalSetupAdapterBase,
  prepareAccountConfigInput: ({ cfg, accountId, input }) =>
    prepareSignalSetupInput({ cfg, accountId, input }),
  singleAccountKeysToMove: [
    "signalNumber",
    "account",
    "cliPath",
    "httpUrl",
    "httpHost",
    "httpPort",
  ],
  applyAccountConfig: (params) => {
    const accountId = normalizeAccountId(params.accountId);
    // Generic multi-account setup can promote the root account but not its owner-specific
    // transport. Rejoin that pair here so Signal keeps one canonical default-account shape.
    const cfg = restorePromotedSignalDefaultAccount(params.cfg);
    const previousTransport = resolveConfiguredSignalTransport(cfg, accountId);
    const next = signalSetupAdapterBase.applyAccountConfig?.({ ...params, cfg, accountId }) ?? cfg;
    const configuredTransport = resolveConfiguredSignalTransport(next, accountId);
    if (configuredTransport && configuredTransport.kind !== "managed-native") {
      const transport =
        params.input.httpUrl &&
        !params.input.signalTransport &&
        (previousTransport?.kind === "container" || previousTransport?.kind === "external-native")
          ? { ...configuredTransport, kind: previousTransport.kind }
          : configuredTransport;
      return writeSignalAccountTransport({
        cfg: next,
        accountId,
        transport,
      });
    }
    return writeSignalAccountTransport({
      cfg: next,
      accountId,
      transport: prepareSignalManagedNativeTransport({
        // Use pre-patch transport state so aligned connection URLs can follow authored bind edits.
        cfg,
        accountId,
        overrides: managedTransportOverridesFromSetupInput(params.input),
      }),
    });
  },
};

export const signalSetupContract = defineChannelSetupContract({
  fields: signalSetupFields,
  adapter: signalSetupAdapter,
});

export function createSignalSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
      configuredHint: t("wizard.channels.statusSignalCliFound"),
      unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
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
