/** Native harness hook event relay and public Plugin SDK facade. */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  clearNativeHookRelayBridgesForTests,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
  readNativeHookRelayBridgeRecordIfExists,
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
  getNativeHookRelayRegistrationForTests,
  getNativeHookRelayRoute,
  listNativeHookRelayRoutes,
  pruneExpiredNativeHookRelays,
  registerNativeHookRelayLifecycle,
  registerRetainedNativeHookRelayLifecycle,
  resolveNativeHookRelayInvocationBinding,
  unregisterNativeHookRelay,
} from "./native-hook-relay-lifecycle.js";
import type { NativeHookRelayRetention } from "./native-hook-relay-lifecycle.js";
import { formatPermissionApprovalDescription } from "./native-hook-relay-permission-gateway.js";
import {
  permissionRequestContentFingerprint,
  permissionRequestToolInputKeyFingerprint,
  clearNativeHookRelayPermissionsForTests,
  resolveUnscopedNativeHookRelayDeferredToolApproval,
  setNativeHookRelayDeferredToolApprovalRequesterForTests as setNativeHookRelayDeferredToolApprovalRequesterForTestsImpl,
  setNativeHookRelayPermissionApprovalRequesterForTests as setNativeHookRelayPermissionApprovalRequesterForTestsImpl,
} from "./native-hook-relay-permissions.js";
import type { NativeHookRelayDeferredToolApprovalRequester } from "./native-hook-relay-permissions.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayEvent,
  NativeHookRelayDeferredApprovalOutcome,
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalRequester,
  NativeHookRelayProcessResponse,
  NativeHookRelayRegistration,
  RegisterNativeHookRelayParams,
} from "./native-hook-relay-types.js";
import {
  isJsonValue,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
  snapshotNativeHookRelayPayload,
} from "./native-hook-relay-utils.js";
export { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
export type { NativeHookRelayRetention } from "./native-hook-relay-lifecycle.js";
export type {
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayRegistrationHandle,
} from "./native-hook-relay-types.js";

const log = createSubsystemLogger("agents/harness/native-hook-relay");
const { invocations } = nativeHookRelayState;

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  return registerNativeHookRelayLifecycle(params, invokeNativeHookRelay);
}

/** Bundled-only normal relay entrypoint retaining the private approval resolver. */
export function registerNativeHookRelayForBundledRuntime(params: RegisterNativeHookRelayParams) {
  return registerNativeHookRelayLifecycle(params, invokeNativeHookRelay);
}

type RetainedNativeHookRelayParams = RegisterNativeHookRelayParams & {
  composeWithExistingRoute?: boolean;
  retention: NativeHookRelayRetention;
};

export function registerRetainedNativeHookRelay(params: RetainedNativeHookRelayParams) {
  return registerRetainedNativeHookRelayLifecycle(params, invokeNativeHookRelay);
}

/**
 * Compatibility entrypoint for the shipped SDK resolver. Binding-owned callers
 * use the registration handle; this lookup fails closed when a match is ambiguous.
 */
export function resolveNativeHookRelayDeferredToolApproval(params: {
  relayId: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<NativeHookRelayDeferredApprovalOutcome | undefined> {
  return resolveUnscopedNativeHookRelayDeferredToolApproval(params);
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  const route = getNativeHookRelayRoute(relayId);
  if (!route) {
    pruneExpiredNativeHookRelays();
    throw new Error("native hook relay not found");
  }
  if (route.provider !== provider) {
    throw new Error("native hook relay provider mismatch");
  }
  if (Date.now() > route.expiresAtMs) {
    unregisterNativeHookRelay(relayId, route);
    throw new Error("native hook relay expired");
  }
  if (!isJsonValue(params.rawPayload)) {
    throw new Error("native hook relay payload must be JSON-compatible");
  }
  if (params.requireGeneration) {
    const generation = readNonEmptyString(params.generation, "generation");
    if (generation !== route.generation) {
      if (!canAcceptNativeHookRelayGenerationMismatch(route, generation)) {
        throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
      }
      log.debug("native hook relay accepted bootstrap generation mismatch", {
        relayId,
        event,
        runId: route.runId,
      });
    }
  }
  const effectiveRegistration = await resolveNativeHookRelayInvocationBinding(
    route,
    event,
    params.rawPayload,
  );
  if (!effectiveRegistration.allowedEvents.includes(event)) {
    throw new Error("native hook relay event not allowed");
  }

  const normalized = normalizeNativeHookInvocation({
    registration: effectiveRegistration,
    event,
    rawPayload: params.rawPayload,
  });
  effectiveRegistration.assertActive?.();
  recordNativeHookRelayInvocation(normalized);
  const startedAt = Date.now();
  const response = await processNativeHookRelayInvocation({
    registration: effectiveRegistration,
    invocation: normalized,
    adapter: getNativeHookRelayProviderAdapter(provider),
  });
  // Policy and approval callbacks may yield while their admitted run closes.
  // Never let a late allow cross back into the native runtime.
  if (
    event === "pre_tool_use" ||
    event === "permission_request" ||
    event === "before_agent_finalize"
  ) {
    effectiveRegistration.assertActive?.();
  }
  if (
    normalized.toolUseId &&
    response.failureDisposition &&
    readNativeHookRelayApprovalMode(normalized.rawPayload) !== "report"
  ) {
    projectNativeHookRelayPreToolUseFailure(effectiveRegistration, {
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
  turnId?: string;
  toolUseId?: string;
}): boolean {
  const turnId = params.turnId?.trim();
  const toolUseId = params.toolUseId?.trim();
  if (!turnId || !toolUseId) {
    return false;
  }
  return invocations.some(
    (invocation) =>
      invocation.relayId === params.relayId &&
      invocation.event === params.event &&
      invocation.turnId === turnId &&
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

export const testing = {
  clearNativeHookRelaysForTests(): void {
    for (const [relayId, registration] of listNativeHookRelayRoutes()) {
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
    return getNativeHookRelayRegistrationForTests(relayId);
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
  formatPermissionApprovalDescriptionForTests: formatPermissionApprovalDescription,
  permissionRequestContentFingerprintForTests: permissionRequestContentFingerprint,
  permissionRequestToolInputKeyFingerprintForTests: permissionRequestToolInputKeyFingerprint,
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
