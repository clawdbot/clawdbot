import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
/** Shared contracts for the prepared attempt execution phases. */
import type { createPromptBuildToolPolicy } from "./attempt-prompt-support.js";
import type { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
import type { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import type { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import type { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type {
  EmbeddedAttemptExecutionState,
  EmbeddedAttemptExternalAbortController,
  EmbeddedRunAttemptParams,
} from "./types.js";

type Prepared<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;
type PreparedTranscriptLifecycle = Prepared<typeof prepareEmbeddedAttemptTranscriptLifecycle>;

export type EmbeddedAttemptExecutionPhaseInput = {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: AttemptContextEngine;
  agentDir: string;
  isRawModelRun: boolean;
  resolveActiveContextEnginePluginId: () => string | undefined;
  runAbortController: AbortController;
  externalAbortController: Pick<
    EmbeddedAttemptExternalAbortController,
    "setCompactionState" | "setRunAbort"
  >;
  prepared: {
    bootstrap: Prepared<typeof prepareEmbeddedAttemptBootstrap>;
    bundleTools: Prepared<typeof prepareEmbeddedAttemptBundleTools>;
    sessionRuntime: Prepared<typeof prepareEmbeddedAttemptSessionRuntime>;
    systemPrompt: Prepared<typeof prepareEmbeddedAttemptSystemPrompt>;
    toolBase: ReturnType<typeof prepareEmbeddedAttemptToolBase>;
    toolCatalog: ReturnType<typeof prepareEmbeddedAttemptToolCatalog>;
    promptToolPolicy: ReturnType<typeof createPromptBuildToolPolicy>;
  };
  sessionLock: Pick<
    PreparedTranscriptLifecycle,
    "compactionTimeoutMs" | "ownedTranscriptWriteContext" | "withOwnedTranscriptWrite"
  >;
  setup: Pick<
    EmbeddedAttemptSetup,
    | "effectiveFsWorkspaceOnly"
    | "effectiveWorkspace"
    | "emitPrepStageSummary"
    | "prepStages"
    | "sandbox"
    | "sandboxSessionKey"
    | "sessionAgentId"
  >;
  diagnostics: {
    diagnosticTrace: DiagnosticTraceContext;
    runTrace: DiagnosticTraceContext;
  };
  state: EmbeddedAttemptExecutionState;
  lifecycle: {
    applyPermissionMode?: (
      mode: NonNullable<EmbeddedRunAttemptParams["permissionMode"]> | null,
      revokeApprovals: () => void,
    ) => void;
    readYieldState: () => {
      yieldAbortSettled: Promise<void> | null;
      yieldDetected: boolean;
      yieldMessage: string | null;
      yieldAcknowledgment?: string;
    };
    setToolSearchCatalogExecutor: (
      executor: ReturnType<typeof prepareEmbeddedAttemptStream>["toolSearchCatalogExecutor"],
    ) => void;
  };
};
