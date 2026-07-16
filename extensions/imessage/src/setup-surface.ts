import {
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { resolveIMessageAccount } from "./accounts.js";
import {
  createIMessageCliPathTextInput,
  imessageCompletionNote,
  imessageDmPolicy,
  imessageSetupAdapter,
  imessageSetupStatusBase,
  parseIMessageAllowFromEntries,
} from "./setup-core.js";

const channel = "imessage" as const;

export const imessageSetupWizard: ChannelSetupWizard = {
  channel,
  status: createDetectedBinaryStatus({
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
  }),
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

export { imessageSetupAdapter, parseIMessageAllowFromEntries };
