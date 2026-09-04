import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  externalCliDiscoveryForProviderAuth,
  loadAuthProfileStoreForRuntime,
  markAuthProfileFailure,
  markAuthProfileSuccess,
  type AuthProfileStore,
} from "../auth-profiles.js";
import {
  resolveCliRuntimeArtifactFingerprint,
  resolveCliRuntimeOwnerFingerprint,
} from "../cli-auth-epoch.js";
import { claudeCliSessionTranscriptHasContent as claudeCliSessionTranscriptHasContentImpl } from "../command/attempt-execution.helpers.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { resolveAuthProfileFailureReason } from "../embedded-agent-runner/run/auth-profile-failure-policy.js";
import { coerceToFailoverError, isFailoverError } from "../failover-error.js";
import { CliAuthProfilePreparationError } from "./auth-profile-preparation-error.js";
import { buildCliToolCleanupResult } from "./cli-run-results.js";
import type { ClaudeCliRunDiagnosticLifecycle } from "./run-diagnostics.js";
import { createCliToolCleanupError, type CliToolCleanupFailure } from "./tool-cleanup-error.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

export const cliRunSettlementDeps = {
  claudeCliSessionTranscriptHasContent: claudeCliSessionTranscriptHasContentImpl,
  delay: async (delayMs: number) => {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  },
  loadAuthProfileStoreForRuntime,
  markAuthProfileFailure,
  markAuthProfileSuccess,
};

async function settleCliAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  provider: string;
  agentDir?: string;
  terminal:
    | { outcome: "success" }
    | {
        outcome: "failure";
        error: unknown;
        config?: RunCliAgentParams["config"];
        runId: string;
        modelId?: string;
      };
}): Promise<void> {
  try {
    if (params.terminal.outcome === "success") {
      await cliRunSettlementDeps.markAuthProfileSuccess({
        store: params.store,
        profileId: params.profileId,
        provider: params.provider,
        agentDir: params.agentDir,
      });
      return;
    }
    const error = params.terminal.error;
    const reason = resolveAuthProfileFailureReason({
      failoverReason: isFailoverError(error) ? error.reason : null,
      providerStarted:
        isFailoverError(error) && error.reason === "timeout"
          ? error.cliTimeout?.observedActivity
          : undefined,
    });
    if (reason) {
      await cliRunSettlementDeps.markAuthProfileFailure({
        store: params.store,
        profileId: params.profileId,
        reason,
        cfg: params.terminal.config,
        agentDir: params.agentDir,
        runId: params.terminal.runId,
        modelId: params.terminal.modelId,
      });
    }
  } catch (error) {
    log.warn(
      `CLI auth-profile ${params.terminal.outcome} settlement failed: ${formatErrorMessage(error)}`,
    );
  }
}

export async function assertCliRuntimeBinding(context: PreparedCliRunContext): Promise<void> {
  if (!context.runtimeArtifactFingerprint) {
    return;
  }
  const currentArtifact = await resolveCliRuntimeArtifactFingerprint({
    provider: context.params.provider,
    config: context.params.config ?? context.contextEngineConfig,
    agentId: context.params.agentId,
    runtimeArtifactId: context.backendResolved.id,
  });
  if (currentArtifact !== context.runtimeArtifactFingerprint) {
    throw new Error("CLI executable/package artifact changed during successful inference");
  }
  if (!context.runtimeOwnerFingerprint) {
    return;
  }
  const currentOwner = await resolveCliRuntimeOwnerFingerprint({
    provider: context.params.provider,
    config: context.params.config ?? context.contextEngineConfig,
    ...(context.agentDir ? { agentDir: context.agentDir } : {}),
    agentId: context.params.agentId,
    runtimeOwnerId: context.backendResolved.id,
    ...(context.effectiveAuthProfileId ? { authProfileId: context.effectiveAuthProfileId } : {}),
    ...(context.authBindingSkipsLocalCredential ? { skipLocalCredential: true } : {}),
    runtimeArtifactFingerprint: currentArtifact,
  });
  if (currentOwner !== context.runtimeOwnerFingerprint) {
    throw new Error("CLI runtime owner changed during successful inference");
  }
}

export async function settleCliPreparationError(
  error: unknown,
  params: RunCliAgentParams,
): Promise<void> {
  if (!(error instanceof CliAuthProfilePreparationError)) {
    return;
  }
  const store = cliRunSettlementDeps.loadAuthProfileStoreForRuntime(error.agentDir, {
    externalCli: externalCliDiscoveryForProviderAuth({
      cfg: params.config,
      provider: error.provider,
      profileId: error.profileId,
    }),
  });
  await settleCliAuthProfile({
    store,
    profileId: error.profileId,
    provider: error.provider,
    agentDir: error.agentDir,
    terminal: {
      outcome: "failure",
      error,
      config: params.config,
      runId: params.runId,
      modelId: params.model,
    },
  });
}

