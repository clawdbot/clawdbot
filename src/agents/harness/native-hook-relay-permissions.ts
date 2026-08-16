import { createHash } from "node:crypto";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { isApprovalNotFoundError } from "../../infra/approval-errors.js";
import { toErrorObject } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { PluginApprovalResolutions } from "../../plugins/types.js";
import {
  cancelDeferredPluginToolApproval,
  requestDeferredPluginToolApproval,
  type DeferredPluginToolApproval,
} from "../agent-tools.before-tool-call.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  nativeHookRelayParamsWereRewritten,
  normalizeNativeHookToolName,
} from "./native-hook-relay-codec.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  JsonValue,
  NativeHookRelayDeferredApprovalOutcome,
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayPermissionApprovalRequester,
  NativeHookRelayPermissionApprovalResult,
  NativeHookRelayPreToolUseApproval,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import { readOptionalNonEmptyString, truncateRelayText } from "./native-hook-relay-utils.js";

export type NativeHookRelayDeferredToolApprovalRequester = typeof requestDeferredPluginToolApproval;

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const PERMISSION_ALLOW_ALWAYS_TTL_MS = 30 * 60 * 1000;
const MAX_PERMISSION_FALLBACK_KEYS = 200;
const MAX_PERMISSION_FALLBACK_KEY_CHARS = 240;
const MAX_PERMISSION_FINGERPRINT_SORT_KEYS = 200;
const MAX_APPROVAL_TITLE_LENGTH = 80;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 700;
const MAX_PERMISSION_APPROVALS_PER_WINDOW = 12;
const PERMISSION_APPROVAL_WINDOW_MS = 60_000;
const MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES = 512;
const MCP_APPROVAL_UNAVAILABLE_REASON =
  'MCP tool approval timed out (no operator connected). Approve in the Control UI, or set mcp.servers.<id>.codex.defaultToolsApprovalMode:"approve" for trusted servers.';
const log = createSubsystemLogger("agents/harness/native-hook-relay");

const {
  pendingPermissionApprovals,
  pendingPreToolUseApprovals,
  permissionApprovalWindows,
  permissionAllowAlwaysApprovals,
} = nativeHookRelayState;

let nativeHookRelayPermissionApprovalRequester: NativeHookRelayPermissionApprovalRequester =
  requestNativeHookRelayPermissionApproval;
let nativeHookRelayDeferredToolApprovalRequester: NativeHookRelayDeferredToolApprovalRequester =
  requestDeferredPluginToolApproval;

function nativeHookRelayPreToolUseApprovalKey(params: {
  relayId: string;
  toolUseId?: string;
}): string | undefined {
  const toolUseId = params.toolUseId?.trim();
  return toolUseId ? `${params.relayId}:${toolUseId}` : undefined;
}

export function setNativeHookRelayPreToolUseApproval(params: {
  relayId: string;
  toolUseId?: string;
  deferredApproval: DeferredPluginToolApproval;
  originalParamsFingerprint: string;
}): boolean {
  const key = nativeHookRelayPreToolUseApprovalKey(params);
  if (!key) {
    return false;
  }
  const previousApproval = pendingPreToolUseApprovals.get(key);
  if (previousApproval) {
    cancelDeferredPluginToolApproval(previousApproval.deferredApproval);
  }
  pendingPreToolUseApprovals.set(key, {
    deferredApproval: params.deferredApproval,
    originalParamsFingerprint: params.originalParamsFingerprint,
  });
  if (pendingPreToolUseApprovals.size > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    const oldestKey = pendingPreToolUseApprovals.keys().next().value;
    if (oldestKey) {
      const oldestApproval = pendingPreToolUseApprovals.get(oldestKey);
      if (oldestApproval) {
        cancelDeferredPluginToolApproval(oldestApproval.deferredApproval);
      }
      pendingPreToolUseApprovals.delete(oldestKey);
    }
  }
  return true;
}

export function removeNativeHookRelayPreToolUseApprovals(relayId: string): void {
  const prefix = `${relayId}:`;
  for (const [key, pendingApproval] of pendingPreToolUseApprovals) {
    if (key.startsWith(prefix)) {
      cancelDeferredPluginToolApproval(pendingApproval.deferredApproval);
      pendingPreToolUseApprovals.delete(key);
    }
  }
}

