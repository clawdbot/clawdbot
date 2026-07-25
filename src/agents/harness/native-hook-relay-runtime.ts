import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { listAgentToolResultMiddlewares } from "../../plugins/agent-tool-result-middleware.js";
import { hasGlobalHooks } from "../../plugins/hook-runner-global.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { hasBeforeToolCallPolicy } from "../agent-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR } from "./native-hook-relay-bridge.js";
import type {
  ActiveNativeHookRelayRegistration,
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
  RegisterNativeHookRelayParams,
} from "./native-hook-relay-contracts.js";
import {
  getNativeHookRelayProviderAdapter,
  isJsonValue,
  normalizeAllowedEvents,
  normalizeNativeHookInvocation,
  normalizeNativeHookToolName,
  normalizeOptionalPositiveInteger,
  normalizePositiveInteger,
  readNativeHookRelayApprovalMode,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
  resolveOpenClawCliExecutable,
  shellQuoteArgs,
  snapshotNativeHookRelayPayload,
} from "./native-hook-relay-provider.js";
import { renewOrRestoreNativeHookRelayBridgeRecord } from "./native-hook-relay-store.js";

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;
const NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS = 250;

export function createNativeHookRelayRuntime(context: {
  relays: Map<string, ActiveNativeHookRelayRegistration>;
  relayBridges: Map<string, NativeHookRelayBridgeRegistration>;
  invocations: NativeHookRelayInvocation[];
  registerNativeHookRelayBridge: (
    registration: ActiveNativeHookRelayRegistration,
    stateDbPath: string,
  ) => void;
  resolveNativeHookRelayBridgeRecord: (
    registration: ActiveNativeHookRelayRegistration,
    bridge: NativeHookRelayBridgeRegistration,
    expiresAtMs?: number,
  ) => import("./native-hook-relay-store.js").NativeHookRelayBridgeRecord | undefined;
  unregisterNativeHookRelayBridge: (
    relayId: string,
    options?: { deferBridgeRecordRemovalMs?: number },
  ) => void;
  processNativeHookRelayInvocation: (params: {
    registration: NativeHookRelayRegistration;
    invocation: NativeHookRelayInvocation;
    adapter: NativeHookRelayProviderAdapter;
  }) => Promise<NativeHookRelayProcessResponse>;
  removeNativeHookRelayPreToolUseApprovals: (relayId: string) => void;
  removeNativeHookRelayPermissionState: (relayId: string) => void;
  pruneNativeHookRelayPermissionAllowAlways: (now?: number) => void;
  log: Pick<ReturnType<typeof createSubsystemLogger>, "debug">;
}) {
  const {
    relays,
    relayBridges,
    invocations,
    registerNativeHookRelayBridge,
    resolveNativeHookRelayBridgeRecord,
    unregisterNativeHookRelayBridge,
    processNativeHookRelayInvocation,
    removeNativeHookRelayPreToolUseApprovals,
    removeNativeHookRelayPermissionState,
    pruneNativeHookRelayPermissionAllowAlways,
    log,
  } = context;

  function resolveNativeHookRelayExpiresAtMs(ttlMs: number | undefined): number | undefined {
    return resolveExpiresAtMsFromDurationMs(normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS));
  }
  function registerNativeHookRelay(
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
    registerNativeHookRelayBridge(registration, stateDbPath);
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
          const record = resolveNativeHookRelayBridgeRecord(current, bridge, renewedExpiresAtMs);
          if (!record) {
            return;
          }
          try {
            if (
              !renewOrRestoreNativeHookRelayBridgeRecord({
                record,
                stateDbPath: bridge.stateDbPath,
              })
            ) {
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

  function resolveNativeHookRelayNicePrefix(value: number | false | undefined): string[] {
    if (process.platform === "win32" || value === false || value === undefined) {
      return [];
    }
    const nice = normalizePositiveInteger(value, 0);
    if (nice <= 0) {
      return [];
    }
    return ["nice", "-n", String(nice)];
  }

  function resolveNativeHookRelayCommandTimeoutMs(
    configuredTimeoutMs: number | undefined,
    overrideTimeoutMs: number | undefined,
  ): number | undefined {
    const configured = normalizeOptionalPositiveInteger(configuredTimeoutMs);
    const override = normalizeOptionalPositiveInteger(overrideTimeoutMs);
    if (configured === undefined) {
      return override;
    }
    if (override === undefined) {
      return configured;
    }
    return Math.min(configured, override);
  }

  function buildNativeHookRelayCommand(params: {
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
    return buildNativeHookRelayCommandWithStateDatabase(params);
  }

  function buildNativeHookRelayCommandWithStateDatabase(params: {
    provider: NativeHookRelayProvider;
    relayId: string;
    stateDbPath?: string;
    generation?: string;
    event: NativeHookRelayEvent;
    preToolUseUnavailable?: "noop";
    timeoutMs?: number;
    executable?: string;
    nice?: number | false;
    nodeExecutable?: string;
  }): string {
    const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
    const executable = params.executable ?? resolveOpenClawCliExecutable();
    const argv =
      executable === "openclaw"
        ? ["openclaw"]
        : [params.nodeExecutable ?? process.execPath, executable];
    const nicePrefix = resolveNativeHookRelayNicePrefix(params.nice);
    const command = shellQuoteArgs([
      ...nicePrefix,
      ...argv,
      "hooks",
      "relay",
      "--provider",
      params.provider,
      "--relay-id",
      params.relayId,
      ...(params.stateDbPath ? ["--state-db", params.stateDbPath] : []),
      ...(params.generation ? ["--generation", params.generation] : []),
      "--event",
      params.event,
      ...(params.event === "pre_tool_use" && params.preToolUseUnavailable
        ? ["--pre-tool-use-unavailable", params.preToolUseUnavailable]
        : []),
      "--timeout",
      String(timeoutMs),
    ]);
    // Codex kills the shell process when a hook times out. Replace that shell so
    // the timeout targets this relay instead of leaving its Node child behind.
    return process.platform === "win32" ? command : `exec ${command}`;
  }

  function nativePreToolUseMayRunLoopDetection(
    registration: ActiveNativeHookRelayRegistration,
  ): boolean {
    if (!registration.preToolUseLoopDetection || !registration.sessionKey) {
      return false;
    }
    const loopDetection = resolveToolLoopDetectionConfig({
      cfg: registration.config,
      agentId: registration.agentId,
    });
    return loopDetection?.enabled !== false;
  }

  function nativeHookRelayEventHasLocalWork(
    registration: ActiveNativeHookRelayRegistration,
    event: NativeHookRelayEvent,
  ): boolean {
    if (event === "pre_tool_use") {
      // Avoid spawning a native hook relay for every Codex tool call when there
      // is no before_tool_call hook, trusted-tool policy, or loop detector work.
      return hasBeforeToolCallPolicy() || nativePreToolUseMayRunLoopDetection(registration);
    }
    if (event === "post_tool_use") {
      return (
        hasGlobalHooks("after_tool_call") || listAgentToolResultMiddlewares("codex").length > 0
      );
    }
    if (event === "before_agent_finalize") {
      return hasGlobalHooks("before_agent_finalize");
    }
    return true;
  }

  async function invokeNativeHookRelay(
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
    if (!callback) {
      return;
    }
    if (registration.preToolUseFailureProjections.has(failure.toolCallId)) {
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

  function hasNativeHookRelayInvocation(params: {
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

  return {
    registerNativeHookRelay,
    buildNativeHookRelayCommand,
    invokeNativeHookRelay,
    hasNativeHookRelayInvocation,
    unregisterNativeHookRelay,
    pruneExpiredNativeHookRelays,
    getNativeHookRelayInvocationsForTests: () => [...invocations],
    getNativeHookRelayRegistrationForTests: (relayId: string) => relays.get(relayId),
  };
}
