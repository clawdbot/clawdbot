import { existsSync } from "node:fs";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { stableStringify } from "../stable-stringify.js";
import { normalizeToolName } from "../tool-policy.js";
import type {
  JsonValue,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayInvocationMetadata,
  NativeHookRelayProvider,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-contracts.js";

const NATIVE_HOOK_RELAY_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const MAX_NATIVE_HOOK_RELAY_JSON_DEPTH = 64;
const MAX_NATIVE_HOOK_RELAY_JSON_NODES = 20_000;
const MAX_NATIVE_HOOK_RELAY_STRING_LENGTH = 1_000_000;
const MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH = 4_000_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH = 4_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH = 20_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS = 50;
const MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS = 50;

const NATIVE_HOOK_TOOL_NAME_ALIASES: Record<string, string> = {
  exec_command: "exec",
};

const nativeHookRelayProviderAdapters: Record<
  NativeHookRelayProvider,
  NativeHookRelayProviderAdapter
> = {
  codex: {
    normalizeMetadata: normalizeCodexHookMetadata,
    readToolInput: readCodexToolInput,
    readToolResponse: readCodexToolResponse,
    renderNoopResponse: () => {
      // Codex treats empty stdout plus exit 0 as no decision/no additional context.
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    renderPreToolUseBlockResponse: (reason, failureDisposition) => ({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
      ...(failureDisposition ? { failureDisposition } : {}),
    }),
    renderBeforeAgentFinalizeReviseResponse: (reason) => ({
      stdout: `${JSON.stringify({
        decision: "block",
        reason,
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
    renderBeforeAgentFinalizeStopResponse: (reason) => ({
      stdout: `${JSON.stringify({
        continue: false,
        ...(reason?.trim() ? { stopReason: reason.trim() } : {}),
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
    renderPermissionDecisionResponse: (decision, message) => ({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision:
            decision === "allow"
              ? { behavior: "allow" }
              : {
                  behavior: "deny",
                  message: message?.trim() || "Denied by OpenClaw",
                },
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
  },
};

export function snapshotNativeHookRelayPayload(payload: JsonValue): JsonValue {
  return snapshotJsonValue(payload, {
    remainingStringLength: MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH,
  });
}

function snapshotJsonValue(value: JsonValue, state: { remainingStringLength: number }): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return snapshotString(value, state);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS)
      .map((item) => snapshotJsonValue(item, state));
    if (value.length > MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS) {
      items.push("[truncated]");
    }
    return items;
  }
  const snapshot: Record<string, JsonValue> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS)) {
    const item = value[key];
    if (item !== undefined) {
      snapshot[snapshotString(key, state)] = snapshotJsonValue(item, state);
    }
  }
  if (keys.length > MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS) {
    snapshot["[truncated]"] = keys.length - MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS;
  }
  return snapshot;
}

function snapshotString(value: string, state: { remainingStringLength: number }): string {
  if (state.remainingStringLength <= 0) {
    return "[truncated]";
  }
  const limit = Math.min(
    value.length,
    MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH,
    state.remainingStringLength,
  );
  if (limit >= value.length) {
    state.remainingStringLength -= limit;
    return value;
  }
  const prefix = truncateUtf16Safe(value, limit);
  // Charge the retained prefix; a safe boundary may back up one code unit.
  state.remainingStringLength -= prefix.length;
  return `${prefix}...[truncated]`;
}

export function normalizeNativeHookInvocation(params: {
  registration: NativeHookRelayRegistration;
  event: NativeHookRelayEvent;
  rawPayload: JsonValue;
}): NativeHookRelayInvocation {
  const metadata = getNativeHookRelayProviderAdapter(
    params.registration.provider,
  ).normalizeMetadata(params.rawPayload);
  return {
    provider: params.registration.provider,
    relayId: params.registration.relayId,
    event: params.event,
    ...metadata,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    runId: params.registration.runId,
    rawPayload: params.rawPayload,
    receivedAt: new Date().toISOString(),
  };
}

export function getNativeHookRelayProviderAdapter(
  provider: NativeHookRelayProvider,
): NativeHookRelayProviderAdapter {
  return nativeHookRelayProviderAdapters[provider];
}

function normalizeCodexHookMetadata(rawPayload: JsonValue): NativeHookRelayInvocationMetadata {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const metadata: NativeHookRelayInvocationMetadata = {};
  const nativeEventName = readOptionalString(payload.hook_event_name);
  if (nativeEventName) {
    metadata.nativeEventName = nativeEventName;
  }
  const cwd = readOptionalString(payload.cwd);
  if (cwd) {
    metadata.cwd = cwd;
  }
  const model = readOptionalString(payload.model);
  if (model) {
    metadata.model = model;
  }
  const turnId = readOptionalString(payload.turn_id);
  if (turnId) {
    metadata.turnId = turnId;
  }
  const transcriptPath = readOptionalString(payload.transcript_path);
  if (transcriptPath) {
    metadata.transcriptPath = transcriptPath;
  }
  const permissionMode = readOptionalString(payload.permission_mode);
  if (permissionMode) {
    metadata.permissionMode = permissionMode;
  }
  const stopHookActive = readOptionalBoolean(payload.stop_hook_active);
  if (stopHookActive !== undefined) {
    metadata.stopHookActive = stopHookActive;
  }
  const lastAssistantMessage = readOptionalString(payload.last_assistant_message);
  if (lastAssistantMessage) {
    metadata.lastAssistantMessage = lastAssistantMessage;
  }
  const toolName = readOptionalString(payload.tool_name);
  if (toolName) {
    metadata.toolName = toolName;
  }
  const toolUseId = readOptionalString(payload.tool_use_id);
  if (toolUseId) {
    metadata.toolUseId = toolUseId;
  }
  return metadata;
}

function readCodexToolInput(rawPayload: JsonValue): Record<string, JsonValue> {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const toolInput = payload.tool_input;
  if (isJsonObject(toolInput)) {
    const toolName = readOptionalString(payload.tool_name);
    return normalizeCodexToolInput(
      normalizeNativeHookToolName(toolName),
      toolInput as Record<string, JsonValue>,
    );
  }
  if (toolInput === undefined) {
    return {};
  }
  return { value: toolInput as JsonValue };
}

function normalizeCodexToolInput(
  toolName: string,
  toolInput: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const command = normalizeCodexCommand(toolInput.cmd);
  if (toolName !== "exec" || command === undefined) {
    return toolInput;
  }
  return {
    ...toolInput,
    command,
  };
}

function normalizeCodexCommand(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((part): part is string => typeof part === "string")) {
    return shellQuoteArgs(value);
  }
  return undefined;
}

export function nativeHookRelayParamsWereRewritten(
  originalFingerprint: string,
  candidate: unknown,
): boolean {
  if (candidate === undefined) {
    return false;
  }
  return stableStringify(candidate) !== originalFingerprint;
}

function readCodexToolResponse(rawPayload: JsonValue): unknown {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  return payload.tool_response;
}

export function readNativeHookRelayApprovalMode(rawPayload: JsonValue): "report" | undefined {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  return payload.openclaw_approval_mode === "report" ? "report" : undefined;
}

export function normalizeNativeHookToolName(toolName: string | undefined): string {
  const normalized = normalizeToolName(toolName ?? "tool");
  return NATIVE_HOOK_TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function nativeHookRelayProviderDisplayName(provider: NativeHookRelayProvider): string {
  if (provider === "codex") {
    return "Codex";
  }
  return provider;
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, maxLength - 3))}...`;
}

export function resolveOpenClawCliExecutable(): string {
  const envPath = process.env.OPENCLAW_CLI_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (packageRoot) {
    for (const candidate of [
      path.join(packageRoot, "openclaw.mjs"),
      path.join(packageRoot, "dist", "entry.js"),
      path.join(packageRoot, "scripts", "run-node.mjs"),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  const argvEntry = process.argv[1];
  if (argvEntry) {
    const resolved = path.resolve(argvEntry);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  throw new Error("Cannot resolve OpenClaw CLI executable path for native hook relay");
}

export function normalizeAllowedEvents(
  events: readonly NativeHookRelayEvent[] | undefined,
): readonly NativeHookRelayEvent[] {
  if (!events?.length) {
    return NATIVE_HOOK_RELAY_EVENTS;
  }
  return [...new Set(events)];
}

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function normalizeOptionalPositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function shellQuoteArgs(args: readonly string[]): string {
  return args.map((arg) => shellQuoteArg(arg, process.platform)).join(" ");
}

function shellQuoteArg(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  if (platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function readNativeHookRelayProvider(value: unknown): NativeHookRelayProvider {
  if (value === "codex") {
    return value;
  }
  throw new Error("unsupported native hook relay provider");
}

export function readNativeHookRelayEvent(value: unknown): NativeHookRelayEvent {
  if (
    value === "pre_tool_use" ||
    value === "post_tool_use" ||
    value === "permission_request" ||
    value === "before_agent_finalize"
  ) {
    return value;
  }
  throw new Error("unsupported native hook relay event");
}

export function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`native hook relay ${name} is required`);
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let totalStringLength = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
      return false;
    }
    if (current.depth > MAX_NATIVE_HOOK_RELAY_JSON_DEPTH) {
      return false;
    }
    if (current.value === null) {
      continue;
    }
    if (typeof current.value === "string") {
      if (current.value.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) {
        return false;
      }
      totalStringLength += current.value.length;
      if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "boolean") {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const valueLocal of current.value) {
        if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
          return false;
        }
        stack.push({ value: valueLocal, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isJsonObject(current.value)) {
      return false;
    }
    try {
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) {
          continue;
        }
        if (key.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) {
          return false;
        }
        totalStringLength += key.length;
        if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) {
          return false;
        }
        if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
          return false;
        }
        stack.push({ value: current.value[key], depth: current.depth + 1 });
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
