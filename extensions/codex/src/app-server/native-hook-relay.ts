/**
 * Bridges Codex native hook callbacks into OpenClaw's native hook relay so
 * app-server tool events can still run OpenClaw policy and diagnostics.
 */
import { createHash } from "node:crypto";
import type {
  BeforeToolCallFailureDisposition,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  NativeHookRelayEvent,
  NativeHookRelayRegistrationHandle,
  registerNativeHookRelay,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { registerRetainedNativeHookRelayForBundledRuntime } from "openclaw/plugin-sdk/native-hook-relay-runtime";
import {
  addTimerTimeoutGraceMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

/** Codex hook events that can be registered through OpenClaw's native relay. */
export const CODEX_NATIVE_HOOK_RELAY_EVENTS: readonly NativeHookRelayEvent[] = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
/** Extra relay lifetime after the expected turn budget, preventing late hook drops. */
export const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS = 250;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS = 1_000;
// The relay starts a niced Node subprocess, so busy hosts can exceed the former
// five-second relay timeout before policy and task-mirroring work completes.
const CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC = 10;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS = 10_000;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS = 5_000;
const MAX_PENDING_DIRECT_CHILD_ADMISSIONS = 32;

const CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID: Readonly<Record<string, readonly string[]>> = {
  exec: ["Bash", "exec", "exec_command"],
  apply_patch: ["apply_patch", "Write", "Edit"],
  spawn_agent: ["spawn_agent", "Agent"],
};

type CodexHookEventName = "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop";

export type CodexNativePreToolUseFailure = {
  toolName: string;
  toolCallId: string;
  disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">;
  durationMs: number;
};

export type CodexNativeHookRelay = NativeHookRelayRegistrationHandle & {
  authorizeRetentionAfterSuccessfulYield: () => void;
  claimDirectChild: (threadId: string) => () => void;
  rejectPendingDirectChild: (threadId: string, reason: string) => void;
};

/** Defers relay unregister so late native hook subprocesses can still resolve. */
export function scheduleCodexNativeHookRelayUnregister(params: {
  relay: NativeHookRelayRegistrationHandle;
  hookTimeoutSec?: number;
}): void {
  let pending: { timeout: ReturnType<typeof setTimeout>; unregister: () => void } | undefined;
  const unregister = () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (!nativeHookRelayUnregisterQueue.delete(current)) {
      return;
    }
    params.relay.unregister();
  };
  const timeout = setTimeout(
    unregister,
    resolveCodexNativeHookRelayUnregisterGraceMs(params.hookTimeoutSec),
  );
  pending = { timeout, unregister };
  nativeHookRelayUnregisterQueue.add(pending);
  timeout.unref();
}

/** Computes the delayed unregister window from Codex's hook timeout. */
function resolveCodexNativeHookRelayUnregisterGraceMs(hookTimeoutSec: number | undefined): number {
  const hookTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 0;
  return Math.max(
    CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS,
    addTimerTimeoutGraceMs(hookTimeoutMs, CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS) ?? 0,
  );
}

/** Records a native pre-tool failure that Codex does not project as a tool item. */
export function emitCodexNativePreToolUseFailureDiagnostic(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  runId: string;
  signal?: AbortSignal;
  failure: CodexNativePreToolUseFailure;
  terminalReason?: CodexNativePreToolUseFailure["disposition"];
  sourceTimestampMs?: number;
}): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.error",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    runId: params.runId,
    toolName: params.failure.toolName,
    toolCallId: params.failure.toolCallId,
    durationMs: params.failure.durationMs,
    errorCategory: "before_tool_call",
    terminalReason:
      params.terminalReason ??
      (params.signal?.aborted
        ? resolveCodexToolAbortTerminalReason(params.signal)
        : params.failure.disposition),
    ...(params.sourceTimestampMs !== undefined
      ? { sourceTimestampMs: params.sourceTimestampMs }
      : {}),
  });
}

