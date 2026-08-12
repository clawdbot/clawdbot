/**
 * Bridges Codex native hook callbacks into OpenClaw's native hook relay so
 * app-server tool events can still run OpenClaw policy and diagnostics.
 */
import { createHash } from "node:crypto";
import {
  embeddedAgentLog,
  hasBeforeToolCallPolicy,
  registerNativeHookRelay,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  addTimerTimeoutGraceMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import type { JsonObject, JsonValue } from "./protocol.js";

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
}): NativeHookRelayRegistrationHandle | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  return registerNativeHookRelay({
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
    onPreToolUseFailure: params.onPreToolUseFailure,
    command: {
      // Hook relay subprocesses are observational for most tool events; keep
      // them lower priority so they do not compete with the active reply turn.
      nice: 10,
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  });
}

// The relay event the app-server approval bridge's native policy path is gated on
// (`approval-bridge.ts`: `allowedEvents.includes("pre_tool_use")`), and where
// trusted-tool policy runs. `permission_request` is deliberately not the floor:
// `resolveCodexNativeHookRelayEvents` below excludes it while approvals are
// active so the approval bridge owns escalation instead of a stale pre-guardian
// plugin prompt.
const CODEX_NATIVE_HOOK_RELAY_APPROVAL_POLICY_FLOOR_EVENT: NativeHookRelayEvent = "pre_tool_use";

// The same override warns once per turn otherwise. Keyed by message: one line per
// distinct effective-policy/requested/resolved triple per process.
const warnedCodexNativeHookRelayNarrowings = new Set<string>();

type CodexNativeHookRelayRequest = {
  enabled?: boolean;
  events?: readonly NativeHookRelayEvent[];
};

/**
 * Applies the before-tool policy floor to an operator-configured relay shape,
 * keyed on the **effective** approval policy of the run: the runtime-resolved
 * value rather than the configured one. `resolveCodexAppServerRuntimeOptions`
 * can force a prompting policy over a configured `"never"` (unknown-model or
 * exec-mode reviewer forcing, forced guardian reviewer, forced
 * danger-full-access sandbox); on the side-question path the effective value is
 * the bound thread's policy when a persistent binding carries one. Both run
 * paths call this after that resolution and before the relay options are
 * consumed, so no thread can drop the relay the approval bridge runs on while
 * its own policy still prompts.
 *
 * The approval transport itself is out of reach here by construction: approvals
 * ride the app-server approval bridge over JSON-RPC, which falls back to the
 * in-process `before_tool_call` hook when no relay is registered.
 *
 * A full opt-out therefore needs two things to be true: approvals off **and** no
 * active OpenClaw before-tool policy. `hasBeforeToolCallPolicy()` reports the
 * second — a registered `before_tool_call` hook or any trusted-tool policy — and
 * is the same predicate `nativeHookRelayEventHasLocalWork` uses to decide whether
 * `pre_tool_use` has local work at all. Without that check an explicit
 * `approvalPolicy: "never"` would emit `features.hooks: false`, so the relay that
 * executes and can block that policy would never run.
 *
 * An explicit `events` list passes through verbatim under every policy. That is
 * upstream's own pre-existing contract, not a gap: #116117 (`a19132e7eb`,
 * "prevent approval promotion from blocking unattended runs" / "honor hook
 * approval ownership" / "keep permission grants human-gated") deliberately
 * preserves an explicit `permission_request` relay under a prompting policy and
 * pins it in `run-attempt.native-hook-relay.test.ts`. This config surface exposes
 * those semantics unchanged; the floor applies only to the `enabled: false`
 * opt-out, which would otherwise remove a relay the operator never scoped.
 *
 * Fields beyond `enabled`/`events` (ttl, timeouts) pass through untouched.
 */
export function resolveCodexNativeHookRelayForApprovalPolicy<
  T extends CodexNativeHookRelayRequest,
>(params: {
  requested: T | undefined;
  approvalPolicy: CodexAppServerRuntimeOptions["approvalPolicy"];
  warn?: (message: string, meta: Record<string, unknown>) => void;
}): T | undefined {
  const requested = params.requested;
  // Anything but the opt-out, including an explicit `events` scope, is the
  // operator's to author under every policy (see the #116117 contract above).
  if (!requested || requested.enabled !== false) {
    return requested;
  }
  const approvalsPrompt = params.approvalPolicy !== "never";
  const beforeToolPolicyActive = hasBeforeToolCallPolicy();
  if (!approvalsPrompt && !beforeToolPolicyActive) {
    // Nothing left for the relay to enforce: the full kill-switch is honored.
    return requested;
  }
  // The opt-out narrows to the required relay; any `events` scope is subsumed.
  return warnNarrowedCodexNativeHookRelay({
    approvalPolicy: params.approvalPolicy,
    approvalsPrompt,
    beforeToolPolicyActive,
    requested,
    resolved: {
      ...requested,
      enabled: true,
      events: [CODEX_NATIVE_HOOK_RELAY_APPROVAL_POLICY_FLOOR_EVENT],
    },
    warn: params.warn,
  });
}

