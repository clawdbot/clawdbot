import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { BootstrapContextRunKind } from "../../agents/bootstrap-mode.js";
import type { DeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import type { ContextEngineLogicalTurnLease } from "../../agents/harness/context-engine-logical-turn.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ThinkLevel } from "../thinking.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import type {
  AgentTurnCompaction,
  AgentTurnInternalResult,
  AgentTurnParams,
  EmbeddedAgentRunResult,
  RuntimeFallbackAttempt,
} from "./agent-runner-execution.types.js";
import type { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import type { FollowupRun } from "./queue.js";

/** Inputs prepared once per fallback candidate and consumed by either runtime adapter. */
export type AgentFallbackCandidateCommonParams = {
  preparedRunAdmission: PreparedAgentRunAdmission;
  turn: AgentTurnParams;
  candidateRun: FollowupRun["run"];
  runtimeConfig: OpenClawConfig;
  provider: string;
  model: string;
  candidateThinkLevel?: ThinkLevel;
  candidateFastMode: Pick<RunEmbeddedAgentParams, "fastMode" | "fastModeAutoOnSeconds">;
  runId: string;
  runAbortSignal?: AbortSignal;
  runLane: RunEmbeddedAgentParams["lane"];
  isFallbackRetry: boolean;
  isFinalFallbackAttempt?: boolean;
  suppressQueuedUserPersistenceForCandidate: boolean;
  userTurnTranscriptRecorder: RunEmbeddedAgentParams["userTurnTranscriptRecorder"];
  contextEngineLogicalTurnLease: ContextEngineLogicalTurnLease;
  onContextEngineTurnCandidate: RunEmbeddedAgentParams["onContextEngineTurnCandidate"];
  notifyUserMessagePersisted: () => void;
  fastModeStartedAtMs: number;
  fastModeAutoProgressState: FastModeAutoProgressState;
  bootstrapContextRunKind: BootstrapContextRunKind;
  bootstrapPromptWarningSignaturesSeen: string[];
  currentTurnImages: Awaited<
    ReturnType<typeof import("./current-turn-images.js").resolveCurrentTurnImages>
  >;
  signalExecutionPhaseForTyping: NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>;
  notifyAgentRunStart: () => void;
  preserveProgressCallbackStartOrder: boolean;
  presentation: ReturnType<typeof createAgentTurnPresentation>;
  timing: AgentTurnTimingTracker;
  onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => void;
  deferredLifecycle: DeferredEmbeddedRunLifecycleManager;
};

export type AgentFallbackCycleState = {
  deferredLifecycle: DeferredEmbeddedRunLifecycleManager;
  lifecycleGeneration: string;
  /** Turn admission time; terminal backstops must not stamp failure time as the start. */
  turnStartedAtMs: number;
  compaction: AgentTurnCompaction;
  /** Failure attribution only; model start does not prove current token freshness. */
  postCompactionModelAttempted: boolean;
  attemptedRuntimeProvider: string;
  attemptedRuntimeModel: string;
  bootstrapPromptWarningSignaturesSeen: string[];
  pendingLifecycleTerminal?: {
    provider: string;
    model: string;
    backstop: AgentLifecycleTerminalBackstop;
  };
};

type CompletedFallbackCycle = {
  kind: "completed";
  runResult: EmbeddedAgentRunResult;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackExhausted: boolean;
  fallbackAttempts: RuntimeFallbackAttempt[];
  terminalRunFailed: boolean;
};

export type AgentFallbackCycleResult =
  | CompletedFallbackCycle
  | Extract<AgentTurnInternalResult, { kind: "final" | "aborted" }>;

type AgentFallbackModelPatch = {
  captureFallbackFailure: (attempts: RuntimeFallbackAttempt[]) => boolean | undefined;
  captureFailure: (error: unknown) => void;
};

export type AgentFallbackCycleParams = {
  preparedRunAdmission: PreparedAgentRunAdmission;
  turn: AgentTurnParams;
  effectiveRun: FollowupRun["run"];
  runtimeConfig: OpenClawConfig;
  liveModelSwitchRuntimeEntry?: Pick<
    SessionEntry,
    "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
  >;
  runId: string;
  runAbortSignal?: AbortSignal;
  currentTurnImages: Awaited<
    ReturnType<typeof import("./current-turn-images.js").resolveCurrentTurnImages>
  >;
  state: AgentFallbackCycleState;
  presentation: ReturnType<typeof createAgentTurnPresentation>;
  directlySentBlockKeys: Set<string>;
  notifyAgentRunStart: () => void;
  signalExecutionPhaseForTyping: NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>;
  notifyUserAboutCompaction: boolean;
  timing: AgentTurnTimingTracker;
  modelPatch: AgentFallbackModelPatch;
  shouldSurfaceToControlUi: boolean;
  commitTerminalOutcome: () => void;
  clearRecoveredAutoFallbackPrimaryProbe: (candidate: {
    provider: string;
    model: string;
  }) => Promise<void>;
};
