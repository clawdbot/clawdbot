/** Native harness hook event relay and public Plugin SDK facade. */
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-capability.js";
import {
  clearNativeHookRelayBridgesForTests,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
  readNativeHookRelayBridgeRecordIfExists,
  registerNativeHookRelayBridge,
  renewNativeHookRelayBridgeRecord,
  resolveNativeHookRelayBridgeRecordExpiresAtMs,
  isRetryableNativeHookRelayBridgeLookupError,
} from "./native-hook-relay-bridge.js";
import {
  getNativeHookRelayProviderAdapter,
  normalizeNativeHookInvocation,
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-codec.js";
import {
  buildNativeHookRelayCommandWithStateDatabase,
  resolveNativeHookRelayCommandTimeoutMs,
} from "./native-hook-relay-command.js";
import {
  nativeHookRelayEventHasLocalWork,
  nativeHookRelayEventToolMatcher,
  processNativeHookRelayInvocation,
} from "./native-hook-relay-events.js";
import {
  clearNativeHookRelayPermissionsForTests,
  formatPermissionApprovalDescriptionForTests as formatPermissionApprovalDescriptionForTestsImpl,
  permissionRequestContentFingerprintForTests as permissionRequestContentFingerprintForTestsImpl,
  permissionRequestToolInputKeyFingerprintForTests as permissionRequestToolInputKeyFingerprintForTestsImpl,
  pruneNativeHookRelayPermissionAllowAlways,
  setNativeHookRelayDeferredToolApprovalRequesterForTests as setNativeHookRelayDeferredToolApprovalRequesterForTestsImpl,
  setNativeHookRelayPermissionApprovalRequesterForTests as setNativeHookRelayPermissionApprovalRequesterForTestsImpl,
} from "./native-hook-relay-permissions.js";
import type { NativeHookRelayDeferredToolApprovalRequester } from "./native-hook-relay-permissions.js";
import type { NativeHookRelayRetention } from "./native-hook-relay-registrations.js";
import {
  claimNativeHookRelayTurn,
  deactivateNativeHookRelayForeground,
  pruneExpiredNativeHookRelays,
  readRelayLifetime,
  resolveNativeHookRelayInvocationBinding,
  resolveNativeHookRelayInvocationTarget,
  scheduleNativeHookRelayExpiry,
  setRelayLifetime,
  unregisterNativeHookRelay,
} from "./native-hook-relay-registrations.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
  nativeHookRelayRegistrationsById,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayPermissionApprovalRequester,
  NativeHookRelayProcessResponse,
  NativeHookRelayRegistration,
  RegisterNativeHookRelayParams,
} from "./native-hook-relay-types.js";
import { NATIVE_HOOK_RELAY_EVENTS } from "./native-hook-relay-types.js";
import {
  isJsonValue,
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
  snapshotNativeHookRelayPayload,
} from "./native-hook-relay-utils.js";
export { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
export { resolveNativeHookRelayDeferredToolApproval } from "./native-hook-relay-permissions.js";
export type { NativeHookRelayRetention } from "./native-hook-relay-registrations.js";
export type {
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayRegistrationHandle,
} from "./native-hook-relay-types.js";

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
// Overlapping runs on one agent/session (main lane, nested announce runs,
// bound-thread resumes) each hold a live registration on the same stable
// relayId until their own deferred unregister fires. The cap bounds leak
// growth, but hitting it must reject the NEW registration: evicting a live
// sibling would strand a still-active run's hooks mid-turn, which is exactly
// the lifecycle bug this module guards against. Sized well above legitimate
// overlap (rapid short turns each hold a deferred-unregister registration
// for ~10-15s; expired slots are pruned before the cap is enforced).
const MAX_NATIVE_HOOK_RELAY_CONCURRENT_REGISTRATIONS = 32;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays, relayBridges, invocations } = nativeHookRelayState;
const relayRegistrationsById = nativeHookRelayRegistrationsById;

type RetainedNativeHookRelayParams = RegisterNativeHookRelayParams & {
  retention: NativeHookRelayRetention;
};

function resolveNativeHookRelayExpiresAtMs(ttlMs: number | undefined): number | undefined {
  return resolveExpiresAtMsFromDurationMs(normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS));
}

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  return registerNativeHookRelayInternal(params, undefined);
}

