import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildRestartRecoveryClaimCleanupPatch,
  hasRestartRecoveryTerminalRun,
} from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import {
  retryMainSessionRecoveryMutation,
  scheduleMainSessionRecoveryMutation,
} from "./main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import {
  isMainSessionRecoveryPending,
  type MainSessionRecoveryReservation,
} from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import { normalizeFiniteTimestamp } from "./main-session-restart-recovery-shared.js";

const log = createSubsystemLogger("main-session-restart-recovery");

type RestartRecoveryTerminalStatus = "error" | "ok" | "timeout";

export function normalizeRestartRecoveryTerminalStatus(
  value: unknown,
): RestartRecoveryTerminalStatus | undefined {
  return value === "error" || value === "ok" || value === "timeout" ? value : undefined;
}

export async function probeRestartRecoveryTerminalStatus(
  runId: string,
  gatewayRuntime: GatewayRecoveryRuntime,
): Promise<RestartRecoveryTerminalStatus | undefined> {
  try {
    const result = await gatewayRuntime.waitForAgent<{ endedAt?: unknown; status?: unknown }>(
      { runId, timeoutMs: 0 },
      2_000,
    );
    const status = normalizeRestartRecoveryTerminalStatus(result.status);
    // A zero-time wait also reports timeout for active or unknown work.
    return status === "timeout" && typeof result.endedAt !== "number" ? undefined : status;
  } catch {
    return undefined;
  }
}

async function settleRestartRecoveryDispatch(params: {
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  sessionKeys: readonly string[];
  shouldContinue?: () => boolean;
  storePath: string;
  agentId?: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): Promise<void> {
  await applySessionEntryReplacements({
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    update: (entries) => {
      if (params.shouldContinue?.() === false) {
        return { result: undefined };
      }
      const current = entries
        .filter(
          ({ entry }) =>
            entry.sessionId === params.expectedSessionId &&
            normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ===
              params.expectedRecoveryRunId &&
            normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
              params.expectedRecoverySourceRunId,
        )
        .toSorted((a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))[0];
      if (!current) {
        return { result: undefined };
      }
      const entry = current.entry;
      const now = Date.now();
      if (params.terminalStatus) {
        entry.abortedLastRun = params.terminalStatus !== "ok";
        entry.status =
          params.terminalStatus === "ok"
            ? "done"
            : params.terminalStatus === "timeout"
              ? "timeout"
              : "failed";
        entry.endedAt = now;
        const startedAt = normalizeFiniteTimestamp(entry.startedAt);
        if (startedAt !== undefined) {
          entry.runtimeMs = Math.max(0, now - startedAt);
        }
        entry.restartRecoveryForceSafeTools = undefined;
        Object.assign(
          entry,
          buildRestartRecoveryClaimCleanupPatch({
            entry,
            recordTerminalSource: true,
            terminalRunId: params.expectedRecoveryRunId,
            terminalSourceRunId: params.expectedRecoverySourceRunId,
          }),
          buildMainSessionRecoveryClearPatch(entry),
        );
      } else {
        entry.abortedLastRun = false;
      }
      entry.updatedAt = now;
      return {
        result: undefined,
        replacements: [{ sessionKey: current.sessionKey, entry }],
      };
    },
  });
}

function isExactRestartRecoveryDispatchAdmission(params: {
  admission: Awaited<ReturnType<typeof commitMainSessionRecovery>>;
  lifecycleGeneration: string;
  recoveryRunId: string;
  sessionId: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): boolean {
  const entry = params.admission.entry;
  if (!entry || entry.sessionId !== params.sessionId) {
    return false;
  }
  return (
    (entry.abortedLastRun === false &&
      normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === params.recoveryRunId &&
      entry.restartRecoveryRuns?.some(
        (run) =>
          run.runId === params.recoveryRunId &&
          run.lifecycleGeneration === params.lifecycleGeneration,
      ) === true) ||
    (hasRestartRecoveryTerminalRun(entry, params.recoveryRunId) &&
      ((params.terminalStatus === "ok" && entry.status === "done") ||
        (params.terminalStatus === "error" && entry.status === "failed") ||
        (params.terminalStatus === "timeout" && entry.status === "timeout")))
  );
}

export async function settleAcceptedRestartRecovery(params: {
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  lifecycleGeneration: string;
  reservation?: MainSessionRecoveryReservation;
  sessionKey: string;
  sessionKeys: readonly string[];
  shouldContinue?: () => boolean;
  storePath: string;
  agentId?: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): Promise<boolean> {
  const admission = await commitMainSessionRecovery({
    command: {
      kind: "admit_recovery",
      lifecycleGeneration: params.lifecycleGeneration,
      now: Date.now(),
      runId: params.expectedRecoveryRunId,
      sessionId: params.expectedSessionId,
    },
    shouldContinue: params.shouldContinue,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
    agentId: params.agentId,
  });
  if (
    admission.transition.kind !== "admitted_recovery" &&
    !isExactRestartRecoveryDispatchAdmission({
      admission,
      lifecycleGeneration: params.lifecycleGeneration,
      recoveryRunId: params.expectedRecoveryRunId,
      sessionId: params.expectedSessionId,
      terminalStatus: params.terminalStatus,
    })
  ) {
    return false;
  }
  if (params.shouldContinue?.() === false) {
    return true;
  }
  if (params.reservation) {
    await commitMainSessionRecovery({
      command: { kind: "abandon_reservation", reservation: params.reservation },
      target: { sessionKey: params.sessionKey, storePath: params.storePath },
      agentId: params.agentId,
    });
  }
  if (params.shouldContinue?.() !== false) {
    await settleRestartRecoveryDispatch(params);
  }
  return true;
}

export async function rollbackRestartRecoveryReservation(params: {
  kind: "abandon_reservation" | "cancel_reservation";
  reservation: MainSessionRecoveryReservation;
  sessionKey: string;
  storePath: string;
  agentId?: string;
}) {
  return await retryMainSessionRecoveryMutation(async () =>
    commitMainSessionRecovery({
      command: { kind: params.kind, reservation: params.reservation },
      requireWriteSuccess: true,
      target: { sessionKey: params.sessionKey, storePath: params.storePath },
      agentId: params.agentId,
    }),
  );
}

export function scheduleRestartRecoveryReservationRollback(
  params: Parameters<typeof rollbackRestartRecoveryReservation>[0],
): void {
  // Keep the exact reservation token alive after transient store outages.
  // A Gateway restart safely retires the timer and its stale-generation slot.
  scheduleMainSessionRecoveryMutation({
    mutation: () => rollbackRestartRecoveryReservation(params),
    onError: (error) => {
      log.warn(
        `failed delayed restart recovery reservation rollback ${params.sessionKey}: ${String(error)}`,
      );
    },
    onSuccess: ({ entry, sessionKey }) => {
      if (
        entry?.sessionId === params.reservation.sessionId &&
        sessionKey &&
        isMainSessionRecoveryPending(entry, sessionKey)
      ) {
        scheduleMainSessionRecoveryPendingTarget({
          sessionId: entry.sessionId,
          sessionKey,
          storePath: params.storePath,
          ...(params.agentId ? { agentId: params.agentId } : {}),
        });
      }
    },
  });
}
