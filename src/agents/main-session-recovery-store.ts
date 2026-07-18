import { randomUUID } from "node:crypto";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { retryAsync } from "../infra/retry.js";
import {
  isMainRestartRecoveryCandidate,
  transitionMainSessionRecovery,
  type MainSessionRecoveryCommand,
  type MainSessionRecoveryOwnerClaim,
  type MainSessionRecoveryReservation,
  type MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-state.js";

type MainSessionRecoveryStoreTarget = {
  sessionKey: string;
  storePath: string;
};

const OWNER_RELEASE_RETRY_DELAY_MS = 1_000;
const OWNER_RELEASE_RETRY_MAX_DELAY_MS = 30_000;

export type MainSessionRecoveryOwnerLease = MainSessionRecoveryOwnerClaim &
  MainSessionRecoveryStoreTarget;

type MainSessionRecoveryStoreResult = {
  entry?: SessionEntry;
  sessionKey?: string;
  transition: MainSessionRecoveryTransitionResult;
};

export type MainSessionRecoveryPendingTarget = MainSessionRecoveryStoreTarget & {
  sessionId: string;
};

type MainSessionRecoveryOwnerClaimResult =
  | {
      kind: "claimed";
      lease: MainSessionRecoveryOwnerLease;
      entry: SessionEntry;
      sessionKey: string;
    }
  | { kind: "invalidated"; reason: string }
  | { kind: "not_required" };

type MainSessionRecoveryInspectionResult =
  | { kind: "invalidated"; reason: string }
  | { kind: "not_required" }
  | { kind: "required" };

function transitionChanged(result: MainSessionRecoveryTransitionResult): boolean {
  return (
    result.kind !== "foreground_validated" &&
    result.kind !== "no_change" &&
    result.kind !== "observed" &&
    result.kind !== "rejected"
  );
}

function matchesReservation(entry: SessionEntry, reservation: MainSessionRecoveryReservation) {
  const state = entry.mainRestartRecovery;
  return (
    entry.sessionId === reservation.sessionId &&
    state?.cycleId === reservation.cycleId &&
    state.reservation?.runId === reservation.runId &&
    state.reservation.lifecycleGeneration === reservation.lifecycleGeneration
  );
}

function matchesRecoveryAdmission(
  entry: SessionEntry,
  command: Extract<MainSessionRecoveryCommand, { kind: "admit_recovery" | "validate_recovery" }>,
): boolean {
  const reservation = entry.mainRestartRecovery?.reservation;
  return (
    entry.sessionId === command.sessionId &&
    reservation?.runId === command.runId &&
    reservation.lifecycleGeneration === command.lifecycleGeneration
  );
}

function matchesOwnerClaim(entry: SessionEntry, claim: MainSessionRecoveryOwnerClaim): boolean {
  const state = entry.mainRestartRecovery;
  return (
    state?.cycleId === claim.cycleId &&
    state.foregroundClaims?.lifecycleGeneration === claim.lifecycleGeneration &&
    state.foregroundClaims.tokens.includes(claim.claimId)
  );
}

function currentGenerationRequiredBy(command: MainSessionRecoveryCommand): string | undefined {
  // Generation gates new decisions. Exact reservation/token cleanup must remain
  // valid after a restart so the old owner cannot leak its slot or claim.
  switch (command.kind) {
    case "admit_recovery":
    case "claim_foreground":
    case "inspect":
    case "mark_admitted_recovery_interrupted":
    case "observe":
    case "prepare_attempt":
    case "validate_recovery":
      return command.lifecycleGeneration;
    case "validate_foreground":
    case "bind_foreground_run":
      return command.claim.lifecycleGeneration;
    default:
      return undefined;
  }
}

export async function commitMainSessionRecovery(params: {
  command: MainSessionRecoveryCommand;
  expectedSessionId?: string;
  requireWriteSuccess?: boolean;
  scanAliases?: boolean;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryStoreResult> {
  const cancellation =
    params.command.kind === "cancel_reservation" ? params.command.reservation : undefined;
  const abandonment =
    params.command.kind === "abandon_reservation" ? params.command.reservation : undefined;
  const recoveryAdmission =
    params.command.kind === "admit_recovery" || params.command.kind === "validate_recovery"
      ? params.command
      : undefined;
  const ownerClaim = params.command.kind === "claim_foreground" ? params.command : undefined;
  const ownerValidation =
    params.command.kind === "validate_foreground" ? params.command.claim : undefined;
  const ownerRelease =
    params.command.kind === "release_foreground" ? params.command.claim : undefined;
  const reservationCleanup = cancellation ?? abandonment;
  const scansAliases = Boolean(
    params.scanAliases ||
    reservationCleanup ||
    recoveryAdmission ||
    ownerValidation ||
    ownerRelease,
  );
  return await applySessionEntryReplacements<MainSessionRecoveryStoreResult>({
    requireWriteSuccess: params.requireWriteSuccess,
    ...(scansAliases ? {} : { sessionKeys: [params.target.sessionKey] }),
    storePath: params.target.storePath,
    update: (entries) => {
      const expectedGeneration = currentGenerationRequiredBy(params.command);
      if (expectedGeneration && expectedGeneration !== getAgentEventLifecycleGeneration()) {
        return {
          result: {
            transition: { kind: "rejected", reason: "stale_generation" },
          },
        };
      }
      const selected = entries.find(({ sessionKey }) => sessionKey === params.target.sessionKey);
      let candidate =
        (params.expectedSessionId && selected?.entry.sessionId !== params.expectedSessionId) ||
        (ownerClaim && selected?.entry.sessionId !== ownerClaim.sessionId)
          ? undefined
          : selected;
      if (reservationCleanup) {
        candidate =
          entries.find(({ entry }) => matchesReservation(entry, reservationCleanup)) ?? selected;
      } else if (recoveryAdmission) {
        // Canonical session-key migration may happen between reservation and
        // Gateway admission; the reservation identity remains authoritative.
        candidate =
          entries.find(({ entry }) => matchesRecoveryAdmission(entry, recoveryAdmission)) ??
          selected;
      } else if (ownerValidation || ownerRelease) {
        const exactClaim = ownerValidation ?? ownerRelease!;
        candidate = entries.find(({ entry }) => matchesOwnerClaim(entry, exactClaim)) ?? selected;
      } else if (ownerClaim && (!selected || selected.entry.sessionId !== ownerClaim.sessionId)) {
        candidate = entries.find(({ entry }) => entry.sessionId === ownerClaim.sessionId);
      } else if (params.scanAliases && params.expectedSessionId) {
        candidate = entries.find(({ entry }) => entry.sessionId === params.expectedSessionId);
      }
      if (!candidate) {
        return {
          result: {
            entry: selected?.entry,
            sessionKey: selected?.sessionKey,
            transition: { kind: "rejected", reason: "session_replaced" },
          },
        };
      }
      const entry = candidate.entry as SessionEntry;
      const previousRecoveryState = entry.mainRestartRecovery;
      let command: MainSessionRecoveryCommand;
      if (ownerClaim) {
        command =
          ownerClaim.sessionKey === candidate.sessionKey
            ? ownerClaim
            : { ...ownerClaim, sessionKey: candidate.sessionKey };
      } else if (
        (params.command.kind === "observe" || params.command.kind === "inspect") &&
        params.command.sessionKey !== candidate.sessionKey
      ) {
        command = { ...params.command, sessionKey: candidate.sessionKey };
      } else {
        command = params.command;
      }
      const transition = transitionMainSessionRecovery(entry, command);
      const changed =
        transitionChanged(transition) || previousRecoveryState !== entry.mainRestartRecovery;
      return {
        result: { entry, sessionKey: candidate.sessionKey, transition },
        ...(changed ? { replacements: [{ sessionKey: candidate.sessionKey, entry }] } : {}),
      };
    },
  });
}

export async function readMainSessionRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease,
): Promise<{ entry: SessionEntry; sessionKey: string } | undefined> {
  const result = await commitMainSessionRecovery({
    command: { kind: "validate_foreground", claim: lease },
    requireWriteSuccess: true,
    target: lease,
  });
  return result.transition.kind === "foreground_validated" && result.entry && result.sessionKey
    ? { entry: result.entry, sessionKey: result.sessionKey }
    : undefined;
}

export async function claimMainSessionRecoveryOwner(params: {
  allowMissingSession?: boolean;
  lifecycleGeneration: string;
  replacementSessionId?: string;
  sessionId: string;
  runId?: string;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryOwnerClaimResult> {
  const command = {
    kind: "claim_foreground" as const,
    cycleId: randomUUID(),
    lifecycleGeneration: params.lifecycleGeneration,
    sessionId: params.sessionId,
    sessionKey: params.target.sessionKey,
    claimId: randomUUID(),
    ...(params.runId ? { runId: params.runId } : {}),
  };
  let claim = await commitMainSessionRecovery({
    command,
    requireWriteSuccess: true,
    target: params.target,
  });
  if (claim.transition.kind === "rejected" && claim.transition.reason === "session_replaced") {
    claim = await commitMainSessionRecovery({
      command,
      requireWriteSuccess: true,
      scanAliases: true,
      target: params.target,
    });
  }
  if (claim.transition.kind === "foreground_claimed") {
    if (!claim.entry || !claim.sessionKey) {
      return { kind: "invalidated", reason: "state_changed" };
    }
    return {
      kind: "claimed",
      lease: { ...claim.transition.claim, storePath: params.target.storePath },
      entry: claim.entry,
      sessionKey: claim.sessionKey,
    };
  }
  if (claim.transition.kind === "rejected" && claim.transition.reason === "stale_generation") {
    return { kind: "invalidated", reason: claim.transition.reason };
  }
  if (!claim.entry && (params.allowMissingSession || params.replacementSessionId)) {
    // A fresh explicit session has no predecessor. An automatic rollover can
    // also lose its predecessor before admission. Either way, no row remains to fence.
    return { kind: "not_required" };
  }
  if (
    params.replacementSessionId &&
    claim.entry?.sessionId === params.replacementSessionId &&
    claim.entry.abortedLastRun !== true &&
    claim.entry.restartRecoveryRuns === undefined &&
    claim.entry.mainRestartRecovery === undefined
  ) {
    return { kind: "not_required" };
  }
  if (
    claim.entry?.sessionId === params.sessionId &&
    claim.sessionKey &&
    !isMainRestartRecoveryCandidate(claim.entry, claim.sessionKey)
  ) {
    return { kind: "not_required" };
  }
  if (
    claim.entry?.sessionId === params.sessionId &&
    claim.entry.abortedLastRun !== true &&
    claim.entry.restartRecoveryRuns === undefined &&
    claim.entry.mainRestartRecovery === undefined
  ) {
    // A healthy completion may clear recovery between the caller's read and this
    // transaction. Only that fully clean same-session state can proceed unclaimed.
    return { kind: "not_required" };
  }
  const reason = claim.transition.kind === "rejected" ? claim.transition.reason : "state_changed";
  return { kind: "invalidated", reason };
}

export async function bindMainSessionRecoveryOwnerRun(
  lease: MainSessionRecoveryOwnerLease,
  runId: string,
): Promise<{
  lease: MainSessionRecoveryOwnerLease;
  entry: SessionEntry;
  sessionKey: string;
}> {
  const result = await commitMainSessionRecovery({
    command: { kind: "bind_foreground_run", claim: lease, runId },
    requireWriteSuccess: true,
    target: lease,
  });
  if (result.transition.kind !== "applied" || !result.entry || !result.sessionKey) {
    throw new Error("main-session recovery owner changed before run binding");
  }
  return { lease: { ...lease, runId }, entry: result.entry, sessionKey: result.sessionKey };
}

export async function inspectMainSessionRecoveryRequired(params: {
  allowMissingSession?: boolean;
  expectedSessionId: string;
  lifecycleGeneration: string;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryInspectionResult> {
  const command = {
    kind: "inspect" as const,
    lifecycleGeneration: params.lifecycleGeneration,
    sessionKey: params.target.sessionKey,
  };
  let result = await commitMainSessionRecovery({
    command,
    expectedSessionId: params.expectedSessionId,
    requireWriteSuccess: true,
    target: params.target,
  });
  if (result.transition.kind === "rejected" && result.transition.reason === "session_replaced") {
    result = await commitMainSessionRecovery({
      command,
      expectedSessionId: params.expectedSessionId,
      requireWriteSuccess: true,
      scanAliases: true,
      target: params.target,
    });
  }
  if (result.transition.kind === "observed") {
    return result.transition.view.status === "inactive"
      ? { kind: "not_required" }
      : { kind: "required" };
  }
  if (result.transition.kind === "rejected" && result.transition.reason === "session_replaced") {
    return !result.entry && params.allowMissingSession
      ? { kind: "not_required" }
      : { kind: "invalidated", reason: result.transition.reason };
  }
  return {
    kind: "invalidated",
    reason: result.transition.kind === "rejected" ? result.transition.reason : "state_changed",
  };
}

async function releaseMainSessionRecoveryOwnerWithRetries(
  lease: MainSessionRecoveryOwnerLease,
): Promise<MainSessionRecoveryPendingTarget | undefined> {
  // A leaked current-generation token blocks automatic recovery until restart.
  // Token-scoped release is idempotent, so transient writer failures are safe to retry.
  const released = await retryAsync(
    async () =>
      await commitMainSessionRecovery({
        command: { kind: "release_foreground", claim: lease },
        requireWriteSuccess: true,
        target: lease,
      }),
    3,
    25,
  );
  const { entry, sessionKey } = released;
  const state = entry?.mainRestartRecovery;
  if (
    (released.transition.kind !== "applied" && released.transition.kind !== "no_change") ||
    !entry ||
    !sessionKey ||
    entry.sessionId !== lease.sessionId ||
    entry.status !== "running" ||
    entry.abortedLastRun !== true ||
    !isMainRestartRecoveryCandidate(entry, sessionKey) ||
    state?.foregroundClaims ||
    state?.reservation ||
    state?.tombstone
  ) {
    return undefined;
  }
  return { sessionId: entry.sessionId, sessionKey, storePath: lease.storePath };
}

function scheduleMainSessionRecoveryOwnerRelease(
  lease: MainSessionRecoveryOwnerLease,
  delayMs = OWNER_RELEASE_RETRY_DELAY_MS,
): void {
  // A token is process-owned but durably blocks recovery. Keep exact-token
  // cleanup alive through transient writer outages until release or restart.
  setTimeout(() => {
    void releaseMainSessionRecoveryOwnerWithRetries(lease).then(
      async (pending) => {
        if (!pending) {
          return;
        }
        const { scheduleMainSessionRecoveryPendingTarget } =
          await import("./main-session-recovery-owner-release.js");
        scheduleMainSessionRecoveryPendingTarget(pending);
      },
      () => {
        scheduleMainSessionRecoveryOwnerRelease(
          lease,
          Math.min(delayMs * 2, OWNER_RELEASE_RETRY_MAX_DELAY_MS),
        );
      },
    );
  }, delayMs).unref?.();
}

export async function releaseMainSessionRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease | undefined,
): Promise<MainSessionRecoveryPendingTarget | undefined> {
  if (!lease) {
    return undefined;
  }
  try {
    return await releaseMainSessionRecoveryOwnerWithRetries(lease);
  } catch (error) {
    scheduleMainSessionRecoveryOwnerRelease(lease);
    throw error;
  }
}
