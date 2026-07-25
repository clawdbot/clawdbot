/**
 * Bridges native harness hook events through registered relay processes.
 */
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type {
  BeforeToolCallFailureDisposition,
  requestDeferredPluginToolApproval,
} from "../agent-tools.before-tool-call.js";
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
import {
  buildNativeHookRelayCommand as buildNativeHookRelayCommandImpl,
  buildNativeHookRelayCommandWithStateDatabase,
  resolveNativeHookRelayCommandTimeoutMs,
} from "./native-hook-relay-command.js";
import {
  nativeHookRelayEventHasLocalWork,
  processNativeHookRelayInvocation,
} from "./native-hook-relay-events.js";
import {
  clearNativeHookRelayPermissionsForTests,
  formatPermissionApprovalDescriptionForTests as formatPermissionApprovalDescriptionForTestsImpl,
  permissionRequestContentFingerprintForTests as permissionRequestContentFingerprintForTestsImpl,
  permissionRequestToolInputKeyFingerprintForTests as permissionRequestToolInputKeyFingerprintForTestsImpl,
  pruneNativeHookRelayPermissionAllowAlways,
  removeNativeHookRelayPermissionState,
  removeNativeHookRelayPreToolUseApprovals,
  resolveNativeHookRelayDeferredToolApproval as resolveNativeHookRelayDeferredToolApprovalImpl,
  setNativeHookRelayDeferredToolApprovalRequesterForTests as setNativeHookRelayDeferredToolApprovalRequesterForTestsImpl,
  setNativeHookRelayPermissionApprovalRequesterForTests as setNativeHookRelayPermissionApprovalRequesterForTestsImpl,
} from "./native-hook-relay-permissions.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayCommandForEventOptions,
  NativeHookRelayDeferredApprovalOutcome,
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayPermissionApprovalRequester,
  NativeHookRelayRegistration,
  RegisterNativeHookRelayParams,
} from "./native-hook-relay-types.js";
import {
  isJsonValue,
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
  snapshotNativeHookRelayPayload,
} from "./native-hook-relay-utils.js";

export { invokeNativeHookRelayBridge } from "./native-hook-relay-bridge.js";
export { isNativeHookRelayBridgeStaleRegistrationError } from "./native-hook-relay-bridge.js";

const NATIVE_HOOK_RELAY_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const NATIVE_HOOK_RELAY_PROVIDERS = ["codex"] as const;

export type NativeHookRelayEvent = (typeof NATIVE_HOOK_RELAY_EVENTS)[number];
export type NativeHookRelayProvider = (typeof NATIVE_HOOK_RELAY_PROVIDERS)[number];

export type NativeHookRelayProcessResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
  failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
};

export type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
  generation?: string;
  shouldRelayEvent: (event: NativeHookRelayEvent) => boolean;
  commandForEvent: (
    event: NativeHookRelayEvent,
    options?: NativeHookRelayCommandForEventOptions,
  ) => string;
  renew: (ttlMs?: number) => void;
  unregister: () => void;
};

type NativeHookRelayDeferredToolApprovalRequester = typeof requestDeferredPluginToolApproval;

export function buildNativeHookRelayCommand(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  generation?: string;
  event: NativeHookRelayEvent;
  preToolUseUnavailable?: "noop";
  timeoutMs?: number;
  executable?: string;
  nice?: number | false;
  nodeExecutable?: string;
}): string {
  return buildNativeHookRelayCommandImpl(params);
}

