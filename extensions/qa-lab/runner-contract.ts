import type { QaProviderMode } from "./src/providers/index.js";
import type { QaRuntimePairLane, QaScenarioExecution } from "./src/scenario-catalog.js";
import type {
  QaScorecardChannelDriver,
  QaScorecardEvidenceMode,
} from "./src/scorecard-taxonomy.js";

export type QaLabExecutionKind = NonNullable<QaScenarioExecution["kind"]>;

export type QaLabRunSelection = {
  profile: string;
  channel: string | null;
  channelDriver: QaScorecardChannelDriver;
  evidenceMode: QaScorecardEvidenceMode;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  runtimePair: ["openclaw", "codex"] | null;
  runtimePairLane: QaRuntimePairLane | null;
  scenarioIds: string[] | null;
};

export type QaLabResolvedRunPlan = {
  status: "ready" | "invalid";
  profile: string;
  explicitScenarioSelection: boolean;
  selectedScenarios: Array<{
    id: string;
    title: string;
    executionKind: QaLabExecutionKind;
    declaredChannel: string | null;
    effectiveChannel: string | null;
  }>;
  executionKinds: QaLabExecutionKind[];
  exclusions: Array<{
    scenarioId: string;
    executionKind: QaLabExecutionKind;
    reasons: string[];
  }>;
  errors: string[];
};

type QaLabRunArtifacts = {
  outputDir: string;
  evidencePath: string;
  reportPath: string;
  summaryPath: string;
  watchUrl: string;
};

export type QaLabRunnerSnapshot = {
  status: "idle" | "running" | "completed" | "failed";
  selection: QaLabRunSelection;
  plan: QaLabResolvedRunPlan | null;
  startedAt?: string;
  finishedAt?: string;
  artifacts: QaLabRunArtifacts | null;
  error: string | null;
};