/** Registers an OpenClaw native hook relay for a Codex app-server turn. */
export function createCodexNativeHookRelay(params: {
  options:
    | {
        enabled?: boolean;
        ttlMs?: number;
        gatewayTimeoutMs?: number;
      }
    | undefined;
  generation?: string;
  generationMismatchGraceMs?: number;
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParams["config"];
  runId: string;
  channelId?: string;
  requester?: NonNullable<PluginHookToolContext["requester"]>;
  approvalContext?: Parameters<typeof registerNativeHookRelay>[0]["approvalContext"];
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
  loopDetectionPreToolUseRelay: boolean;
  signal: AbortSignal;
  hostCapabilities: EmbeddedRunAttemptParams["hostCapabilities"];
  onPreToolUseFailure: (failure: CodexNativePreToolUseFailure) => void | Promise<void>;
}): CodexNativeHookRelay | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  const directChildClaims = new Map<string, symbol>();
  const pendingDirectChildAdmissions = new Map<
    string,
    {
      promise: Promise<symbol>;
      resolve: (claim: symbol) => void;
      reject: (reason: Error) => void;
    }
  >();
  let foregroundClosed = false;
  let successfulYieldRetentionAuthorized = false;
  const assertClaim = (threadId: string, claim: symbol) => () =>
    directChildClaims.get(threadId) === claim;
  const rejectPendingAdmissions = (reason: string) => {
    for (const pending of pendingDirectChildAdmissions.values()) {
      pending.reject(new Error(reason));
    }
    pendingDirectChildAdmissions.clear();
  };
  const relay = registerRetainedNativeHookRelayForBundledRuntime({
    provider: "codex",
    relayId: buildCodexNativeHookRelayId({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    }),
    ...(params.generation ? { generation: params.generation } : {}),
    ...(params.generationMismatchGraceMs
      ? { generationMismatchGraceMs: params.generationMismatchGraceMs }
      : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    runId: params.runId,
    ...(params.channelId ? { channelId: params.channelId } : {}),
    ...(params.requester ? { requester: params.requester } : {}),
    ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
    allowedEvents: params.events,
    preToolUseLoopDetection: params.loopDetectionPreToolUseRelay,
    ttlMs: resolveCodexNativeHookRelayTtlMs({
      explicitTtlMs: params.options?.ttlMs,
      attemptTimeoutMs: params.attemptTimeoutMs,
      startupTimeoutMs: params.startupTimeoutMs,
      turnStartTimeoutMs: params.turnStartTimeoutMs,
    }),
    signal: params.signal,
    runBeforeToolCall: params.hostCapabilities.runBeforeToolCall,
    assertActive: params.hostCapabilities.assertActive,
    retention: {
      readClaim: readCodexNativeChildThreadId,
      // A child claim identifies the subject; successful parent finalization
      // separately authorizes its lifetime beyond foreground closure.
      shouldRetainAfterForegroundClose: () =>
        successfulYieldRetentionAuthorized && directChildClaims.size > 0,
      allowPreToolUse: (childThreadId) => directChildClaims.has(childThreadId),
      awaitForegroundAdmission: (childThreadId) => {
        if (foregroundClosed) {
          return Promise.reject(new Error("native hook relay foreground admission unavailable"));
        }
        const existingClaim = directChildClaims.get(childThreadId);
        if (existingClaim) {
          return Promise.resolve(assertClaim(childThreadId, existingClaim));
        }
        const existingPending = pendingDirectChildAdmissions.get(childThreadId);
        if (existingPending) {
          return existingPending.promise.then((claim) => assertClaim(childThreadId, claim));
        }
        if (pendingDirectChildAdmissions.size >= MAX_PENDING_DIRECT_CHILD_ADMISSIONS) {
          return Promise.reject(
            new Error("native hook relay foreground admission capacity reached"),
          );
        }
        const { promise, resolve, reject } = createDeferred<symbol>();
        pendingDirectChildAdmissions.set(childThreadId, {
          promise,
          resolve,
          reject,
        });
        return promise.then((claim) => assertClaim(childThreadId, claim));
      },
      onDispose: () => {
        foregroundClosed = true;
        rejectPendingAdmissions("native hook relay registration closed");
      },
    },
    onPreToolUseFailure: params.onPreToolUseFailure,
    command: {
      // Hook relay subprocesses are observational for most tool events; keep
      // them lower priority so they do not compete with the active reply turn.
      nice: 10,
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  });
  const unregister = () => {
    foregroundClosed = true;
    rejectPendingAdmissions("native hook relay foreground closed");
    relay.unregister();
  };
  return {
    ...relay,
    unregister,
    authorizeRetentionAfterSuccessfulYield: () => {
      successfulYieldRetentionAuthorized = true;
    },
    rejectPendingDirectChild: (threadIdInput, reason) => {
      const threadId = threadIdInput.trim();
      const pending = threadId ? pendingDirectChildAdmissions.get(threadId) : undefined;
      if (!pending) {
        return;
      }
      pendingDirectChildAdmissions.delete(threadId);
      pending.reject(new Error(reason));
    },
    claimDirectChild: (threadIdInput) => {
      const threadId = threadIdInput.trim();
      if (!threadId) {
        return () => undefined;
      }
      const existingClaim = directChildClaims.get(threadId);
      if (existingClaim) {
        return () => undefined;
      }
      const claim = Symbol(threadId);
      directChildClaims.set(threadId, claim);
      const pending = pendingDirectChildAdmissions.get(threadId);
      pendingDirectChildAdmissions.delete(threadId);
      pending?.resolve(claim);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        if (directChildClaims.get(threadId) !== claim) {
          return;
        }
        directChildClaims.delete(threadId);
        if (foregroundClosed && directChildClaims.size === 0) {
          relay.unregister();
        }
      };
    },
  };
}

