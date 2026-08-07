import { performance } from "node:perf_hooks";
import { readLatestGatewayBootOutcome } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";
import {
  inspectGatewayPortHealth,
  resolveGatewayRestartProbeAuth,
} from "./restart-health-probe.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
} from "./restart-health.constants.js";
import type { GatewayPortHealthSnapshot } from "./restart-health.types.js";
import { waitForGatewayLockReplacement } from "./restart-lock-replacement.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function withWaitOutcome(
  snapshot: GatewayPortHealthSnapshot,
  startedAtMs: number,
  previousOwnerPid?: number,
): GatewayPortHealthSnapshot {
  const elapsedMs = Math.max(0, performance.now() - startedAtMs);
  if (snapshot.healthy) {
    return { ...snapshot, waitOutcome: "healthy", elapsedMs };
  }
  // In-process (SIGUSR1) restarts keep the same PID, so an alive process with
  // a free port means the gateway is still booting — not dead. Reporting that
  // as failure language pushes operators toward destructive recovery of a
  // healthy process, so surface it as a distinct "still starting" outcome.
  if (
    previousOwnerPid !== undefined &&
    snapshot.portUsage.status === "free" &&
    isProcessAlive(previousOwnerPid) &&
    // The boot lifecycle also records terminal failures: a restart loop that
    // already recorded startup_failed keeps the process alive (so the port
    // stays free) but is NOT still starting — report it as a timeout so
    // operators see the failed restart instead of a false success.
    readLatestGatewayBootOutcome() !== "startup_failed"
  ) {
    return { ...snapshot, waitOutcome: "still-starting", elapsedMs };
  }
  return { ...snapshot, waitOutcome: "timeout", elapsedMs };
}

export async function waitForGatewayHealthyListener(params: {
  port: number;
  attempts?: number;
  delayMs?: number;
  previousLockIdentity?: GatewayLockIdentity;
  waitIndefinitelyForPreviousOwner?: boolean;
  /**
   * PID of the gateway process that received the restart signal. In-process
   * (SIGUSR1) restarts keep the same PID; combined with a free port, an alive
   * PID means the gateway is still booting rather than dead.
   */
  previousOwnerPid?: number;
}): Promise<GatewayPortHealthSnapshot> {
  const startedAtMs = performance.now();
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;
  const previousLockIdentity = params.previousLockIdentity;
  const previousOwnerPid = params.previousOwnerPid;

  const probeAuth = await resolveGatewayRestartProbeAuth(undefined).catch(() => undefined);
  let snapshot: GatewayPortHealthSnapshot = previousLockIdentity
    ? {
        portUsage: {
          port: params.port,
          status: "unknown",
          listeners: [],
          hints: [],
          errors: [
            `Previous gateway lock owner ${previousLockIdentity.ownerId ?? previousLockIdentity.pid} is still active.`,
          ],
        },
        healthy: false,
      }
    : await inspectGatewayPortHealth({
        port: params.port,
        auth: probeAuth,
      });

  let attempt = 0;
  let expectedListenerPid: number | undefined;
  if (previousLockIdentity) {
    const replacement = await waitForGatewayLockReplacement({
      previousLockIdentity,
      attempts,
      delayMs,
      waitIndefinitelyForPreviousOwner: params.waitIndefinitelyForPreviousOwner === true,
    });
    if (replacement.status === "timeout") {
      return withWaitOutcome(snapshot, startedAtMs, previousOwnerPid);
    }
    attempt = replacement.attemptsUsed;
    expectedListenerPid = replacement.lockIdentity.pid;
    snapshot = await inspectGatewayPortHealth({
      port: params.port,
      auth: probeAuth,
      expectedListenerPid,
    });
  }

  if (snapshot.healthy) {
    return withWaitOutcome(snapshot, startedAtMs, previousOwnerPid);
  }
  while (attempt < attempts) {
    attempt += 1;
    await sleep(delayMs);
    snapshot = await inspectGatewayPortHealth({
      port: params.port,
      auth: probeAuth,
      expectedListenerPid,
    });
    if (snapshot.healthy) {
      return withWaitOutcome(snapshot, startedAtMs, previousOwnerPid);
    }
  }

  return withWaitOutcome(snapshot, startedAtMs, previousOwnerPid);
}
