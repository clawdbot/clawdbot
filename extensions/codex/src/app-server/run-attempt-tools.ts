import type {
  EmbeddedRunAttemptParams,
  NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import type {
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
  JsonValue,
} from "./protocol.js";
import { sanitizeCodexToolResponse } from "./tool-progress-normalization.js";

export function toTranscriptToolResult(
  response: CodexDynamicToolCallResponse,
): Record<string, unknown> {
  const sanitized = sanitizeCodexToolResponse(response);
  const contentItems = Array.isArray(sanitized.contentItems) ? sanitized.contentItems : [];
  const result: Record<string, unknown> = {
    ...sanitized,
    // Progress events are UI/transcript-facing; map only sanitized content so
    // event redaction cannot be bypassed by raw dynamic tool output.
    content: contentItems.map(toTranscriptToolResultContentItem),
  };
  delete result.contentItems;
  delete result.success;
  return result;
}

function toTranscriptToolResultContentItem(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") {
    return { type: "text", text: "" };
  }
  const record = item as Record<string, unknown>;
  if (record.type === "inputText") {
    return { type: "text", text: typeof record.text === "string" ? record.text : "" };
  }
  if (record.type === "inputImage") {
    return typeof record.imageUrl === "string"
      ? { type: "image", url: record.imageUrl }
      : { type: "text", text: formatUnsupportedCodexDynamicToolOutput(record.type) };
  }
  return { type: "text", text: formatUnsupportedCodexDynamicToolOutput(record.type) };
}

function formatUnsupportedCodexDynamicToolOutput(type: unknown): string {
  const rawType = typeof type === "string" ? type.replace(/\s+/g, " ").trim() : "";
  const label = rawType ? truncateUtf16Safe(rawType, 80) : "unknown";
  const suffix = rawType.length > 80 ? "..." : "";
  return `[Unsupported Codex dynamic tool output: ${label}${suffix}]`;
}

type CodexDynamicToolExecutionIdentity = Pick<
  CodexDynamicToolCallParams,
  "threadId" | "turnId" | "callId"
>;

export function createCodexDynamicToolExecutionRegistry() {
  const executions = new Map<string, Promise<CodexDynamicToolCallResponse>>();
  const keyFor = (call: CodexDynamicToolExecutionIdentity) =>
    JSON.stringify([call.threadId, call.turnId, call.callId]);

  return {
    get(call: CodexDynamicToolExecutionIdentity) {
      return executions.get(keyFor(call));
    },
    claim(
      call: CodexDynamicToolExecutionIdentity,
      start: () => Promise<CodexDynamicToolCallResponse>,
    ) {
      const existing = executions.get(keyFor(call));
      if (existing) {
        return { execution: existing, replayed: true } as const;
      }
      const execution = start();
      executions.set(keyFor(call), execution);
      return { execution, replayed: false } as const;
    },
  };
}

export function handleApprovalRequest(params: {
  method: string;
  params: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  nativeHookRelay?: NativeHookRelayRegistrationHandle;
  autoApprove?: boolean;
  signal?: AbortSignal;
  onNativeToolFailureDisposition?: Parameters<
    typeof handleCodexAppServerApprovalRequest
  >[0]["onNativeToolFailureDisposition"];
}): Promise<JsonValue | undefined> {
  return handleCodexAppServerApprovalRequest({
    method: params.method,
    requestParams: params.params,
    paramsForRun: params.paramsForRun,
    threadId: params.threadId,
    turnId: params.turnId,
    nativeHookRelay: params.nativeHookRelay,
    autoApprove: params.autoApprove,
    signal: params.signal,
    onNativeToolFailureDisposition: params.onNativeToolFailureDisposition,
  });
}

export function resolveCodexDynamicToolDirectNames(
  params: EmbeddedRunAttemptParams,
  hostSystemAgentActive = false,
): string[] {
  // Tools with catalogMode=direct-only use the model-only namespace. This list
  // remains for control tools that intentionally live at the dynamic-tool root.
  const names: string[] = [];
  // OpenClaw is the run's only tool and must stay callable when Codex tool
  // search is unavailable. Exact toolsAllow is the public harness contract.
  if (hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow)) {
    names.push("openclaw");
  }
  if (params.sourceReplyDeliveryMode === "message_tool_only") {
    names.push("message");
  }
  return names;
}