function readCodexNativeChildThreadId(rawPayload: unknown): string | undefined {
  if (!isJsonObject(rawPayload) || typeof rawPayload.agent_id !== "string") {
    return undefined;
  }
  const threadId = rawPayload.agent_id.trim();
  return threadId || undefined;
}

/** Selects the native hook events Codex should install for the current approval mode. */
export function resolveCodexNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy">;
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents;
  }
  // Codex emits PermissionRequest before the app-server approval reviewer has
  // resolved the command. In native approval modes, let Codex's app-server
  // approval bridge own the real escalation instead of surfacing a stale
  // pre-guardian OpenClaw plugin approval prompt.
  return params.appServer.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

/** Derives the native hook relay TTL from the turn budget unless explicitly configured. */
export function resolveCodexNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.attemptTimeoutMs +
    params.startupTimeoutMs +
    params.turnStartTimeoutMs +
    CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}

/** Builds a stable relay id scoped to the agent and session identity. */
function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v1");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}

const CODEX_HOOK_EVENT_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, CodexHookEventName> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  permission_request: "PermissionRequest",
  before_agent_finalize: "Stop",
};

const CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, string> = {
  pre_tool_use: "pre_tool_use",
  post_tool_use: "post_tool_use",
  permission_request: "permission_request",
  before_agent_finalize: "stop",
};

const CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS = [
  "/<session-flags>/config.toml",
  "<session-flags>/config.toml",
] as const;

