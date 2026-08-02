import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import {
  applySessionEntryReplacements,
  loadExactSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  MAX_GATEWAY_TIMEOUT_RECOVERY_ATTEMPTS,
  type ExpectedRestartRecoveryClaim,
} from "./main-session-restart-claim.js";
import {
  canPrepareMainSessionRecovery,
  retryRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery.js";

const log = createSubsystemLogger("main-session-timeout-recovery");
const DEFAULT_RECOVERY_DELAY_MS = 0;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_DISPATCH_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;

type TimedOutRecoveryTarget = {
  canonicalSessionKey?: string;
  expectedRunId: string;
  expectedSessionId: string;
  sessionKeys: readonly string[];
  storePath: string;
};

type PreparedTimedOutRecovery =
  | { state: "gone" }
  | { state: "pending" }
  | { claim: ExpectedRestartRecoveryClaim; state: "ready" };

function matchesDirectGatewayTimeoutClaim(
  entry: SessionEntry,
  target: TimedOutRecoveryTarget,
): boolean {
  return (
    entry.sessionId === target.expectedSessionId &&
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === target.expectedRunId &&
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) === undefined
  );
}

async function prepareTimedOutMainSessionRecovery(
  cfg: OpenClawConfig,
  target: TimedOutRecoveryTarget,
): Promise<PreparedTimedOutRecovery> {
  return await applySessionEntryReplacements<PreparedTimedOutRecovery>({
    sessionKeys: target.sessionKeys,
    storePath: target.storePath,
    update: (entries) => {
      const current = entries
        .filter(({ entry }) => matchesDirectGatewayTimeoutClaim(entry, target))
        .toSorted((a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))[0];
      if (!current) {
        return { result: { state: "gone" as const } };
      }
      const { entry, sessionKey } = current;
      if (!canPrepareMainSessionRecovery({ cfg, entry, sessionKey, storePath: target.storePath })) {
        return { result: { state: "pending" as const } };
      }
      let recoveryRunId = target.expectedRunId;
      const claimFor = (claimSessionKey: string): ExpectedRestartRecoveryClaim => ({
        canonicalSessionKey: target.canonicalSessionKey,
        recoveryRunId,
        sessionId: target.expectedSessionId,
        sessionKey: claimSessionKey,
      });
      if (entry.status === "running" && entry.abortedLastRun === true) {
        return entry.restartRecoveryInterruptionReason === "gateway_timeout"
          ? { result: { claim: claimFor(sessionKey), state: "ready" as const } }
          : { result: { state: "pending" as const } };
      }
      if (entry.status !== "timeout") {
        return { result: { state: "pending" as const } };
      }
      entry.restartRecoveryInterruptionReason = "gateway_timeout";
      const timeoutAttemptCount = entry.restartRecoveryTimeoutAttemptCount ?? 0;
      if (timeoutAttemptCount >= MAX_GATEWAY_TIMEOUT_RECOVERY_ATTEMPTS) {
        entry.restartRecoveryTimeoutExhausted = true;
      } else {
        entry.restartRecoveryTimeoutAttemptCount = timeoutAttemptCount + 1;
        // Rotate away from the just-terminalized gateway id in the same durable
        // transaction that adopts this timeout. Every later retry reuses it.
        recoveryRunId = randomUUID();
        entry.restartRecoveryDeliveryRunId = recoveryRunId;
      }
      entry.status = "running";
      entry.abortedLastRun = true;
      entry.startedAt = undefined;
      entry.endedAt = undefined;
      entry.runtimeMs = undefined;
      entry.updatedAt = Date.now();
      return {
        result: { claim: claimFor(sessionKey), state: "ready" as const },
        replacements: [{ sessionKey, entry }],
      };
    },
  });
}

