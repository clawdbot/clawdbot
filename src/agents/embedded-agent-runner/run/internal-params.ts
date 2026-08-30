import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { AgentExecutionAuthBinding } from "../../execution-auth-binding.js";
import type { PreparedModelRuntimePluginGeneration } from "../../prepared-model-runtime.types.js";
import type { SystemAgentToolOptions } from "../../tools/system-agent-tool.js";
import type { DeferredEmbeddedRunLifecycleOwner } from "./deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type CompactionAccountingTarget = Readonly<
  SessionTranscriptRuntimeTarget &
    Pick<InternalSessionEntry, "lifecycleRevision" | "activeWriterRunId">
>;

/** Ordered producer observations; unknown context never borrows an older request's usage. */
export type EmbeddedContextAccountingEvent = Readonly<
  | { kind: "compaction"; tokensAfter: number | undefined }
  | { kind: "model"; contextTokens: number | undefined }
>;

/** Writer custody is independent of telemetry; an absent snapshot is not observed unknown context. */
export type CompactionAccountingFact = Readonly<
  { count: number; currentContextSnapshot?: { tokens: number | undefined } } & (
    | { kind: "durable"; target: CompactionAccountingTarget }
    | { kind: "presentation-only" }
  )
>;

type CompactionAccountingParams =
  | { compactionCountOwner?: "subscription"; onCompactionAccounting?: never }
  | {
      compactionCountOwner: "caller";
      onCompactionAccounting: (fact: CompactionAccountingFact | undefined) => void;
    };

export type RunEmbeddedAgentInternalParams = RunEmbeddedAgentParams &
  CompactionAccountingParams & {
    /** Attempt-local context observer, installed by the host loop before dispatch. */
    onContextAccountingEvent?: (event: EmbeddedContextAccountingEvent) => void;
    onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
    /** Maintenance needs the winning profile, not native runtime artifact capture. */
    onSuccessfulAuthProfile?: (profileId: string | undefined) => void;
    authProfileStateMode?: "read-write" | "read-only";
    /** Prepare only the requested candidate with this runtime; fallbacks keep their own policy. */
    agentHarnessRuntimePreparationHint?: string;
    /** Keep staged setup config and credentials outside configured Gateway ownership. */
    preparedModelRuntimeMode?: "isolated-read-only";
    /** Ring-zero tool override, supplied only by the OpenClaw orchestrator. */
    systemAgentTool?: SystemAgentToolOptions;
    /** Gateway-private lifecycle generation selected before command admission. */
    pluginGeneration?: PreparedModelRuntimePluginGeneration;
    /** Host-only transfer of attempt terminal resources to the logical turn. */
    onDeferredLifecycleOwner?: (owner: DeferredEmbeddedRunLifecycleOwner) => void;
    /** Aborts the logical turn when its retained embedded handle is cancelled. */
    onDeferredLifecycleAbort?: (reason?: "user_abort" | "restart" | "superseded") => void;
  };

export type EmbeddedRunAttemptInternalParams = EmbeddedRunAttemptParams &
  Pick<RunEmbeddedAgentInternalParams, "compactionCountOwner" | "onContextAccountingEvent">;

export type RunEmbeddedAgentParamsWithSessionFile = RunEmbeddedAgentInternalParams & {
  sessionFile: string;
};
