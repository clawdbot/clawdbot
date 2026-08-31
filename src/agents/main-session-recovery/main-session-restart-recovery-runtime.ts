import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
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
import { getMainSessionRecoveryRetryCount } from "./main-session-recovery-state.js";
import { markStartupOrphanedMainSessionsForRecovery } from "./main-session-restart-recovery-marking.js";
import {
  DEFAULT_RECOVERY_DELAY_MS,
  type ExhaustedRestartRecoveryTarget,
  type ExpectedRestartRecoveryTarget,
  mainSessionRecoveryLog,
  MAX_RECOVERY_RETRIES,
  RETRY_BACKOFF_MULTIPLIER,
  resolveRestartRecoveryStorePaths,
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

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    if (params.shouldContinue?.() === false) {
      return result;
    }
    const storeResult = await recoverStore({
      cfg: params.cfg,
      onExhaustedTarget: params.onExhaustedTarget,
      storePath,
      stateDir: params.stateDir,
      handledSessionKeys,
      activeSessionIds: params.activeSessionIds,
      activeSessionKeys: params.activeSessionKeys,
      lifecycleGeneration: params.lifecycleGeneration,
      shouldContinue: params.shouldContinue,
      gatewayRuntime: params.gatewayRuntime,
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
export async function retryRestartAbortedMainSessionRecovery(params: {
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  expectedRecoveryRunId?: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  sessionKey: string;
  stateDir?: string;
  storePath: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<RecoveryCounts> {
  const expected = {
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

async function recoverExpectedRestartRecovery(params: {
  cfg?: OpenClawConfig;
  expectedClaim?: ExpectedRestartRecoveryClaim;
  expectedTarget?: ExpectedRestartRecoveryTarget;
  lifecycleGeneration?: string;
  observationOnly?: boolean;
  sessionKey: string;
  shouldContinue?: () => boolean;
  storePath: string;
  stateDir?: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<RecoveryCounts> {
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
    assertAllowed: assertExpectedCurrent,
    revalidateAllowed: assertExpectedCurrent,
  });
  const handoffId = admission.createHandoff();
  try {
    return await admission.run(
      async () =>
        await recoverStore({
          cfg: params.cfg,
          observationOnly: params.observationOnly,
          storePath: params.storePath,
          stateDir: params.stateDir,
          handledSessionKeys: new Set<string>(),
          expectedClaim: params.expectedClaim,
          expectedTarget: params.expectedTarget,
          sessionWorkAdmissionHandoffId: handoffId,
          lifecycleGeneration: params.lifecycleGeneration,
          shouldContinue: params.shouldContinue,
          gatewayRuntime: params.gatewayRuntime,
        }),
    );
  } finally {
    cancelSessionWorkAdmissionHandoff(handoffId);
    admission.release();
  }
}

export function scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease(params: {
  delayMs?: number;
  getConfig: () => OpenClawConfig;
  getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
  maxRetries?: number;
  expectedSessionId: string;
  sessionKey: string;
  stateDir?: string;
  storePath: string;
}): void {
  const recover = () =>
    runWithGatewayIndependentRootWorkAdmission(async () => {
      const gatewayRuntime = params.getGatewayRuntime();
      if (!gatewayRuntime) {
        throw new Error("Gateway recovery runtime is unavailable");
      }
      return await retryRestartAbortedMainSessionRecovery({
        cfg: params.getConfig(),
        expectedSessionId: params.expectedSessionId,
        sessionKey: params.sessionKey,
        stateDir: params.stateDir,
        storePath: params.storePath,
        gatewayRuntime,
      });
    });
  void runRecoveryRetries({
    initialDelayMs: 0,
    maxRetries: params.maxRetries ?? MAX_RECOVERY_RETRIES,
    retryDelayMs: params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS,
    shouldContinue: () => true,
    attempt: async (finalAttempt) => {
      const result = await recover();
      const stillPending = loadExpectedRestartRecoveryTarget({
        expected: {
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
  let stopped = false;
  const shouldContinue = () =>
    !stopped &&
    params.shouldContinue?.() !== false &&
    isAgentEventLifecycleGenerationCurrent(lifecycleGeneration);
  const startupRecoveryCutoffMs = Date.now();
  const startupCheckedStorePaths = params.startupCheckedStorePaths ?? new Set<string>();
  const runRecoveryAttempt = async (
    exhaustedTargets: Map<string, ExhaustedRestartRecoveryTarget>,
  ): Promise<RecoveryCounts> => {
    return await runWithGatewayIndependentRootWorkAdmission(async () => {
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
          exhaustedTargets.set(`${target.storePath}\u0000${target.sessionKey}`, target);
        },
        stateDir: params.stateDir,
        handledSessionKeys,
        lifecycleGeneration,
        shouldContinue,
        gatewayRuntime: params.gatewayRuntime,
      });
    });
  };
  const reconcileExhaustedTargets = async (targets: Iterable<ExhaustedRestartRecoveryTarget>) => {
    const outcomes = await Promise.allSettled(
      [...targets].map((target) =>
        runWithGatewayIndependentRootWorkAdmission(async () =>
          recoverExpectedRestartRecovery({
            cfg: params.getConfig(),
            expectedTarget: {
              canonicalSessionKey: target.canonicalSessionKey,
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
            },
            lifecycleGeneration,
            observationOnly: true,
            sessionKey: target.sessionKey,
            shouldContinue,
            storePath: target.storePath,
            stateDir: params.stateDir,
            gatewayRuntime: params.gatewayRuntime,
          }),
        ),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        mainSessionRecoveryLog.warn(
          `main-session exhaustion reconciliation failed: ${String(outcome.reason)}`,
        );
      }
    }
  };
  const cancelled = new Promise<void>((resolve) => {
    abortController.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  let exhaustedTargets = new Map<string, ExhaustedRestartRecoveryTarget>();
  const run = Promise.resolve().then(async () => {
    if (params.waitForStart) {
      await Promise.race([params.waitForStart(), cancelled]);
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
      stopped = true;
      abortController.abort();
      await run;
    },
  };
}
