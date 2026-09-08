/** Error classification and physical-client retirement for startup recovery. */
import {
  AgentHarnessPreflightError,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isCodexAppServerStartupError } from "./attempt-timeouts.js";
import {
  isCodexAppServerBrokenPipeError,
  isCodexAppServerOverloadError,
  isCodexAppServerRequestTimeoutError,
  type CodexAppServerClient,
} from "./client.js";
import {
  isCodexAppServerStartSelectionChangedError,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle-types.js";

const CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED =
  "CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED";

/** True when a pre-write context restart must replay on the newly selected owner. */
export function isCodexContextRestartSelectionChangedError(
  error: unknown,
): error is Error & { code: typeof CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED
  );
}

export async function restartCodexContextEngineThread(params: {
  client: CodexAppServerClient;
  restart: () => Promise<CodexAppServerThreadLifecycleBinding>;
}): Promise<CodexAppServerThreadLifecycleBinding> {
  try {
    return await params.restart();
  } catch (error) {
    if (!isCodexAppServerStartSelectionChangedError(error)) {
      throw error;
    }
    // The run loop cannot safely swap the physical client, router, and lease
    // halfway through an overflow retry. Retire this generation so the next
    // bounded attempt acquires the owner selected by current native config.
    retireSharedCodexAppServerClientIfCurrent(params.client);
    throw Object.assign(new Error("codex app-server client is closed", { cause: error }), {
      code: CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED,
    });
  }
}

export function shouldRetireCodexStartupClient(
  error: unknown,
  spawnedBy: EmbeddedRunAttemptParams["spawnedBy"],
  signal: AbortSignal,
): boolean {
  if (
    signal.aborted ||
    isCodexAppServerStartupError(error) ||
    isCodexAppServerRequestTimeoutError(error)
  ) {
    return true;
  }
  // Model-independent preflights preserve healthy conversations. A handoff with
  // an uncertain native write owns its retirement at the resume boundary.
  return (
    !isCodexAppServerStartSelectionChangedError(error) &&
    !isCodexAppServerOverloadError(error) &&
    !(error instanceof AgentHarnessPreflightError && error.scope === undefined) &&
    (isCodexAppServerBrokenPipeError(error) || !spawnedBy)
  );
}
