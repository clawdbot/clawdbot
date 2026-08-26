import { formatErrorMessage } from "../../infra/errors.js";
import { isCliSessionInvalidatingFailoverReason } from "../cli-session.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { type FailoverError, isFailoverError } from "../failover-error.js";
import { createCliFailoverError } from "./exit-error.js";
import { cliBackendLog } from "./log.js";
import type { CliReusableSession, PreparedCliRunContext } from "./types.js";

export type CliRecoveryOptions = {
  timeoutMs?: number;
  forkCliSessionOnResume?: boolean;
  resumeAt?: string;
  onForkSuccessorPersisted?: (sessionId: string) => void;
};

export function resolveCliSessionId(reusableCliSession: CliReusableSession): string | undefined {
  return reusableCliSession.mode === "reuse" || reusableCliSession.mode === "reuse-with-drift"
    ? reusableCliSession.sessionId
    : undefined;
}

function shouldRetryFreshCliSessionAfterFailover(params: {
  error: FailoverError;
  hasHistoryPrompt: boolean;
  recoveryPolicy?: "replace-binding" | "invalidated-only";
}): boolean {
  if (!params.hasHistoryPrompt) {
    return false;
  }
  // Some CLIs can safely replace a resumable conversation after transport or
  // format failures. Backends that cannot must positively prove invalidation.
  if (
    params.recoveryPolicy === "invalidated-only" &&
    !isCliSessionInvalidatingFailoverReason(params.error.reason)
  ) {
    return false;
  }
  switch (params.error.reason) {
    case "session_expired":
      return true;
    case "unknown":
      return params.error.code === "cli_unknown_empty_failure";
    case "empty_response":
      return params.error.code === "cli_unknown_empty_failure";
    case "format":
      return params.error.code === "cli_synthetic_no_response";
    case "timeout":
      return params.error.code === "cli_no_output_timeout";
    case "context_overflow":
      return params.error.code === "cli_context_overflow";
    default:
      return false;
  }
}

function shouldRetryForkedCliSessionAfterFailover(error: FailoverError): boolean {
  return error.reason === "timeout" && error.code === "cli_no_output_timeout";
}

function isUnsupportedCliResumeAtError(error: unknown, resumeAtArg: string): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes(resumeAtArg.toLowerCase()) &&
    /\b(?:unknown|unexpected|unrecognized)\b|\bnot\s+recognized\b/.test(message)
  );
}

