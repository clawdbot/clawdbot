import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { waitForAbortSignal } from "../../infra/abort-signal.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
} from "../../sessions/session-lifecycle-admission.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "./main-session-recovery-admission.js";
import { getMainSessionRecoveryRetryCount } from "./main-session-recovery-state.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { markStartupOrphanedMainSessionsForRecovery } from "./main-session-restart-recovery-marking.js";
import {
  DEFAULT_RECOVERY_DELAY_MS,
  type ExhaustedRestartRecoveryTarget,
  type ExpectedRestartRecoveryTarget,
  mainSessionRecoveryLog,
  MAX_RECOVERY_RETRIES,
  RETRY_BACKOFF_MULTIPLIER,
  discoverRestartRecoveryStoreTargets,
} from "./main-session-restart-recovery-shared.js";
import {
  type ExpectedRestartRecoveryClaim,
  loadExpectedRestartRecoveryClaim,
  loadExpectedRestartRecoveryTarget,
  recoverStore,
} from "./main-session-restart-recovery-store.js";

type RecoveryCounts = { started: number; settled: number; failed: number; skipped: number };

async function runRecoveryRetries(params: {
  initialDelayMs: number;
  maxRetries: number;
  retryDelayMs?: number;
  shouldContinue: () => boolean;
  signal?: AbortSignal;
  attempt: (finalAttempt: boolean) => Promise<boolean>;
  onError: (error: unknown, finalAttempt: boolean) => void | Promise<void>;
}): Promise<void> {
  let delayMs = params.initialDelayMs;
  for (let attempt = 1; attempt <= params.maxRetries && params.shouldContinue(); attempt += 1) {
    const finalAttempt = attempt === params.maxRetries;
    try {
      if (delayMs > 0) {
        await sleepWithAbort(delayMs, params.signal, { ref: false });
      }
      if (!params.shouldContinue() || (await params.attempt(finalAttempt))) {
        return;
      }
    } catch (error) {
      if (!params.shouldContinue()) {
        return;
      }
      await params.onError(error, finalAttempt);
      if (finalAttempt) {
        return;
      }
    }
    delayMs =
      delayMs > 0
        ? delayMs * RETRY_BACKOFF_MULTIPLIER
        : (params.retryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS);
  }
}