export async function settlePreparedCliRun(params: {
  context: PreparedCliRunContext;
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle;
  run: () => Promise<EmbeddedAgentRunResult>;
}): Promise<EmbeddedAgentRunResult> {
  const { context, diagnosticLifecycle, run } = params;
  const runParams = context.params;
  let result: EmbeddedAgentRunResult | undefined;
  let runError: unknown;
  try {
    result = await run();
  } catch (error) {
    runError = error;
  }
  const terminalRunError = runError;
  let cleanupError: unknown;
  const recordCleanupError = (error: unknown) => {
    cleanupError ??= error;
  };
  if (runParams.cleanupCliLiveSessionOnRunEnd === true) {
    try {
      const { closeCliLiveSession } = await import("./cli-live-session-registry.js");
      await closeCliLiveSession(context, "restart");
    } catch (error) {
      recordCleanupError(error);
    }
  }
  if (runParams.cleanupBundleMcpOnRunEnd === true) {
    // The run's session ID is immutable; its session key can already belong to
    // a newer run. Never retire the newer runtime or close the shared listener.
    try {
      const { retireSessionMcpRuntime } = await import("../agent-bundle-mcp-tools.js");
      await retireSessionMcpRuntime({
        sessionId: runParams.sessionId,
        reason: "cli-run-end",
        onError: recordCleanupError,
      });
    } catch (error) {
      recordCleanupError(error);
    }
  }
  if (cleanupError) {
    if (
      runError ||
      result?.didSendViaMessagingTool === true ||
      result?.meta.replayInvalid === true
    ) {
      log.warn(`cli run cleanup failed after completion: ${formatErrorMessage(cleanupError)}`);
    } else {
      diagnosticLifecycle?.setPhase("cleanup");
      runError =
        cleanupError instanceof Error ? cleanupError : new Error(formatErrorMessage(cleanupError));
    }
  }
  // Retiring a caller is not a provider failure and must not quarantine its credential.
  runParams.assertCurrent?.();
  // Settle only after backend recovery is exhausted. Recording inside an
  // attempt would quarantine a healthy profile for a recovered session fault.
  if (context.effectiveAuthProfileId && context.authProfileStore) {
    const profileId = context.effectiveAuthProfileId;
    const authProfileStore = context.authProfileStore;
    if (terminalRunError) {
      await settleCliAuthProfile({
        store: authProfileStore,
        profileId,
        provider: authProfileStore.profiles[profileId]?.provider ?? runParams.provider,
        agentDir: context.agentDir,
        terminal: {
          outcome: "failure",
          error: terminalRunError,
          config: runParams.config,
          runId: runParams.runId,
          modelId: context.modelId,
        },
      });
    } else if (result?.meta.executionTrace?.attempts?.at(-1)?.result === "success") {
      const provider = authProfileStore.profiles[profileId]?.provider ?? runParams.provider;
      await settleCliAuthProfile({
        store: authProfileStore,
        profileId,
        provider,
        agentDir: context.agentDir,
        terminal: { outcome: "success" },
      });
    }
  }
  if (runError) {
    throw runError instanceof Error ? runError : new Error(formatErrorMessage(runError));
  }
  return result as EmbeddedAgentRunResult;
}

export function settleCliBackendOutcome(params: {
  context: PreparedCliRunContext;
  toolCleanupFailure?: CliToolCleanupFailure;
  runResult: EmbeddedAgentRunResult | undefined;
  runError: unknown;
  runFailed: boolean;
  cleanupError: Error | undefined;
  deliveredMessagingSideEffect: boolean;
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle;
  failoverContext: { provider: string; model: string; sessionId: string; lane?: string };
}): EmbeddedAgentRunResult {
  const {
    context,
    toolCleanupFailure,
    cleanupError,
    deliveredMessagingSideEffect,
    diagnosticLifecycle,
    failoverContext,
    runError,
    runFailed,
    runResult,
  } = params;
  if (toolCleanupFailure) {
    const laterFailures = [
      ...(runFailed && runError !== toolCleanupFailure.error ? [runError] : []),
      ...(cleanupError ? [cleanupError] : []),
    ];
    const failure =
      laterFailures.length > 0
        ? {
            ...toolCleanupFailure,
            error: createCliToolCleanupError(toolCleanupFailure.output, [
              toolCleanupFailure.error,
              ...laterFailures,
            ]),
          }
        : toolCleanupFailure;
    return buildCliToolCleanupResult(context, failure);
  }
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
