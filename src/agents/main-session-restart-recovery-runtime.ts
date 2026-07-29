import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
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
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    const storeResult = await recoverStore({
      cfg: params.cfg,
      onExhaustedTarget: params.onExhaustedTarget,
      storePath,
      resumedSessionKeys,
      activeSessionIds: params.activeSessionIds,
      activeSessionKeys: params.activeSessionKeys,
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
  observationOnly?: boolean;
  sessionKey: string;
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
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ marked: number; recovered: number; failed: number; skipped: number }> {
  const startupRecoveryCutoffMs = params.updatedBeforeMs ?? Date.now();
  const marked = await markStartupOrphanedMainSessionsForRecovery({
    cfg: params.cfg,
    stateDir: params.stateDir,
    activeSessionIds: params.activeSessionIds,
    activeSessionKeys: params.activeSessionKeys,
    updatedBeforeMs: startupRecoveryCutoffMs,
  });
  const recovered = await recoverRestartAbortedMainSessionsWithOptions({
    cfg: params.cfg,
    onExhaustedTarget: params.onExhaustedTarget,
    stateDir: params.stateDir,
    resumedSessionKeys: params.resumedSessionKeys,
    activeSessionIds: params.activeSessionIds,
    activeSessionKeys: params.activeSessionKeys,
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
  stateDir?: string;
  gatewayRuntime: GatewayRecoveryRuntime;
}): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();
  // Only reconcile rows that existed before this startup recovery was scheduled.
  // Fresh runs started by this gateway are protected again by the active-run check.
  const startupRecoveryCutoffMs = Date.now();

  const runRecoveryAttempt = (attempt: number, delay: number) => {
    const exhaustedTargets = new Map<string, ExhaustedRestartRecoveryTarget>();
    const reconcileExhaustedTargets = async () => {
      const outcomes = await Promise.allSettled(
        [...exhaustedTargets.values()].map((target) =>
          runWithGatewayIndependentRootWorkAdmission(
            async () =>
              await recoverExpectedRestartRecoveryTarget({
                canonicalSessionKey: target.canonicalSessionKey,
                cfg: params.cfg,
                expectedSessionId: target.sessionId,
                observationOnly: true,
                sessionKey: target.sessionKey,
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
    void runWithGatewayIndependentRootWorkAdmission(
      async () =>
        await recoverStartupOrphanedMainSessionsWithOptions({
          cfg: params.cfg,
          onExhaustedTarget: (target) => {
            exhaustedTargets.set(`${target.storePath}\u0000${target.sessionKey}`, target);
          },
          stateDir: params.stateDir,
          resumedSessionKeys,
          updatedBeforeMs: startupRecoveryCutoffMs,
          gatewayRuntime: params.gatewayRuntime,
        }),
    )
      .then(async (result) => {
        if (result.failed > 0 && attempt < maxRetries) {
          scheduleAttempt(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
        } else if (result.failed > 0 && attempt === maxRetries && exhaustedTargets.size > 0) {
          // Reconcile only exact rows whose final dispatch retained its durable charge.
          await reconcileExhaustedTargets();
        }
      })
      .catch(async (err: unknown) => {
        if (attempt < maxRetries) {
          log.warn(`main-session restart recovery failed: ${String(err)}`);
          scheduleAttempt(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
        } else {
          log.warn(`main-session restart recovery gave up: ${String(err)}`);
          await reconcileExhaustedTargets();
        }
      });
  };

  const scheduleAttempt = (attempt: number, delay: number) => {
    if (delay <= 0) {
      runRecoveryAttempt(attempt, delay);
      return;
    }
    setTimeout(() => {
      runRecoveryAttempt(attempt, delay);
    }, delay).unref?.();
  };

  scheduleAttempt(1, initialDelay);
}
