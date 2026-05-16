import {
  createSetupTranslator,
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { installSignalCli } from "./install-signal-cli.js";
import {
  createSignalCliPathTextInput,
  signalCompletionNote,
  signalDmPolicy,
  signalNumberTextInput,
} from "./setup-core.js";

const t = createSetupTranslator();

const channel = "signal" as const;
export const signalSetupWizard: ChannelSetupWizard = {
  channel,
  status: createDetectedBinaryStatus({
    channelLabel: "Signal",
    binaryLabel: "signal-cli",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
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
    resolveBinaryPath: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.cliPath ?? "signal-cli",
    detectBinary,
  }),
  prepare: async ({ cfg, accountId, credentialValues, runtime, prompter, options }) => {
    if (!options?.allowSignalInstall) {
      return undefined;
    }
    const currentCliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      resolveSignalAccount({ cfg, accountId }).config.cliPath ??
      "signal-cli";
    const cliDetected = await detectBinary(currentCliPath);
    const wantsInstall = await prompter.confirm({
      message: cliDetected ? t("wizard.signal.reinstallPrompt") : t("wizard.signal.installPrompt"),
      initialValue: !cliDetected,
    });
    if (!wantsInstall) {
      return undefined;
    }
    try {
      const result = await installSignalCli(runtime);
      if (result.ok && result.cliPath) {
        await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
        return {
          credentialValues: {
            cliPath: result.cliPath,
          },
        };
      }
      if (!result.ok) {
        await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
      }
    } catch (error) {
      await prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
    }
    return undefined;
  },
  credentials: [],
  textInputs: [
    createSignalCliPathTextInput(async ({ currentValue }) => {
      return !(await detectBinary(currentValue ?? "signal-cli"));
    }),
    signalNumberTextInput,
  ],
  completionNote: signalCompletionNote,
  dmPolicy: signalDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