/** Builds the Codex config overlay that installs trusted command hooks for relay events. */
export function buildCodexNativeHookRelayConfig(params: {
  relay: NativeHookRelayRegistrationHandle;
  events?: readonly NativeHookRelayEvent[];
  hookTimeoutSec?: number;
  clearOmittedEvents?: boolean;
}): JsonObject {
  const events = params.events?.length ? params.events : CODEX_NATIVE_HOOK_RELAY_EVENTS;
  const selectedEvents = new Set<NativeHookRelayEvent>(events);
  const config: JsonObject = {
    "features.hooks": true,
  };
  const hookState: JsonObject = {};
  for (const event of CODEX_NATIVE_HOOK_RELAY_EVENTS) {
    const codexEvent = CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event];
    const selected = selectedEvents.has(event);
    const shouldRelay = params.relay.shouldRelayEvent(event);
    if (!selected || !shouldRelay) {
      if (selected || params.clearOmittedEvents) {
        config[`hooks.${codexEvent}`] = [] satisfies JsonValue;
      }
      if (params.clearOmittedEvents) {
        for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
          hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = {
            enabled: false,
          } satisfies JsonValue;
        }
      }
      continue;
    }
    const timeout = normalizeHookTimeoutSec(params.hookTimeoutSec);
    const command = params.relay.commandForEvent(event, {
      timeoutMs: resolveCodexNativeHookRelayCommandTimeoutMs(timeout),
    });
    const matcher = buildCodexNativeToolMatcher(params.relay.toolMatcherForEvent(event));
    config[`hooks.${codexEvent}`] = [
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: "command",
            command,
            timeout,
            async: false,
            statusMessage: "OpenClaw native hook relay",
          },
        ],
      },
    ] satisfies JsonValue;
    const state = {
      enabled: true,
      trusted_hash: codexCommandHookTrustedHash({
        event,
        command,
        matcher,
        timeout,
        statusMessage: "OpenClaw native hook relay",
      }),
    };
    for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
      hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] =
        state satisfies JsonValue;
    }
  }
  config["hooks.state"] = hookState;
  return config;
}

/** Builds a Codex config overlay that disables native hooks and clears hook arrays. */
export function buildCodexNativeHookRelayDisabledConfig(): JsonObject {
  return {
    "features.hooks": false,
    "hooks.PreToolUse": [],
    "hooks.PostToolUse": [],
    "hooks.PermissionRequest": [],
    "hooks.Stop": [],
  };
}

function normalizeHookTimeoutSec(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC;
}

function resolveCodexNativeHookRelayCommandTimeoutMs(hookTimeoutSec: number | undefined): number {
  const parentTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 5_000;
  const parentMarginMs = Math.min(
    CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS,
    Math.max(CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS, Math.floor(parentTimeoutMs / 5)),
  );
  return Math.max(1, parentTimeoutMs - parentMarginMs);
}

function buildCodexNativeToolMatcher(toolNames: readonly string[] | undefined): string | undefined {
  if (toolNames === undefined) {
    return undefined;
  }
  if (toolNames.length === 0) {
    throw new TypeError("Codex native hook matcher requires at least one tool name");
  }
  const nativeNames = new Set<string>();
  let hasCustomToolName = false;
  for (const toolName of toolNames) {
    const canonicalToolName = toolName.trim();
    if (!canonicalToolName || canonicalToolName === "*") {
      throw new TypeError("Codex native hook matcher requires canonical OpenClaw tool ids");
    }
    const nativeAliases = CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID[canonicalToolName];
    if (!nativeAliases) {
      hasCustomToolName = true;
    }
    for (const nativeName of nativeAliases ?? [canonicalToolName]) {
      nativeNames.add(nativeName);
    }
  }
  const sortedNames = Array.from(nativeNames).toSorted();
  if (!hasCustomToolName && sortedNames.every((toolName) => /^[A-Za-z0-9_]+$/.test(toolName))) {
    return sortedNames.join("|");
  }
  const escapedNames = sortedNames.map((toolName) =>
    toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `(?i)^(?:${escapedNames.join("|")})$`;
}

function codexCommandHookTrustedHash(params: {
  event: NativeHookRelayEvent;
  command: string;
  matcher?: string;
  timeout: number;
  statusMessage: string;
}): string {
  // Keep the match-all matcher omitted rather than null. Codex app-server
  // converts JSON null to an empty TOML string before hashing, which changes the
  // trust identity even though both forms match all tools.
  const identity = {
    event_name: CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[params.event],
    ...(params.matcher ? { matcher: params.matcher } : {}),
    hooks: [
      {
        async: false,
        command: params.command,
        statusMessage: params.statusMessage,
        timeout: params.timeout,
        type: "command",
      },
    ],
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(sortJsonValue(identity)))
    .digest("hex");
  return `sha256:${hash}`;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  const sorted: JsonObject = {};
  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sorted[key] = sortJsonValue(entry);
  }
  return sorted;
}