/** Private-local bundled runtime entrypoint; not exported through the public SDK. */
export function registerRetainedNativeHookRelay(
  params: RetainedNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  const { retention, ...registrationParams } = params;
  return registerNativeHookRelayInternal(registrationParams, retention);
}

function registerNativeHookRelayInternal(
  params: RegisterNativeHookRelayParams,
  retention: NativeHookRelayRetention | undefined,
): ActiveNativeHookRelayRegistrationHandle {
  pruneExpiredNativeHookRelays();
  pruneNativeHookRelayPermissionAllowAlways();
  const relayId = normalizeRelayKey(params.relayId, "id") ?? randomUUID();
  const generation = normalizeRelayKey(params.generation, "generation") ?? randomUUID();
  const generationMismatchGraceMs = normalizePositiveInteger(params.generationMismatchGraceMs, 0);
  const now = Date.now();
  const expiresAtMs = resolveNativeHookRelayExpiresAtMs(params.ttlMs);
  if (expiresAtMs === undefined) {
    throw new Error("Native hook relay expiry is outside the supported Date range");
  }
  const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
  const stateDbPath = resolveOpenClawStateSqlitePath();
  // Concurrent runs of the same agent/session share this stable relayId, and
  // bound-thread resumes can even share one generation. Registering must not
  // evict a sibling run's live registration: every registration keeps its own
  // slot, and the newest one becomes "current" for callers that cannot
  // present a generation.
  const registrations =
    relayRegistrationsById.get(relayId) ?? new Set<ActiveNativeHookRelayRegistration>();
  if (registrations.size >= MAX_NATIVE_HOOK_RELAY_CONCURRENT_REGISTRATIONS) {
    // pruneExpiredNativeHookRelays() at the top of this function already freed
    // expired slots, so everything still counted here is live. Reject the new
    // registration instead of evicting a live sibling mid-turn.
    log.error("native hook relay concurrent registration limit reached", {
      relayId,
      runId: params.runId,
      liveRegistrations: registrations.size,
      cap: MAX_NATIVE_HOOK_RELAY_CONCURRENT_REGISTRATIONS,
    });
    throw new Error("native hook relay concurrent registration limit reached");
  }
  let partialRegistration: ActiveNativeHookRelayRegistration | undefined;
  try {
    const retained =
      params.runBeforeToolCall && retention
        ? retainBeforeToolCallForNativeHookRelay(params.runBeforeToolCall)
        : undefined;
    const registration = {
      relayId,
      provider: params.provider,
      generation,
      ...(generationMismatchGraceMs > 0
        ? { generationMismatchGraceExpiresAtMs: now + generationMismatchGraceMs }
        : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionId: params.sessionId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.config ? { config: params.config } : {}),
      runId: params.runId,
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.requester ? { requester: params.requester } : {}),
      ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
      allowedEvents,
      preToolUseLoopDetection: params.preToolUseLoopDetection !== false,
      expiresAtMs,
      preToolUseFailureProjections: new Map(),
      claimedTurnIds: new Set<string>(),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.runBeforeToolCall ? { runBeforeToolCall: params.runBeforeToolCall } : {}),
      ...(params.assertActive ? { assertActive: params.assertActive } : {}),
      ...(params.onPreToolUseFailure ? { onPreToolUseFailure: params.onPreToolUseFailure } : {}),
      // SAFETY: the literal supplies the complete mutable internal registration contract.
    } as ActiveNativeHookRelayRegistration;
    partialRegistration = registration;
    relayRegistrationsById.set(relayId, registrations);
    registrations.add(registration);
    relays.set(relayId, registration);
    setRelayLifetime(registration, {
      foregroundOpen: true,
      foregroundToken: Symbol("native-hook-relay-foreground"),
      ...(retained ? { retained } : {}),
      ...(retention ? { retention } : {}),
    });
    if (params.signal) {
      const abort = () => unregisterNativeHookRelay(relayId, registration);
      params.signal.addEventListener("abort", abort, { once: true });
      readRelayLifetime(registration)!.removeAbortListener = () =>
        params.signal?.removeEventListener("abort", abort);
      if (params.signal.aborted) {
        unregisterNativeHookRelay(relayId, registration);
        throw new Error("native hook relay registration aborted");
      }
    }
    registerNativeHookRelayBridge(registration, stateDbPath, invokeNativeHookRelay);
    scheduleNativeHookRelayExpiry(relayId, registration);
    const handle: ActiveNativeHookRelayRegistrationHandle = {
      ...registration,
      shouldRelayEvent: (event) => nativeHookRelayEventHasLocalWork(registration, event),
      toolMatcherForEvent: (event) => nativeHookRelayEventToolMatcher(registration, event),
      commandForEvent: (event, options) =>
        buildNativeHookRelayCommandWithStateDatabase({
          provider: params.provider,
          relayId,
          stateDbPath,
          generation: registration.generation,
          event,
          nice: params.command?.nice,
          timeoutMs: resolveNativeHookRelayCommandTimeoutMs(
            params.command?.timeoutMs,
            options?.timeoutMs,
          ),
          executable: params.command?.executable,
          nodeExecutable: params.command?.nodeExecutable,
        }),
      claimTurn: (turnId) => claimNativeHookRelayTurn(relayId, registration, turnId),
      renew: (ttlMs) => {
        // Renewal must work for non-current siblings too: a long-running turn
        // keeps its own registration alive even after a newer run registered
        // on the same relayId.
        if (!relayRegistrationsById.get(relayId)?.has(registration)) {
          return;
        }
        const renewedExpiresAtMs = resolveNativeHookRelayExpiresAtMs(ttlMs);
        if (renewedExpiresAtMs === undefined) {
          return;
        }
        const bridge = relayBridges.get(relayId);
        if (bridge && bridge.server.listening) {
          try {
            // One bridge record covers every live registration for the
            // relayId, so renewal must never shorten it below the
            // longest-lived sibling.
            const renewal = renewNativeHookRelayBridgeRecord(
              registration,
              bridge,
              resolveNativeHookRelayBridgeRecordExpiresAtMs(relayId, renewedExpiresAtMs) ??
                renewedExpiresAtMs,
            );
            if (renewal === "unavailable") {
              return;
            }
            if (renewal === "ownership-changed") {
              log.debug("native hook relay bridge record ownership changed", { relayId });
              unregisterNativeHookRelay(relayId, registration);
              return;
            }
          } catch (error) {
            log.debug("failed to renew native hook relay bridge record", { error, relayId });
            return;
          }
        }
        registration.expiresAtMs = renewedExpiresAtMs;
        handle.expiresAtMs = renewedExpiresAtMs;
        scheduleNativeHookRelayExpiry(relayId, registration);
      },
      unregister: () => deactivateNativeHookRelayForeground(relayId, registration),
    };
    return handle;
  } catch (error) {
    if (partialRegistration) {
      unregisterNativeHookRelay(relayId, partialRegistration);
    }
    throw error;
  }
}

