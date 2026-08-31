/** Registration slot bookkeeping and lifetime teardown for native hook relays. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-capability.js";
import {
  refreshNativeHookRelayBridgeRecord,
  unregisterNativeHookRelayBridge,
} from "./native-hook-relay-bridge.js";
import {
  removeNativeHookRelayPermissionState,
  removeNativeHookRelayPreToolUseApprovals,
} from "./native-hook-relay-permissions.js";
import {
  nativeHookRelayRegistrationsById,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayEvent,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";

const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays, relayBridges, invocations } = nativeHookRelayState;
const relayRegistrationsById = nativeHookRelayRegistrationsById;

export type RelayLifetime = {
  foregroundOpen: boolean;
  foregroundToken: symbol;
  retained?: ReturnType<typeof retainBeforeToolCallForNativeHookRelay>;
  retention?: NativeHookRelayRetention;
  removeAbortListener?: () => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

const RELAY_LIFETIME = "__openclawNativeHookRelayLifetimeV1";

// A run claims one native turn (side questions and retries register their own
// relay), so the cap only bounds leaks. Evicting the oldest claim degrades
// that turn's hooks to the fail-closed contested-generation rejection below,
// never to cross-run routing.
const MAX_NATIVE_HOOK_RELAY_TURN_CLAIMS = 32;

/** Private bundled-runtime callbacks for retained direct-child hook policy. */
export type NativeHookRelayRetention = Readonly<{
  readClaim: (rawPayload: unknown) => string | undefined;
  shouldRetainAfterForegroundClose: () => boolean;
  allowPreToolUse: (claim: string) => boolean;
  awaitForegroundAdmission?: (claim: string) => Promise<(() => boolean) | undefined>;
  onDispose: () => void;
}>;

export function readRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
): RelayLifetime | undefined {
  // SAFETY: this private symbol-keyed expando is installed only by setRelayLifetime below.
  return (registration as ActiveNativeHookRelayRegistration & { [RELAY_LIFETIME]?: RelayLifetime })[
    RELAY_LIFETIME
  ];
}

export function setRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
  lifetime: RelayLifetime,
): void {
  Object.defineProperty(registration, RELAY_LIFETIME, {
    configurable: true,
    value: lifetime,
  });
}

