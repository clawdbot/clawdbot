import type { Server } from "node:http";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
/**
 * Bridges native harness hook events through registered relay processes.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginHookToolRequesterContext } from "../../plugins/hook-types.js";
import type {
  BeforeToolCallFailureDisposition,
  DeferredPluginToolApproval,
  requestDeferredPluginToolApproval,
} from "../agent-tools.before-tool-call.js";
import { createNativeHookRelayBridgeRuntime } from "./native-hook-relay-bridge.js";
import { createNativeHookRelayEventRuntime } from "./native-hook-relay-events.js";
import { createNativeHookRelayPermissionRuntime } from "./native-hook-relay-permissions.js";
import { createNativeHookRelayRuntime } from "./native-hook-relay-runtime.js";
import { clearNativeHookRelayBridgeRecordsForTests } from "./native-hook-relay-store.js";

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

type NativeHookRelayRegistration = {
  relayId: string;
  provider: NativeHookRelayProvider;
  generationMismatchGraceExpiresAtMs?: number;
  generationMismatchGraceAcceptedGeneration?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  channelId?: string;
  requester?: PluginHookToolRequesterContext;
  allowedEvents: readonly NativeHookRelayEvent[];
  expiresAtMs: number;
  signal?: AbortSignal;
  onPreToolUseFailure?: (failure: {
    toolName: string;
    toolCallId: string;
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    durationMs: number;
  }) => void | Promise<void>;
};

type NativeHookRelayCommandOptions = {
  executable?: string;
  nice?: number | false;
  nodeExecutable?: string;
  timeoutMs?: number;
};

type NativeHookRelayCommandForEventOptions = {
  timeoutMs?: number;
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

type ActiveNativeHookRelayRegistrationHandle = NativeHookRelayRegistrationHandle & {
  generation: string;
};

type RegisterNativeHookRelayParams = {
  provider: NativeHookRelayProvider;
  relayId?: string;
  generation?: string;
  generationMismatchGraceMs?: number;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  channelId?: string;
  requester?: PluginHookToolRequesterContext;
  allowedEvents?: readonly NativeHookRelayEvent[];
  /** Whether this relay should run OpenClaw loop detection from native PreToolUse hooks. */
  preToolUseLoopDetection?: boolean;
  ttlMs?: number;
  command?: NativeHookRelayCommandOptions;
  signal?: AbortSignal;
  onPreToolUseFailure?: NativeHookRelayRegistration["onPreToolUseFailure"];
};

type InvokeNativeHookRelayParams = {
  provider: unknown;
  relayId: unknown;
  generation?: unknown;
  event: unknown;
  rawPayload: unknown;
  requireGeneration?: boolean;
};

type InvokeNativeHookRelayBridgeParams = InvokeNativeHookRelayParams & {
  registrationTimeoutMs?: number;
  stateDbPath?: string;
  timeoutMs?: number;
};