async function recoverTimedOutMainSession(params: {
  cfg: OpenClawConfig;
  target: TimedOutRecoveryTarget;
}): Promise<"pending" | "settled"> {
  const prepared = await prepareTimedOutMainSessionRecovery(params.cfg, params.target);
  if (prepared.state === "gone") {
    return "settled";
  }
  if (prepared.state === "pending") {
    return "pending";
  }
  const result = await retryRestartAbortedMainSessionRecovery({
    canonicalSessionKey: prepared.claim.canonicalSessionKey,
    cfg: params.cfg,
    expectedRecoveryRunId: prepared.claim.recoveryRunId,
    expectedRecoverySourceRunId: prepared.claim.recoverySourceRunId,
    expectedSessionId: prepared.claim.sessionId,
    interruptionReason: "gateway_timeout",
    sessionKey: prepared.claim.sessionKey,
    storePath: params.target.storePath,
  });
  if (result.recovered > 0) {
    return "settled";
  }
  const current = loadExactSessionEntry({
    readConsistency: "latest",
    sessionKey: prepared.claim.sessionKey,
    storePath: params.target.storePath,
  })?.entry;
  const currentRunId = normalizeOptionalString(current?.restartRecoveryDeliveryRunId);
  if (
    current &&
    current.sessionId === prepared.claim.sessionId &&
    current.status === "running" &&
    current.abortedLastRun === true &&
    current.restartRecoveryInterruptionReason === "gateway_timeout" &&
    normalizeOptionalString(current.restartRecoveryDeliverySourceRunId) === undefined &&
    currentRunId
  ) {
    params.target.expectedRunId = currentRunId;
    return "pending";
  }
  return "settled";
}

/**
 * Hands one exact gateway-timed-out delivery claim to transcript recovery after
 * the original run releases session admission. Startup recovery remains the
 * durable fallback if these bounded in-process dispatch retries cannot settle.
 */
export function scheduleTimedOutMainSessionRecovery(params: {
  canonicalSessionKey?: string;
  cfg: OpenClawConfig;
  delayMs?: number;
  expectedRunId: string;
  expectedSessionId: string;
  maxRetries?: number;
  sessionKeys: readonly string[];
  storePath: string;
}): Promise<boolean> {
  const target: TimedOutRecoveryTarget = {
    canonicalSessionKey: params.canonicalSessionKey,
    expectedRunId: params.expectedRunId,
    expectedSessionId: params.expectedSessionId,
    sessionKeys: Array.from(new Set(params.sessionKeys.filter((key) => key.trim()))),
    storePath: params.storePath,
  };
  const maxRetries = params.maxRetries ?? MAX_DISPATCH_RETRIES;
  let resolveStable = (_stable: boolean) => {};
  const stable = new Promise<boolean>((resolve) => {
    resolveStable = resolve;
  });

  const scheduleAttempt = (attempt: number, delayMs: number) => {
    const run = () => {
      void runWithGatewayIndependentRootWorkAdmission(
        async () => await recoverTimedOutMainSession({ cfg: params.cfg, target }),
      )
        .then((state) => {
          if (state === "settled") {
            resolveStable(true);
            return;
          }
          if (attempt >= maxRetries) {
            log.warn(
              `timed-out main-session recovery remains durable after ${attempt} attempt(s): ${target.expectedRunId}`,
            );
            resolveStable(false);
            return;
          }
          scheduleAttempt(
            attempt + 1,
            Math.max(DEFAULT_RETRY_DELAY_MS, delayMs * RETRY_BACKOFF_MULTIPLIER),
          );
        })
        .catch((error: unknown) => {
          if (attempt >= maxRetries) {
            log.warn(
              `timed-out main-session recovery gave up with a durable claim: ${String(error)}`,
            );
            resolveStable(false);
            return;
          }
          log.warn(`timed-out main-session recovery failed: ${String(error)}`);
          scheduleAttempt(
            attempt + 1,
            Math.max(DEFAULT_RETRY_DELAY_MS, delayMs * RETRY_BACKOFF_MULTIPLIER),
          );
        });
    };
    if (delayMs <= 0) {
      run();
      return;
    }
    setTimeout(run, delayMs).unref?.();
  };

  scheduleAttempt(1, params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS);
  return stable;
}
