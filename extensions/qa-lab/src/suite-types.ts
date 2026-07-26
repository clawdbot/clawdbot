import type { QaProviderMode } from "./model-selection.js";
import type { QaTransportId } from "./qa-transport-registry.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";
import type {
  QaSuiteEnvironment,
  QaSuiteResult,
  QaSuiteRunParams,
  QaSuiteScenarioResult,
} from "./suite.js";

export type {
  QaSuiteEnvironment,
  QaSuiteResult,
  QaSuiteRunParams,
  QaSuiteScenarioResult,
  QaSuiteStartLabFn,
} from "./suite.js";

export type QaSuiteRunner = (params?: QaSuiteRunParams) => Promise<QaSuiteResult>;
export type QaSuiteScenarioRunner = (
  env: QaSuiteEnvironment,
  scenario: ReturnType<
    typeof import("./scenario-catalog.js").readQaBootstrapScenarioCatalog
  >["scenarios"][number],
) => Promise<QaSuiteScenarioResult>;

export type QaSuiteResolvedRunContext = {
  startedAt: Date;
  repoRoot: string;
  outputDir: string;
  transportId: QaTransportId;
  selectedScenarios: ReturnType<
    typeof import("./scenario-catalog.js").readQaBootstrapScenarioCatalog
  >["scenarios"];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  channelDriver?: QaScorecardChannelDriver;
  enabledPluginIds: string[];
  gatewayConfigPatch: ReturnType<
    typeof import("./suite-planning.js").collectQaSuiteGatewayConfigPatch
  >;
  gatewayRuntimeOptions: ReturnType<
    typeof import("./suite-planning.js").collectQaSuiteGatewayRuntimeOptions
  >;
  concurrency: number;
  progressEnabled: boolean;
  gatewayHeapCheckpointsEnabled: boolean;
};
