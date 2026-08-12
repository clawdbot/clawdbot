import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
/** Shared contracts for the prepared attempt execution phases. */
import type {
  createEmbeddedAttemptExternalAbortController,
  EmbeddedAttemptAbortStatePort,
} from "./attempt-finalize.js";
import type { prepareEmbeddedAttemptHistory } from "./attempt-history.js";
import type { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import type { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import type { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import type { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import type { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import type { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type Prepared<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;
type PreparedSetup = Prepared<typeof prepareEmbeddedAttemptSetup>;
type PreparedTranscriptLifecycle = Prepared<typeof prepareEmbeddedAttemptTranscriptLifecycle>;
type HistoryInput = Parameters<typeof prepareEmbeddedAttemptHistory>[0];
type StreamInput = Parameters<typeof prepareEmbeddedAttemptStream>[0];
type StreamGuardInput = Parameters<typeof installEmbeddedAttemptStreamGuards>[0];
type AttemptContextEngine = NonNullable<HistoryInput["activeContextEngine"]>;

export type EmbeddedAttemptExecutionState = {
  beforeAgentRunBlockedBy: string | undefined;
  terminal: AgentRunAttemptTerminal;
  trajectoryEndRecorded: boolean;
};

export type EmbeddedAttemptExecutionPhaseInput = {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: AttemptContextEngine;
  agentDir: string;
  isRawModelRun: boolean;
  resolveActiveContextEnginePluginId: () => string | undefined;
  runAbortController: AbortController;
  externalAbortController: Pick<
    ReturnType<typeof createEmbeddedAttemptExternalAbortController>,
    "setCompactionState" | "setRunAbort"
  >;
  abortState: EmbeddedAttemptAbortStatePort;
  prepared: {
    bootstrap: Prepared<typeof prepareEmbeddedAttemptBootstrap>;
    bundleTools: Prepared<typeof prepareEmbeddedAttemptBundleTools>;
    sessionRuntime: Prepared<typeof prepareEmbeddedAttemptSessionRuntime>;
    systemPrompt: Prepared<typeof prepareEmbeddedAttemptSystemPrompt>;
    toolBase: ReturnType<typeof prepareEmbeddedAttemptToolBase>;
    toolCatalog: ReturnType<typeof prepareEmbeddedAttemptToolCatalog>;
  };
  sessionLock: Pick<
    PreparedTranscriptLifecycle,
    "compactionTimeoutMs" | "ownedTranscriptWriteContext" | "withOwnedTranscriptWrite"
  >;
  setup: Pick<
    PreparedSetup,
    | "effectiveFsWorkspaceOnly"
    | "effectiveWorkspace"
    | "emitPrepStageSummary"
    | "prepStages"
    | "sandbox"
    | "sandboxSessionKey"
    | "sessionAgentId"
  >;
  diagnostics: {
    diagnosticTrace: StreamInput["diagnosticTrace"];
    runTrace: StreamGuardInput["runTrace"];
  };
  state: EmbeddedAttemptExecutionState;
  lifecycle: {
    readYieldState: () => {
      yieldAbortSettled: Promise<void> | null;
      yieldDetected: boolean;
      yieldMessage: string | null;
    };
    setToolSearchCatalogExecutor: (
      executor: ReturnType<typeof prepareEmbeddedAttemptStream>["toolSearchCatalogExecutor"],
    ) => void;
  };
};