function normalizeRelayKey(
  value: string | undefined,
  kind: "id" | "generation",
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error(`native hook relay ${kind} must be non-empty, compact, and URL-safe`);
  }
  return trimmed;
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  if (!relayRegistrationsById.get(relayId)?.size && !relays.has(relayId)) {
    pruneExpiredNativeHookRelays();
    throw new Error("native hook relay not found");
  }
  const requestedGeneration = params.requireGeneration
    ? readNonEmptyString(params.generation, "generation")
    : undefined;
  if (!isJsonValue(params.rawPayload)) {
    throw new Error("native hook relay payload must be JSON-compatible");
  }
  const adapter = getNativeHookRelayProviderAdapter(provider);
  // Resolve the caller's own registration before any policy, approval, or
  // recording work. Concurrent runs on the same relayId each keep a live
  // registration; a sibling run registering later must not make this caller's
  // hooks stale, a sibling unregistering must not remove them, and an
  // unclaimed hook on a generation shared by two live runs fails closed
  // instead of executing under the newest sibling's policy context.
  const target = resolveNativeHookRelayInvocationTarget({
    relayId,
    requestedGeneration,
    turnSelector: adapter.normalizeMetadata(params.rawPayload).turnId,
    rawPayload: params.rawPayload,
  });
  if (target.outcome === "contested-generation") {
    log.warn("native hook relay rejected unclaimed hook on contested generation", {
      relayId,
      event,
    });
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }
  if (target.outcome === "not-found") {
    pruneExpiredNativeHookRelays();
    throw new Error("native hook relay not found");
  }
  const registration = target.registration;
  if (Date.now() > registration.expiresAtMs) {
    unregisterNativeHookRelay(relayId, registration);
    throw new Error("native hook relay expired");
  }
  if (registration.provider !== provider) {
    throw new Error("native hook relay provider mismatch");
  }
  if (requestedGeneration !== undefined && requestedGeneration !== registration.generation) {
    if (!canAcceptNativeHookRelayGenerationMismatch(registration, requestedGeneration)) {
      throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
    }
    log.debug("native hook relay accepted bootstrap generation mismatch", {
      relayId,
      event,
      runId: registration.runId,
    });
  }
  if (!registration.allowedEvents.includes(event)) {
    throw new Error("native hook relay event not allowed");
  }

  const normalized = normalizeNativeHookInvocation({
    registration,
    event,
    rawPayload: params.rawPayload,
  });
  const effectiveRegistration = await resolveNativeHookRelayInvocationBinding(
    registration,
    event,
    params.rawPayload,
  );
  if (event === "pre_tool_use" || event === "permission_request") {
    effectiveRegistration.assertActive?.();
  }
  recordNativeHookRelayInvocation(normalized);
  const startedAt = Date.now();
  const response = await processNativeHookRelayInvocation({
    registration: effectiveRegistration,
    invocation: normalized,
    adapter,
  });
  // Policy and approval callbacks may yield while their admitted run closes.
  // Never let a late allow cross back into the native runtime.
  if (event === "pre_tool_use" || event === "permission_request") {
    effectiveRegistration.assertActive?.();
  }
  if (
    normalized.toolUseId &&
    response.failureDisposition &&
    readNativeHookRelayApprovalMode(normalized.rawPayload) !== "report"
  ) {
    projectNativeHookRelayPreToolUseFailure(registration, {
      toolName: normalizeNativeHookToolName(normalized.toolName),
      toolCallId: normalized.toolUseId,
      disposition: response.failureDisposition,
      durationMs: Date.now() - startedAt,
    });
  }
  return response;
}

