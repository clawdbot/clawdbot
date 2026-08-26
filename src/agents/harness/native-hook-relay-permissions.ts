import { createHash } from "node:crypto";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  prepareSystemRunMutableFileBinding,
  revalidateSystemRunMutableFileBinding,
  type SystemRunMutableFileBinding,
} from "../../infra/system-run-approval-binding.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  cancelDeferredPluginToolApproval,
  requestDeferredPluginToolApproval,
  type DeferredPluginToolApproval,
} from "../agent-tools.before-tool-call.js";
import {
  nativeHookRelayParamsWereRewritten,
  normalizeNativeHookToolName,
} from "./native-hook-relay-codec.js";
import { requestNativeHookRelayPermissionApproval } from "./native-hook-relay-permission-gateway.js";
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
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import { readOptionalNonEmptyString, truncateRelayText } from "./native-hook-relay-utils.js";

export type NativeHookRelayDeferredToolApprovalRequester = typeof requestDeferredPluginToolApproval;

const PERMISSION_ALLOW_ALWAYS_TTL_MS = 30 * 60 * 1000;
const MAX_PERMISSION_FALLBACK_KEYS = 200;
const MAX_PERMISSION_FALLBACK_KEY_CHARS = 240;
const MAX_PERMISSION_FINGERPRINT_SORT_KEYS = 200;
const MAX_PERMISSION_APPROVALS_PER_WINDOW = 12;
const PERMISSION_APPROVAL_WINDOW_MS = 60_000;
const MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES = 512;
const MCP_APPROVAL_UNAVAILABLE_REASON =
  'MCP tool approval timed out (no operator connected). Approve in the Control UI, or set mcp.servers.<id>.codex.defaultToolsApprovalMode:"approve" for trusted servers.';
const log = createSubsystemLogger("agents/harness/native-hook-relay");
const NATIVE_SHELL_APPROVAL_TOOLS = new Set([
  "bash",
  "exec",
  "exec_command",
  "shell",
  "shell_command",
]);

const {
  approvalOwners,
  pendingPermissionApprovals,
  pendingPreToolUseApprovals,
  permissionApprovalWindows,
  permissionAllowAlwaysApprovals,
} = nativeHookRelayState;

export function registerNativeHookRelayApprovalOwner(
  registration: NativeHookRelayRegistration,
  owner: symbol,
): void {
  approvalOwners.set(registration, owner);
}

export function inheritNativeHookRelayApprovalOwner(
  registration: NativeHookRelayRegistration,
  ownerRegistration: NativeHookRelayRegistration,
): void {
  const owner = approvalOwners.get(ownerRegistration);
  if (owner) {
    approvalOwners.set(registration, owner);
  }
}

let nativeHookRelayPermissionApprovalRequester: NativeHookRelayPermissionApprovalRequester =
  requestNativeHookRelayPermissionApproval;
let nativeHookRelayDeferredToolApprovalRequester: NativeHookRelayDeferredToolApprovalRequester =
  requestDeferredPluginToolApproval;

function nativeHookRelayPreToolUseApprovalKey(params: {
  relayId: string;
  turnId?: string;
  toolUseId?: string;
}): string | undefined {
  const turnId = params.turnId?.trim();
  const toolUseId = params.toolUseId?.trim();
  return turnId && toolUseId ? `${params.relayId}:${turnId}:${toolUseId}` : undefined;
}