export async function runCliRecovery<TAttempt>(params: {
  context: PreparedCliRunContext;
  executeAttempt: (cliSessionIdToUse?: string, options?: CliRecoveryOptions) => Promise<TAttempt>;
  finishAttempt: (
    attempt: TAttempt,
    fallbackCliSessionId?: string,
  ) => Promise<EmbeddedAgentRunResult>;
  finishDeliveredFailure: (error: unknown) => Promise<EmbeddedAgentRunResult | undefined>;
  onTerminalFailure: (error: unknown) => Promise<void>;
}): Promise<EmbeddedAgentRunResult> {
  const { context } = params;
  const runParams = context.params;
  const reusableCliSessionId = resolveCliSessionId(context.reusableCliSession);
  const resumeCheckpointId = runParams.cliSessionBinding?.resumeCheckpointId;
  let retryableSessionId = reusableCliSessionId;
  try {
    return await params.finishAttempt(
      await params.executeAttempt(
        reusableCliSessionId,
        runParams.forkCliSessionOnResume
          ? {
              onForkSuccessorPersisted: (sessionId) => {
                retryableSessionId = sessionId;
              },
            }
          : undefined,
      ),
      reusableCliSessionId,
    );
  } catch (err) {
    const deliveredFailure = await params.finishDeliveredFailure(err);
    if (deliveredFailure) {
      return deliveredFailure;
    }
    let recoveryError = err;
    if (
      runParams.forkCliSessionOnResume &&
      resumeCheckpointId &&
      context.preparedBackend.backend.resumeAtArg &&
      isUnsupportedCliResumeAtError(err, context.preparedBackend.backend.resumeAtArg)
    ) {
      recoveryError = createCliFailoverError(
        "CLI backend cannot resume from the stored checkpoint.",
        "session_expired",
        {
          provider: runParams.provider,
          model: context.modelId,
          sessionId: runParams.sessionId,
          lane: runParams.lane,
        },
        { cause: err },
      );
    }
    if (isFailoverError(recoveryError)) {
      if (
        !runParams.forkCliSessionOnResume &&
        shouldRetryForkedCliSessionAfterFailover(recoveryError) &&
        retryableSessionId &&
        resumeCheckpointId &&
        runParams.sessionKey &&
        context.preparedBackend.backend.forkArg &&
        context.preparedBackend.backend.resumeAtArg &&
        runParams.onBeforeForkedCliSessionRetry
      ) {
        try {
          const retryTimeoutMs = runParams.timeoutMs - (Date.now() - context.started);
          if (retryTimeoutMs <= 0) {
            throw recoveryError;
          }
          const forkPrepared = await runParams.onBeforeForkedCliSessionRetry({
            provider: runParams.provider,
            reason: recoveryError.reason,
            sessionId: retryableSessionId,
          });
          if (!forkPrepared) {
            throw recoveryError;
          }
          cliBackendLog.warn(
            `cli session recovery fork: provider=${runParams.provider} reason=${recoveryError.reason} sessionKey=${runParams.sessionKey}`,
          );
          return await params.finishAttempt(
            await params.executeAttempt(retryableSessionId, {
              timeoutMs: retryTimeoutMs,
              forkCliSessionOnResume: true,
              resumeAt: resumeCheckpointId,
              onForkSuccessorPersisted: (sessionId) => {
                retryableSessionId = sessionId;
              },
            }),
          );
        } catch (forkError) {
          const deliveredForkFailure = await params.finishDeliveredFailure(forkError);
          if (deliveredForkFailure) {
            return deliveredForkFailure;
          }
          recoveryError = isUnsupportedCliResumeAtError(
            forkError,
            context.preparedBackend.backend.resumeAtArg,
          )
            ? err
            : forkError;
        }
      }
      if (
        isFailoverError(recoveryError) &&
        shouldRetryFreshCliSessionAfterFailover({
          error: recoveryError,
          hasHistoryPrompt: Boolean(context.openClawHistoryPrompt),
          recoveryPolicy: context.preparedBackend.backend.freshSessionRecovery,
        }) &&
        retryableSessionId &&
        runParams.sessionKey
      ) {
        try {
          const retryTimeoutMs = runParams.timeoutMs - (Date.now() - context.started);
          if (retryTimeoutMs <= 0) {
            throw recoveryError;
          }
          if (runParams.onBeforeFreshCliSessionRetry) {
            const clearedStaleBinding = await runParams.onBeforeFreshCliSessionRetry({
              provider: runParams.provider,
              reason: recoveryError.reason,
              sessionId: retryableSessionId,
            });
            if (!clearedStaleBinding) {
              throw recoveryError;
            }
          }
          cliBackendLog.warn(
            `cli session recovery retry: provider=${runParams.provider} reason=${recoveryError.reason} sessionKey=${runParams.sessionKey}`,
          );
          return await params.finishAttempt(
            await params.executeAttempt(undefined, {
              timeoutMs: retryTimeoutMs,
              forkCliSessionOnResume: false,
            }),
          );
        } catch (retryErr) {
          const deliveredRetryFailure = await params.finishDeliveredFailure(retryErr);
          if (deliveredRetryFailure) {
            return deliveredRetryFailure;
          }
          await params.onTerminalFailure(retryErr);
          throw retryErr;
        }
      }
    }
    await params.onTerminalFailure(recoveryError);
    throw recoveryError;
  }
}
