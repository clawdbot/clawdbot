import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
// Signal plugin module implements setup surface behavior.
import {
  createSetupTranslator,
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
  WizardCancelledError,
} from "openclaw/plugin-sdk/setup";
import { detectBinary, formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { installSignalCli } from "./install-signal-cli.js";
import { createSignalLinkRpcClient, type SignalLinkRpcClient } from "./link-rpc.js";
import {
  createSignalCliPathTextInput,
  normalizeSignalAccountInput,
  SIGNAL_LINK_COMPLETED_CREDENTIAL,
  signalCompletionNote,
  signalDmPolicy,
  signalNumberTextInput,
} from "./setup-core.js";

const t = createSetupTranslator();

const channel = "signal" as const;
const SIGNAL_LINK_URI_MAX_LENGTH = 4096;
const SIGNAL_LINK_RPC_MAX_BYTES = 16 * 1024;
const SIGNAL_LINK_EXPIRES_IN_MS = 120_000;
const configuredLabel = t("wizard.channels.statusConfigured");
const unconfiguredLabel = t("wizard.channels.statusNeedsSetup");
const managedStatus = createDetectedBinaryStatus({
  channelLabel: "Signal",
  binaryLabel: "signal-cli",
  configuredLabel,
  unconfiguredLabel,
  configuredHint: t("wizard.channels.statusSignalCliFound"),
  unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
  configuredScore: 1,
  unconfiguredScore: 0,
  resolveConfigured: ({ cfg, accountId }) =>
    accountId
      ? resolveSignalAccount({ cfg, accountId }).configured
      : listSignalAccountIds(cfg).some(
          (resolvedAccountId) =>
            resolveSignalAccount({ cfg, accountId: resolvedAccountId }).configured,
        ),
  resolveBinaryPath: ({ cfg, accountId }) => {
    const transport = resolveSignalAccount({ cfg, accountId }).transport;
    return transport.kind === "managed-native" ? transport.cliPath : "signal-cli";
  },
  detectBinary,
});

function parseSignalAccounts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("invalid Signal account list");
  }
  return [
    ...new Set(
      value.map((entry) => {
        const rawNumber = isRecord(entry) ? entry.number : undefined;
        const number =
          typeof rawNumber === "string" ? normalizeSignalAccountInput(rawNumber) : null;
        if (!number) {
          throw new Error("invalid Signal account");
        }
        return number;
      }),
    ),
  ].toSorted();
}

function parseSignalLinkUri(value: unknown): string {
  const rawUri = isRecord(value) ? value.deviceLinkUri : undefined;
  const uri = typeof rawUri === "string" ? rawUri.trim() : "";
  if (!uri || uri !== rawUri || uri.length > SIGNAL_LINK_URI_MAX_LENGTH) {
    throw new Error("invalid Signal device link URI");
  }
  const parsed = new URL(uri);
  if (parsed.protocol !== "sgnl:" || parsed.hostname !== "linkdevice") {
    throw new Error("invalid Signal device link URI");
  }
  return uri;
}

function parseLinkedSignalNumber(value: unknown): string {
  const rawNumber = isRecord(value) ? value.number : undefined;
  const number = typeof rawNumber === "string" ? normalizeSignalAccountInput(rawNumber) : null;
  if (!number) {
    throw new Error("invalid linked Signal account");
  }
  return number;
}

async function noteSignalLinkFallback(prompter: WizardPrompter, signal: AbortSignal) {
  if (signal.aborted) {
    throw new WizardCancelledError();
  }
  await prompter.note(
    [
      "Automatic Signal linking could not complete. Continue with the account number, then link it manually:",
      formatCliCommand('signal-cli link -n "OpenClaw"'),
    ].join("\n"),
    "Signal",
  );
}