type NativeHookRelayDeferredApprovalOutcome =
  | { handled: true; outcome: "approved-once" }
  | {
      handled: true;
      outcome: "denied";
      reason: string;
      failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type NativeHookRelayInvocation = {
  provider: NativeHookRelayProvider;
  relayId: string;
  event: NativeHookRelayEvent;
  nativeEventName?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  cwd?: string;
  model?: string;
  turnId?: string;
  transcriptPath?: string;
  permissionMode?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  toolName?: string;
  toolUseId?: string;
  rawPayload: JsonValue;
  receivedAt: string;
};

type NativeHookRelayPermissionDecision = "allow" | "deny";

type NativeHookRelayPermissionApprovalResult =
  | NativeHookRelayPermissionDecision
  | "allow-always"
  | "defer";

type ActiveNativeHookRelayRegistration = NativeHookRelayRegistration & {
  generation: string;
  preToolUseLoopDetection: boolean;
  preToolUseFailureProjections: Map<string, { promise: Promise<void>; settled: boolean }>;
};

type NativeHookRelayPermissionApprovalRequest = {
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  cwd?: string;
  model?: string;
  toolInput: Record<string, JsonValue>;
  signal?: AbortSignal;
};

type NativeHookRelayPermissionApprovalRequester = (
  request: NativeHookRelayPermissionApprovalRequest,
) => Promise<NativeHookRelayPermissionApprovalResult>;

type NativeHookRelayDeferredToolApprovalRequester = typeof requestDeferredPluginToolApproval;

type NativeHookRelayPreToolUseApproval = {
  deferredApproval: DeferredPluginToolApproval;
  originalParamsFingerprint: string;
  resolutionPromise?: Promise<NativeHookRelayDeferredApprovalOutcome>;
};

type NativeHookRelayBridgeRegistration = {
  relayId: string;
  stateDbPath: string;
  token: string;
  server: Server;
};

type NativeHookRelaySharedState = {
  relays: Map<string, ActiveNativeHookRelayRegistration>;
  relayBridges: Map<string, NativeHookRelayBridgeRegistration>;
  invocations: NativeHookRelayInvocation[];
  pendingPermissionApprovals: Map<string, Promise<NativeHookRelayPermissionApprovalResult>>;
  pendingPreToolUseApprovals: Map<string, NativeHookRelayPreToolUseApproval>;
  permissionApprovalWindows: Map<string, number[]>;
  permissionAllowAlwaysApprovals: Map<string, { expiresAtMs: number }>;
};

const NATIVE_HOOK_RELAY_STATE_SYMBOL = Symbol.for("openclaw.nativeHookRelay.state");

function getNativeHookRelaySharedState(): NativeHookRelaySharedState {
  const globalRecord = globalThis as typeof globalThis & {
    [key: symbol]: NativeHookRelaySharedState | undefined;
  };
  globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL] ??= {
    relays: new Map<string, ActiveNativeHookRelayRegistration>(),
    relayBridges: new Map<string, NativeHookRelayBridgeRegistration>(),
    invocations: [],
    pendingPermissionApprovals: new Map<string, Promise<NativeHookRelayPermissionApprovalResult>>(),
    pendingPreToolUseApprovals: new Map<string, NativeHookRelayPreToolUseApproval>(),
    permissionApprovalWindows: new Map<string, number[]>(),
    permissionAllowAlwaysApprovals: new Map<string, { expiresAtMs: number }>(),
  };
  return globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL];
}

const nativeHookRelayState = getNativeHookRelaySharedState();
const relays = nativeHookRelayState.relays;
const relayBridges = nativeHookRelayState.relayBridges;
const invocations = nativeHookRelayState.invocations;
const pendingPermissionApprovals = nativeHookRelayState.pendingPermissionApprovals;
const pendingPreToolUseApprovals = nativeHookRelayState.pendingPreToolUseApprovals;
const permissionApprovalWindows = nativeHookRelayState.permissionApprovalWindows;
const permissionAllowAlwaysApprovals = nativeHookRelayState.permissionAllowAlwaysApprovals;

const log = createSubsystemLogger("agents/harness/native-hook-relay");

const permissionRuntime = createNativeHookRelayPermissionRuntime({
  pendingPermissionApprovals,
  pendingPreToolUseApprovals,
  permissionApprovalWindows,
  permissionAllowAlwaysApprovals,
  log,
});

const runtimeHolder: { current?: ReturnType<typeof createNativeHookRelayRuntime> } = {};
const bridgeRuntime = createNativeHookRelayBridgeRuntime({
  relays,
  relayBridges,
  invokeNativeHookRelay: (params) => {
    if (!runtimeHolder.current) {
      throw new Error("native hook relay runtime unavailable");
    }
    return runtimeHolder.current.invokeNativeHookRelay(params);
  },
  log,
});
const eventRuntime = createNativeHookRelayEventRuntime({
  pendingPermissionApprovals,
  setNativeHookRelayPreToolUseApproval: permissionRuntime.setNativeHookRelayPreToolUseApproval,
  startNativeHookRelayPermissionApprovalWithBudget:
    permissionRuntime.startNativeHookRelayPermissionApprovalWithBudget,
  nativeHookRelayPermissionApprovalKey: permissionRuntime.nativeHookRelayPermissionApprovalKey,
  nativeHookRelayPermissionAllowAlwaysKey:
    permissionRuntime.nativeHookRelayPermissionAllowAlwaysKey,
  hasNativeHookRelayPermissionAllowAlways:
    permissionRuntime.hasNativeHookRelayPermissionAllowAlways,
  rememberNativeHookRelayPermissionAllowAlways:
    permissionRuntime.rememberNativeHookRelayPermissionAllowAlways,
  log,
});
const runtime = createNativeHookRelayRuntime({
  relays,
  relayBridges,
  invocations,
  registerNativeHookRelayBridge: bridgeRuntime.registerNativeHookRelayBridge,
  resolveNativeHookRelayBridgeRecord: bridgeRuntime.resolveNativeHookRelayBridgeRecord,
  unregisterNativeHookRelayBridge: bridgeRuntime.unregisterNativeHookRelayBridge,
  processNativeHookRelayInvocation: eventRuntime.processNativeHookRelayInvocation,
  removeNativeHookRelayPreToolUseApprovals:
    permissionRuntime.removeNativeHookRelayPreToolUseApprovals,
  removeNativeHookRelayPermissionState: permissionRuntime.removeNativeHookRelayPermissionState,
  pruneNativeHookRelayPermissionAllowAlways:
    permissionRuntime.pruneNativeHookRelayPermissionAllowAlways,
  log,
});
runtimeHolder.current = runtime;

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  return runtime.registerNativeHookRelay(params);
}

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
  return runtime.buildNativeHookRelayCommand(params);
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  return runtime.invokeNativeHookRelay(params);
}