export function resolveNativeHookRelayDeferredToolApproval(params: {
  relayId: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<NativeHookRelayDeferredApprovalOutcome | undefined> {
  return resolveNativeHookRelayDeferredToolApprovalImpl(params);
}

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays, relayBridges, invocations } = nativeHookRelayState;

function resolveNativeHookRelayExpiresAtMs(ttlMs: number | undefined): number | undefined {
  return resolveExpiresAtMsFromDurationMs(normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS));
}

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  pruneExpiredNativeHookRelays();
  pruneNativeHookRelayPermissionAllowAlways();
  const relayId = normalizeRelayId(params.relayId) ?? randomUUID();
  const generation = normalizeRelayGeneration(params.generation) ?? randomUUID();
  const generationMismatchGraceMs = normalizePositiveInteger(params.generationMismatchGraceMs, 0);
  const now = Date.now();
  const expiresAtMs = resolveNativeHookRelayExpiresAtMs(params.ttlMs);
  if (expiresAtMs === undefined) {
    throw new Error("Native hook relay expiry is outside the supported Date range");
  }
  const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
  const stateDbPath = resolveOpenClawStateSqlitePath();
  unregisterNativeHookRelay(relayId, undefined, {
    deferBridgeRecordRemovalMs: NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  });
  const registration: ActiveNativeHookRelayRegistration = {
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
    allowedEvents,
    preToolUseLoopDetection: params.preToolUseLoopDetection !== false,
    expiresAtMs,
    preToolUseFailureProjections: new Map(),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onPreToolUseFailure ? { onPreToolUseFailure: params.onPreToolUseFailure } : {}),
  };
  relays.set(relayId, registration);
  registerNativeHookRelayBridge(registration, stateDbPath, invokeNativeHookRelay);
  const handle: ActiveNativeHookRelayRegistrationHandle = {
    ...registration,
    shouldRelayEvent: (event) => nativeHookRelayEventHasLocalWork(registration, event),
    commandForEvent: (event, options) =>
      buildNativeHookRelayCommandWithStateDatabase({
        provider: params.provider,
        relayId,
        stateDbPath,
        generation: registration.generation,
        event,
        preToolUseUnavailable:
          event === "pre_tool_use" && !nativeHookRelayEventHasLocalWork(registration, event)
            ? "noop"
            : undefined,
        nice: params.command?.nice,
        timeoutMs: resolveNativeHookRelayCommandTimeoutMs(
          params.command?.timeoutMs,
          options?.timeoutMs,
        ),
        executable: params.command?.executable,
        nodeExecutable: params.command?.nodeExecutable,
      }),
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
    },
    unregister: () => unregisterNativeHookRelay(relayId, registration),
  };
  return handle;
}

function unregisterNativeHookRelay(
  relayId: string,
  expectedRegistration?: ActiveNativeHookRelayRegistration,
  options?: { deferBridgeRecordRemovalMs?: number },
): void {
  if (expectedRegistration && relays.get(relayId) !== expectedRegistration) {
    return;
  }
  unregisterNativeHookRelayBridge(relayId, options);
  relays.delete(relayId);
  removeNativeHookRelayInvocations(relayId);
  removeNativeHookRelayPreToolUseApprovals(relayId);
  removeNativeHookRelayPermissionState(relayId);
}

function normalizeRelayId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error("native hook relay id must be non-empty, compact, and URL-safe");
  }
  return trimmed;
}

function normalizeRelayGeneration(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error("native hook relay generation must be non-empty, compact, and URL-safe");
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
  recordNativeHookRelayInvocation(normalized);
  const startedAt = Date.now();
  const response = await processNativeHookRelayInvocation({
    registration,
    invocation: normalized,
    adapter: getNativeHookRelayProviderAdapter(provider),
  });
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

export function renderNativeHookRelayUnavailableResponse(params: {
  provider: unknown;
  event: unknown;
  preToolUseUnavailable?: unknown;
  message?: string;
}): NativeHookRelayProcessResponse {
  const provider = readNativeHookRelayProvider(params.provider);
  const event = readNativeHookRelayEvent(params.event);
  const adapter = getNativeHookRelayProviderAdapter(provider);
  const message = params.message?.trim() || "Native hook relay unavailable";
  if (event === "pre_tool_use") {
    // The standalone CLI cannot reconstruct the originating registration after
    // relay lookup fails, so unavailable PreToolUse must fail closed unless the
    // generated command explicitly recorded that no before-tool policy existed.
    if (params.preToolUseUnavailable === "noop") {
      return adapter.renderNoopResponse(event);
    }
    return adapter.renderPreToolUseBlockResponse(message);
  }
  if (event === "permission_request") {
    return adapter.renderPermissionDecisionResponse("deny", message);
  }
  return adapter.renderNoopResponse(event);
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
    clearNativeHookRelayBridgesForTests();
    relays.clear();
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
