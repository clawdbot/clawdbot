import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import type { QaEvidenceTiming, QaEvidenceSummaryJson } from "./evidence-summary.js";
import type { QaCliBackendAuthMode, QaGatewayChildCommand } from "./gateway-child.js";
import type { QaLabServerHandle, QaLabServerStartParams } from "./lab-server.types.js";
import type { QaProviderMode } from "./model-selection.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import type {
  QaTransportAdapterFactory,
  QaTransportFactoryContext,
  QaTransportId,
} from "./qa-transport-registry.js";
import type { QaReportCheck } from "./report.js";
import type { RuntimeId, RuntimeParityCell, RuntimeParityResult } from "./runtime-parity.js";
import type { QaScorecardChannelDriver, QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import type { QaSuiteRoundTripProbe } from "./suite-round-trip.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

export type QaSuiteScenarioResult = {
  name: string;
  status: "pass" | "fail" | "skip";
  steps: QaReportCheck[];
  details?: string;
  timing?: QaEvidenceTiming;
  runtimeParity?: RuntimeParityResult;
};

export type QaSuiteEnvironment = {
  lab: QaLabServerHandle;
  runtimeId: RuntimeId;
  webSessionIds: Set<string>;
} & QaSuiteRuntimeEnv;

export type QaSuiteStartLabFn = (params?: QaLabServerStartParams) => Promise<QaLabServerHandle>;

export type QaSuiteRunParams = {
  adapterOptions?: QaTransportFactoryContext["adapterOptions"];
  adapterFactories?: readonly QaTransportAdapterFactory[];
  channelId?: string;
  evidenceMode?: QaScorecardEvidenceMode;
  repoRoot?: string;
  sutOpenClawCommand?: QaGatewayChildCommand;
  outputDir?: string;
  providerMode?: QaProviderMode;
  transportId?: QaTransportId;
  channelDriver?: QaScorecardChannelDriver;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  failFast?: boolean;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  scenarioIds?: string[];
  lab?: QaLabServerHandle;
  startLab?: QaSuiteStartLabFn;
  concurrency?: number;
  enabledPluginIds?: string[];
  controlUiEnabled?: boolean;
  transportReadyTimeoutMs?: number;
  workerStartStaggerMs?: number;
  forcedRuntime?: RuntimeId;
  runtimePair?: [RuntimeId, RuntimeId];
  captureRuntimeParityCell?: boolean;
  roundTripProbe?: QaSuiteRoundTripProbe;
  // Unified suite partitions consume child evidence in memory; only the
  // parent should write the aggregate qa-evidence.json artifact.
  writeEvidenceFile?: boolean;
};

export type QaSuiteResult = {
  evidence?: QaEvidenceSummaryJson;
  outputDir: string;
  evidencePath: string;
  reportPath: string;
  summaryPath: string;
  report: string;
  scenarios: QaSuiteScenarioResult[];
  startedScenarioIds: string[];
  watchUrl: string;
  runtimeParityCell?: RuntimeParityCell;
};

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