function warnNarrowedCodexNativeHookRelay<T extends CodexNativeHookRelayRequest>(params: {
  approvalPolicy: CodexAppServerRuntimeOptions["approvalPolicy"];
  approvalsPrompt: boolean;
  beforeToolPolicyActive: boolean;
  requested: T;
  resolved: T;
  warn?: (message: string, meta: Record<string, unknown>) => void;
}): T {
  // Two reasons can hold the relay open; name the one that actually applies so an
  // operator who already set `approvalPolicy: "never"` is not told to set it again.
  const reason = params.approvalsPrompt
    ? `effective approval policy ${formatCodexEffectiveApprovalPolicy(
        params.approvalPolicy,
      )} requires the before-tool policy relay; approvals must be off (effective approvalPolicy "never") for a full opt-out`
    : "an active OpenClaw before-tool policy (before_tool_call hook or trusted-tool policy) requires the before-tool policy relay; a full opt-out needs approvals off and no before-tool policy";
  const message = `codex native hook relay ${formatCodexNativeHookRelayRequest(
    params.requested,
  )} narrowed to events [${(params.resolved.events ?? []).join(", ")}]: ${reason}`;
  if (warnedCodexNativeHookRelayNarrowings.has(message)) {
    return params.resolved;
  }
  warnedCodexNativeHookRelayNarrowings.add(message);
  (params.warn ?? embeddedAgentLog.warn.bind(embeddedAgentLog))(message, {
    approvalPolicy: params.approvalPolicy,
    beforeToolPolicyActive: params.beforeToolPolicyActive,
    requested: { enabled: params.requested.enabled, events: params.requested.events },
    resolved: { enabled: params.resolved.enabled, events: params.resolved.events },
  });
  return params.resolved;
}

/** Renders the effective policy for the operator warning; it may be a granular object. */
function formatCodexEffectiveApprovalPolicy(
  approvalPolicy: CodexAppServerRuntimeOptions["approvalPolicy"],
): string {
  return typeof approvalPolicy === "string" ? `"${approvalPolicy}"` : "granular";
}

function formatCodexNativeHookRelayRequest(requested: CodexNativeHookRelayRequest): string {
  return requested.enabled === false
    ? "opt-out (enabled: false)"
    : `events [${(requested.events ?? []).join(", ")}]`;
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
  loopDetectionPreToolUseRelay: boolean;
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
    // The no-policy marker is part of the shipped Codex fallback contract.
    // Only the Codex-owned loop relay opt-out may omit it.
    const selectedNoopPreToolUse =
      selected && event === "pre_tool_use" && !shouldRelay && params.loopDetectionPreToolUseRelay;
    if (!selected || (!shouldRelay && !selectedNoopPreToolUse)) {
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
    const matcher = selectedNoopPreToolUse
      ? undefined
      : buildCodexNativeToolMatcher(params.relay.toolMatcherForEvent(event));
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

/**
 * Builds the overlay for an operator opt-out of the OpenClaw native hook relay.
 *
 * Unlike {@link buildCodexNativeHookRelayDisabledConfig}, this overlay leaves
 * `features.hooks` alone. Disabling that flag switches off the whole Codex hook
 * engine, which also suppresses independent user, project, plugin, and managed
 * hooks the relay never installed — far more than opting out of the relay.
 * Instead this clears only the relay's own event arrays and pins disabled
 * `hooks.state` markers for the OpenClaw session-flags command keys, so
 * lower-precedence copies of the injected commands cannot be layered back in
 * during hook discovery.
 *
 * `features.hooks` is omitted rather than forced to `true`: this overlay is
 * merged last, so an explicit `true` would re-enable hooks for callers that
 * deliberately turned them off (the ring-zero thread config, for one). Omitting
 * the key keeps the opt-out neutral in both directions.
 */
export function buildCodexNativeHookRelayOptOutConfig(): JsonObject {
  const config: JsonObject = {};
  const hookState: JsonObject = {};
  for (const event of CODEX_NATIVE_HOOK_RELAY_EVENTS) {
    config[`hooks.${CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event]}`] = [] satisfies JsonValue;
    for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
      hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = {
        enabled: false,
      } satisfies JsonValue;
    }
  }
  config["hooks.state"] = hookState;
  return config;
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