export function hasNativeHookRelayInvocation(params: {
  relayId: string;
  event: NativeHookRelayEvent;
  toolUseId?: string;
}): boolean {
  return runtime.hasNativeHookRelayInvocation(params);
}

export async function resolveNativeHookRelayDeferredToolApproval(params: {
  relayId: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<NativeHookRelayDeferredApprovalOutcome | undefined> {
  return permissionRuntime.resolveNativeHookRelayDeferredToolApproval(params);
}

export async function invokeNativeHookRelayBridge(
  params: InvokeNativeHookRelayBridgeParams,
): Promise<NativeHookRelayProcessResponse> {
  return bridgeRuntime.invokeNativeHookRelayBridge(params);
}

export function renderNativeHookRelayUnavailableResponse(params: {
  provider: unknown;
  event: unknown;
  preToolUseUnavailable?: unknown;
  message?: string;
}): NativeHookRelayProcessResponse {
  return bridgeRuntime.renderNativeHookRelayUnavailableResponse(params);
}

export function isNativeHookRelayBridgeStaleRegistrationError(error: unknown): boolean {
  return bridgeRuntime.isNativeHookRelayBridgeStaleRegistrationError(error);
}

export const testing = {
  clearNativeHookRelaysForTests(): void {
    for (const relayId of relayBridges.keys()) {
      bridgeRuntime.unregisterNativeHookRelayBridge(relayId);
    }
    relays.clear();
    invocations.length = 0;
    permissionRuntime.resetForTests();
    clearNativeHookRelayBridgeRecordsForTests();
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return runtime.getNativeHookRelayInvocationsForTests();
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return runtime.getNativeHookRelayRegistrationForTests(relayId);
  },
  getNativeHookRelayBridgeDirForTests(): string {
    throw new Error("native hook relay bridge files were retired");
  },
  getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
    void relayId;
    throw new Error("native hook relay bridge files were retired");
  },
  getNativeHookRelayBridgeRecordForTests(relayId: string): Record<string, unknown> | undefined {
    const record = bridgeRuntime.readNativeHookRelayBridgeRecordIfExists(relayId);
    return record ? { ...record } : undefined;
  },
  isNativeHookRelayBridgeLookupRetryableForTests(error: unknown, elapsedMs = 0): boolean {
    return bridgeRuntime.isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs });
  },
  formatPermissionApprovalDescriptionForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return permissionRuntime.formatPermissionApprovalDescription(request);
  },
  permissionRequestContentFingerprintForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return permissionRuntime.permissionRequestContentFingerprint(request);
  },
  permissionRequestToolInputKeyFingerprintForTests(toolInput: Record<string, unknown>): string {
    return permissionRuntime.permissionRequestToolInputKeyFingerprint(toolInput);
  },
  setNativeHookRelayPermissionApprovalRequesterForTests(
    requester: NativeHookRelayPermissionApprovalRequester,
  ): void {
    permissionRuntime.setPermissionApprovalRequesterForTests(requester);
  },
  setNativeHookRelayDeferredToolApprovalRequesterForTests(
    requester: NativeHookRelayDeferredToolApprovalRequester,
  ): void {
    permissionRuntime.setDeferredToolApprovalRequesterForTests(requester);
  },
} as const;