export async function recoverRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  stateDir?: string;
  handledSessionKeys?: Set<string>;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<RecoveryCounts> {
  const result = { started: 0, settled: 0, failed: 0, skipped: 0 };
  const handledSessionKeys = params.handledSessionKeys ?? new Set<string>();

  for (const target of await discoverRestartRecoveryStoreTargets({
    ...params,
    statuses: ["running"],
  })) {
    if (params.shouldContinue?.() === false) {
      return result;
    }
    const storeResult = await recoverStore({
      ...params,
      storePath: target.storePath,
      storeAgentId: target.agentId,
      handledSessionKeys,
    });
    result.started += storeResult.started;
    result.settled += storeResult.settled;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
  }

  if (result.started > 0 || result.settled > 0 || result.failed > 0) {
    mainSessionRecoveryLog.info(
      `main-session restart recovery startup complete: started=${result.started} settled=${result.settled} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}

/** Retries one exact durable Control UI row from its owning per-agent SQLite store. */
export async function retryRestartAbortedMainSessionRecovery(
  params: MainSessionRecoveryStoreTarget & {
    canonicalSessionKey?: string;
    cfg?: OpenClawConfig;
    expectedRecoveryRunId?: string;
    expectedRecoverySourceRunId?: string;
    expectedSessionId: string;
    stateDir?: string;
    gatewayRuntime: GatewayRecoveryRuntime;
  },
): Promise<RecoveryCounts> {
  const expected = {
    agentId: params.agentId,
    canonicalSessionKey: params.canonicalSessionKey,
    sessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
  };
  const expectedClaim: ExpectedRestartRecoveryClaim | undefined =
    params.expectedRecoveryRunId && params.expectedRecoverySourceRunId
      ? {
          ...expected,
          recoveryRunId: params.expectedRecoveryRunId,
          recoverySourceRunId: params.expectedRecoverySourceRunId,
        }
      : undefined;
  return await recoverExpectedRestartRecovery({
    ...params,
    ...(expectedClaim ? { expectedClaim } : { expectedTarget: expected }),
  });
}

async function recoverExpectedRestartRecovery(
  params: MainSessionRecoveryStoreTarget & {
    cfg?: OpenClawConfig;
    expectedClaim?: ExpectedRestartRecoveryClaim;
    expectedTarget?: ExpectedRestartRecoveryTarget;
    lifecycleGeneration?: string;
    observationOnly?: boolean;
    shouldContinue?: () => boolean;
    stateDir?: string;
    gatewayRuntime: GatewayRecoveryRuntime;
  },
): Promise<RecoveryCounts> {
  const loadExpected = () =>
    params.expectedClaim
      ? loadExpectedRestartRecoveryClaim({
          expected: params.expectedClaim,
          storePath: params.storePath,
        })
      : params.expectedTarget
        ? loadExpectedRestartRecoveryTarget({
            expected: params.expectedTarget,
            storePath: params.storePath,
          })
        : undefined;
  if (!loadExpected()) {
    return { started: 0, settled: 0, failed: 0, skipped: 0 };
  }
  const assertExpectedCurrent = () => {
    if (!loadExpected()) {
      throw new Error("restart recovery session ownership changed before dispatch");
    }
  };
  const expectedSessionId = (params.expectedClaim ?? params.expectedTarget)!.sessionId;
  // Keep lifecycle replacement behind accepted recovery dispatch. The RPC
  // adopts this lease, so another admission cannot deadlock behind its active work.
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, params.expectedClaim?.canonicalSessionKey, expectedSessionId],
    owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
    assertAllowed: assertExpectedCurrent,
    revalidateAllowed: assertExpectedCurrent,
  });
  const handoffId = admission.createHandoff();
  try {
    return await admission.run(
      async () =>
        await recoverStore({
          ...params,
          handledSessionKeys: new Set<string>(),
          sessionWorkAdmissionHandoffId: handoffId,
        }),
    );
  } finally {
    cancelSessionWorkAdmissionHandoff(handoffId);
  }
}

export function scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease(
  params: MainSessionRecoveryStoreTarget & {
    delayMs?: number;
    getConfig: () => OpenClawConfig;
    getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
    maxRetries?: number;
    expectedSessionId: string;
    stateDir?: string;
  },
): void {
  const recover = () =>
    runWithGatewayIndependentRootWorkAdmission(async () => {
      const gatewayRuntime = params.getGatewayRuntime();
      if (!gatewayRuntime) {
        throw new Error("Gateway recovery runtime is unavailable");
      }
      return await retryRestartAbortedMainSessionRecovery({
        ...params,
        cfg: params.getConfig(),
        gatewayRuntime,
      });
    }, "main-session:restart-recovery");
  void runRecoveryRetries({
    initialDelayMs: 0,
    maxRetries: params.maxRetries ?? MAX_RECOVERY_RETRIES,
    retryDelayMs: params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS,
    shouldContinue: () => true,
    attempt: async (finalAttempt) => {
      const result = await recover();
      const stillPending = loadExpectedRestartRecoveryTarget({
        expected: {
          agentId: params.agentId,
          sessionId: params.expectedSessionId,
          sessionKey: params.sessionKey,
        },
        storePath: params.storePath,
      });
      if (result.failed === 0 && (result.started > 0 || result.settled > 0 || !stillPending)) {
        return true;
      }
      if (
        finalAttempt &&
        getMainSessionRecoveryRetryCount(stillPending?.mainRestartRecovery) ===
          MAX_RECOVERY_RETRIES &&
        !stillPending?.mainRestartRecovery?.reservation
      ) {
        // The last ambiguous dispatch consumed the final durable charge. One
        // exact observation tombstones exhaustion without dispatching again.
        await recover();
      }
      return false;
    },
    onError: (error, finalAttempt) => {
      if (finalAttempt) {
        mainSessionRecoveryLog.warn(`main-session owner-release recovery failed: ${String(error)}`);
      }
    },
  });
}

export function scheduleRestartAbortedMainSessionRecovery(params: {
  delayMs?: number;
  getConfig: () => OpenClawConfig;
  maxRetries?: number;
  shouldContinue?: () => boolean;
  stateDir?: string;
  startupCheckedStorePaths?: Set<string>;
  waitForStart?: () => Promise<void>;
  gatewayRuntime: GatewayRecoveryRuntime;
}): { stop: () => Promise<void> } {
  const handledSessionKeys = new Set<string>();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const abortController = new AbortController();
  const shouldContinue = () =>
    !abortController.signal.aborted &&
    params.shouldContinue?.() !== false &&
    isAgentEventLifecycleGenerationCurrent(lifecycleGeneration);
  const startupRecoveryCutoffMs = Date.now();
  const startupCheckedStorePaths = params.startupCheckedStorePaths ?? new Set<string>();
  const runRecoveryAttempt = async (
    exhaustedTargets: Map<string, ExhaustedRestartRecoveryTarget>,
  ): Promise<RecoveryCounts> => {
    return await runWithGatewayIndependentRootWorkAdmission(
      async () => {
        const cfg = params.getConfig();
        await markStartupOrphanedMainSessionsForRecovery({
          cfg,
          stateDir: params.stateDir,
          startupCheckedStorePaths,
          updatedBeforeMs: startupRecoveryCutoffMs,
        });
        return await recoverRestartAbortedMainSessions({
          cfg,
          onExhaustedTarget: (target) => {
            exhaustedTargets.set(
              JSON.stringify([
                target.storePath,
                target.agentId,
                target.canonicalSessionKey ?? target.sessionKey,
              ]),
              target,
            );
          },
          stateDir: params.stateDir,
          handledSessionKeys,
          lifecycleGeneration,
          shouldContinue,
          gatewayRuntime: params.gatewayRuntime,
        });
      },
      "main-session:startup-recovery",
      abortController.signal,
    );
  };
  const reconcileExhaustedTargets = async (targets: Iterable<ExhaustedRestartRecoveryTarget>) => {
    const outcomes = await Promise.allSettled(
      [...targets].map((target) =>
        runWithGatewayIndependentRootWorkAdmission(
          async () =>
            recoverExpectedRestartRecovery({
              ...target,
              cfg: params.getConfig(),
              expectedTarget: target,
              lifecycleGeneration,
              observationOnly: true,
              shouldContinue,
              stateDir: params.stateDir,
              gatewayRuntime: params.gatewayRuntime,
            }),
          "main-session:target-recovery",
          abortController.signal,
        ),
      ),
    );
    for (const outcome of outcomes) {
      if (
        outcome.status === "rejected" &&
        !(
          abortController.signal.aborted &&
          (outcome.reason === abortController.signal.reason ||
            (outcome.reason instanceof Error &&
              outcome.reason.cause === abortController.signal.reason))
        )
      ) {
        mainSessionRecoveryLog.warn(
          `main-session exhaustion reconciliation failed: ${String(outcome.reason)}`,
        );
      }
    }
  };
  let exhaustedTargets = new Map<string, ExhaustedRestartRecoveryTarget>();
  const run = Promise.resolve().then(async () => {
    if (params.waitForStart) {
      await Promise.race([params.waitForStart(), waitForAbortSignal(abortController.signal)]);
    }
    await runRecoveryRetries({
      initialDelayMs: params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS,
      maxRetries: Math.max(1, params.maxRetries ?? MAX_RECOVERY_RETRIES),
      shouldContinue,
      signal: abortController.signal,
      attempt: async (finalAttempt) => {
        exhaustedTargets = new Map();
        const result = await runRecoveryAttempt(exhaustedTargets);
        if (result.failed === 0) {
          return true;
        }
        if (finalAttempt && exhaustedTargets.size > 0) {
          await reconcileExhaustedTargets(exhaustedTargets.values());
        }
        return false;
      },
      onError: async (err, finalAttempt) => {
        if (finalAttempt) {
          mainSessionRecoveryLog.warn(`main-session restart recovery gave up: ${String(err)}`);
          await reconcileExhaustedTargets(exhaustedTargets.values());
        } else {
          mainSessionRecoveryLog.warn(`main-session restart recovery failed: ${String(err)}`);
        }
      },
    });
  });
  return {
    stop: async () => {
      // Restart recovery belongs to its startup generation; stale timers must
      // never claim a session after that gateway begins draining.
      abortController.abort();
      await run;
    },
  };
}