function projectNativeHookRelayPreToolUseFailure(
  registration: ActiveNativeHookRelayRegistration,
  failure: Parameters<NonNullable<NativeHookRelayRegistration["onPreToolUseFailure"]>>[0],
): void {
  const callback = registration.onPreToolUseFailure;
  if (!callback || registration.preToolUseFailureProjections.has(failure.toolCallId)) {
    return;
  }
  const record = {
    promise: Promise.resolve().then(() => callback(failure)),
    settled: false,
  };
  registration.preToolUseFailureProjections.set(failure.toolCallId, record);
  void record.promise.then(
    () => {
      record.settled = true;
    },
    (error: unknown) => {
      record.settled = true;
      if (registration.preToolUseFailureProjections.get(failure.toolCallId) === record) {
        registration.preToolUseFailureProjections.delete(failure.toolCallId);
      }
      log.debug("native pre-tool failure projection failed", {
        error,
        relayId: registration.relayId,
        toolCallId: failure.toolCallId,
      });
    },
  );
  if (registration.preToolUseFailureProjections.size > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    let oldestToolCallId: string | undefined;
    for (const [toolCallId, candidate] of registration.preToolUseFailureProjections) {
      oldestToolCallId ??= toolCallId;
      if (candidate.settled) {
        registration.preToolUseFailureProjections.delete(toolCallId);
        return;
      }
    }
    if (oldestToolCallId) {
      registration.preToolUseFailureProjections.delete(oldestToolCallId);
    }
  }
}

export function hasNativeHookRelayInvocation(params: {
  relayId: string;
  event: NativeHookRelayEvent;
  toolUseId?: string;
}): boolean {
  const toolUseId = params.toolUseId?.trim();
  if (!toolUseId) {
    return false;
  }
  return invocations.some(
    (invocation) =>
      invocation.relayId === params.relayId &&
      invocation.event === params.event &&
      invocation.toolUseId === toolUseId,
  );
}

