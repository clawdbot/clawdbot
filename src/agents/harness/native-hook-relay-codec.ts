import { stableStringify } from "../stable-stringify.js";
import { normalizeToolName } from "../tool-policy.js";
import { codexNativeHookRelayResponseCodec } from "./native-hook-relay-response-codec.js";
import type {
  JsonValue,
  NativeHookRelayInvocation,
  NativeHookRelayInvocationMetadata,
  NativeHookRelayProvider,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import {
  isJsonObject,
  readOptionalBoolean,
  readOptionalString,
  shellQuoteArgs,
} from "./native-hook-relay-utils.js";

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
    ...codexNativeHookRelayResponseCodec,
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
  },
};

export function getNativeHookRelayProviderAdapter(
  provider: NativeHookRelayProvider,
): NativeHookRelayProviderAdapter {
  return nativeHookRelayProviderAdapters[provider];
}

export function normalizeNativeHookInvocation(params: {
  registration: NativeHookRelayRegistration;
  event: NativeHookRelayInvocation["event"];
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