export function setNativeHookRelayPreToolUseApproval(params: {
  registration: NativeHookRelayRegistration;
  turnId?: string;
  toolUseId?: string;
  deferredApproval: DeferredPluginToolApproval;
  originalParamsFingerprint: string;
}): boolean {
  const turnId = params.turnId?.trim();
  const toolUseId = params.toolUseId?.trim();
  const key = nativeHookRelayPreToolUseApprovalKey({
    relayId: params.registration.relayId,
    turnId,
    toolUseId,
  });
  const owner = approvalOwners.get(params.registration);
  if (!key || !owner || !turnId || !toolUseId) {
    return false;
  }
  let approvalsForKey = pendingPreToolUseApprovals.get(key);
  if (!approvalsForKey) {
    approvalsForKey = new Map();
    pendingPreToolUseApprovals.set(key, approvalsForKey);
  }
  const previousApproval = approvalsForKey.get(owner);
  if (previousApproval) {
    cancelDeferredPluginToolApproval(previousApproval.deferredApproval);
  }
  approvalsForKey.set(owner, {
    relayId: params.registration.relayId,
    turnId,
    toolUseId,
    deferredApproval: params.deferredApproval,
    originalParamsFingerprint: params.originalParamsFingerprint,
    ...(params.registration.assertActive ? { assertActive: params.registration.assertActive } : {}),
  });
  let approvalCount = 0;
  for (const approvals of pendingPreToolUseApprovals.values()) {
    approvalCount += approvals.size;
  }
  if (approvalCount > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    const oldestKey = pendingPreToolUseApprovals.keys().next().value;
    const oldestApprovals = oldestKey ? pendingPreToolUseApprovals.get(oldestKey) : undefined;
    const oldestOwner = oldestApprovals?.keys().next().value;
    if (oldestKey && oldestApprovals && oldestOwner) {
      const oldestApproval = oldestApprovals.get(oldestOwner);
      if (oldestApproval) {
        cancelDeferredPluginToolApproval(oldestApproval.deferredApproval);
      }
      oldestApprovals.delete(oldestOwner);
      if (oldestApprovals.size === 0) {
        pendingPreToolUseApprovals.delete(oldestKey);
      }
    }
  }
  return true;
}

export function removeNativeHookRelayPreToolUseApprovals(relayId: string): void {
  const prefix = `${relayId}:`;
  for (const [key, approvalsForKey] of pendingPreToolUseApprovals) {
    if (key.startsWith(prefix)) {
      for (const pendingApproval of approvalsForKey.values()) {
        cancelDeferredPluginToolApproval(pendingApproval.deferredApproval);
      }
      pendingPreToolUseApprovals.delete(key);
    }
  }
}

