import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
/** Shared contracts for the prepared attempt execution phases. */
import type {
  createEmbeddedAttemptExternalAbortController,
  EmbeddedAttemptAbortStatePort,
} from "./attempt-finalize.js";
import type { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import type { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import type { prepareEmbeddedAttemptStreamRuntime } from "./attempt-stream-runtime-prepare.js";
import type { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import type { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type Prepared<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;
type PreparedSetup = Prepared<typeof prepareEmbeddedAttemptSetup>;
type PreparedTranscriptLifecycle = Prepared<typeof prepareEmbeddedAttemptTranscriptLifecycle>;
type StreamRuntimeInput = Parameters<typeof prepareEmbeddedAttemptStreamRuntime>[0];
type AttemptContextEngine = NonNullable<StreamRuntimeInput["history"]["activeContextEngine"]>;

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
    diagnosticTrace: StreamRuntimeInput["stream"]["diagnosticTrace"];
    runTrace: StreamRuntimeInput["guards"]["runTrace"];
  };
  state: EmbeddedAttemptExecutionState;
  lifecycle: {
    readYieldState: () => {
      yieldAbortSettled: Promise<void> | null;
      yieldDetected: boolean;
      yieldMessage: string | null;
    };
    setToolSearchCatalogExecutor: StreamRuntimeInput["lifecycle"]["setToolSearchCatalogExecutor"];
  };
};
