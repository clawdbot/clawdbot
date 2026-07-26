import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import type {
  AgentRunLoopResult,
  AgentTurnParams,
  EmbeddedAgentRunResult,
  RuntimeFallbackAttempt,
} from "./agent-runner-execution.types.js";
import type { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import type { FollowupRun } from "./queue.js";

export type AgentFallbackCycleState = {
  lifecycleGeneration: string;
  autoCompactionCount: number;
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
  | Extract<AgentRunLoopResult, { kind: "final" }>;

type AgentFallbackModelPatch = {
  captureFallbackFailure: (attempts: RuntimeFallbackAttempt[]) => boolean | undefined;
  captureFailure: (error: unknown) => void;
};

export type AgentFallbackCycleParams = {
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