export function scheduleNativeHookRelayExpiry(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  const lifetime = readRelayLifetime(registration);
  if (!lifetime) {
    return;
  }
  if (lifetime.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  const rearm = () => {
    if (!relayRegistrationsById.get(relayId)?.has(registration)) {
      return;
    }
    const remainingMs = registration.expiresAtMs - Date.now();
    if (remainingMs < 0) {
      unregisterNativeHookRelay(relayId, registration);
      return;
    }
    lifetime.expiryTimer = setTimeout(rearm, Math.min(remainingMs + 1, MAX_TIMER_TIMEOUT_MS));
    lifetime.expiryTimer.unref();
  };
  rearm();
}

export function unregisterNativeHookRelay(
  relayId: string,
  expectedRegistration: ActiveNativeHookRelayRegistration,
): void {
  const registrations = relayRegistrationsById.get(relayId);
  if (registrations?.has(expectedRegistration)) {
    // Detach first: owner cleanup may register a same-id successor, which must
    // never be removed by this registration's later resource cleanup.
    registrations.delete(expectedRegistration);
    if (relays.get(relayId) === expectedRegistration) {
      // Promote the most recently registered surviving registration so callers
      // without a generation (bootstrap grace) keep resolving.
      const latest = latestNativeHookRelayRegistration(registrations);
      if (latest) {
        relays.set(relayId, latest);
      } else {
        relays.delete(relayId);
      }
    }
    if (registrations.size === 0) {
      relayRegistrationsById.delete(relayId);
    }
    releaseNativeHookRelayRegistration(relayId, expectedRegistration);
    return;
  }
  if (relays.get(relayId) === expectedRegistration) {
    // Compatibility: this registration lives only in `relays` — written by an
    // older module copy that predates the registration slot map. Removing it
    // must never tear down slot-tracked live siblings.
    const latest = latestNativeHookRelayRegistration(registrations);
    if (latest) {
      relays.set(relayId, latest);
    } else {
      relays.delete(relayId);
    }
    releaseNativeHookRelayRegistration(relayId, expectedRegistration);
  }
  // Otherwise: already unregistered, expired, or removed — or a sibling run's
  // live registration. Never remove a registration the caller does not own.
}

/** Frees one registration's own resources; relayId-wide state goes with the last one. */
function releaseNativeHookRelayRegistration(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  const lifetime = readRelayLifetime(registration);
  if (lifetime?.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  lifetime?.removeAbortListener?.();
  lifetime?.retained?.release();
  // Claims die with the registration: a released run's turns must never keep
  // routing authority through retained handle copies.
  registration.claimedTurnIds.clear();
  // SAFETY: this deletes the same private expando installed by setRelayLifetime.
  delete (registration as ActiveNativeHookRelayRegistration & { [RELAY_LIFETIME]?: RelayLifetime })[
    RELAY_LIFETIME
  ];
  if (!relayRegistrationsById.get(relayId)?.size && !relays.has(relayId)) {
    teardownNativeHookRelayId(relayId);
  } else {
    // Live siblings keep the shared bridge; retighten the record's expiry to
    // the surviving registrations.
    refreshNativeHookRelayBridgeRecord(relayId);
  }
  try {
    lifetime?.retention?.onDispose();
  } catch (error) {
    try {
      log.warn("native hook relay unregister callback failed", { error, relayId });
    } catch {
      // Teardown has already detached every identity-bound resource. Logging
      // must not turn an observer callback failure into a cleanup failure.
    }
  }
}

/** Tears down relayId-wide resources once no registration remains. */
function teardownNativeHookRelayId(relayId: string): void {
  const bridge = relayBridges.get(relayId);
  unregisterNativeHookRelayBridge(relayId, bridge ? { expectedBridge: bridge } : undefined);
  removeNativeHookRelayInvocations(relayId);
  removeNativeHookRelayPreToolUseApprovals(relayId);
  removeNativeHookRelayPermissionState(relayId);
}

function latestNativeHookRelayRegistration(
  registrations: Set<ActiveNativeHookRelayRegistration> | undefined,
): ActiveNativeHookRelayRegistration | undefined {
  let latest: ActiveNativeHookRelayRegistration | undefined;
  for (const candidate of registrations ?? []) {
    latest = candidate;
  }
  return latest;
}

function isLiveNativeHookRelayRegistration(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): boolean {
  return (
    relayRegistrationsById.get(relayId)?.has(registration) === true ||
    // A shared-state registration written by an older module copy that
    // predates the registration slot map lives only in `relays`.
    relays.get(relayId) === registration
  );
}

export function claimNativeHookRelayTurn(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
  turnId: string,
): void {
  const trimmed = turnId.trim();
  if (!trimmed || !isLiveNativeHookRelayRegistration(relayId, registration)) {
    return;
  }
  // Codex turn/start is start-or-steer: with a sibling's turn already active it
  // steers and returns that ACTIVE turn's id (../codex turn_processor.rs
  // start_or_steer_turn -> TurnInputSubmission::Steered { turn_id }). Claiming
  // the returned id here would silently hand the live sibling's hook and
  // approval routing to this run, so the duplicate is refused: the original
  // claimant keeps owning its own live turn. Only slot-tracked siblings can
  // hold claims — registrations from older module copies predate turn claims.
  for (const sibling of relayRegistrationsById.get(relayId) ?? []) {
    if (sibling !== registration && sibling.claimedTurnIds.has(trimmed)) {
      log.warn("native hook relay refused duplicate turn claim from steered turn start", {
        relayId,
        runId: registration.runId,
        claimantRunId: sibling.runId,
      });
      return;
    }
  }
  if (
    registration.claimedTurnIds.size >= MAX_NATIVE_HOOK_RELAY_TURN_CLAIMS &&
    !registration.claimedTurnIds.has(trimmed)
  ) {
    const oldest = registration.claimedTurnIds.values().next().value;
    if (oldest !== undefined) {
      registration.claimedTurnIds.delete(oldest);
    }
  }
  registration.claimedTurnIds.add(trimmed);
}

export type NativeHookRelayInvocationTarget =
  | { outcome: "resolved"; registration: ActiveNativeHookRelayRegistration }
  | { outcome: "contested-generation" }
  | { outcome: "not-found" };

/**
 * Resolves the one live registration that owns an invocation, in ownership
 * order: retained direct-child claim, then claimed turn id, then unique
 * generation match. Overlapping runs of one bound thread share
 * (relayId, generation) and byte-identical persisted hook commands, so an
 * unclaimed hook on a generation with two live registrations has no provable
 * originating run: routing it to the newest sibling would execute it under the
 * wrong run's policy context (the P1 cross-bind). That case fails closed.
 * Unclaimed direct-child subjects are the one deliberate exception: monitor
 * claims arrive asynchronously, so with a single live retained candidate the
 * hook resolves to it and invocation binding decides — admission-wait while
 * the foreground is open, rejection once it closes.
 */
export function resolveNativeHookRelayInvocationTarget(params: {
  relayId: string;
  requestedGeneration: string | undefined;
  turnSelector: string | undefined;
  rawPayload: unknown;
}): NativeHookRelayInvocationTarget {
  const registrations = relayRegistrationsById.get(params.relayId);
  // Retained direct-child owner first: subagent hooks present the child
  // subject, and a registration that already claimed that child runs them
  // under its retained policy capability. Newest claimant wins the
  // degenerate double-claim case deterministically.
  let childOwner: ActiveNativeHookRelayRegistration | undefined;
  let childCandidate: ActiveNativeHookRelayRegistration | undefined;
  let childCandidateCount = 0;
  for (const candidate of registrations ?? []) {
    const retention = readRelayLifetime(candidate)?.retention;
    if (!retention) {
      continue;
    }
    try {
      const claim = retention.readClaim(params.rawPayload);
      if (!claim) {
        continue;
      }
      childCandidate = candidate;
      childCandidateCount += 1;
      if (retention.allowPreToolUse(claim)) {
        childOwner = candidate;
      }
    } catch {
      // A throwing retention probe grants no ownership; other live
      // registrations and the generation path still resolve.
    }
  }
  if (childOwner) {
    return { outcome: "resolved", registration: childOwner };
  }
  if (childCandidateCount === 1 && childCandidate) {
    // Unclaimed child subject with exactly one live retained candidate:
    // subagent-monitor claims are asynchronous (a racing child hook can beat
    // its own claim), so ownership is not yet provable but also not
    // contested. Binding decides — admission-wait while the candidate's
    // foreground is open, rejection once it closes.
    return { outcome: "resolved", registration: childCandidate };
  }
  if (childCandidateCount > 1) {
    return { outcome: "contested-generation" };
  }
  if (params.turnSelector) {
    let turnOwner: ActiveNativeHookRelayRegistration | undefined;
    let turnOwnerCount = 0;
    for (const candidate of registrations ?? []) {
      if (candidate.claimedTurnIds.has(params.turnSelector)) {
        turnOwner = candidate;
        turnOwnerCount += 1;
      }
    }
    if (turnOwnerCount > 1) {
      // Two live registrations claiming one provider-minted turn id is corrupt
      // routing state (steer duplicates are refused at claim time): no provable
      // owner, so policy and approval dispatch must fail closed rather than
      // pick the newest claimant.
      return { outcome: "contested-generation" };
    }
    if (turnOwner) {
      return { outcome: "resolved", registration: turnOwner };
    }
    if (registrations?.size) {
      // A provider-minted turn selector is an exact claim, never a hint. Once
      // present, missing/stale/wrong claims must not downgrade to generation
      // routing, even if only one same-generation sibling remains live.
      return { outcome: "contested-generation" };
    }
    // No slot-tracked registration exists: fall through to the shared-state
    // fallback so a claim-incapable registration written by an older module
    // copy keeps serving real payloads, which always carry a turn id.
  }
  if (params.requestedGeneration !== undefined && registrations) {
    let match: ActiveNativeHookRelayRegistration | undefined;
    let matchCount = 0;
    for (const candidate of registrations) {
      if (candidate.generation === params.requestedGeneration) {
        match = candidate;
        matchCount += 1;
      }
    }
    // Without a request selector, more than one same-generation registration
    // is inherently ambiguous and must fail before policy dispatch.
    if (matchCount > 1) {
      return { outcome: "contested-generation" };
    }
    if (match) {
      return { outcome: "resolved", registration: match };
    }
  }
  // Fall back to the current registration so bootstrap generation-mismatch
  // grace and generation-less callers keep resolving. Also covers shared-state
  // entries written by an older module copy that predates the slot map.
  const fallback = relays.get(params.relayId) ?? latestNativeHookRelayRegistration(registrations);
  return fallback ? { outcome: "resolved", registration: fallback } : { outcome: "not-found" };
}

export function deactivateNativeHookRelayForeground(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  if (!isLiveNativeHookRelayRegistration(relayId, registration)) {
    return;
  }
  const lifetime = readRelayLifetime(registration);
  if (!lifetime) {
    return;
  }
  lifetime.foregroundOpen = false;
  let shouldRetain = false;
  if (lifetime.retained && lifetime.retention) {
    try {
      shouldRetain = lifetime.retention.shouldRetainAfterForegroundClose();
    } catch (error) {
      try {
        log.warn("native hook relay retention predicate failed", { error, relayId });
      } catch {
        // A logging failure cannot make a throwing retention predicate retain authority.
      }
    }
  }
  if (shouldRetain) {
    return;
  }
  unregisterNativeHookRelay(relayId, registration);
}

export async function resolveNativeHookRelayInvocationBinding(
  registration: ActiveNativeHookRelayRegistration,
  event: NativeHookRelayEvent,
  rawPayload: unknown,
): Promise<NativeHookRelayRegistration> {
  const lifetime = readRelayLifetime(registration);
  if (!lifetime) {
    throw new Error("native hook relay registration is inactive");
  }
  const claim = lifetime.retention?.readClaim(rawPayload);
  if (claim && event === "pre_tool_use" && lifetime.retained && lifetime.retention) {
    const retained = lifetime.retained;
    const retention = lifetime.retention;
    let assertAdmission: (() => boolean) | undefined;
    const assertRetainedAuthority = () => {
      if (
        !isLiveNativeHookRelayRegistration(registration.relayId, registration) ||
        Date.now() > registration.expiresAtMs
      ) {
        throw new Error("native hook relay registration is inactive");
      }
      registration.signal?.throwIfAborted();
      retained.assertActive();
      if (assertAdmission && !assertAdmission()) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      if (!retention.allowPreToolUse(claim)) {
        throw new Error("native hook relay retained invocation not allowed");
      }
    };
    if (lifetime.foregroundOpen && retention.awaitForegroundAdmission) {
      assertAdmission = await retention.awaitForegroundAdmission(claim);
      if (!assertAdmission) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      assertRetainedAuthority();
    } else if (!retention.allowPreToolUse(claim)) {
      throw new Error("native hook relay retained invocation not allowed");
    }
    return {
      ...registration,
      assertActive: assertRetainedAuthority,
      runBeforeToolCall: retained.runBeforeToolCall,
    };
  }
  if (!lifetime.foregroundOpen) {
    throw new Error("native hook relay foreground invocation not allowed");
  }
  const foregroundToken = lifetime.foregroundToken;
  const assertActive = () => {
    if (
      !isLiveNativeHookRelayRegistration(registration.relayId, registration) ||
      Date.now() > registration.expiresAtMs
    ) {
      throw new Error("native hook relay registration is inactive");
    }
    registration.signal?.throwIfAborted();
    registration.assertActive?.();
    if (!lifetime.foregroundOpen || lifetime.foregroundToken !== foregroundToken) {
      throw new Error("native hook relay foreground invocation not allowed");
    }
  };
  return { ...registration, assertActive };
}

function removeNativeHookRelayInvocations(relayId: string): void {
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    if (invocations[index]?.relayId === relayId) {
      invocations.splice(index, 1);
    }
  }
}

export function pruneExpiredNativeHookRelays(now = Date.now()): void {
  // unregisterNativeHookRelay only removes the caller's own entry (and
  // possibly its relayId key), which is safe during Map/Set iteration.
  for (const registrations of relayRegistrationsById.values()) {
    for (const registration of registrations) {
      if (now > registration.expiresAtMs) {
        unregisterNativeHookRelay(registration.relayId, registration);
      }
    }
  }
  // Compatibility sweep: a registration written by an older module copy that
  // predates the slot map lives only in `relays`. Expire it here so it cannot
  // pin the relayId, the bridge auth fallback, or a routing fallback forever.
  for (const [relayId, registration] of relays) {
    if (now > registration.expiresAtMs && !relayRegistrationsById.get(relayId)?.has(registration)) {
      unregisterNativeHookRelay(relayId, registration);
    }
  }
}