export async function resolveOwnedNativeHookRelayDeferredToolApproval(params: {
  approvalOwner: symbol;
  relayId: string;
  turnId?: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<NativeHookRelayDeferredApprovalOutcome | undefined> {
  const pendingApprovalKey = nativeHookRelayPreToolUseApprovalKey(params);
  if (!pendingApprovalKey) {
    return undefined;
  }
  const owner = params.approvalOwner;
  const approvalsForKey = pendingPreToolUseApprovals.get(pendingApprovalKey);
  const pendingApproval = approvalsForKey?.get(owner);
  if (!approvalsForKey || !pendingApproval) {
    return undefined;
  }
  return resolvePendingNativeHookRelayDeferredToolApproval({
    approvalsForKey,
    owner,
    pendingApproval,
    pendingApprovalKey,
    signal: params.signal,
  });
}

export async function resolveUnscopedNativeHookRelayDeferredToolApproval(params: {
  relayId: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<NativeHookRelayDeferredApprovalOutcome | undefined> {
  const toolUseId = params.toolUseId?.trim();
  if (!toolUseId) {
    return undefined;
  }
  let selected:
    | {
        approvalsForKey: Map<symbol, NativeHookRelayPreToolUseApproval>;
        owner: symbol;
        pendingApproval: NativeHookRelayPreToolUseApproval;
        pendingApprovalKey: string;
      }
    | undefined;
  for (const [pendingApprovalKey, approvalsForKey] of pendingPreToolUseApprovals) {
    for (const [owner, pendingApproval] of approvalsForKey) {
      if (pendingApproval.relayId !== params.relayId || pendingApproval.toolUseId !== toolUseId) {
        continue;
      }
      if (selected) {
        return undefined;
      }
      selected = { approvalsForKey, owner, pendingApproval, pendingApprovalKey };
    }
  }
  if (!selected) {
    return undefined;
  }
  return resolvePendingNativeHookRelayDeferredToolApproval({
    ...selected,
    signal: params.signal,
  });
}

function resolvePendingNativeHookRelayDeferredToolApproval(params: {
  approvalsForKey: Map<symbol, NativeHookRelayPreToolUseApproval>;
  owner: symbol;
  pendingApproval: NativeHookRelayPreToolUseApproval;
  pendingApprovalKey: string;
  signal?: AbortSignal;
}): Promise<NativeHookRelayDeferredApprovalOutcome> {
  const { approvalsForKey, owner, pendingApproval, pendingApprovalKey } = params;
  pendingApproval.resolutionPromise ??= resolveNativeHookRelayPreToolUseApproval(
    pendingApproval,
    params.signal,
  ).finally(() => {
    if (approvalsForKey.get(owner) === pendingApproval) {
      approvalsForKey.delete(owner);
      if (approvalsForKey.size === 0) {
        pendingPreToolUseApprovals.delete(pendingApprovalKey);
      }
    }
  });
  return pendingApproval.resolutionPromise;
}

async function resolveNativeHookRelayPreToolUseApproval(
  pendingApproval: NativeHookRelayPreToolUseApproval,
  signal?: AbortSignal,
): Promise<NativeHookRelayDeferredApprovalOutcome> {
  pendingApproval.assertActive?.();
  const outcome = await nativeHookRelayDeferredToolApprovalRequester({
    deferredApproval: pendingApproval.deferredApproval,
    signal,
  });
  pendingApproval.assertActive?.();
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
  const mutableFileBinding = await prepareNativeHookMutableFileBinding(request);
  if (!mutableFileBinding.ok) {
    return params.adapter.renderPermissionDecisionResponse("deny", mutableFileBinding.message);
  }
  const approvalKey = nativeHookRelayPermissionApprovalKey({
    registration: params.registration,
    request,
    binding: mutableFileBinding.binding,
  });
  const allowAlwaysKey = nativeHookRelayPermissionAllowAlwaysKey({
    registration: params.registration,
    request,
    binding: mutableFileBinding.binding,
  });
  if (hasNativeHookRelayPermissionAllowAlways(allowAlwaysKey)) {
    params.registration.assertActive?.();
    if (mutableFileBinding.binding) {
      const current = await revalidateSystemRunMutableFileBinding({
        binding: mutableFileBinding.binding,
        cwd: request.cwd,
      });
      params.registration.assertActive?.();
      if (!current.ok) {
        return params.adapter.renderPermissionDecisionResponse("deny", current.message);
      }
    }
    return params.adapter.renderPermissionDecisionResponse("allow");
  }
  const pendingApproval = pendingPermissionApprovals.get(approvalKey);
  const owner = approvalOwners.get(params.registration);
  const pendingPromise =
    pendingApproval && pendingApproval.owner === owner ? pendingApproval.promise : undefined;
  try {
    const decision = await (pendingPromise ??
      startNativeHookRelayPermissionApprovalWithBudget({
        registration: params.registration,
        approvalKey,
        request,
      }));
    params.registration.assertActive?.();
    if ((decision === "allow" || decision === "allow-always") && mutableFileBinding.binding) {
      // PermissionRequest is OpenClaw's last boundary before the native runtime
      // owns spawn; recheck after the wait before returning its allow response.
      const current = await revalidateSystemRunMutableFileBinding({
        binding: mutableFileBinding.binding,
        cwd: request.cwd,
      });
      params.registration.assertActive?.();
      if (!current.ok) {
        return params.adapter.renderPermissionDecisionResponse("deny", current.message);
      }
    }
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
    if (decision === "timed-out" && request.toolName.startsWith("mcp__")) {
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
  const owner = approvalOwners.get(params.registration);
  if (!owner) {
    return "defer";
  }
  if (!consumeNativeHookRelayPermissionBudget(params.registration.relayId)) {
    log.warn(
      `native hook permission approval rate limit exceeded; deferring to provider approval path: relay=${params.registration.relayId} run=${params.registration.runId}`,
    );
    return "defer";
  }
  const pendingApproval = {
    promise: nativeHookRelayPermissionApprovalRequester(params.request).finally(() => {
      if (pendingPermissionApprovals.get(params.approvalKey) === pendingApproval) {
        pendingPermissionApprovals.delete(params.approvalKey);
      }
    }),
    owner,
  };
  pendingPermissionApprovals.set(params.approvalKey, pendingApproval);
  return pendingApproval.promise;
}

export function removeNativeHookRelayPendingApprovalsForOwner(
  relayId: string,
  registration: NativeHookRelayRegistration,
): void {
  const owner = approvalOwners.get(registration);
  if (!owner) {
    return;
  }
  const prefix = `${relayId}:`;
  for (const [key, approvalsForKey] of pendingPreToolUseApprovals) {
    if (key.startsWith(prefix)) {
      const pendingApproval = approvalsForKey.get(owner);
      if (pendingApproval) {
        cancelDeferredPluginToolApproval(pendingApproval.deferredApproval);
        approvalsForKey.delete(owner);
        if (approvalsForKey.size === 0) {
          pendingPreToolUseApprovals.delete(key);
        }
      }
    }
  }
  for (const [key, pendingApproval] of pendingPermissionApprovals) {
    if (key.startsWith(prefix) && pendingApproval.owner === owner) {
      pendingPermissionApprovals.delete(key);
    }
  }
}

function nativeHookRelayPermissionApprovalKey(params: {
  registration: NativeHookRelayRegistration;
  request: NativeHookRelayPermissionApprovalRequest;
  binding?: SystemRunMutableFileBinding;
}): string {
  return [
    params.registration.relayId,
    params.registration.runId,
    params.request.toolCallId
      ? `call:${params.request.toolCallId}`
      : permissionRequestFallbackKey(params.request),
    permissionRequestContentFingerprint(params.request),
    params.binding ? permissionRequestBindingFingerprint(params.binding) : "no-file-binding",
  ].join(":");
}

async function prepareNativeHookMutableFileBinding(
  request: NativeHookRelayPermissionApprovalRequest,
): Promise<{ ok: true; binding?: SystemRunMutableFileBinding } | { ok: false; message: string }> {
  if (!NATIVE_SHELL_APPROVAL_TOOLS.has(request.toolName.trim().toLowerCase())) {
    return { ok: true };
  }
  const command = readOptionalNonEmptyString(request.toolInput.command);
  const prepared = await prepareSystemRunMutableFileBinding({
    command: { kind: "shell", text: command ?? "" },
    cwd: request.cwd,
  });
  if (!prepared.ok) {
    return { ok: false, message: prepared.message };
  }
  return prepared.binding.operands.length > 0
    ? { ok: true, binding: prepared.binding }
    : { ok: true };
}

function permissionRequestBindingFingerprint(binding: SystemRunMutableFileBinding): string {
  const hash = createHash("sha256");
  for (const { argv, snapshot } of binding.operands) {
    hash.update(JSON.stringify([argv, snapshot.argvIndex, snapshot.path, snapshot.sha256]));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function nativeHookRelayPermissionAllowAlwaysKey(params: {
  registration: NativeHookRelayRegistration;
  request: NativeHookRelayPermissionApprovalRequest;
  binding?: SystemRunMutableFileBinding;
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
  hash.update("\0");
  hash.update(
    params.binding ? permissionRequestBindingFingerprint(params.binding) : "no-file-binding",
  );
  return hash.digest("hex");
}

function permissionRequestFallbackKey(request: NativeHookRelayPermissionApprovalRequest): string {
  const command = readOptionalNonEmptyString(request.toolInput.command);
  if (command) {
    return `${request.toolName}:command:${truncateRelayText(command, 240)}`;
  }
  return `${request.toolName}:keys:${permissionRequestToolInputKeyFingerprint(request.toolInput)}`;
}
export function permissionRequestToolInputKeyFingerprint(
  toolInput: Record<string, unknown>,
): string {
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

export function permissionRequestContentFingerprint(
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
  for (const approvalsForKey of pendingPreToolUseApprovals.values()) {
    for (const pendingApproval of approvalsForKey.values()) {
      cancelDeferredPluginToolApproval(pendingApproval.deferredApproval);
    }
  }
  pendingPreToolUseApprovals.clear();
  permissionApprovalWindows.clear();
  permissionAllowAlwaysApprovals.clear();
  nativeHookRelayPermissionApprovalRequester = requestNativeHookRelayPermissionApproval;
  nativeHookRelayDeferredToolApprovalRequester = requestDeferredPluginToolApproval;
}