export async function resolveNativeHookRelayDeferredToolApproval(params: {
  relayId: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<NativeHookRelayDeferredApprovalOutcome | undefined> {
  const pendingApprovalKey = nativeHookRelayPreToolUseApprovalKey(params);
  if (!pendingApprovalKey) {
    return undefined;
  }
  const pendingApproval = pendingPreToolUseApprovals.get(pendingApprovalKey);
  if (!pendingApproval) {
    return undefined;
  }
  pendingApproval.resolutionPromise ??= resolveNativeHookRelayPreToolUseApproval(
    pendingApproval,
    params.signal,
  ).finally(() => {
    if (pendingPreToolUseApprovals.get(pendingApprovalKey) === pendingApproval) {
      pendingPreToolUseApprovals.delete(pendingApprovalKey);
    }
  });
  return pendingApproval.resolutionPromise;
}

async function resolveNativeHookRelayPreToolUseApproval(
  pendingApproval: NativeHookRelayPreToolUseApproval,
  signal?: AbortSignal,
): Promise<NativeHookRelayDeferredApprovalOutcome> {
  const outcome = await nativeHookRelayDeferredToolApprovalRequester({
    deferredApproval: pendingApproval.deferredApproval,
    signal,
  });
  if (outcome.blocked) {
    return {
      handled: true,
      outcome: "denied",
      reason: outcome.reason,
      ...(outcome.kind === "failure" && outcome.disposition !== "blocked"
        ? { failureDisposition: outcome.disposition }
        : {}),
    };
  }
  if (
    nativeHookRelayParamsWereRewritten(pendingApproval.originalParamsFingerprint, outcome.params)
  ) {
    return {
      handled: true,
      outcome: "denied",
      reason:
        "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    };
  }
  return { handled: true, outcome: "approved-once" };
}

export async function runNativeHookRelayPermissionRequest(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const request: NativeHookRelayPermissionApprovalRequest = {
    provider: params.registration.provider,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    runId: params.registration.runId,
    toolName: normalizeNativeHookToolName(params.invocation.toolName),
    ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
    ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
    ...(params.invocation.model ? { model: params.invocation.model } : {}),
    toolInput: params.adapter.readToolInput(params.invocation.rawPayload),
    ...(params.registration.signal ? { signal: params.registration.signal } : {}),
  };
  const approvalKey = nativeHookRelayPermissionApprovalKey({
    registration: params.registration,
    request,
  });
  const allowAlwaysKey = nativeHookRelayPermissionAllowAlwaysKey({
    registration: params.registration,
    request,
  });
  if (hasNativeHookRelayPermissionAllowAlways(allowAlwaysKey)) {
    return params.adapter.renderPermissionDecisionResponse("allow");
  }
  const pendingApproval = pendingPermissionApprovals.get(approvalKey);
  try {
    const decision = await (pendingApproval ??
      startNativeHookRelayPermissionApprovalWithBudget({
        registration: params.registration,
        approvalKey,
        request,
      }));
    if (decision === "allow") {
      return params.adapter.renderPermissionDecisionResponse("allow");
    }
    if (decision === "allow-always") {
      rememberNativeHookRelayPermissionAllowAlways(allowAlwaysKey);
      return params.adapter.renderPermissionDecisionResponse("allow");
    }
    if (decision === "deny") {
      return params.adapter.renderPermissionDecisionResponse("deny", "Denied by user");
    }
    if (decision === "unavailable" && request.toolName.startsWith("mcp__")) {
      return params.adapter.renderPermissionDecisionResponse(
        "deny",
        MCP_APPROVAL_UNAVAILABLE_REASON,
      );
    }
  } catch (error) {
    log.warn(
      `native hook permission approval failed; deferring to provider approval path: ${String(error)}`,
    );
  }
  // A PermissionRequest no-op is not an allow decision. Codex interprets it as
  // "no hook decision" and falls through to its normal guardian/user approval path.
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function startNativeHookRelayPermissionApprovalWithBudget(params: {
  registration: NativeHookRelayRegistration;
  approvalKey: string;
  request: NativeHookRelayPermissionApprovalRequest;
}): Promise<NativeHookRelayPermissionApprovalResult> {
  if (!consumeNativeHookRelayPermissionBudget(params.registration.relayId)) {
    log.warn(
      `native hook permission approval rate limit exceeded; deferring to provider approval path: relay=${params.registration.relayId} run=${params.registration.runId}`,
    );
    return "defer";
  }
  const approval: Promise<NativeHookRelayPermissionApprovalResult> =
    nativeHookRelayPermissionApprovalRequester(params.request).finally(() => {
      if (pendingPermissionApprovals.get(params.approvalKey) === approval) {
        pendingPermissionApprovals.delete(params.approvalKey);
      }
    });
  pendingPermissionApprovals.set(params.approvalKey, approval);
  return approval;
}

function nativeHookRelayPermissionApprovalKey(params: {
  registration: NativeHookRelayRegistration;
  request: NativeHookRelayPermissionApprovalRequest;
}): string {
  return [
    params.registration.relayId,
    params.registration.runId,
    params.request.toolCallId
      ? `call:${params.request.toolCallId}`
      : permissionRequestFallbackKey(params.request),
    permissionRequestContentFingerprint(params.request),
  ].join(":");
}

function nativeHookRelayPermissionAllowAlwaysKey(params: {
  registration: NativeHookRelayRegistration;
  request: NativeHookRelayPermissionApprovalRequest;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:native-hook-relay:permission-allow-always:v2");
  hash.update("\0");
  hash.update(params.registration.relayId);
  hash.update("\0");
  hash.update(params.request.provider);
  hash.update("\0");
  hash.update(params.request.agentId ?? "");
  hash.update("\0");
  hash.update(params.request.sessionKey ?? params.request.sessionId);
  hash.update("\0");
  hash.update(permissionRequestContentFingerprint(params.request));
  return hash.digest("hex");
}

function permissionRequestFallbackKey(request: NativeHookRelayPermissionApprovalRequest): string {
  const command = readOptionalNonEmptyString(request.toolInput.command);
  if (command) {
    return `${request.toolName}:command:${truncateRelayText(command, 240)}`;
  }
  return `${request.toolName}:keys:${permissionRequestToolInputKeyFingerprint(request.toolInput)}`;
}

export function permissionRequestToolInputKeyFingerprintForTests(
  toolInput: Record<string, unknown>,
): string {
  return permissionRequestToolInputKeyFingerprint(toolInput);
}

function permissionRequestToolInputKeyFingerprint(toolInput: Record<string, unknown>): string {
  let fingerprint = "";
  const { keys, truncated } = readBoundedOwnKeys(toolInput, MAX_PERMISSION_FALLBACK_KEYS);
  for (const key of keys) {
    const separator = fingerprint ? "," : "";
    const remaining = MAX_PERMISSION_FALLBACK_KEY_CHARS - fingerprint.length - separator.length;
    if (remaining <= 0) {
      break;
    }
    fingerprint += `${separator}${key.slice(0, remaining)}`;
  }
  if (truncated && fingerprint.length < MAX_PERMISSION_FALLBACK_KEY_CHARS) {
    const marker = `${fingerprint ? "," : ""}...`;
    fingerprint += marker.slice(0, MAX_PERMISSION_FALLBACK_KEY_CHARS - fingerprint.length);
  }
  return fingerprint || "none";
}

export function permissionRequestContentFingerprintForTests(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  return permissionRequestContentFingerprint(request);
}

function permissionRequestContentFingerprint(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  const hash = createHash("sha256");
  hash.update(request.toolName);
  hash.update("\0");
  hash.update(request.cwd ?? "");
  hash.update("\0");
  updateJsonHash(hash, request.toolInput);
  return hash.digest("hex");
}

function updateJsonHash(hash: ReturnType<typeof createHash>, value: JsonValue): void {
  if (value === null) {
    hash.update("null");
    return;
  }
  if (typeof value === "string") {
    hash.update("string:");
    hash.update(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    hash.update(`number:${String(value)}`);
    return;
  }
  if (typeof value === "boolean") {
    hash.update(`boolean:${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    hash.update("[");
    for (const item of value) {
      updateJsonHash(hash, item);
      hash.update(",");
    }
    hash.update("]");
    return;
  }
  hash.update("{");
  const { keys, truncated } = readBoundedOwnKeys(value, MAX_PERMISSION_FINGERPRINT_SORT_KEYS);
  for (const key of keys) {
    hash.update(JSON.stringify(key));
    hash.update(":");
    const item = value[key];
    if (item !== undefined) {
      updateJsonHash(hash, item);
    }
    hash.update(",");
  }
  if (truncated) {
    // Keep ordinary objects order-independent without sorting a broad native
    // hook payload. The tail remains content-sensitive in traversal order.
    const sortedKeySet = new Set(keys);
    hash.update("#object-tail:");
    for (const key in value) {
      if (!Object.hasOwn(value, key) || sortedKeySet.has(key)) {
        continue;
      }
      hash.update(JSON.stringify(key));
      hash.update(":");
      const item = value[key];
      if (item !== undefined) {
        updateJsonHash(hash, item);
      }
      hash.update(",");
    }
  }
  hash.update("}");
}

function readBoundedOwnKeys(
  value: Record<string, unknown>,
  maxKeys: number,
): { keys: string[]; truncated: boolean } {
  const keys: string[] = [];
  let truncated = false;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (keys.length >= maxKeys) {
      truncated = true;
      break;
    }
    keys.push(key);
  }
  keys.sort();
  return { keys, truncated };
}

function consumeNativeHookRelayPermissionBudget(relayId: string, now = Date.now()): boolean {
  const windowStart = now - PERMISSION_APPROVAL_WINDOW_MS;
  const timestamps = (permissionApprovalWindows.get(relayId) ?? []).filter(
    (timestamp) => timestamp >= windowStart,
  );
  if (timestamps.length >= MAX_PERMISSION_APPROVALS_PER_WINDOW) {
    permissionApprovalWindows.set(relayId, timestamps);
    return false;
  }
  timestamps.push(now);
  permissionApprovalWindows.set(relayId, timestamps);
  return true;
}

function hasNativeHookRelayPermissionAllowAlways(key: string, now = Date.now()): boolean {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    return false;
  }
  const entry = permissionAllowAlwaysApprovals.get(key);
  if (!entry) {
    return false;
  }
  const expiresAtMs = asDateTimestampMs(entry.expiresAtMs);
  if (expiresAtMs === undefined || expiresAtMs <= validNow) {
    permissionAllowAlwaysApprovals.delete(key);
    return false;
  }
  return true;
}

function rememberNativeHookRelayPermissionAllowAlways(key: string, now = Date.now()): void {
  pruneNativeHookRelayPermissionAllowAlways(now);
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(PERMISSION_ALLOW_ALWAYS_TTL_MS, {
    nowMs: now,
  });
  if (expiresAtMs === undefined) {
    return;
  }
  permissionAllowAlwaysApprovals.set(key, { expiresAtMs });
  pruneMapToMaxSize(permissionAllowAlwaysApprovals, MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES);
}

export function pruneNativeHookRelayPermissionAllowAlways(now = Date.now()): void {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    return;
  }
  for (const [key, entry] of permissionAllowAlwaysApprovals) {
    const expiresAtMs = asDateTimestampMs(entry.expiresAtMs);
    if (expiresAtMs === undefined || expiresAtMs <= validNow) {
      permissionAllowAlwaysApprovals.delete(key);
    }
  }
}

export function removeNativeHookRelayPermissionState(relayId: string): void {
  permissionApprovalWindows.delete(relayId);
  for (const key of pendingPermissionApprovals.keys()) {
    if (key.startsWith(`${relayId}:`)) {
      pendingPermissionApprovals.delete(key);
    }
  }
}

async function requestNativeHookRelayPermissionApproval(
  request: NativeHookRelayPermissionApprovalRequest,
): Promise<NativeHookRelayPermissionApprovalResult> {
  const timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;
  const requestResult: { id?: string; decision?: string | null } = await callGatewayTool(
    "plugin.approval.request",
    { timeoutMs: timeoutMs + 10_000 },
    {
      pluginId: `openclaw-native-hook-relay-${request.provider}`,
      title: truncateRelayText(
        `${nativeHookRelayProviderDisplayName(request.provider)} permission request`,
        MAX_APPROVAL_TITLE_LENGTH,
      ),
      description: truncateRelayText(
        formatPermissionApprovalDescription(request),
        MAX_APPROVAL_DESCRIPTION_LENGTH,
      ),
      severity: "warning",
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      allowedDecisions: [
        PluginApprovalResolutions.ALLOW_ONCE,
        PluginApprovalResolutions.ALLOW_ALWAYS,
        PluginApprovalResolutions.DENY,
      ],
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      timeoutMs,
      twoPhase: true,
    },
    { expectFinal: false },
  );
  const approvalId = requestResult?.id;
  if (!approvalId) {
    return "unavailable";
  }
  let decision: string | null | undefined;
  if (Object.hasOwn(requestResult ?? {}, "decision")) {
    decision = requestResult.decision;
  } else {
    const waitResult = await waitForNativeHookRelayApprovalDecision({
      approvalId,
      signal: request.signal,
      timeoutMs,
    });
    // Bind the verdict to the request that parked this call. A stale or
    // misrouted reply must never release a different tool gate.
    decision = waitResult?.id === approvalId ? waitResult.decision : undefined;
  }
  if (decision === PluginApprovalResolutions.ALLOW_ONCE) {
    return "allow";
  }
  if (decision === PluginApprovalResolutions.ALLOW_ALWAYS) {
    return "allow-always";
  }
  if (decision === PluginApprovalResolutions.DENY) {
    return "deny";
  }
  return "unavailable";
}

async function waitForNativeHookRelayApprovalDecision(params: {
  approvalId: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<{ id?: string; decision?: string | null } | undefined> {
  const waitPromise: Promise<{ id?: string; decision?: string | null } | undefined> =
    callGatewayTool(
      "plugin.approval.waitDecision",
      { timeoutMs: params.timeoutMs + 10_000 },
      { id: params.approvalId },
    ).catch((error: unknown) => {
      if (isApprovalNotFoundError(error)) {
        return undefined;
      }
      throw error;
    });
  if (!params.signal) {
    return waitPromise;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (params.signal!.aborted) {
      reject(toErrorObject(params.signal!.reason, "Non-Error rejection"));
      return;
    }
    onAbort = () => reject(toErrorObject(params.signal!.reason, "Non-Error rejection"));
    params.signal!.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([waitPromise, abortPromise]);
  } finally {
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

export function formatPermissionApprovalDescriptionForTests(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  return formatPermissionApprovalDescription(request);
}

function formatPermissionApprovalDescription(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  const lines = [
    `Tool: ${sanitizeApprovalText(request.toolName)}`,
    request.cwd ? `Cwd: ${sanitizeApprovalText(request.cwd)}` : undefined,
    request.model ? `Model: ${sanitizeApprovalText(request.model)}` : undefined,
    formatToolInputPreview(request.toolInput),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function formatToolInputPreview(toolInput: Record<string, unknown>): string | undefined {
  const command = readOptionalNonEmptyString(toolInput.command);
  if (command) {
    return `Command: ${truncateRelayText(sanitizeApprovalText(command), 240)}`;
  }
  const keys = Object.keys(toolInput).map(sanitizeApprovalText).filter(Boolean).toSorted();
  if (!keys.length) {
    return undefined;
  }
  const shownKeys = keys.slice(0, 12).join(", ");
  const omitted = keys.length > 12 ? ` (${keys.length - 12} omitted)` : "";
  return `Input keys: ${shownKeys}${omitted}`;
}

function sanitizeApprovalText(value: string): string {
  let sanitized = "";
  for (const char of stripAnsi(value)) {
    const codePoint = char.codePointAt(0);
    sanitized += codePoint != null && isUnsafeApprovalCodePoint(codePoint) ? " " : char;
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

function isUnsafeApprovalCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    (codePoint >= 127 && codePoint <= 159) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function nativeHookRelayProviderDisplayName(provider: NativeHookRelayProvider): string {
  return provider === "codex" ? "Codex" : provider;
}

export function setNativeHookRelayPermissionApprovalRequesterForTests(
  requester: NativeHookRelayPermissionApprovalRequester,
): void {
  nativeHookRelayPermissionApprovalRequester = requester;
}

export function setNativeHookRelayDeferredToolApprovalRequesterForTests(
  requester: NativeHookRelayDeferredToolApprovalRequester,
): void {
  nativeHookRelayDeferredToolApprovalRequester = requester;
}

export function clearNativeHookRelayPermissionsForTests(): void {
  pendingPermissionApprovals.clear();
  for (const pendingApproval of pendingPreToolUseApprovals.values()) {
    cancelDeferredPluginToolApproval(pendingApproval.deferredApproval);
  }
  pendingPreToolUseApprovals.clear();
  permissionApprovalWindows.clear();
  permissionAllowAlwaysApprovals.clear();
  nativeHookRelayPermissionApprovalRequester = requestNativeHookRelayPermissionApproval;
  nativeHookRelayDeferredToolApprovalRequester = requestDeferredPluginToolApproval;
}