async function prepareManagedSignalLink(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: {
    signal?: AbortSignal;
    beforeExternalEffect?: () => Promise<void>;
    beforePersistentEffect?: () => Promise<void>;
  };
  cliPath: string;
}): Promise<string | undefined> {
  const signal = params.options?.signal;
  if (
    !signal ||
    !params.prompter.qrCode ||
    listSignalAccountIds(params.cfg).some(
      (accountId) => resolveSignalAccount({ cfg: params.cfg, accountId }).configured,
    )
  ) {
    return undefined;
  }
  const transport = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).transport;
  if (transport.kind !== "managed-native") {
    return undefined;
  }

  let linkClient: SignalLinkRpcClient | undefined;
  try {
    let accounts: string[];
    let deviceLinkUri: string | undefined;
    try {
      linkClient = createSignalLinkRpcClient({
        cliPath: params.cliPath,
        ...(transport.configPath ? { configPath: transport.configPath } : {}),
        abortSignal: signal,
      });
      accounts = parseSignalAccounts(
        await linkClient.request("listAccounts", undefined, {
          timeoutMs: transport.startupTimeoutMs,
          maxResponseBytes: SIGNAL_LINK_RPC_MAX_BYTES,
        }),
      );
    } catch {
      await noteSignalLinkFallback(params.prompter, signal);
      return undefined;
    }
    if (accounts.length === 0) {
      signal.throwIfAborted();
      await params.options?.beforeExternalEffect?.();
      signal.throwIfAborted();
      try {
        deviceLinkUri = parseSignalLinkUri(
          await linkClient.request("startLink", undefined, {
            timeoutMs: 35_000,
            maxResponseBytes: SIGNAL_LINK_RPC_MAX_BYTES,
          }),
        );
      } catch {
        await noteSignalLinkFallback(params.prompter, signal);
        return undefined;
      }
    }

    if (accounts.length > 0) {
      return accounts.length === 1
        ? accounts[0]
        : await params.prompter.select({
            message: "Choose the Signal account for OpenClaw",
            options: accounts.map((number) => ({ value: number, label: number })),
          });
    }
    if (!deviceLinkUri) {
      await noteSignalLinkFallback(params.prompter, signal);
      return undefined;
    }

    signal.throwIfAborted();
    await params.options?.beforeExternalEffect?.();
    signal.throwIfAborted();
    await params.options?.beforePersistentEffect?.();
    signal.throwIfAborted();
    try {
      const settled = linkClient
        .request(
          "finishLink",
          { deviceLinkUri, deviceName: "OpenClaw" },
          {
            timeoutMs: SIGNAL_LINK_EXPIRES_IN_MS + 5_000,
            maxResponseBytes: SIGNAL_LINK_RPC_MAX_BYTES,
          },
        )
        .then(parseLinkedSignalNumber);
      return await params.prompter.qrCode({
        title: "Link Signal",
        message:
          "In Signal, open Settings → Linked devices and scan this QR code. Setup will finish or time out.",
        text: deviceLinkUri,
        expiresInMs: SIGNAL_LINK_EXPIRES_IN_MS,
        settled,
      });
    } catch {
      await noteSignalLinkFallback(params.prompter, signal);
      return undefined;
    }
  } finally {
    await linkClient?.stop();
  }
}

export const signalSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    ...managedStatus,
    resolveStatusLines: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return (await managedStatus.resolveStatusLines?.(params)) ?? [];
      }
      return [`Signal: ${params.configured ? configuredLabel : unconfiguredLabel}`];
    },
    resolveSelectionHint: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return await managedStatus.resolveSelectionHint?.(params);
      }
      return params.configured ? configuredLabel : unconfiguredLabel;
    },
    resolveQuickstartScore: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return await managedStatus.resolveQuickstartScore?.(params);
      }
      return params.configured ? 1 : 0;
    },
  },
  prepare: async ({ cfg, accountId, credentialValues, runtime, prompter, options }) => {
    if (!options?.allowSignalInstall) {
      return undefined;
    }
    const transport = resolveSignalAccount({ cfg, accountId }).transport;
    if (transport.kind !== "managed-native") {
      return undefined;
    }
    let cliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      (transport.kind === "managed-native" ? transport.cliPath : undefined) ??
      "signal-cli";
    const cliDetected = await detectBinary(cliPath);
    const wantsInstall = await prompter.confirm({
      message: cliDetected ? t("wizard.signal.reinstallPrompt") : t("wizard.signal.installPrompt"),
      initialValue: !cliDetected,
    });
    if (!wantsInstall && !cliDetected) {
      return undefined;
    }
    const preparedCredentialValues: Record<string, string> = {};
    if (wantsInstall) {
      try {
        await options?.beforePersistentEffect?.();
        const result = await installSignalCli(runtime);
        if (result.ok && result.cliPath) {
          cliPath = result.cliPath;
          preparedCredentialValues.cliPath = cliPath;
          await prompter.note(`Installed signal-cli at ${cliPath}`, "Signal");
        } else if (!result.ok) {
          await prompter.note(
            "signal-cli installation failed. Install it manually and retry setup.",
            "Signal",
          );
          return undefined;
        }
      } catch {
        await prompter.note(
          "signal-cli installation failed. Install it manually and retry setup.",
          "Signal",
        );
        return undefined;
      }
    }
    const linkedNumber = await prepareManagedSignalLink({
      cfg,
      accountId,
      runtime,
      prompter,
      options,
      cliPath,
    });
    if (linkedNumber) {
      preparedCredentialValues.signalNumber = linkedNumber;
      preparedCredentialValues[SIGNAL_LINK_COMPLETED_CREDENTIAL] = "true";
    }
    return Object.keys(preparedCredentialValues).length > 0
      ? { credentialValues: preparedCredentialValues }
      : undefined;
  },
  credentials: [],
  textInputs: [
    createSignalCliPathTextInput(async ({ cfg, accountId, currentValue }) => {
      if (resolveSignalAccount({ cfg, accountId }).transport.kind !== "managed-native") {
        return false;
      }
      return !(await detectBinary(currentValue ?? "signal-cli"));
    }),
    signalNumberTextInput,
  ],
  completionNote: signalCompletionNote,
  dmPolicy: signalDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
