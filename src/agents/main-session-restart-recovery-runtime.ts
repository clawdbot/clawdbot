import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
} from "../sessions/session-lifecycle-admission.js";
import {
  loadExpectedRestartRecoveryClaim,
  type ExpectedRestartRecoveryClaim,
} from "./main-session-restart-claim.js";
import { markStartupOrphanedMainSessionsForRecovery } from "./main-session-restart-recovery-marking.js";
import {
  DEFAULT_RECOVERY_DELAY_MS,
  type ExhaustedRestartRecoveryTarget,
  type ExpectedRestartRecoveryTarget,
  log,
  MAX_RECOVERY_RETRIES,
  RETRY_BACKOFF_MULTIPLIER,
  resolveRestartRecoveryStorePaths,
} from "./main-session-restart-recovery-shared.js";
import {
  loadExpectedRestartRecoveryTarget,
  recoverStore,
} from "./main-session-restart-recovery-store.js";

async function recoverRestartAbortedMainSessionsWithOptions(params: {
  cfg?: OpenClawConfig;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  stateDir?: string;
  resumedSessionKeys?: Set<string>;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    if (params.shouldContinue?.() === false) {
      return result;
    }
    const storeResult = await recoverStore({
      cfg: params.cfg,
      onExhaustedTarget: params.onExhaustedTarget,
      storePath,
      resumedSessionKeys,
      activeSessionIds: params.activeSessionIds,
      activeSessionKeys: params.activeSessionKeys,
      lifecycleGeneration: params.lifecycleGeneration,
      shouldContinue: params.shouldContinue,
      gatewayRuntime: params.gatewayRuntime,
    });
    result.recovered += storeResult.recovered;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `main-session restart recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}

export async function recoverRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  resumedSessionKeys?: Set<string>;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  return await recoverRestartAbortedMainSessionsWithOptions(params);
}

/** Retries one exact durable Control UI row from its owning per-agent SQLite store. */
export async function retryRestartAbortedMainSessionRecovery(params: {
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId: string;
  expectedSessionId: string;
  sessionKey: string;
  storePath: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const expectedClaim: ExpectedRestartRecoveryClaim = {
    canonicalSessionKey: params.canonicalSessionKey,
    recoveryRunId: params.expectedRecoveryRunId,
    recoverySourceRunId: params.expectedRecoverySourceRunId,
    sessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
  };
  if (!loadExpectedRestartRecoveryClaim({ expected: expectedClaim, storePath: params.storePath })) {
    return { recovered: 0, failed: 0, skipped: 0 };
  }
  const assertClaimCurrent = () => {
    if (
      !loadExpectedRestartRecoveryClaim({ expected: expectedClaim, storePath: params.storePath })
    ) {
      throw new Error("restart recovery session ownership changed before dispatch");
    }
  };
  // Keep lifecycle replacement behind the accepted recovery dispatch. The agent
  // RPC atomically adopts this lease, so no second admission can deadlock behind
  // a mutation that already sees the accepted browser turn as active work.
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, params.canonicalSessionKey, params.expectedSessionId],
    assertAllowed: assertClaimCurrent,
    revalidateAllowed: assertClaimCurrent,
  });
  const handoffId = admission.createHandoff();
  try {
    return await admission.run(
      async () =>
        await recoverStore({
          cfg: params.cfg,
          storePath: params.storePath,
          resumedSessionKeys: new Set<string>(),
          expectedClaim,
          sessionWorkAdmissionHandoffId: handoffId,
          gatewayRuntime: params.gatewayRuntime,
        }),
    );
  } finally {
    cancelSessionWorkAdmissionHandoff(handoffId);
    admission.release();
  }
}

/** Reconciles one interrupted row after its final foreground owner releases. */
export async function retryRestartAbortedMainSessionRecoveryAfterOwnerRelease(params: {
  cfg?: OpenClawConfig;
  expectedSessionId: string;
  sessionKey: string;
  storePath: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  return await recoverExpectedRestartRecoveryTarget(params);
}

async function recoverExpectedRestartRecoveryTarget(params: {
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  expectedSessionId: string;
  lifecycleGeneration?: string;
  observationOnly?: boolean;
  sessionKey: string;
  shouldContinue?: () => boolean;
  storePath: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const expectedTarget: ExpectedRestartRecoveryTarget = {
    canonicalSessionKey: params.canonicalSessionKey,
    sessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
  };
  const assertTargetCurrent = () => {
    if (
      !loadExpectedRestartRecoveryTarget({ expected: expectedTarget, storePath: params.storePath })
    ) {
      throw new Error("restart recovery session ownership changed before owner-release retry");
    }
  };
  if (
    !loadExpectedRestartRecoveryTarget({ expected: expectedTarget, storePath: params.storePath })
  ) {
    return { recovered: 0, failed: 0, skipped: 0 };
  }
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, params.expectedSessionId],
    assertAllowed: assertTargetCurrent,
    revalidateAllowed: assertTargetCurrent,
  });
  const handoffId = admission.createHandoff();
  try {
    return await admission.run(
      async () =>
        await recoverStore({
          cfg: params.cfg,
          observationOnly: params.observationOnly,
          storePath: params.storePath,
          resumedSessionKeys: new Set<string>(),
          expectedTarget,
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
  expectedSessionId: string;
  getConfig: () => OpenClawConfig;
  getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
  maxRetries?: number;
  sessionKey: string;
  storePath: string;
}): void {
  const retryDelayMs = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const scheduleAttempt = (attempt: number, delayMs: number) => {
    const run = () => {
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        const gatewayRuntime = params.getGatewayRuntime();
        if (!gatewayRuntime) {
          throw new Error("Gateway recovery runtime is unavailable");
        }
        return await retryRestartAbortedMainSessionRecoveryAfterOwnerRelease({
          cfg: params.getConfig(),
          expectedSessionId: params.expectedSessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          gatewayRuntime,
        });
      })
        .then((result) => {
          const stillPending = loadExpectedRestartRecoveryTarget({
            expected: {
              sessionId: params.expectedSessionId,
              sessionKey: params.sessionKey,
            },
            storePath: params.storePath,
          });
          if (
            (result.failed > 0 || (result.recovered === 0 && stillPending)) &&
            attempt < maxRetries
          ) {
            scheduleAttempt(attempt + 1, retryDelayMs * 2 ** (attempt - 1));
          } else if (
            attempt === maxRetries &&
            stillPending?.mainRestartRecovery?.chargedAttempts === MAX_RECOVERY_RETRIES &&
            !stillPending.mainRestartRecovery.reservation
          ) {
            // The last ambiguous dispatch consumed the final durable charge.
            // One exact observation tombstones exhaustion without dispatching again.
            scheduleAttempt(attempt + 1, 0);
          }
        })
        .catch((error: unknown) => {
          if (attempt < maxRetries) {
            scheduleAttempt(attempt + 1, retryDelayMs * 2 ** (attempt - 1));
          } else {
            log.warn(`main-session owner-release recovery failed: ${String(error)}`);
          }
        });
    };
    if (delayMs <= 0) {
      run();
    } else {
      setTimeout(run, delayMs).unref?.();
    }
  };
  scheduleAttempt(1, 0);
}

async function recoverStartupOrphanedMainSessionsWithOptions(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  updatedBeforeMs?: number;
  resumedSessionKeys?: Set<string>;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ marked: number; recovered: number; failed: number; skipped: number }> {
  if (params.shouldContinue?.() === false) {
    return { marked: 0, recovered: 0, failed: 0, skipped: 0 };
  }
  const startupRecoveryCutoffMs = params.updatedBeforeMs ?? Date.now();
  const marked = await markStartupOrphanedMainSessionsForRecovery({
    cfg: params.cfg,
    stateDir: params.stateDir,
    activeSessionIds: params.activeSessionIds,
    activeSessionKeys: params.activeSessionKeys,
    updatedBeforeMs: startupRecoveryCutoffMs,
  });
  if (params.shouldContinue?.() === false) {
    return { marked: marked.marked, recovered: 0, failed: 0, skipped: marked.skipped };
  }
  const recovered = await recoverRestartAbortedMainSessionsWithOptions({
    cfg: params.cfg,
    onExhaustedTarget: params.onExhaustedTarget,
    stateDir: params.stateDir,
    resumedSessionKeys: params.resumedSessionKeys,
    activeSessionIds: params.activeSessionIds,
    activeSessionKeys: params.activeSessionKeys,
    lifecycleGeneration: params.lifecycleGeneration,
    shouldContinue: params.shouldContinue,
    gatewayRuntime: params.gatewayRuntime,
  });
  return {
    marked: marked.marked,
    recovered: recovered.recovered,
    failed: recovered.failed,
    skipped: marked.skipped + recovered.skipped,
  };
}

export async function recoverStartupOrphanedMainSessions(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  updatedBeforeMs?: number;
  resumedSessionKeys?: Set<string>;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ marked: number; recovered: number; failed: number; skipped: number }> {
  return await recoverStartupOrphanedMainSessionsWithOptions(params);
}

export function scheduleRestartAbortedMainSessionRecovery(params: {
  cfg?: OpenClawConfig;
  delayMs?: number;
  maxRetries?: number;
  shouldContinue?: () => boolean;
  stateDir?: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): { stop: () => Promise<void> } {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queuedAttempt: Promise<void> | undefined;
  let activeAttempt: Promise<void> | undefined;
  const shouldContinue = () =>
    !stopped &&
    params.shouldContinue?.() !== false &&
    isAgentEventLifecycleGenerationCurrent(lifecycleGeneration);
  // Only reconcile rows that existed before this startup recovery was scheduled.
  // Fresh runs started by this gateway are protected again by the active-run check.
  const startupRecoveryCutoffMs = Date.now();

  const runRecoveryAttempt = (attempt: number, delay: number) => {
    if (!shouldContinue()) {
      return;
    }
    const exhaustedTargets = new Map<string, ExhaustedRestartRecoveryTarget>();
    const reconcileExhaustedTargets = async () => {
      if (!shouldContinue()) {
        return;
      }
      const outcomes = await Promise.allSettled(
        [...exhaustedTargets.values()].map((target) =>
          runWithGatewayIndependentRootWorkAdmission(
            async () =>
              await recoverExpectedRestartRecoveryTarget({
                canonicalSessionKey: target.canonicalSessionKey,
                cfg: params.cfg,
                expectedSessionId: target.sessionId,
                lifecycleGeneration,
                observationOnly: true,
                sessionKey: target.sessionKey,
                shouldContinue,
                storePath: target.storePath,
                gatewayRuntime: params.gatewayRuntime,
              }),
          ),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          log.warn(`main-session exhaustion reconciliation failed: ${String(outcome.reason)}`);
        }
      }
    };
    // Delayed retries outlive startup; each attempt must independently block
    // host suspension while it reads and rewrites recovery session state.
    const pendingAttempt = runWithGatewayIndependentRootWorkAdmission(
      async () =>
        await recoverStartupOrphanedMainSessionsWithOptions({
          cfg: params.cfg,
          onExhaustedTarget: (target) => {
            exhaustedTargets.set(`${target.storePath}\u0000${target.sessionKey}`, target);
          },
          stateDir: params.stateDir,
          resumedSessionKeys,
          updatedBeforeMs: startupRecoveryCutoffMs,
          lifecycleGeneration,
          shouldContinue,
          gatewayRuntime: params.gatewayRuntime,
        }),
    )
      .then(async (result) => {
        if (!shouldContinue()) {
          return;
        }
        if (result.failed > 0 && attempt < maxRetries) {
          const retryDelay =
            delay > 0 ? delay * RETRY_BACKOFF_MULTIPLIER : DEFAULT_RECOVERY_DELAY_MS;
          scheduleAttempt(attempt + 1, retryDelay);
        } else if (result.failed > 0 && attempt === maxRetries && exhaustedTargets.size > 0) {
          // Reconcile only exact rows whose final dispatch retained its durable charge.
          await reconcileExhaustedTargets();
        }
      })
      .catch(async (err: unknown) => {
        if (!shouldContinue()) {
          return;
        }
        if (attempt < maxRetries) {
          log.warn(`main-session restart recovery failed: ${String(err)}`);
          const retryDelay =
            delay > 0 ? delay * RETRY_BACKOFF_MULTIPLIER : DEFAULT_RECOVERY_DELAY_MS;
          scheduleAttempt(attempt + 1, retryDelay);
        } else {
          log.warn(`main-session restart recovery gave up: ${String(err)}`);
          await reconcileExhaustedTargets();
        }
      });
    const trackedAttempt = pendingAttempt.finally(() => {
      if (activeAttempt === trackedAttempt) {
        activeAttempt = undefined;
      }
    });
    activeAttempt = trackedAttempt;
  };

  const scheduleAttempt = (attempt: number, delay: number) => {
    if (!shouldContinue()) {
      return;
    }
    if (delay <= 0) {
      // Publish the cancellable handle before immediate startup can claim a session.
      const pendingStart = Promise.resolve().then(() => {
        if (shouldContinue()) {
          runRecoveryAttempt(attempt, delay);
        }
      });
      const trackedStart = pendingStart.finally(() => {
        if (queuedAttempt === trackedStart) {
          queuedAttempt = undefined;
        }
      });
      queuedAttempt = trackedStart;
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      runRecoveryAttempt(attempt, delay);
    }, delay);
    timer.unref?.();
  };

  scheduleAttempt(1, initialDelay);
  return {
    stop: async () => {
      // Restart recovery belongs to its startup generation; stale timers must
      // never claim a session after that gateway begins draining.
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await queuedAttempt;
      await activeAttempt;
    },
  };
}