function recordNativeHookRelayInvocation(invocation: NativeHookRelayInvocation): void {
  invocations.push({
    ...invocation,
    rawPayload: snapshotNativeHookRelayPayload(invocation.rawPayload),
  });
  if (invocations.length > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    invocations.splice(0, invocations.length - MAX_NATIVE_HOOK_RELAY_INVOCATIONS);
  }
}

function canAcceptNativeHookRelayGenerationMismatch(
  registration: NativeHookRelayRegistration,
  generation: string,
): boolean {
  const expiresAtMs = registration.generationMismatchGraceExpiresAtMs;
  if (typeof expiresAtMs !== "number" || Date.now() > expiresAtMs) {
    return false;
  }
  if (registration.generationMismatchGraceAcceptedGeneration) {
    return registration.generationMismatchGraceAcceptedGeneration === generation;
  }
  registration.generationMismatchGraceAcceptedGeneration = generation;
  return true;
}

function normalizeAllowedEvents(
  events: readonly NativeHookRelayEvent[] | undefined,
): readonly NativeHookRelayEvent[] {
  if (!events?.length) {
    return NATIVE_HOOK_RELAY_EVENTS;
  }
  return [...new Set(events)];
}

export const testing = {
  clearNativeHookRelaysForTests(): void {
    // unregisterNativeHookRelay only removes the caller's own entry (and
    // possibly its relayId key), which is safe during Map/Set iteration.
    for (const registrations of relayRegistrationsById.values()) {
      for (const registration of registrations) {
        unregisterNativeHookRelay(registration.relayId, registration);
      }
    }
    for (const [relayId, registration] of relays) {
      unregisterNativeHookRelay(relayId, registration);
    }
    relayRegistrationsById.clear();
    clearNativeHookRelayBridgesForTests();
    invocations.length = 0;
    clearNativeHookRelayPermissionsForTests();
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return [...invocations];
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return relays.get(relayId);
  },
  getNativeHookRelayRegistrationGenerationsForTests(relayId: string): string[] {
    return [...(relayRegistrationsById.get(relayId) ?? [])].map(
      (registration) => registration.generation,
    );
  },
  getNativeHookRelayLiveRegistrationForTests(
    relayId: string,
    generation: string,
  ): NativeHookRelayRegistration | undefined {
    let match: NativeHookRelayRegistration | undefined;
    for (const registration of relayRegistrationsById.get(relayId) ?? []) {
      if (registration.generation === generation) {
        match = registration;
      }
    }
    return match;
  },
  getNativeHookRelayConcurrentRegistrationCapForTests(): number {
    return MAX_NATIVE_HOOK_RELAY_CONCURRENT_REGISTRATIONS;
  },
  simulateLegacyModuleNativeHookRelayRegistrationForTests(relayId: string): void {
    // Mimics a registration written by an older module copy that predates the
    // registration slot map: present in the shared `relays` map, absent from
    // relayRegistrationsById.
    relayRegistrationsById.delete(relayId);
  },
  getNativeHookRelayBridgeDirForTests(): string {
    throw new Error("native hook relay bridge files were retired");
  },
  getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
    void relayId;
    throw new Error("native hook relay bridge files were retired");
  },
  getNativeHookRelayBridgeRecordForTests(relayId: string): Record<string, unknown> | undefined {
    const record = readNativeHookRelayBridgeRecordIfExists(relayId);
    return record ? { ...record } : undefined;
  },
  isNativeHookRelayBridgeLookupRetryableForTests(error: unknown, elapsedMs = 0): boolean {
    return isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs });
  },
  formatPermissionApprovalDescriptionForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return formatPermissionApprovalDescriptionForTestsImpl(request);
  },
  permissionRequestContentFingerprintForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return permissionRequestContentFingerprintForTestsImpl(request);
  },
  permissionRequestToolInputKeyFingerprintForTests:
    permissionRequestToolInputKeyFingerprintForTestsImpl,
  setNativeHookRelayPermissionApprovalRequesterForTests(
    requester: NativeHookRelayPermissionApprovalRequester,
  ): void {
    setNativeHookRelayPermissionApprovalRequesterForTestsImpl(requester);
  },
  setNativeHookRelayDeferredToolApprovalRequesterForTests(
    requester: NativeHookRelayDeferredToolApprovalRequester,
  ): void {
    setNativeHookRelayDeferredToolApprovalRequesterForTestsImpl(requester);
  },
} as const;
