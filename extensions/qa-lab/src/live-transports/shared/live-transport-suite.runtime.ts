import type { LiveTransportQaCommandOptions } from "openclaw/plugin-sdk/qa-runtime";
import { runQaSuiteCommand } from "../../cli.runtime.js";
import {
  resolveQaExecutionShard,
  selectQaExecutionShardScenarioIds,
} from "../../execution-sharding.js";
import type { QaProviderMode } from "../../providers/index.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "../../run-config.js";

const QA_EXECUTION_SHARD_ENV = "OPENCLAW_QA_EXECUTION_SHARD";

type LiveTransportScenarioSelection = (params: {
  profile?: string;
  primaryModel: string;
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
  const primaryModel = options.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const selectedScenarioIds = params.selectScenarioIds({
    profile: options.profile,
    primaryModel,
    providerMode,
    scenarioIds: options.scenarioIds,
  });
  const executionShard = resolveQaExecutionShard(process.env[QA_EXECUTION_SHARD_ENV]);
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
    scenarioIds: executionShard
      ? selectQaExecutionShardScenarioIds(selectedScenarioIds, executionShard)
      : selectedScenarioIds,
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
