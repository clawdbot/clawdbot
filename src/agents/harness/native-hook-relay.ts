/** Native harness hook event relay and public Plugin SDK facade. */
import { randomUUID } from "node:crypto";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { loadMcpToolGrants } from "../../infra/exec-approvals-mcp.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveProjectedMcpCodexToolApprovalMode } from "../mcp-codex-tool-approval.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-private-capabilities.js";
import {
  clearNativeHookRelayBridgesForTests,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
  readNativeHookRelayBridgeRecordIfExists,
  registerNativeHookRelayBridge,
  renewNativeHookRelayBridgeRecord,
  unregisterNativeHookRelayBridge,
  isRetryableNativeHookRelayBridgeLookupError,
} from "./native-hook-relay-bridge.js";
import {
  getNativeHookRelayProviderAdapter,
  normalizeNativeHookInvocation,
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-codec.js";
import { processNativeHookRelayInvocation } from "./native-hook-relay-events.js";
import {
  clearNativeHookRelayPermissionsForTests,
  formatPermissionApprovalDescriptionForTests as formatPermissionApprovalDescriptionForTestsImpl,
  permissionRequestContentFingerprintForTests as permissionRequestContentFingerprintForTestsImpl,
  permissionRequestToolInputKeyFingerprintForTests as permissionRequestToolInputKeyFingerprintForTestsImpl,
  pruneNativeHookRelayPermissionAllowAlways,
  removeNativeHookRelayPermissionState,
  removeNativeHookRelayPreToolUseApprovals,
  setNativeHookRelayDeferredToolApprovalRequesterForTests as setNativeHookRelayDeferredToolApprovalRequesterForTestsImpl,
  setNativeHookRelayPermissionApprovalRequesterForTests as setNativeHookRelayPermissionApprovalRequesterForTestsImpl,
} from "./native-hook-relay-permissions.js";
import type { NativeHookRelayDeferredToolApprovalRequester } from "./native-hook-relay-permissions.js";
import { buildNativeHookRelayCommandPlan } from "./native-hook-relay-plan.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
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
export type {
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayRegistrationHandle,
} from "./native-hook-relay-types.js";

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays, relayBridges, invocations } = nativeHookRelayState;
type RelayLifetime = {
  foregroundOpen: boolean;
  foregroundToken: symbol;
  retained?: ReturnType<typeof retainBeforeToolCallForNativeHookRelay>;
  retention?: NativeHookRelayRetention;
  removeAbortListener?: () => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

const RELAY_LIFETIME = "__openclawNativeHookRelayLifetimeV1";

/** Private bundled-runtime callbacks for retained direct-child hook policy. */
export type NativeHookRelayRetention = Readonly<{
  readClaim: (rawPayload: unknown) => string | undefined;
  shouldRetainAfterForegroundClose: () => boolean;
  allowPreToolUse: (claim: string) => boolean;
  awaitForegroundAdmission?: (claim: string) => Promise<(() => boolean) | undefined>;
  onDispose: () => void;
}>;

type RetainedNativeHookRelayParams = RegisterNativeHookRelayParams & {
  retention: NativeHookRelayRetention;
};

function readRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
): RelayLifetime | undefined {
  // SAFETY: this private symbol-keyed expando is installed only by setRelayLifetime below.
  return (registration as ActiveNativeHookRelayRegistration & { [RELAY_LIFETIME]?: RelayLifetime })[
    RELAY_LIFETIME
  ];
}

function setRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
  lifetime: RelayLifetime,
): void {
  Object.defineProperty(registration, RELAY_LIFETIME, {
    configurable: true,
    value: lifetime,
  });
}

