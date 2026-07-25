import type { LiveTransportQaCommandOptions } from "openclaw/plugin-sdk/qa-runtime";
import { runQaSuiteCommand } from "../../cli.runtime.js";
import type { QaProviderMode } from "../../providers/index.js";
import { normalizeQaProviderMode } from "../../run-config.js";

type LiveTransportScenarioSelection = (params: {
  profile?: string;
  providerMode: QaProviderMode;
  scenarioIds?: readonly string[];
}) => string[];

export async function runLiveTransportQaSuiteCommand(params: {
  channelId: string;
  credentialMode?: "env-only" | "shared-lease";
  defaultProviderMode: QaProviderMode;
  envCredentialReason?: string;
  laneLabel?: string;
  options: LiveTransportQaCommandOptions;
  selectScenarioIds: LiveTransportScenarioSelection;
}) {
  const options = params.options;
  if (params.credentialMode === "env-only") {
    const laneLabel = params.laneLabel ?? params.channelId;
    const credentialSource = options.credentialSource?.trim().toLowerCase();
    if (credentialSource && credentialSource !== "env") {
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
  return runQaSuiteCommand({
    repoRoot: options.repoRoot,
    outputDir: options.outputDir,
    providerMode,
    primaryModel: options.primaryModel,
    alternateModel: options.alternateModel,
    fastMode: options.fastMode,
    allowFailures: options.allowFailures,
    failFast: options.failFast,
    channelDriver: "live",
    channel: params.channelId,
    concurrency: 1,
    scenarioIds: params.selectScenarioIds({
      profile: options.profile,
      providerMode,
      scenarioIds: options.scenarioIds,
    }),
    sutAccountId: options.sutAccountId,
    ...(params.credentialMode === "env-only"
      ? {}
      : {
          credentialSource: options.credentialSource?.trim(),
          credentialRole: options.credentialRole?.trim(),
        }),
    explicitScenarioSelection: Boolean(options.scenarioIds?.length),
  });
}
