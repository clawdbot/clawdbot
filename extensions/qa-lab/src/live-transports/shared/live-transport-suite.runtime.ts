import type { LiveTransportQaCommandOptions } from "openclaw/plugin-sdk/qa-runtime";
import { runQaSuiteCommand } from "../../cli.runtime.js";
import type { QaProviderMode } from "../../providers/index.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "../../run-config.js";

type DedicatedLiveTransportQaCommandOptions = LiveTransportQaCommandOptions & {
  channelDriver?: string;
};

type LiveTransportScenarioSelection = (params: {
  channelDriver: "live" | "crabline";
  profile?: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  scenarioIds?: readonly string[];
}) => string[];

function resolveDedicatedChannelDriver(value: string | undefined): "live" | "crabline" {
  const normalized = value?.trim().toLowerCase() || "live";
  if (normalized !== "live" && normalized !== "crabline") {
    throw new Error(`channel driver must be live or crabline, got "${value}".`);
  }
  return normalized;
}

export async function runLiveTransportQaSuiteCommand(params: {
  channelId: string;
  credentialMode?: "env-only" | "shared-lease";
  defaultProviderMode: QaProviderMode;
  envCredentialReason?: string;
  laneLabel?: string;
  options: DedicatedLiveTransportQaCommandOptions;
  selectScenarioIds: LiveTransportScenarioSelection;
}) {
  const options = params.options;
  const credentialSource =
    options.credentialSource?.trim() || process.env.OPENCLAW_QA_CREDENTIAL_SOURCE?.trim();
  const channelDriver = resolveDedicatedChannelDriver(options.channelDriver);
  if (channelDriver === "crabline") {
    if (options.credentialSource?.trim()) {
      throw new Error("QA Lab Crabline channel drivers do not use --credential-source.");
    }
    if (options.credentialRole?.trim()) {
      throw new Error("QA Lab Crabline channel drivers do not use --credential-role.");
    }
  } else if (params.credentialMode === "env-only") {
    const laneLabel = params.laneLabel ?? params.channelId;
    if (credentialSource && credentialSource.toLowerCase() !== "env") {
      throw new Error(
        `QA Lab ${laneLabel} supports only --credential-source env${params.envCredentialReason ? ` because ${params.envCredentialReason}` : "."}`,
      );
    }
    if (options.credentialRole?.trim()) {
      throw new Error(`QA Lab ${laneLabel} does not use credential roles.`);
    }
  }

  const providerMode =
    options.providerMode === undefined
      ? params.defaultProviderMode
      : normalizeQaProviderMode(options.providerMode);
  const primaryModel = options.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const selectedScenarioIds = params.selectScenarioIds({
    channelDriver,
    profile: options.profile,
    primaryModel,
    providerMode,
    scenarioIds: options.scenarioIds,
  });
  if (options.listScenarios) {
    for (const scenarioId of selectedScenarioIds) {
      process.stdout.write(`${scenarioId}\n`);
    }
    return undefined;
  }
  return runQaSuiteCommand({
    repoRoot: options.repoRoot,
    outputDir: options.outputDir,
    providerMode,
    primaryModel: options.primaryModel,
    alternateModel: options.alternateModel,
    fastMode: options.fastMode,
    allowFailures: options.allowFailures,
    failFast: options.failFast,
    channelDriver,
    channel: params.channelId,
    concurrency: 1,
    scenarioIds: selectedScenarioIds,
    sutAccountId: options.sutAccountId,
    ...(options.credentialFile ? { credentialFile: options.credentialFile } : {}),
    ...(channelDriver === "crabline" || params.credentialMode === "env-only"
      ? {}
      : {
          credentialSource,
          credentialRole: options.credentialRole?.trim(),
        }),
    explicitScenarioSelection: Boolean(options.scenarioIds?.length),
  });
}