function scheduleNativeHookRelayExpiry(
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
    if (relays.get(relayId) !== registration) {
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
  const deliverReplacedRegistrationUnregister = unregisterNativeHookRelay(relayId, undefined, {
    deferBridgeRecordRemovalMs: NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
    deferOnUnregister: true,
  });
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
      deferMcpToolApprovals:
        params.autoApproveMcpTools === true ||
        // Native hook names lose raw identity; let Codex apply the prepared per-tool config.
        (params.agentId ? loadMcpToolGrants(params.agentId).length > 0 : false) ||
        Object.keys({ ...params.projectedMcpServers, ...params.config?.mcp?.servers }).some(
          (serverName) =>
            resolveProjectedMcpCodexToolApprovalMode(
              serverName,
              params.config?.mcp?.servers?.[serverName] ?? {},
              params.projectedMcpServers?.[serverName],
            ) !== undefined,
        ),
      runId: params.runId,
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.requester ? { requester: params.requester } : {}),
      ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
      allowedEvents,
      preToolUseLoopDetection: params.preToolUseLoopDetection !== false,
      expiresAtMs,
      preToolUseFailureProjections: new Map(),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.runBeforeToolCall ? { runBeforeToolCall: params.runBeforeToolCall } : {}),
      ...(params.assertActive ? { assertActive: params.assertActive } : {}),
      ...(params.onPreToolUseFailure ? { onPreToolUseFailure: params.onPreToolUseFailure } : {}),
      // SAFETY: the literal supplies the complete mutable internal registration contract.
    } as ActiveNativeHookRelayRegistration;
    partialRegistration = registration;
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
      ...buildNativeHookRelayCommandPlan({ ...params, relayId, generation }),
      renew: (ttlMs) => {
        const current = relays.get(relayId);
        if (current !== registration) {
          return;
        }
        const renewedExpiresAtMs = resolveNativeHookRelayExpiresAtMs(ttlMs);
        if (renewedExpiresAtMs === undefined) {
          return;
        }
        const bridge = relayBridges.get(relayId);
        if (bridge && bridge.server.listening) {
          try {
            const renewal = renewNativeHookRelayBridgeRecord(current, bridge, renewedExpiresAtMs);
            if (renewal === "unavailable") {
              return;
            }
            if (renewal === "ownership-changed") {
              log.debug("native hook relay bridge record ownership changed", { relayId });
              unregisterNativeHookRelay(relayId, current);
              return;
            }
          } catch (error) {
            log.debug("failed to renew native hook relay bridge record", { error, relayId });
            return;
          }
        }
        current.expiresAtMs = renewedExpiresAtMs;
        handle.expiresAtMs = renewedExpiresAtMs;
        scheduleNativeHookRelayExpiry(relayId, current);
      },
      unregister: () => deactivateNativeHookRelayForeground(relayId, registration),
    };
    return handle;
  } catch (error) {
    if (partialRegistration) {
      unregisterNativeHookRelay(relayId, partialRegistration);
    }
    throw error;
  } finally {
    // The successor is authoritative before the old callback runs. A reentrant
    // callback can therefore replace this registration normally instead of
    // being overwritten by the outer replacement path. Finally also preserves
    // the old callback if successor setup aborts partway through.
    deliverReplacedRegistrationUnregister?.();
  }
}

function unregisterNativeHookRelay(
  relayId: string,
  expectedRegistration?: ActiveNativeHookRelayRegistration,
  options?: { deferBridgeRecordRemovalMs?: number; deferOnUnregister?: boolean },
): (() => void) | undefined {
  if (expectedRegistration && relays.get(relayId) !== expectedRegistration) {
    return undefined;
  }
  const registration = expectedRegistration ?? relays.get(relayId);
  if (!registration) {
    return undefined;
  }
  const lifetime = readRelayLifetime(registration);
  const bridge = relayBridges.get(relayId);
  // Detach first: owner cleanup may register a same-id successor, which must
  // never be removed by this registration's later resource cleanup.
  if (relays.get(relayId) === registration) {
    relays.delete(relayId);
  }
  if (lifetime?.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  lifetime?.removeAbortListener?.();
  lifetime?.retained?.release();
  // SAFETY: this deletes the same private expando installed by setRelayLifetime.
  delete (registration as ActiveNativeHookRelayRegistration & { [RELAY_LIFETIME]?: RelayLifetime })[
    RELAY_LIFETIME
  ];
  unregisterNativeHookRelayBridge(relayId, {
    ...options,
    ...(bridge ? { expectedBridge: bridge } : {}),
  });
  removeNativeHookRelayInvocations(relayId);
  removeNativeHookRelayPreToolUseApprovals(relayId);
  removeNativeHookRelayPermissionState(relayId);
  const deliverOnUnregister = () => {
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
  };
  if (options?.deferOnUnregister) {
    return deliverOnUnregister;
  }
  deliverOnUnregister();
  return undefined;
}

function deactivateNativeHookRelayForeground(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  if (relays.get(relayId) !== registration) {
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

async function resolveNativeHookRelayInvocationBinding(
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
        relays.get(registration.relayId) !== registration ||
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
      relays.get(registration.relayId) !== registration ||
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
  const registration = relays.get(relayId);
  if (!registration) {
    pruneExpiredNativeHookRelays();
    throw new Error("native hook relay not found");
  }
  if (Date.now() > registration.expiresAtMs) {
    unregisterNativeHookRelay(relayId, registration);
    throw new Error("native hook relay expired");
  }
  if (registration.provider !== provider) {
    throw new Error("native hook relay provider mismatch");
  }
  if (params.requireGeneration) {
    const generation = readNonEmptyString(params.generation, "generation");
    if (generation !== registration.generation) {
      if (!canAcceptNativeHookRelayGenerationMismatch(registration, generation)) {
        throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
      }
      log.debug("native hook relay accepted bootstrap generation mismatch", {
        relayId,
        event,
        runId: registration.runId,
      });
    }
  }
  if (!registration.allowedEvents.includes(event)) {
    throw new Error("native hook relay event not allowed");
  }
  if (!isJsonValue(params.rawPayload)) {
    throw new Error("native hook relay payload must be JSON-compatible");
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
    adapter: getNativeHookRelayProviderAdapter(provider),
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

function removeNativeHookRelayInvocations(relayId: string): void {
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    if (invocations[index]?.relayId === relayId) {
      invocations.splice(index, 1);
    }
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

function pruneExpiredNativeHookRelays(now = Date.now()): void {
  for (const [relayId, registration] of relays) {
    if (now > registration.expiresAtMs) {
      unregisterNativeHookRelay(relayId, registration);
    }
  }
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
    for (const [relayId, registration] of relays) {
      unregisterNativeHookRelay(relayId, registration);
    }
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
