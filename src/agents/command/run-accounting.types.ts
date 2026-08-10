import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CodeModeRunFinalQuiescence } from "../code-mode-activity.js";
import type { CodeModeStats } from "../code-mode-stats.js";
import type { EmbeddedRunAccountingObservation } from "../embedded-agent-runner/run/accounting-observers.js";
import type { EmbeddedRunOpaqueWorkReason } from "../embedded-agent-runner/run/accounting-observers.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import type {
  ProviderTransportAccountingCoverage,
  ProviderTransportAccountingCoverageReason,
  ProviderTransportAccountingObserver,
  ProviderTransportAccountingSnapshot,
} from "../provider-transport-accounting.js";
import type { AgentSubmissionHandle } from "../sessions/agent-session-accounting.js";
import type { NormalizedUsage } from "../usage.js";

export type AgentCommandCandidateRuntime = "embedded" | "cli" | "native" | "cloud" | "unknown";

export type AgentCommandRunAccountingCoverageReason =
  | "candidate_failed"
  | "candidate_details_truncated"
  | "candidate_identity_truncated"
  | "effective_model_details_truncated"
  | "cli_runtime"
  | "native_runtime"
  | "cloud_runtime"
  | "unknown_runtime"
  | "missing_usage"
  | "partial_usage"
  | "partial_provider_billed_cost"
  | "missing_pricing"
  | "tiered_pricing_aggregate"
  | "acp_runtime"
  | "settled_finalization_failed"
  | "session_core_compaction"
  | "session_extension_compaction"
  | "native_harness_compaction"
  | "deferred_context_engine_maintenance"
  | "post_turn_compaction"
  | "tool_details_truncated"
  | "agent_submission_unsettled"
  | "model_call_unsettled"
  | "not_instrumented"
  | "not_observed"
  | "attempt_extraction_only"
  | ProviderTransportAccountingCoverageReason;

export type AgentCommandRunAccountingCoverage =
  | { state: "complete" }
  | {
      state: "partial" | "unavailable";
      reasons: AgentCommandRunAccountingCoverageReason[];
    };

export type AgentCommandRunCandidateAccounting = {
  selectRuntime: (runtime: Exclude<AgentCommandCandidateRuntime, "unknown">) => void;
  beginAgentSubmission: () => AgentSubmissionHandle;
  beginModelCall: () => AgentSubmissionHandle;
  markModelCallInstrumentationInstalled: () => void;
  observeEmbeddedAttempt: (observation: EmbeddedRunAccountingObservation) => void;
  observeAgentDuration: (durationMs: unknown) => void;
  markOpaqueWork: (reason: EmbeddedRunOpaqueWorkReason) => void;
  settle: (outcome: "returned" | "threw") => void;
};

export type AgentCommandModelCallSettlement = {
  outcome: "completed" | "failed";
  provider: string;
  model: string;
  usage?: NormalizedUsage;
  config?: OpenClawConfig;
  agentDir?: string;
};

export type AgentCommandModelCallAccounting = {
  settle: (settlement: AgentCommandModelCallSettlement) => void;
};

export type RunAccountingAccumulator = {
  readonly providerTransportObserver: ProviderTransportAccountingObserver;
  beginCandidate: (identity: {
    provider: string;
    model: string;
  }) => AgentCommandRunCandidateAccounting;
  beginAgentSubmission: () => AgentSubmissionHandle;
  beginModelCall: () => AgentCommandModelCallAccounting;
  markNoModelWork: () => void;
  markOpaqueWork: (reason: EmbeddedRunOpaqueWorkReason) => void;
  observeCodeModeFinalQuiescence: (state: CodeModeRunFinalQuiescence) => void;
  seal: () => void;
  project: () => AgentCommandRunAccountingSnapshot;
};

export type AgentCommandRunUsageBucket = import("../usage.js").NormalizedUsageBucket;

type AgentCommandRunCandidateRecord = {
  provider: string;
  model: string;
  runtime: AgentCommandCandidateRuntime;
  outcome: "returned" | "threw";
  effectiveModels: {
    entries: Array<{ provider: string; model: string }>;
    truncated: number;
  };
};

export type AgentCommandRunAccountingSnapshot = {
  candidates: {
    total: number;
    returned: number;
    threw: number;
    runtimes: Record<AgentCommandCandidateRuntime, number>;
    entries: AgentCommandRunCandidateRecord[];
    truncated: number;
  };
  agentSubmissions?: {
    total: number;
    completed: number;
    failed: number;
  };
  modelCalls?: {
    total: number;
    completed: number;
    failed: number;
  };
  assistantTurns?: number;
  usage?: Partial<Record<AgentCommandRunUsageBucket, number>>;
  toolSummary?: ToolSummaryTrace;
  toolNamesTruncated?: true;
  opaqueWork?: {
    total: number;
    byReason: Partial<Record<EmbeddedRunOpaqueWorkReason, number>>;
  };
  costUsd?: number;
  providerTransport?: ProviderTransportAccountingSnapshot;
  agentDurationMs?: number;
  commandExecutionDurationMs: number;
  coverage: {
    candidates: AgentCommandRunAccountingCoverage;
    agentSubmissions: AgentCommandRunAccountingCoverage;
    modelCalls: AgentCommandRunAccountingCoverage;
    assistantTurns: AgentCommandRunAccountingCoverage;
    usage: AgentCommandRunAccountingCoverage;
    usageBuckets: Record<AgentCommandRunUsageBucket, AgentCommandRunAccountingCoverage>;
    tools: AgentCommandRunAccountingCoverage;
    cost: AgentCommandRunAccountingCoverage;
    agentTime: AgentCommandRunAccountingCoverage;
    commandExecutionDuration: AgentCommandRunAccountingCoverage;
    wallLatency: AgentCommandRunAccountingCoverage;
    providerTransport: ProviderTransportAccountingCoverage;
  };
  codeMode?: {
    engaged: boolean;
    stats?: CodeModeStats;
    lifecycle: {
      maxUnresolvedAtExtraction?: number;
      attemptsWithUnresolved?: number;
      finalQuiescence:
        | { state: Exclude<CodeModeRunFinalQuiescence, "unavailable"> }
        | {
            state: "unavailable";
            reasons: AgentCommandRunAccountingCoverageReason[];
          };
    };
  };
};
