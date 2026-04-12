import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { detectBinary as defaultDetectBinary } from "../../plugins/setup-binary.js";
import type {
  ChannelSetupWizard,
  ChannelSetupWizardStatus,
  ChannelSetupWizardTextInput,
} from "./setup-wizard.js";

type SetupTextInputParams = Parameters<NonNullable<ChannelSetupWizardTextInput["currentValue"]>>[0];
type SetupStatusParams = Parameters<NonNullable<ChannelSetupWizardStatus["resolveStatusLines"]>>[0];

export function createDetectedBinaryStatus(params: {
  channelLabel: string;
  binaryLabel: string;
  configuredLabel: string;
  unconfiguredLabel: string;
  configuredHint: string;
  unconfiguredHint: string;
  configuredScore: number;
  unconfiguredScore: number;
  resolveConfigured: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => boolean | Promise<boolean>;
  resolveBinaryPath: (params: { cfg: OpenClawConfig; accountId?: string }) => string;
  detectBinary?: (path: string) => Promise<boolean>;
}): ChannelSetupWizardStatus {
  const detectBinary = params.detectBinary ?? defaultDetectBinary;

  return {
    configuredLabel: params.configuredLabel,
    unconfiguredLabel: params.unconfiguredLabel,
    configuredHint: params.configuredHint,
    unconfiguredHint: params.unconfiguredHint,
    configuredScore: params.configuredScore,
    unconfiguredScore: params.unconfiguredScore,
    resolveConfigured: params.resolveConfigured,
    async resolveStatusLines({ cfg, accountId, configured }: SetupStatusParams): Promise<string[]> {
      const binaryPath = params.resolveBinaryPath({ cfg, accountId });
      const detected = await detectBinary(binaryPath);
      return [
        `${params.channelLabel}: ${configured ? params.configuredLabel : params.unconfiguredLabel}`,
        `${params.binaryLabel}: ${detected ? "found" : "missing"} (${binaryPath})`,
      ];
    },
    async resolveSelectionHint({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string;
      configured: boolean;
    }): Promise<string | undefined> {
      return (await detectBinary(params.resolveBinaryPath({ cfg, accountId })))
        ? params.configuredHint
        : params.unconfiguredHint;
    },
    async resolveQuickstartScore({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string;
      configured: boolean;
    }): Promise<number | undefined> {
      return (await detectBinary(params.resolveBinaryPath({ cfg, accountId })))
        ? params.configuredScore
        : params.unconfiguredScore;
    },
  };
}

export function createCliPathTextInput(params: {
  inputKey: ChannelSetupWizardTextInput["inputKey"];
  message: string;
  resolvePath: (params: SetupTextInputParams) => string | undefined;
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>;
  helpTitle?: string;
  helpLines?: string[];
}): ChannelSetupWizardTextInput {
  return {
    inputKey: params.inputKey,
    message: params.message,
    currentValue: params.resolvePath,
    initialValue: params.resolvePath,
    shouldPrompt: params.shouldPrompt,
    confirmCurrentValue: false,
    applyCurrentValue: true,
    ...(params.helpTitle ? { helpTitle: params.helpTitle } : {}),
    ...(params.helpLines ? { helpLines: params.helpLines } : {}),
  };
}

export function createDelegatedSetupWizardStatusResolvers(
  loadWizard: () => Promise<ChannelSetupWizard>,
): Pick<
  ChannelSetupWizardStatus,
  "resolveStatusLines" | "resolveSelectionHint" | "resolveQuickstartScore"
> {
  return {
    async resolveStatusLines(params) {
      return (await loadWizard()).status.resolveStatusLines?.(params) ?? [];
    },
    async resolveSelectionHint(params) {
      return await (await loadWizard()).status.resolveSelectionHint?.(params);
    },
    async resolveQuickstartScore(params) {
      return await (await loadWizard()).status.resolveQuickstartScore?.(params);
    },
  };
}

export function createDelegatedTextInputShouldPrompt(params: {
  loadWizard: () => Promise<ChannelSetupWizard>;
  inputKey: ChannelSetupWizardTextInput["inputKey"];
}): NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]> {
  return async (inputParams) => {
    const input = (await params.loadWizard()).textInputs?.find(
      (entry) => entry.inputKey === params.inputKey,
    );
    return (await input?.shouldPrompt?.(inputParams)) ?? false;
  };
}
