// Imessage plugin module implements setup surface behavior.
import {
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { resolveIMessageAccount } from "./accounts.js";
import { installIMessageCli } from "./install-imsg.js";
import {
  createIMessageCliPathTextInput,
  IMESSAGE_INSTALL_COMMAND,
  isAutoManagedIMessageCliPath,
  imessageCompletionNote,
  imessageDmPolicy,
  imessageSetupStatusBase,
  normalizeIMessageCliPathForSetup,
  parseIMessageAllowFromEntries,
} from "./setup-core.js";

const channel = "imessage" as const;

const imessageDetectedBinaryStatus = createDetectedBinaryStatus({
  channelLabel: "iMessage",
  binaryLabel: "imsg",
  configuredLabel: imessageSetupStatusBase.configuredLabel,
  unconfiguredLabel: imessageSetupStatusBase.unconfiguredLabel,
  configuredHint: imessageSetupStatusBase.configuredHint,
  unconfiguredHint: imessageSetupStatusBase.unconfiguredHint,
  configuredScore: imessageSetupStatusBase.configuredScore,
  unconfiguredScore: imessageSetupStatusBase.unconfiguredScore,
  resolveConfigured: imessageSetupStatusBase.resolveConfigured,
  resolveBinaryPath: ({ cfg, accountId }) =>
    resolveIMessageAccount({ cfg, accountId }).config.cliPath ?? "imsg",
  detectBinary,
});

export const imessageSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    ...imessageDetectedBinaryStatus,
    async resolveStatusLines(params) {
      const lines = (await imessageDetectedBinaryStatus.resolveStatusLines?.(params)) ?? [];
      const configuredCliPath = resolveIMessageAccount({
        cfg: params.cfg,
        accountId: params.accountId,
      }).config.cliPath;
      const cliPath = configuredCliPath ?? "imsg";
      if (await detectBinary(cliPath)) {
        return lines;
      }
      const hint = isAutoManagedIMessageCliPath(cliPath, {
        explicit: configuredCliPath !== undefined,
      })
        ? `Install imsg on the Messages Mac: ${IMESSAGE_INSTALL_COMMAND}`
        : `imsg command not found (${cliPath}). Check the configured cliPath or wrapper.`;
      return [...lines, hint];
    },
  },
  prepare: async ({ cfg, accountId, credentialValues, runtime, prompter, options }) => {
    if (!options?.allowIMessageInstall || process.platform !== "darwin") {
      return undefined;
    }
    const credentialCliPath =
      typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined;
    const configuredCliPath = resolveIMessageAccount({ cfg, accountId }).config.cliPath;
    const explicitCliPath = credentialCliPath ?? configuredCliPath;
    const currentCliPath = explicitCliPath ?? "imsg";
    const normalizedCliPath = normalizeIMessageCliPathForSetup(currentCliPath);
    if (
      !isAutoManagedIMessageCliPath(normalizedCliPath, {
        explicit: explicitCliPath !== undefined,
      })
    ) {
      return undefined;
    }
    const cliDetected = await detectBinary(normalizedCliPath);
    const wantsInstall = await prompter.confirm({
      message: cliDetected
        ? "imsg detected. Reinstall/update now?"
        : "imsg not found. Install now?",
      initialValue: !cliDetected,
    });
    if (!wantsInstall) {
      return undefined;
    }
    try {
      await options?.beforePersistentEffect?.();
      const result = await installIMessageCli(runtime, { upgrade: cliDetected });
      if (result.ok && result.cliPath) {
        await prompter.note(`Installed imsg at ${result.cliPath}`, "iMessage");
        return {
          credentialValues: {
            cliPath: result.cliPath,
          },
        };
      }
      if (!result.ok) {
        await prompter.note(result.error ?? "imsg install failed.", "iMessage");
      }
    } catch (error) {
      await prompter.note(`imsg install failed: ${String(error)}`, "iMessage");
    }
    return undefined;
  },
  credentials: [],
  textInputs: [
    createIMessageCliPathTextInput(async ({ currentValue }) => {
      return !(await detectBinary(currentValue ?? "imsg"));
    }),
  ],
  completionNote: imessageCompletionNote,
  dmPolicy: imessageDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { parseIMessageAllowFromEntries };
