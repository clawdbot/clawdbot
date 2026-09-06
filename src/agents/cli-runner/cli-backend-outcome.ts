import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { coerceToFailoverError } from "../failover-error.js";
import type { ClaudeCliRunDiagnosticLifecycle } from "./run-diagnostics.js";

const log = createSubsystemLogger("agents/cli-runner");

export function settleCliBackendOutcome(params: {
  runResult: EmbeddedAgentRunResult | undefined;
  runError: unknown;
  runFailed: boolean;
  cleanupError: Error | undefined;
  deliveredMessagingSideEffect: boolean;
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle;
  failoverContext: { provider: string; model: string; sessionId: string; lane?: string };
}): EmbeddedAgentRunResult {
  const {
    cleanupError,
    deliveredMessagingSideEffect,
    diagnosticLifecycle,
    failoverContext,
    runError,
    runFailed,
    runResult,
  } = params;
  if (cleanupError) {
    if (!deliveredMessagingSideEffect) {
      if (runFailed) {
        log.warn(`CLI run also failed before backend cleanup: ${formatErrorMessage(runError)}`);
      }
      diagnosticLifecycle?.setPhase("cleanup");
      throw cleanupError;
    }
    log.warn(
      `CLI backend cleanup failed after confirmed message delivery: ${formatErrorMessage(cleanupError)}`,
    );
  }
  if (runFailed) {
    throw coerceToFailoverError(runError, failoverContext) ?? runError;
  }
  if (!runResult) {
    throw new Error("CLI run completed without a result");
  }
  return runResult;
}
