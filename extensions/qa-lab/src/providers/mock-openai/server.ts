// QA Lab mock Responses dispatcher, HTTP transport, and debug endpoints.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { closeQaHttpServer } from "../../bus-server.js";
import { parseQaDebugRequestCursor } from "../shared/debug-request-cursor.js";
import { writeJson } from "../shared/http-json.js";
import {
  listMockCodexModelInfos,
  listMockOpenAiServerModelIds,
} from "../shared/mock-model-config.js";
import {
  buildMessagesPayload,
  normalizeAnthropicMessagesRequest,
} from "./mock-anthropic-messages.js";
import { adaptAnthropicToolCallIds } from "./mock-anthropic-wire.js";
import {
  buildAssistantText,
  isCanonicalCompactionRetryWriteResult,
  QA_COMPACTION_RETRY_FINAL_MARKER,
} from "./mock-openai-assistant-text.js";
import {
  type ResponsesInputItem,
  type StreamEvent,
  resolveProviderVariant,
  type MockOpenAiRequestSnapshot,
  type MockOpenAiRequestSnapshotInput,
  type MockOpenAiRequestKind,
  type MockCompactionSummaryFaultMode,
  type AnthropicMessagesRequest,
  type QaMockProviderDispatchRequest,
  type QaMockProviderDispatchResult,
  TINY_PNG_BASE64,
  QA_REASONING_ONLY_RECOVERY_PROMPT_RE,
  QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE,
  QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT_RE,
  QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE,
  QA_THINKING_VISIBILITY_OFF_PROMPT_RE,
  QA_THINKING_VISIBILITY_MAX_PROMPT_RE,
  QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE,
  QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE,
  QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT_RE,
  QA_REPEATED_REQUEST_RECOVERY_PROMPT_RE,
  QA_REPEATED_REQUEST_QUEUED_REPLY_PROMPT_RE,
  QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER,
  QA_STREAMING_PROMPT_RE,
  QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE,
  QA_BLOCK_STREAMING_PROMPT_RE,
  QA_TOOL_PROGRESS_ERROR_PROMPT_RE,
  QA_TOOL_PROGRESS_PROMPT_RE,
  QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE,
  QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE,
  QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE,
  QA_MSTEAMS_THREAD_DEDUPE_PROMPT_RE,
  QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE,
  QA_GROUP_MESSAGE_UNAVAILABLE_FALLBACK_PROMPT_RE,
  QA_STRANDED_FINAL_RECOVERY_PROMPT_RE,
  QA_STRANDED_FINAL_RETRY_PROMPT_RE,
  QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE,
  QA_TELEGRAM_STREAM_SINGLE_MARKER,
  QA_TELEGRAM_LONG_FINAL_THREE_CHUNK_PROMPT_RE,
  QA_TELEGRAM_LONG_FINAL_PROMPT_RE,
  QA_WHATSAPP_LONG_FINAL_PROMPT_RE,
  QA_SLACK_CHART_PRESENTATION_PROMPT_RE,
  QA_SLACK_MPIM_HISTORY_RECALL_PROMPT_RE,
  QA_SLACK_MPIM_HISTORY_SEED_PROMPT_RE,
  buildSlackMpimHistoryBotReply,
  QA_WHATSAPP_AGENT_MESSAGE_ACTION_REACT_PROMPT_RE,
  QA_WHATSAPP_AGENT_MESSAGE_ACTION_UPLOAD_PROMPT_RE,
  QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE,
  QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE,
  QA_SUBAGENT_SELF_YIELD_FOLLOW_UP_RE,
  QA_SUBAGENT_SELF_YIELD_WORKER_RE,
  QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE,
  QA_SUBAGENT_TERMINAL_MATRIX_WORKER_RE,
  buildStrandedFinalRecoveryText,
  buildStrandedFinalRetryFailureText,
  isStrandedFinalRetryFailureRequest,
  QA_SUBAGENT_DIRECT_FALLBACK_MARKER,
  QA_SUBAGENT_SELF_YIELD_MARKER,
  QA_SUBAGENT_TERMINAL_MARKERS,
  QA_SUBAGENT_TERMINAL_METADATA_SENTINEL,
  QA_NATIVE_STOP_DELAY_PROMPT_RE,
  QA_NATIVE_STOP_DELAY_MS,
  QA_IMAGE_GENERATION_PROMPT_RE,
  QA_REASONING_ONLY_RETRY_NEEDLE,
  QA_EMPTY_RESPONSE_RETRY_NEEDLE,
  QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE,
  QA_SKILL_WORKSHOP_GIF_PROMPT_RE,
  QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE,
  QA_RELEASE_AUDIT_PROMPT_RE,
  QA_TOOL_SEARCH_PROMPT_RE,
  QA_TOOL_SEARCH_FAILURE_PROMPT_RE,
  QA_MCP_CODE_MODE_PROMPT_RE,
  QA_RESTART_CODE_MODE_WAIT_PROMPT_RE,
  QA_RESTART_RECOVERY_PROMPT_RE,
  QA_MCP_CODE_MODE_API_FILE_PROMPT_RE,
  type MockScenarioState,
  sourceDiscoveryReadPathForProvider,
  subagentHandoffTaskForProvider,
  subagentFanoutTaskForProvider,
  MOCK_OPENAI_DEBUG_REQUEST_LIMIT,
  readBody,
  parseJsonObjectBody,
  writeOpenAiMalformedJsonError,
  transcriptionTextForAudioRequest,
  writeSse,
  isRemoteCompactionV2Request,
  buildRemoteCompactionV2Events,
  writeSseWithPreviewPause,
  writeAnthropicSse,
  countApproxTokens,
  extractEmbeddingInputTexts,
  buildDeterministicEmbedding,
} from "./mock-openai-contracts.js";
import {
  extractExactReplyDirective,
  extractExactMarkerDirective,
  extractWhatsAppLocationMarkerDirective,
  extractWhatsAppContactMarkerDirective,
  extractWhatsAppStickerMarkerDirective,
  shouldUseWhatsAppLocationMarker,
  shouldUseWhatsAppContactMarker,
  shouldUseWhatsAppStickerMarker,
  extractBlockStreamingMarkerDirectives,
  extractSlackProgressCommentaryDirectives,
  QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE,
  hasDeclaredTool,
  hasToolDefinition,
  isQaToolSearchFixture,
  buildExplicitSessionsSpawnArgs,
  buildQaA2aMessageToolMirrorSessionsSendArgs,
  hasToolErrorOutput,
  extractSessionStatusSessionKey,
  isHeartbeatPrompt,
} from "./mock-openai-directives.js";
import {
  buildToolCallEvents,
  buildReleaseAuditJson,
  buildReleaseHandoffMarkdown,
  extractPlannedToolName,
  extractPlannedToolIdentity,
  extractPlannedToolArgs,
  splitMockStreamingText,
  buildQaLongFinalText,
  buildAssistantThenToolCallEvents,
  buildAssistantEvents,
  buildReasoningOnlyEvents,
  buildReasoningAndAssistantEvents,
  buildFailedResponseEvents,
} from "./mock-openai-events.js";
import {
  extractLastUserText,
  extractLastMatchingUserTurn,
  hasToolOutput,
  extractToolOutput,
  extractToolOutputValue,
  extractToolOutputStructuredError,
  extractToolOutputCallId,
  extractLatestToolOutput,
  extractAllToolOutputText,
  extractUserTextAfterLatestToolOutput,
  extractSlackMpimRetainedBotNonce,
  extractAllUserTexts,
  extractInstructionsText,
  extractAllRequestTexts,
  buildWhatsAppPendingHistoryReply,
  buildWhatsAppBroadcastReply,
  buildWhatsAppGroupDispatchReply,
  buildWhatsAppBatchedReply,
  countImageInputs,
  extractCurrentImageRequest,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import { attachQaMockResponsesWebSocketServer } from "./mock-openai-responses-websocket.js";
import {
  readTargetFromPrompt,
  execCommandFromToolProgressPrompt,
  buildCustomToolCallEventsWithInput,
  buildToolCallEventsWithArgs as buildRawToolCallEventsWithArgs,
  extractOrbitCode,
  extractToolSearchTarget,
  toolSearchOutputHasCandidate,
  buildQaToolSearchArgs,
  QA_TOOL_SEARCH_SECONDARY_TARGET,
  isActiveMemorySubagentPrompt,
  isSnackRecallPrompt,
  extractSnackPreference,
} from "./mock-openai-tooling.js";

const QA_COMPACTION_RETRY_PROMPT_RE = /compaction retry mutating tool check/i;
const QA_COMPACTION_SUMMARY_INSTRUCTIONS_RE =
  /context summarization assistant[\s\S]*structured summary[\s\S]*do not continue/i;
const QA_COMPACTION_RETRY_OVERFLOW_THRESHOLD_BYTES = 256 * 1024;
const QA_COMPACTION_OUTPUT_RECOVERY_OVERFLOW_THRESHOLD_BYTES = 96 * 1024;
const QA_COMPACTION_RETRY_DURABLE_MARKER = "QA-COMPACTION-DURABLE-MARKER";
const QA_COMPACTION_RETRY_BULKY_MARKER = "QA-COMPACTION-BULKY-HISTORICAL-MARKER";
const QA_COMPACTION_RETRY_HISTORICAL_PHRASE = "post-marker historical user block";
const QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-EMPTY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
const QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
const QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY";
const QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-REASONING-RECOVERED-SUMMARY";
const QA_COMPACTION_RETRY_SUMMARY = `## Decisions
- Continue the compaction retry from durable context without replaying a completed mutation.

## Open TODOs
- Write compaction-retry-summary.txt exactly once.
- Return the final replay-safety marker.

## Constraints/Rules
- Preserve ${QA_COMPACTION_RETRY_DURABLE_MARKER}.
- Write exactly: Replay safety: unsafe after write.

## Pending user asks
- Create compaction-retry-summary.txt, then reply exactly: Protocol note: replay unsafe after write.

## Exact identifiers
- ${QA_COMPACTION_RETRY_DURABLE_MARKER}
- compaction-retry-summary.txt`;
const QA_COMPACTION_RETRY_HISTORICAL_SUMMARY = `## Decisions
- Preserve the latest ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} context through staged compaction.

## Open TODOs
- Continue summarizing the ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} sequence.

## Constraints/Rules
- Keep historical content distinct from live task state.
- Do not invent durable context absent from the summarized history.

## Pending user asks
- Retain the ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} details.

## Exact identifiers
- None captured.`;
const QA_GENERIC_COMPACTION_SUMMARY = `## Decisions
- Continue from the summary without restarting completed work.

## Open TODOs
- Continue the active task.

## Constraints/Rules
- Keep current requirements and identifiers.

## Pending user asks
- Continue the active task from the retained context.

## Exact identifiers
- None captured.`;
const QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY = `## Decisions
- Retry the typed compaction-summary fault at the compaction owner.

## Open TODOs
- Continue the active task after compaction.

## Constraints/Rules
- Preserve the historical recovery user block and current continuation.

## Pending user asks
- Retain the historical recovery user block context.

## Exact identifiers`;

function resolveCompactionRecoverySummary(allInputText: string) {
  const faultMarker =
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0] ??
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0];
  const recoveryMarker = faultMarker?.startsWith("QA-COMPACTION-EMPTY-")
    ? QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER
    : faultMarker
      ? QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER
      : undefined;
  return recoveryMarker && faultMarker
    ? `${QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY}\n- ${recoveryMarker}\n- ${faultMarker}`
    : QA_GENERIC_COMPACTION_SUMMARY;
}

function hasCompactionOutputRecoveryMarker(allInputText: string) {
  return (
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.test(allInputText) ||
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.test(allInputText)
  );
}

const QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE =
  /(?:partial|quiet) streaming qa check|final-only marker streaming qa check|block streaming qa check|tool progress(?: error)? qa check/i;
const QA_STREAMING_TOOL_PROGRESS_CONTINUATION_RE =
  /^Continue with (?:the current Matrix QA scenario|the QA scenario plan and report worked, failed, and blocked items)\.$/i;
const QA_CODE_MODE_TARGET_MARKER = "qa-code-mode-target:";
const QA_FAILED_TOOL_TERMINAL_RECOVERY_PROMPT_RE = /failed tool terminal recovery qa check/i;
// Keep each real provider request active long enough for retries to span the
// unchanged five-minute recovery bound while remaining below first-byte timeout.
const QA_REPEATED_REQUEST_RESPONSE_PAUSE_MS = 110_000;

function isStreamingToolProgressContinuationText(text: string) {
  const trimmed = text.trim();
  return (
    QA_STREAMING_TOOL_PROGRESS_CONTINUATION_RE.test(trimmed) ||
    trimmed.startsWith(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE)
  );
}

function extractLatestScenarioFamilyPrompt(texts: string[]) {
  let envelope = "";
  for (const text of texts.toReversed()) {
    if (QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE.test(text)) {
      envelope = text;
      break;
    }
    if (!isStreamingToolProgressContinuationText(text)) {
      return "";
    }
  }
  if (!envelope) {
    return "";
  }
  const pattern = new RegExp(
    QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE.source,
    `${QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE.flags}g`,
  );
  let latestIndex = -1;
  for (const match of envelope.matchAll(pattern)) {
    latestIndex = match.index;
  }
  return latestIndex < 0 ? "" : envelope.slice(latestIndex);
}

function stringifyScenarioToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function encodeCodeModeTarget(name: string, args: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ name, args }), "utf8").toString("base64url");
}

function decodeCodeModeTarget(code: string | undefined) {
  const marker = code
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`// ${QA_CODE_MODE_TARGET_MARKER}`));
  if (!marker) {
    return null;
  }
  try {
    const encoded = marker.slice(`// ${QA_CODE_MODE_TARGET_MARKER}`.length).trim();
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      !record.args ||
      typeof record.args !== "object" ||
      Array.isArray(record.args)
    ) {
      return null;
    }
    return {
      name: record.name,
      args: record.args as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function findNamedToolDefinition(
  value: unknown,
  name: string,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 6 || !value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findNamedToolDefinition(item, name, depth + 1);
      if (match) {
        return match;
      }
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.name === name || record.tool === name || record.functionName === name) {
    return record;
  }
  for (const item of Object.values(record)) {
    const match = findNamedToolDefinition(item, name, depth + 1);
    if (match) {
      return match;
    }
  }
  return null;
}

type CodeModeExecSurface = "native" | "guest";

function resolveCodeModeExecSurface(body: Record<string, unknown>): CodeModeExecSurface | null {
  const tools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
  ];
  const execDefinition = findNamedToolDefinition(tools, "exec");
  if (!execDefinition || !hasToolDefinition(body, "wait")) {
    return null;
  }
  if (execDefinition.type === "custom") {
    return "native";
  }
  const schema =
    (execDefinition.input_schema as Record<string, unknown> | undefined) ??
    (execDefinition.parameters as Record<string, unknown> | undefined);
  if (!schema) {
    return null;
  }
  const properties = schema.properties;
  const required = schema.required;
  return properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, "code") &&
    Array.isArray(required) &&
    required.includes("code")
    ? "guest"
    : null;
}

function hasCodeModeExecSurface(body: Record<string, unknown>) {
  return resolveCodeModeExecSurface(body) !== null;
}

function resolveCurrentToolDeclarationSurface(
  body: Record<string, unknown>,
  input: ResponsesInputItem[],
) {
  const additionalTools = input.flatMap((item) =>
    item.type === "additional_tools" && item.role === "developer" && Array.isArray(item.tools)
      ? item.tools
      : [],
  );
  return additionalTools.length === 0
    ? body
    : {
        ...body,
        tools: [...(Array.isArray(body.tools) ? body.tools : []), ...additionalTools],
      };
}

function findToolCallByCallId(input: ResponsesInputItem[], callId: string) {
  return input.toReversed().find((item) => {
    const type = item.type;
    return (type === "function_call" || type === "custom_tool_call") && item.call_id === callId;
  });
}

function parseToolCallArguments(toolCall: ResponsesInputItem) {
  if (typeof toolCall.arguments !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readGeneratedCodeModeExecSource(toolCall: ResponsesInputItem | undefined) {
  if (toolCall?.type === "custom_tool_call" && typeof toolCall.input === "string") {
    return toolCall.input;
  }
  const code = toolCall ? parseToolCallArguments(toolCall)?.code : undefined;
  return typeof code === "string" ? code : undefined;
}

function isGeneratedCodeModeExecCall(toolCall: ResponsesInputItem | undefined) {
  const source = toolCall?.name === "exec" ? readGeneratedCodeModeExecSource(toolCall) : undefined;
  return typeof source === "string" && decodeCodeModeTarget(source) !== null;
}

function parseNativeCodeModeOutput(
  output: unknown,
): { status: "waiting"; cellId: string } | { status: "completed"; value: unknown } | null {
  if (!Array.isArray(output)) {
    return null;
  }
  const readText = (item: unknown) =>
    typeof item === "string"
      ? item
      : item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).text === "string"
        ? String((item as Record<string, unknown>).text)
        : null;
  const statusText = readText(output[0]);
  if (!statusText) {
    return null;
  }
  const cellId = /^Script running with cell ID ([^\s\n]+)/u.exec(statusText)?.[1];
  if (cellId) {
    return { status: "waiting", cellId };
  }
  if (!statusText.startsWith("Script completed\n")) {
    return null;
  }
  for (const item of output.slice(1).toReversed()) {
    const text = readText(item);
    if (!text) {
      continue;
    }
    try {
      return { status: "completed", value: JSON.parse(text) as unknown };
    } catch {
      // Native Code Mode may emit non-JSON content before the final value.
    }
  }
  return null;
}

function isGeneratedCodeModeWaitCall(input: ResponsesInputItem[], toolCall: ResponsesInputItem) {
  if (toolCall.name !== "wait") {
    return false;
  }
  const args = parseToolCallArguments(toolCall);
  const waitId =
    typeof args?.cell_id === "string"
      ? args.cell_id
      : typeof args?.runId === "string"
        ? args.runId
        : undefined;
  if (!waitId) {
    return false;
  }
  return input.some((item) => {
    if (
      (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") ||
      typeof item.call_id !== "string"
    ) {
      return false;
    }
    const native = parseNativeCodeModeOutput(item.output);
    const parsed = native ?? parseToolOutputJson(stringifyScenarioToolOutput(item.output));
    return (
      parsed?.status === "waiting" &&
      (("cellId" in parsed && parsed.cellId === waitId) ||
        ("runId" in parsed && parsed.runId === waitId)) &&
      isGeneratedCodeModeExecCall(findToolCallByCallId(input, item.call_id))
    );
  });
}

function isCodeModeControlToolOutput(body: Record<string, unknown>, input: ResponsesInputItem[]) {
  if (!hasCodeModeExecSurface(body)) {
    return false;
  }
  const toolOutputCallId = extractToolOutputCallId(input);
  if (!toolOutputCallId) {
    return false;
  }
  const toolCall = findToolCallByCallId(input, toolOutputCallId);
  return (
    isGeneratedCodeModeExecCall(toolCall) ||
    (toolCall ? isGeneratedCodeModeWaitCall(input, toolCall) : false)
  );
}

function buildScenarioToolCallEvents(
  body: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
) {
  // Code Mode hides catalog capabilities behind exec/wait. Route through that
  // visible surface while retaining the nested capability as debug evidence.
  if (
    name === "exec" ||
    name === "wait" ||
    hasToolDefinition(body, name) ||
    !hasCodeModeExecSurface(body)
  ) {
    const declaration = [
      ...(Array.isArray(body.tools) ? body.tools : []),
      ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
    ].find((tool) => findNamedToolDefinition(tool, name));
    const definition = findNamedToolDefinition(declaration, name);
    // Function and custom calls both retain their declared namespace; Codex
    // dispatches the complete identity and rejects a flattened nested tool.
    const namespace =
      declaration &&
      typeof declaration === "object" &&
      declaration.type === "namespace" &&
      typeof declaration.name === "string"
        ? declaration.name
        : undefined;
    if (definition?.type === "custom" && typeof args.input === "string") {
      return buildCustomToolCallEventsWithInput(name, args.input, namespace);
    }
    return buildRawToolCallEventsWithArgs(name, args, namespace);
  }
  const encodedTarget = encodeCodeModeTarget(name, args);
  if (resolveCodeModeExecSurface(body) === "native") {
    return buildCustomToolCallEventsWithInput(
      "exec",
      [
        `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
        `const targetName = ${JSON.stringify(name)};`,
        `const targetArgs = ${JSON.stringify(args)};`,
        "const target = ALL_TOOLS.find((entry) => entry.name === targetName);",
        "if (!target) throw new Error(`QA mock target tool unavailable: ${targetName}`);",
        "let value = await tools[target.name](targetArgs);",
        'if (targetName === "read" && value?.kind === "text" && typeof value.content === "string") {',
        "  value = { ...value, content: value.content.slice(0, 2048) };",
        "}",
        "text(JSON.stringify(value));",
      ].join("\n"),
    );
  }
  return buildRawToolCallEventsWithArgs("exec", {
    language: "javascript",
    code: [
      `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
      `const targetName = ${JSON.stringify(name)};`,
      `const targetArgs = ${JSON.stringify(args)};`,
      "const target = ALL_TOOLS.find((entry) => entry.name === targetName);",
      "if (!target) throw new Error(`QA mock target tool unavailable: ${targetName}`);",
      "const value = await tools.callValue(target.id, targetArgs);",
      'if (targetName === "read" && value?.kind === "text" && typeof value.content === "string") {',
      "  return { ...value, content: value.content.slice(0, 2048) };",
      "}",
      "return value;",
    ].join("\n"),
  });
}

function extractScenarioPlannedTool(events: StreamEvent[]) {
  const wireName = extractPlannedToolName(events);
  const wireArgs = extractPlannedToolArgs(events);
  const source =
    typeof wireArgs?.input === "string"
      ? wireArgs.input
      : typeof wireArgs?.code === "string"
        ? wireArgs.code
        : undefined;
  if (wireName !== "exec" || !source) {
    return { name: wireName, args: wireArgs, wireName };
  }
  const target = decodeCodeModeTarget(source);
  return target
    ? { name: target.name, args: target.args, wireName }
    : { name: wireName, args: wireArgs, wireName };
}

type TerminalRequesterSettleGate = {
  markSettled: (caseName: string, childSessionKey: string) => void;
  waitUntilSettled: (caseName: string, childSessionKey: string) => Promise<void>;
};

function createTerminalRequesterSettleGate(): TerminalRequesterSettleGate {
  const settledChildren = new Set<string>();
  const waiterPromises = new Map<string, Promise<void>>();
  const waiters = new Map<string, () => void>();
  const childKey = (caseName: string, childSessionKey: string) => `${caseName}\n${childSessionKey}`;
  return {
    markSettled(caseName, childSessionKey) {
      const key = childKey(caseName, childSessionKey);
      settledChildren.add(key);
      waiters.get(key)?.();
    },
    async waitUntilSettled(caseName, childSessionKey) {
      const key = childKey(caseName, childSessionKey);
      if (settledChildren.has(key)) {
        return;
      }
      const existing = waiterPromises.get(key);
      if (existing) {
        return await existing;
      }
      const promise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(key);
          waiterPromises.delete(key);
          reject(new Error(`terminal requester did not settle: ${caseName} (${childSessionKey})`));
        }, 30_000);
        const finish = () => {
          clearTimeout(timeout);
          waiters.delete(key);
          waiterPromises.delete(key);
          resolve();
        };
        waiters.set(key, finish);
      });
      waiterPromises.set(key, promise);
      await promise;
    },
  };
}

function resolveQaRuntimeSessionId(input: ResponsesInputItem[], body: Record<string, unknown>) {
  return /\bRuntime:\s*[^\n]*\bsessionId=([^\s|]+)/u.exec(extractAllRequestTexts(input, body))?.[1];
}

function normalizeResponsesInput(value: unknown): ResponsesInputItem[] {
  if (Array.isArray(value)) {
    return value as ResponsesInputItem[];
  }
  if (typeof value === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: value }] }];
  }
  return [];
}

function resolveQaChildSessionKey(input: ResponsesInputItem[], body: Record<string, unknown>) {
  const systemPrompt = extractAllRequestTexts(
    input.filter((item) => item.role === "developer" || item.role === "system"),
    body,
  );
  return /^- Your session:\s*(.+?)\.\s*$/mu.exec(systemPrompt)?.[1]?.trim();
}

function resolveAcceptedChildSessionKey(input: ResponsesInputItem[]) {
  const output = parseToolOutputJson(extractToolOutput(input));
  return output?.status === "accepted" && typeof output.childSessionKey === "string"
    ? output.childSessionKey.trim() || undefined
    : undefined;
}

function classifyMockOpenAiRequest(
  input: ResponsesInputItem[],
  body: Record<string, unknown>,
): MockOpenAiRequestKind {
  const instructionText = extractAllRequestTexts(
    input.filter((item) => item.role === "developer" || item.role === "system"),
    body,
  );
  if (QA_COMPACTION_SUMMARY_INSTRUCTIONS_RE.test(instructionText)) {
    return "compaction-summary";
  }
  return hasToolOutput(input) ? "tool-continuation" : "agent-initial";
}

function resolveCompactionSummaryFaultMode(params: {
  allInputText: string;
  requestKind: MockOpenAiRequestKind;
  servedFaultMarkers: Set<string>;
}): MockCompactionSummaryFaultMode {
  if (params.requestKind !== "compaction-summary") {
    return "none";
  }
  const emptyMarker = QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.exec(params.allInputText)?.[0];
  const reasoningMarker = QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.exec(
    params.allInputText,
  )?.[0];
  const selected = emptyMarker
    ? {
        key: emptyMarker,
        mode: "empty-output-once" as const,
      }
    : reasoningMarker
      ? {
          key: reasoningMarker,
          mode: "reasoning-only-output-once" as const,
        }
      : undefined;
  if (!selected?.key || params.servedFaultMarkers.has(selected.key)) {
    return "none";
  }
  params.servedFaultMarkers.add(selected.key);
  return selected.mode;
}

async function buildResponsesPayload(
  body: Record<string, unknown>,
  scenarioState: MockScenarioState,
  options: {
    waitForTerminalRequesterSettled?: (caseName: string, childSessionKey: string) => Promise<void>;
    requestKind?: MockOpenAiRequestKind;
    compactionSummaryFaultMode?: MockCompactionSummaryFaultMode;
  } = {},
) {
  const model = typeof body.model === "string" ? body.model : "";
  const providerVariant = resolveProviderVariant(model);
  const input = normalizeResponsesInput(body.input);
  const toolDeclarationBody = resolveCurrentToolDeclarationSurface(body, input);
  const prompt = extractLastUserText(input);
  const hasCompletedToolOutput = hasToolOutput(input);
  const rawToolOutput = extractToolOutput(input);
  const codeModeSurface = resolveCodeModeExecSurface(toolDeclarationBody);
  const hasCodeModeControlOutput = isCodeModeControlToolOutput(toolDeclarationBody, input);
  const codeModeControlJson = hasCodeModeControlOutput
    ? codeModeSurface === "native"
      ? parseNativeCodeModeOutput(extractToolOutputValue(input))
      : parseToolOutputJson(rawToolOutput)
    : null;
  const toolOutput =
    codeModeControlJson?.status === "completed" && Object.hasOwn(codeModeControlJson, "value")
      ? stringifyScenarioToolOutput(codeModeControlJson.value)
      : codeModeSurface === "native" && hasCodeModeControlOutput
        ? ""
        : rawToolOutput;
  const completedToolCall = findToolCallByCallId(input, extractToolOutputCallId(input));
  const completedToolName = (() => {
    if (completedToolCall?.name !== "exec") {
      return completedToolCall?.name;
    }
    const code = readGeneratedCodeModeExecSource(completedToolCall);
    return typeof code === "string" ? decodeCodeModeTarget(code)?.name : undefined;
  })();
  const buildToolCallEventsWithArgs = (name: string, args: Record<string, unknown>) =>
    buildScenarioToolCallEvents(toolDeclarationBody, name, args);
  const allInputText = extractAllRequestTexts(input, body);
  const hasCompactionRetryDurableContext = allInputText.includes(
    QA_COMPACTION_RETRY_DURABLE_MARKER,
  );
  const hasCompactionRetryMarker =
    QA_COMPACTION_RETRY_PROMPT_RE.test(allInputText) ||
    hasCompactionRetryDurableContext ||
    allInputText.includes(QA_COMPACTION_RETRY_BULKY_MARKER);
  const requestKind = options.requestKind ?? classifyMockOpenAiRequest(input, body);
  if (requestKind === "compaction-summary") {
    if (options.compactionSummaryFaultMode === "empty-output-once") {
      return buildAssistantEvents("");
    }
    if (options.compactionSummaryFaultMode === "reasoning-only-output-once") {
      return buildReasoningOnlyEvents(
        "Compaction summary reasoning completed without final summary text.",
        "reasoning_compaction_summary_fault",
      );
    }
    return buildAssistantEvents(
      hasCompactionRetryDurableContext
        ? QA_COMPACTION_RETRY_SUMMARY
        : allInputText.includes(QA_COMPACTION_RETRY_BULKY_MARKER) ||
            allInputText.includes(QA_COMPACTION_RETRY_HISTORICAL_PHRASE)
          ? QA_COMPACTION_RETRY_HISTORICAL_SUMMARY
          : resolveCompactionRecoverySummary(allInputText),
    );
  }
  if (
    QA_COMPACTION_RETRY_PROMPT_RE.test(allInputText) ||
    /compaction-retry-summary\.txt/i.test(toolOutput)
  ) {
    scenarioState.compactionRetryActive = true;
  }
  const compactionRetryScenarioActive =
    scenarioState.compactionRetryActive || hasCompactionRetryMarker;
  const scenarioToolOutput =
    toolOutput ||
    (/thread memory check|session memory ranking check|memory tools check|repo contract followthrough check/i.test(
      allInputText,
    )
      ? extractLatestToolOutput(input)
      : "");
  // The queued followup carries the stalled prompt in transcript history, so
  // current-turn dispatch must win before the persistent recovery fixture.
  if (QA_REPEATED_REQUEST_QUEUED_REPLY_PROMPT_RE.test(prompt)) {
    return buildAssistantEvents(QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER);
  }
  if (QA_REPEATED_REQUEST_RECOVERY_PROMPT_RE.test(allInputText)) {
    return buildFailedResponseEvents();
  }
  const toolJson = parseToolOutputJson(scenarioToolOutput);
  if (codeModeControlJson?.status === "waiting" && hasToolDefinition(toolDeclarationBody, "wait")) {
    if ("cellId" in codeModeControlJson && typeof codeModeControlJson.cellId === "string") {
      return buildRawToolCallEventsWithArgs("wait", { cell_id: codeModeControlJson.cellId });
    }
    if ("runId" in codeModeControlJson && typeof codeModeControlJson.runId === "string") {
      return buildRawToolCallEventsWithArgs("wait", { runId: codeModeControlJson.runId });
    }
  }
  if (compactionRetryScenarioActive) {
    if (isCanonicalCompactionRetryWriteResult(toolOutput)) {
      return buildAssistantEvents(QA_COMPACTION_RETRY_FINAL_MARKER);
    }
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "compaction-retry-summary.txt",
        content: "Replay safety: unsafe after write.\n",
      });
    }
    return buildAssistantEvents("");
  }
  const memoryToolUnavailable =
    toolJson?.unavailable === true ||
    toolJson?.disabled === true ||
    (typeof toolJson?.error === "string" && toolJson.error.trim().length > 0);
  const promptExactReplyDirective = extractExactReplyDirective(prompt);
  const promptExactMarkerDirective = extractExactMarkerDirective(prompt);
  const allUserTexts = extractAllUserTexts(input);
  const allUserText = allUserTexts.join("\n");
  const scenarioFamilyPrompt = extractLatestScenarioFamilyPrompt(allUserTexts) || prompt;
  const scenarioFamilyReplyDirective =
    extractExactReplyDirective(scenarioFamilyPrompt) ??
    extractExactMarkerDirective(scenarioFamilyPrompt) ??
    extractExactReplyDirective(scenarioToolOutput) ??
    extractExactMarkerDirective(scenarioToolOutput);
  const userExactReplyDirective =
    promptExactReplyDirective ?? extractExactReplyDirective(allUserText);
  const userExactMarkerDirective =
    promptExactMarkerDirective ?? extractExactMarkerDirective(allUserText);
  const exactReplyDirective = promptExactReplyDirective ?? extractExactReplyDirective(allInputText);
  const exactMarkerDirective =
    promptExactMarkerDirective ?? extractExactMarkerDirective(allInputText);
  const currentImageRequest = extractCurrentImageRequest(input, body);
  const whatsAppLocationMarker = shouldUseWhatsAppLocationMarker(prompt)
    ? extractWhatsAppLocationMarkerDirective(allInputText)
    : "";
  const whatsAppContactMarker = shouldUseWhatsAppContactMarker(prompt)
    ? extractWhatsAppContactMarkerDirective(allInputText)
    : "";
  const whatsAppStickerMarker = shouldUseWhatsAppStickerMarker(prompt)
    ? extractWhatsAppStickerMarkerDirective(allInputText)
    : "";
  const blockStreamingPrompt = scenarioFamilyPrompt || prompt || allInputText;
  const blockStreamingMarkers = extractBlockStreamingMarkerDirectives(blockStreamingPrompt);
  const isGroupChat = allInputText.includes('"is_group_chat": true');
  const isBaselineUnmentionedChannelChatter = /\bno bot ping here\b/i.test(prompt);
  const hasReasoningOnlyRetryInstruction = allInputText.includes(QA_REASONING_ONLY_RETRY_NEEDLE);
  const hasEmptyResponseRetryInstruction =
    allInputText.includes(QA_EMPTY_RESPONSE_RETRY_NEEDLE) ||
    allInputText.includes(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE);
  const isActiveEmptyResponseSideEffectRecovery =
    QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT_RE.test(prompt) ||
    (prompt.includes(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE) &&
      QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT_RE.test(allInputText));
  const isActiveFailedToolTerminalRecovery =
    QA_FAILED_TOOL_TERMINAL_RECOVERY_PROMPT_RE.test(prompt) ||
    (prompt.includes(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE) &&
      QA_FAILED_TOOL_TERMINAL_RECOVERY_PROMPT_RE.test(allInputText));
  const hasCallableCodeMode = hasCodeModeExecSurface(toolDeclarationBody);
  const canCallSessionsSpawn =
    hasToolDefinition(toolDeclarationBody, "sessions_spawn") || hasCallableCodeMode;
  const canCallSessionsYield =
    hasToolDefinition(toolDeclarationBody, "sessions_yield") || hasCallableCodeMode;
  const toolProgressTurn = extractLastMatchingUserTurn(input, /tool progress(?: error)? qa check/i);
  // Progress scenarios share full session transcripts. Scope completion to
  // the selected prompt so an older turn's tool output cannot finish this one.
  const toolProgressToolOutput = toolProgressTurn
    ? extractToolOutput(input.slice(toolProgressTurn.index))
    : "";
  const toolProgressToolJson = parseToolOutputJson(toolProgressToolOutput);
  const buildToolProgressReadEvents = () => {
    return buildToolCallEventsWithArgs("read", {
      path: readTargetFromPrompt(scenarioFamilyPrompt),
    });
  };
  const buildToolProgressExecEvents = () => {
    const command = execCommandFromToolProgressPrompt(scenarioFamilyPrompt);
    return command ? buildToolCallEventsWithArgs("exec", { command }) : null;
  };
  const slackProgressTurn = extractLastMatchingUserTurn(
    input,
    QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE,
  );
  const slackProgressDirectives = slackProgressTurn
    ? extractSlackProgressCommentaryDirectives(slackProgressTurn.text)
    : null;
  const hasSlackProgressToolOutput = slackProgressTurn
    ? hasToolOutput(input.slice(slackProgressTurn.index))
    : false;
  if (QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput) {
      scenarioState.toolLoopReadAttempts = 0;
    }
    if (/do not repeat this exact tool action/i.test(toolOutput)) {
      return buildAssistantEvents(exactReplyDirective ?? "GLOBAL-LOOP-BREAKER-OK");
    }
    scenarioState.toolLoopReadAttempts += 1;
    if (scenarioState.toolLoopReadAttempts > 21) {
      return buildAssistantEvents("GLOBAL-LOOP-BREAKER-NOT-REACHED");
    }
    return buildToolCallEventsWithArgs("read", { path: "LOOP_STEADY.txt" });
  }
  if (
    QA_TOOL_SEARCH_PROMPT_RE.test(allInputText) ||
    QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText)
  ) {
    const targetTool = extractToolSearchTarget(allInputText);
    const plannedArgs = targetTool
      ? buildQaToolSearchArgs(targetTool, QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText))
      : {};
    if (
      targetTool &&
      hasCompletedToolOutput &&
      completedToolName === "tool_search" &&
      !toolOutput.includes("FAKE_PLUGIN_OK") &&
      toolSearchOutputHasCandidate(parseToolOutputJson(toolOutput), targetTool) &&
      hasDeclaredTool(body, "tool_call")
    ) {
      return buildToolCallEventsWithArgs("tool_call", { id: targetTool, args: plannedArgs });
    }
    if (
      !hasCompletedToolOutput &&
      targetTool &&
      findNamedToolDefinition(toolDeclarationBody, targetTool)?.type === "custom" &&
      typeof plannedArgs.input === "string"
    ) {
      return buildToolCallEventsWithArgs(targetTool, plannedArgs);
    }
    if (!hasCompletedToolOutput && targetTool && hasDeclaredTool(body, "tool_search_code")) {
      return buildToolCallEventsWithArgs("tool_search_code", {
        code: [
          `const hits = await openclaw.tools.search(${JSON.stringify(targetTool)}, { limit: 1 });`,
          "const match = hits.find((tool) => tool.name === " + JSON.stringify(targetTool) + ");",
          "if (!match) throw new Error('target tool not found');",
          `return await openclaw.tools.call(match.id, ${JSON.stringify(plannedArgs)});`,
        ].join("\n"),
      });
    }
    if (
      !hasCompletedToolOutput &&
      targetTool &&
      !hasDeclaredTool(body, targetTool) &&
      hasDeclaredTool(body, "tool_search")
    ) {
      return buildToolCallEventsWithArgs("tool_search", {
        queries: [
          { query: targetTool, limit: 1 },
          { query: QA_TOOL_SEARCH_SECONDARY_TARGET, limit: 1 },
        ],
      });
    }
    if (
      !hasCompletedToolOutput &&
      targetTool &&
      (hasDeclaredTool(body, targetTool) || isQaToolSearchFixture(allInputText))
    ) {
      return buildToolCallEventsWithArgs(targetTool, plannedArgs);
    }
  }
  if (QA_RESTART_CODE_MODE_WAIT_PROMPT_RE.test(allInputText)) {
    if (QA_RESTART_RECOVERY_PROMPT_RE.test(allInputText)) {
      if (toolOutput.includes("unsafe-probe-executed")) {
        return buildAssistantEvents("RESTART-CODE-MODE-WAIT-FAIL");
      }
      if (hasToolDefinition(body, "qa_restart_unsafe_probe")) {
        return buildToolCallEventsWithArgs("qa_restart_unsafe_probe", {});
      }
      return buildAssistantEvents(exactReplyDirective ?? "RESTART-CODE-MODE-WAIT-OK");
    }
    if (toolJson?.status === "completed" && toolJson.value === "RESTART-CODE-MODE-WAIT-OK") {
      return buildAssistantEvents(exactReplyDirective ?? "RESTART-CODE-MODE-WAIT-OK");
    }
    if (
      toolJson?.status === "waiting" &&
      typeof toolJson.runId === "string" &&
      hasDeclaredTool(body, "wait")
    ) {
      return buildToolCallEventsWithArgs("wait", { runId: toolJson.runId });
    }
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "exec")) {
      return buildToolCallEventsWithArgs("exec", {
        language: "javascript",
        restartSafe: true,
        code: [
          'const matches = await tools.search("qa_restart_wait");',
          "await tools.call(matches[0].id, {});",
          'return "RESTART-CODE-MODE-WAIT-OK";',
        ].join("\n"),
      });
    }
    return buildAssistantEvents("RESTART-CODE-MODE-WAIT-FAIL");
  }
  if (
    QA_MCP_CODE_MODE_API_FILE_PROMPT_RE.test(allInputText) ||
    QA_MCP_CODE_MODE_PROMPT_RE.test(allInputText)
  ) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "exec")) {
      const useApiFiles = QA_MCP_CODE_MODE_API_FILE_PROMPT_RE.test(allInputText);
      return buildToolCallEventsWithArgs("exec", {
        language: "javascript",
        code: useApiFiles
          ? [
              'const files = await API.list("mcp");',
              'const root = await API.read("mcp/index.d.ts");',
              'const api = await API.read("mcp/fixture.d.ts");',
              'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
              "return {",
              '  marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",',
              "  files: files.files.map((file) => file.path),",
              "  rootHasFixture: root.content.includes('fixture'),",
              "  headerHasLookup: api.content.includes('function lookupNote'),",
              "  resultText: result.content?.[0]?.text,",
              "  allHasMcp: ALL_TOOLS.some((tool) => tool.source === 'mcp'),",
              "};",
            ].join("\n")
          : [
              "const rootApi = await MCP.$api();",
              'const api = await MCP.fixture.$api("lookupNote", { schema: true });',
              'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
              "return {",
              '  marker: "MCP_CODE_MODE_TOOL_RESULT",',
              "  rootServers: rootApi.servers,",
              "  headerHasLookup: api.header.includes('function lookupNote'),",
              "  schemaKeys: Object.keys(api.schemas),",
              "  resultText: result.content?.[0]?.text,",
              "  allHasMcp: ALL_TOOLS.some((tool) => tool.source === 'mcp'),",
              "};",
            ].join("\n"),
      });
    }
    if (
      toolJson?.status === "waiting" &&
      typeof toolJson.runId === "string" &&
      hasDeclaredTool(body, "wait")
    ) {
      return buildToolCallEventsWithArgs("wait", { runId: toolJson.runId });
    }
    if (
      toolOutput.includes("MCP_CODE_MODE_FILE_TOOL_RESULT") &&
      toolOutput.includes("fixture-note-alpha")
    ) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none improvement=virtual-api-files-were-clear-and-needed-one-exec",
      );
    }
    if (toolOutput.includes("MCP_CODE_MODE_FILE_TOOL_RESULT")) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_FILE_FAIL unclear=code-mode-exec-did-not-return-fixture-note",
      );
    }
    if (/MCP_CODE_MODE_TOOL_RESULT|fixture-note-alpha/.test(toolOutput)) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_OK unclear=none improvement=virtual-header-files-would-avoid-the-first-api-call",
      );
    }
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE.test(prompt)) {
    return buildAssistantEvents(QA_SUBAGENT_DIRECT_FALLBACK_MARKER);
  }
  // A child that pauses itself and finishes only when a later follow-up arrives
  // on the same session. Both turns are matched on the current prompt so the
  // yielded kickoff, still present in the shared transcript, cannot make the
  // follow-up turn yield a second time.
  if (QA_SUBAGENT_SELF_YIELD_FOLLOW_UP_RE.test(prompt)) {
    return buildAssistantEvents(QA_SUBAGENT_SELF_YIELD_MARKER);
  }
  if (QA_SUBAGENT_SELF_YIELD_WORKER_RE.test(prompt) && canCallSessionsYield) {
    return buildToolCallEventsWithArgs("sessions_yield", {
      message: "Waiting for the remote job to report back.",
    });
  }
  const terminalCompletionCase = extractLastMatchingUserTurn(
    input,
    QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE,
  )
    ?.text.match(QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE)?.[1]
    ?.toLowerCase();
  if (terminalCompletionCase && /Internal task completion event/i.test(allInputText)) {
    const visibleRepresentation =
      terminalCompletionCase === "silent"
        ? QA_SUBAGENT_TERMINAL_MARKERS.silent
        : terminalCompletionCase === "empty"
          ? QA_SUBAGENT_TERMINAL_MARKERS.empty
          : undefined;
    if (visibleRepresentation) {
      if (completedToolName === "message") {
        return buildAssistantEvents("");
      }
      if (hasToolDefinition(toolDeclarationBody, "message") || hasCallableCodeMode) {
        const deliveryInstructions = extractAllRequestTexts(
          input.filter((item) => item.role === "system" || item.role === "developer"),
          body,
        );
        const requiresFinal =
          /visible source replies are not automatically delivered for this run\.[\s\S]*set `?final=true`?/i.test(
            deliveryInstructions,
          );
        return buildToolCallEventsWithArgs("message", {
          action: "send",
          message: visibleRepresentation,
          ...(requiresFinal ? { final: true } : {}),
        });
      }
      return buildAssistantEvents(visibleRepresentation);
    }
    // The direct delivery fallback owns visible, restart, and sanitized fallback
    // results. Use explicit silence so generic empty-response recovery cannot
    // replay the historical spawn before that fallback runs.
    return buildAssistantEvents("NO_REPLY");
  }
  const terminalWorkerCase = Array.from(
    allInputText.matchAll(
      new RegExp(
        QA_SUBAGENT_TERMINAL_MATRIX_WORKER_RE.source,
        `${QA_SUBAGENT_TERMINAL_MATRIX_WORKER_RE.flags.replaceAll("g", "")}g`,
      ),
    ),
  )
    .at(-1)?.[1]
    ?.toLowerCase();
  if (terminalWorkerCase) {
    const childSessionKey = resolveQaChildSessionKey(input, body);
    if (options.waitForTerminalRequesterSettled && childSessionKey) {
      await options.waitForTerminalRequesterSettled(terminalWorkerCase, childSessionKey);
    }
  }
  if (terminalWorkerCase === "silent") {
    return buildAssistantEvents("NO_REPLY");
  }
  if (terminalWorkerCase === "empty") {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "write")) {
      return buildToolCallEventsWithArgs("write", {
        path: "qa-terminal-empty-side-effect.txt",
        content: "empty terminal QA side effect completed\n",
      });
    }
    return buildAssistantEvents(
      [
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        QA_SUBAGENT_TERMINAL_METADATA_SENTINEL,
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
    );
  }
  if (terminalWorkerCase === "fallback") {
    return buildAssistantEvents(
      [
        QA_SUBAGENT_TERMINAL_MARKERS.fallback,
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        QA_SUBAGENT_TERMINAL_METADATA_SENTINEL,
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
    );
  }
  if (terminalWorkerCase === "visible" || terminalWorkerCase === "restart") {
    return buildAssistantEvents(QA_SUBAGENT_TERMINAL_MARKERS[terminalWorkerCase]);
  }
  if (terminalCompletionCase) {
    if (!hasCompletedToolOutput && canCallSessionsSpawn) {
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: `Subagent terminal reply QA worker: ${terminalCompletionCase}.`,
        label: `qa-terminal-${terminalCompletionCase}`,
        thread: false,
        mode: "run",
      });
    }
    if (hasCompletedToolOutput) {
      // End the requester turn before the delayed worker settles. The terminal
      // result must therefore use the runtime's direct channel fallback.
      return buildAssistantEvents("NO_REPLY");
    }
  }
  // Protected completion context is excluded from the current user prompt;
  // ignoring it replays the historical kickoff and recursively spawns workers.
  if (
    allInputText.includes(QA_SUBAGENT_DIRECT_FALLBACK_MARKER) &&
    /Internal task completion event/i.test(allInputText)
  ) {
    return buildAssistantEvents("");
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput && canCallSessionsSpawn) {
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: `Subagent direct fallback worker: finish with exactly ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
        label: "qa-direct-fallback-worker",
        thread: false,
        mode: "run",
      });
    }
    if (hasCompletedToolOutput && canCallSessionsYield && !/\byielded\b/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: `Waiting for ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
      });
    }
  }
  if (/remember this fact/i.test(prompt)) {
    return buildAssistantEvents(buildAssistantText(input, body));
  }
  if (isActiveEmptyResponseSideEffectRecovery) {
    if (allInputText.includes(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE)) {
      return buildAssistantEvents(
        exactMarkerDirective ?? exactReplyDirective ?? "TELEGRAM-EMPTY-WRITE-RECOVERED-OK",
      );
    }
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "qa-empty-response-side-effect.txt",
        content: "side effect completed once\n",
      });
    }
    return buildAssistantEvents("");
  }
  if (isActiveFailedToolTerminalRecovery) {
    if (allInputText.includes(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE)) {
      if (!allInputText.includes("state that failure plainly and do not claim it succeeded")) {
        return buildAssistantEvents("FAILED-TOOL-HONESTY-INSTRUCTION-MISSING");
      }
      const marker = exactMarkerDirective ?? exactReplyDirective ?? "QA-FAILED-TOOL-FINALIZED-OK";
      return buildAssistantEvents(`The requested file could not be read: ENOENT. ${marker}`);
    }
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "qa-failed-terminal-missing-file.txt" });
    }
    return buildAssistantEvents("FAILED-TOOL-TERMINAL-WAS-REPLAYED");
  }
  if (isHeartbeatPrompt(prompt)) {
    return buildAssistantEvents("HEARTBEAT_OK");
  }
  if (/fanout worker alpha/i.test(prompt)) {
    return buildAssistantEvents("ALPHA-OK");
  }
  if (/fanout worker beta/i.test(prompt)) {
    return buildAssistantEvents("BETA-OK");
  }
  if (
    /roundtrip image inspection check/i.test(currentImageRequest.text) &&
    currentImageRequest.imageInputCount > 0
  ) {
    return buildAssistantEvents(
      "Protocol note: the generated attachment shows the same QA lighthouse scene from the previous step.",
    );
  }
  if (
    /image understanding check/i.test(currentImageRequest.text) &&
    currentImageRequest.imageInputCount > 0
  ) {
    return buildAssistantEvents(
      "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.",
    );
  }
  if (QA_REASONING_ONLY_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasReasoningOnlyRetryInstruction) {
      return buildReasoningOnlyEvents(
        "Need visible answer after reading the QA kickoff task.",
        "rs_mock_reasoning_recovery",
      );
    }
    return buildAssistantEvents("REASONING-RECOVERED-OK");
  }
  if (QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "reasoning-only-side-effect.txt",
        content: "side effects already happened\n",
      });
    }
    if (!hasReasoningOnlyRetryInstruction) {
      return buildReasoningOnlyEvents(
        "Need visible answer after the write, but the write already happened.",
        "rs_mock_reasoning_side_effect",
      );
    }
    return buildAssistantEvents("BUG-SHOULD-NOT-AUTO-RETRY");
  }
  if (QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT_RE.test(allInputText)) {
    // The catalog's default mock alternate and the explicit proof model both
    // recover, so the scenario exercises the same fallback path with or without flags.
    if (model === "gpt-5.6-luna-alt" || model === "mock-visible-fallback") {
      return buildAssistantEvents("MODEL-FALLBACK-VISIBLE-OK");
    }
    return buildReasoningAndAssistantEvents({
      reasoningId: `rs_mock_mixed_blank_${model.replaceAll(/[^a-z0-9]+/gi, "_")}`,
      answerText: " ",
    });
  }
  if (QA_THINKING_VISIBILITY_MAX_PROMPT_RE.test(prompt)) {
    return buildReasoningAndAssistantEvents({
      reasoningId: "rs_mock_thinking_visibility_max",
      answerText: "THINKING-MAX-OK",
    });
  }
  if (QA_THINKING_VISIBILITY_OFF_PROMPT_RE.test(prompt)) {
    return buildAssistantEvents("THINKING-OFF-OK");
  }
  if (QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasEmptyResponseRetryInstruction) {
      return buildAssistantEvents("");
    }
    return buildAssistantEvents("EMPTY-RECOVERED-OK");
  }
  if (QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    return buildAssistantEvents("");
  }
  if (QA_TELEGRAM_LONG_FINAL_THREE_CHUNK_PROMPT_RE.test(allInputText)) {
    const text = buildQaLongFinalText({
      endMarker: "TELEGRAM-LONG-FINAL-3CHUNK-END",
      segmentCount: 96,
      startMarker: "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN",
    });
    return buildAssistantEvents([
      {
        id: "msg_mock_telegram_long_final_three_chunk",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(text),
        text,
      },
    ]);
  }
  if (QA_TELEGRAM_LONG_FINAL_PROMPT_RE.test(allInputText)) {
    const text = buildQaLongFinalText();
    return buildAssistantEvents([
      {
        id: "msg_mock_telegram_long_final",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(text),
        text,
      },
    ]);
  }
  if (QA_WHATSAPP_LONG_FINAL_PROMPT_RE.test(allInputText)) {
    const text = buildQaLongFinalText({
      endMarker: "WHATSAPP-LONG-FINAL-END",
      segmentPrefix: "whatsapp-long-final-segment",
      segmentCount: 64,
      startMarker: "WHATSAPP-LONG-FINAL-BEGIN",
    });
    return buildAssistantEvents([
      {
        id: "msg_mock_whatsapp_long_final",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(text),
        text,
      },
    ]);
  }
  const whatsAppPendingHistoryReply = buildWhatsAppPendingHistoryReply(prompt, input);
  if (whatsAppPendingHistoryReply) {
    return buildAssistantEvents(whatsAppPendingHistoryReply);
  }
  const whatsAppBroadcastReply = buildWhatsAppBroadcastReply(allInputText);
  if (whatsAppBroadcastReply) {
    return buildAssistantEvents(whatsAppBroadcastReply);
  }
  const whatsAppGroupDispatchReply = buildWhatsAppGroupDispatchReply(allInputText);
  if (whatsAppGroupDispatchReply) {
    return buildAssistantEvents(whatsAppGroupDispatchReply);
  }
  const whatsAppBatchedReply = buildWhatsAppBatchedReply(allInputText);
  if (whatsAppBatchedReply) {
    return buildAssistantEvents(whatsAppBatchedReply);
  }
  const slackChartMatch = QA_SLACK_CHART_PRESENTATION_PROMPT_RE.exec(allInputText);
  if (slackChartMatch?.[1] && slackChartMatch[2]) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: slackChartMatch[1],
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "line",
              title: "QA latency trend",
              categories: ["P50", "P95"],
              series: [{ name: "Latency", values: [120, 240] }],
              xLabel: "Percentile",
              yLabel: "Milliseconds",
            },
          ],
        },
      });
    }
    if (hasCompletedToolOutput) {
      return buildAssistantEvents(slackChartMatch[2]);
    }
  }
  if (QA_WHATSAPP_AGENT_MESSAGE_ACTION_REACT_PROMPT_RE.test(allInputText)) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "react",
        emoji: "👍",
      });
    }
    if (hasCompletedToolOutput) {
      return buildAssistantEvents("");
    }
  }
  const whatsAppUploadMatch = QA_WHATSAPP_AGENT_MESSAGE_ACTION_UPLOAD_PROMPT_RE.exec(allInputText);
  if (whatsAppUploadMatch?.[1]) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "upload-file",
        buffer: TINY_PNG_BASE64,
        caption: whatsAppUploadMatch[1],
        contentType: "image/png",
        filename: "whatsapp-qa-agent-upload.png",
      });
    }
    if (hasCompletedToolOutput) {
      return buildAssistantEvents("");
    }
  }
  if (
    QA_STREAMING_PROMPT_RE.test(allInputText) &&
    allInputText.includes(QA_TELEGRAM_STREAM_SINGLE_MARKER)
  ) {
    return buildAssistantEvents([
      {
        id: "msg_mock_telegram_quiet_stream",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(QA_TELEGRAM_STREAM_SINGLE_MARKER),
        text: QA_TELEGRAM_STREAM_SINGLE_MARKER,
      },
    ]);
  }
  if (
    QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE.test(scenarioFamilyPrompt) &&
    scenarioFamilyReplyDirective
  ) {
    return buildAssistantEvents([
      {
        id: "msg_mock_final_only_marker_stream",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText("QA streaming preview in progress"),
        text: scenarioFamilyReplyDirective,
      },
    ]);
  }
  if (QA_STREAMING_PROMPT_RE.test(scenarioFamilyPrompt) && scenarioFamilyReplyDirective) {
    return buildAssistantEvents([
      {
        id: "msg_mock_quiet_stream",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(scenarioFamilyReplyDirective),
        text: scenarioFamilyReplyDirective,
      },
    ]);
  }
  if (slackProgressDirectives) {
    if (hasSlackProgressToolOutput) {
      return buildAssistantEvents([
        {
          id: "msg_mock_slack_progress_final",
          phase: "final_answer",
          streamDeltas: splitMockStreamingText(slackProgressDirectives.finalMarker),
          text: slackProgressDirectives.finalMarker,
        },
      ]);
    }
    if (hasDeclaredTool(body, "exec")) {
      return buildAssistantThenToolCallEvents(
        {
          id: "msg_mock_slack_progress_commentary",
          phase: "commentary",
          streamDeltas: splitMockStreamingText(slackProgressDirectives.commentaryMarker),
          text: slackProgressDirectives.commentaryMarker,
        },
        "exec",
        { command: slackProgressDirectives.execCommand },
      );
    }
  }
  const toolProgressReplyDirective =
    extractExactReplyDirective(toolProgressToolOutput) ??
    extractExactMarkerDirective(toolProgressToolOutput) ??
    scenarioFamilyReplyDirective;
  if (QA_TOOL_PROGRESS_ERROR_PROMPT_RE.test(scenarioFamilyPrompt)) {
    if (!toolProgressToolOutput) {
      return buildToolProgressReadEvents();
    }
    if (toolProgressReplyDirective) {
      return buildAssistantEvents(
        hasToolErrorOutput(toolProgressToolJson, toolProgressToolOutput)
          ? toolProgressReplyDirective
          : "BUG-TOOL-DID-NOT-FAIL",
      );
    }
  }
  if (QA_TOOL_PROGRESS_PROMPT_RE.test(scenarioFamilyPrompt)) {
    if (!toolProgressToolOutput) {
      return buildToolProgressExecEvents() ?? buildToolProgressReadEvents();
    }
    if (toolProgressReplyDirective) {
      return buildAssistantEvents(toolProgressReplyDirective);
    }
  }
  if (QA_BLOCK_STREAMING_PROMPT_RE.test(scenarioFamilyPrompt) && blockStreamingMarkers) {
    if (!hasCompletedToolOutput) {
      return buildAssistantThenToolCallEvents(
        {
          id: "msg_mock_block_1",
          phase: "final_answer",
          streamDeltas: splitMockStreamingText(blockStreamingMarkers.first),
          text: blockStreamingMarkers.first,
        },
        "read",
        {
          path: readTargetFromPrompt(blockStreamingPrompt),
        },
      );
    }
    return buildAssistantEvents([
      {
        id: "msg_mock_block_2",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(blockStreamingMarkers.second),
        text: blockStreamingMarkers.second,
      },
    ]);
  }
  if (isStrandedFinalRetryFailureRequest(allInputText)) {
    return buildAssistantEvents(buildStrandedFinalRetryFailureText());
  }
  if (QA_STRANDED_FINAL_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (QA_STRANDED_FINAL_RETRY_PROMPT_RE.test(allInputText)) {
      if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
        return buildToolCallEventsWithArgs("message", {
          action: "send",
          message: buildStrandedFinalRecoveryText(),
        });
      }
      return buildAssistantEvents("");
    }
    return buildAssistantEvents(buildStrandedFinalRecoveryText());
  }
  if (QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE.test(prompt)) {
    if (hasCompletedToolOutput) {
      return buildAssistantEvents("");
    }
    const sessionsSendArgs = buildQaA2aMessageToolMirrorSessionsSendArgs(prompt);
    if (sessionsSendArgs && hasDeclaredTool(body, "sessions_send")) {
      return buildToolCallEventsWithArgs("sessions_send", sessionsSendArgs);
    }
  }
  if (QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE.test(allInputText)) {
    const marker = exactMarkerDirective ?? exactReplyDirective ?? "QA-GROUP-TOOL-OK";
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: marker,
      });
    }
    return buildAssistantEvents("");
  }
  if (QA_MSTEAMS_THREAD_DEDUPE_PROMPT_RE.test(allInputText)) {
    const marker = exactMarkerDirective ?? exactReplyDirective ?? "QA-MSTEAMS-THREAD-DEDUPE-OK";
    const target = /msteams message target:\s*`([^`]+)`/iu.exec(prompt)?.[1]?.trim();
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: marker,
        ...(target ? { target } : {}),
      });
    }
    return buildAssistantEvents(marker);
  }
  if (QA_GROUP_MESSAGE_UNAVAILABLE_FALLBACK_PROMPT_RE.test(allInputText)) {
    return buildAssistantEvents(
      exactMarkerDirective ?? exactReplyDirective ?? "QA-GROUP-FALLBACK-OK",
    );
  }
  if (whatsAppLocationMarker) {
    return buildAssistantEvents(whatsAppLocationMarker);
  }
  if (whatsAppContactMarker) {
    return buildAssistantEvents(whatsAppContactMarker);
  }
  if (whatsAppStickerMarker) {
    return buildAssistantEvents(whatsAppStickerMarker);
  }
  const slackMpimHistoryRecall = QA_SLACK_MPIM_HISTORY_RECALL_PROMPT_RE.exec(prompt);
  if (slackMpimHistoryRecall) {
    const [, botReplyPrefix, recalledMarker, missingMarker] = slackMpimHistoryRecall;
    const nonce = botReplyPrefix
      ? extractSlackMpimRetainedBotNonce(prompt, botReplyPrefix)
      : undefined;
    return buildAssistantEvents(
      nonce && recalledMarker ? `${recalledMarker}_${nonce}` : (missingMarker ?? ""),
    );
  }
  const slackMpimHistorySeed = QA_SLACK_MPIM_HISTORY_SEED_PROMPT_RE.exec(prompt)?.[1];
  if (slackMpimHistorySeed) {
    return buildAssistantEvents(buildSlackMpimHistoryBotReply(slackMpimHistorySeed));
  }
  if (/\bmarker\b/i.test(prompt) && promptExactMarkerDirective) {
    return buildAssistantEvents(promptExactMarkerDirective);
  }
  if (/\bmarker\b/i.test(prompt) && promptExactReplyDirective) {
    return buildAssistantEvents(promptExactReplyDirective);
  }
  const isTelegramCurrentSessionStatusTurn =
    QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(prompt) ||
    (hasCompletedToolOutput && QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(allInputText));
  if (isTelegramCurrentSessionStatusTurn) {
    if (!hasCompletedToolOutput && hasDeclaredTool(body, "session_status")) {
      return buildToolCallEventsWithArgs("session_status", { sessionKey: "current" });
    }
    const sessionKey = extractSessionStatusSessionKey(toolJson, toolOutput);
    return buildAssistantEvents(
      sessionKey.includes(":telegram:group:")
        ? `QA-TELEGRAM-CURRENT-SESSION-OK ${sessionKey}`
        : `QA-TELEGRAM-CURRENT-SESSION-BAD ${sessionKey || "missing-session-key"}`,
    );
  }
  if (/\bmarker\b/i.test(allInputText) && promptExactReplyDirective) {
    return buildAssistantEvents(promptExactReplyDirective);
  }
  if (/\bmarker\b/i.test(allInputText) && userExactMarkerDirective) {
    return buildAssistantEvents(userExactMarkerDirective);
  }
  if (/\bmarker\b/i.test(allInputText) && userExactReplyDirective) {
    return buildAssistantEvents(userExactReplyDirective);
  }
  if (QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE.test(allInputText)) {
    return buildAssistantEvents(
      JSON.stringify({
        action: "create",
        skillName: "animated-gif-workflow",
        title: "Animated GIF Workflow",
        reason: "Transcript captured a reusable animated media QA checklist.",
        description: "Reusable workflow notes for animated GIF QA tasks.",
        body: [
          "- Confirm the asset has true animation, not a static preview.",
          "- Check dimensions against the target product UI slot.",
          "- Record attribution and license before using the file.",
          "- Keep a local copy under the workspace before integration.",
          "- Re-open the local copy for final verification.",
        ].join("\n"),
      }),
    );
  }
  if (QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(prompt) && !hasCompletedToolOutput) {
    return buildToolCallEventsWithArgs("write", {
      path: "animated-gif-qa-checklist.md",
      content: [
        "# Animated GIF QA Checklist",
        "",
        "- Confirm true animation.",
        "- Verify dimensions.",
        "- Record attribution.",
        "- Keep a local copy.",
        "- Perform final verification.",
      ].join("\n"),
    });
  }
  if (QA_RELEASE_AUDIT_PROMPT_RE.test(prompt)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "audit-fixture/README.md" });
    }
    if (/Release readiness task|current checklist/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("read", {
        path: "audit-fixture/docs/current-readiness-checklist.md",
      });
    }
    if (/Current release readiness requires checking eight areas/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("write", {
        path: "audit-fixture/release-audit.json",
        content: buildReleaseAuditJson(),
      });
    }
    if (/release-audit\.json/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("write", {
        path: "audit-fixture/release-handoff.md",
        content: buildReleaseHandoffMarkdown(),
      });
    }
    if (/release-handoff\.md/i.test(toolOutput)) {
      return buildAssistantEvents("RELEASE-AUDIT-COMPLETE");
    }
  }
  if (/personal share-safe diagnostics check/i.test(allInputText)) {
    const diagnosticsEvidenceText = extractAllToolOutputText(input);
    if (/successfully (?:wrote|created|updated|replaced)/i.test(diagnosticsEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-diagnostics-summary.txt",
          "Status: share-safe diagnostics summary ready",
          "PERSONAL-DIAGNOSTICS-SAFE-OK",
        ].join("\n"),
      );
    }
    if (
      !diagnosticsEvidenceText ||
      (!diagnosticsEvidenceText.includes("# Personal diagnostics request") &&
        !diagnosticsEvidenceText.includes("# Raw personal diagnostics fixture"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "DIAGNOSTICS_REQUEST.md" });
    }
    if (
      diagnosticsEvidenceText.includes("# Personal diagnostics request") &&
      diagnosticsEvidenceText.includes("# Raw personal diagnostics fixture")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-diagnostics-summary.txt",
        content: [
          "Status: blocked waiting for explicit publish approval",
          "Affected surface: telegram direct message",
          "Omitted content: raw chat text, raw tool output, account id, message id, and fake secret",
          "Redaction confirmed: yes",
          "Next step: ask maintainer whether manually landed commits can count for contributor credit",
        ].join("\n"),
      });
    }
    if (diagnosticsEvidenceText.includes("# Personal diagnostics request")) {
      return buildToolCallEventsWithArgs("read", { path: "PERSONAL_DIAGNOSTICS_RAW.md" });
    }
  }
  if (/personal no-fake-progress check/i.test(allInputText)) {
    const progressEvidenceText = [
      extractAllToolOutputText(input),
      extractUserTextAfterLatestToolOutput(input),
    ]
      .filter(Boolean)
      .join("\n");
    if (/successfully (?:wrote|created|updated|replaced)/i.test(progressEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-progress-proof.txt",
          "Status: local proof artifact written",
          "External status: not sent, not published, not uploaded, not merged",
          "PERSONAL-NO-FAKE-PROGRESS-OK",
        ].join("\n"),
      );
    }
    if (
      !progressEvidenceText ||
      (!progressEvidenceText.includes("# Progress request") &&
        !progressEvidenceText.includes("# Progress evidence"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "PROGRESS_REQUEST.md" });
    }
    if (
      progressEvidenceText.includes("# Progress request") &&
      progressEvidenceText.includes("# Progress evidence")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-progress-proof.txt",
        content: [
          "Personal no-fake-progress",
          "Status: local proof artifact written",
          "External status: not sent; not published; not uploaded; not merged",
          "Evidence: PROGRESS_REQUEST.md and PROGRESS_EVIDENCE.md were read before this artifact was written",
        ].join("\n"),
      });
    }
    if (progressEvidenceText.includes("# Progress request")) {
      return buildToolCallEventsWithArgs("read", { path: "PROGRESS_EVIDENCE.md" });
    }
  }
  if (/personal failure recovery check/i.test(allInputText)) {
    const recoveryEvidenceText = [
      extractAllToolOutputText(input),
      extractUserTextAfterLatestToolOutput(input),
    ]
      .filter(Boolean)
      .join("\n");
    if (/successfully (?:wrote|created|updated|replaced)/i.test(recoveryEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-failure-recovery.txt",
          "Failed step: external calendar update was not attempted",
          "Retry boundary: do not retry until approval is given",
          "PERSONAL-FAILURE-RECOVERY-OK",
        ].join("\n"),
      );
    }
    if (
      !recoveryEvidenceText ||
      (!recoveryEvidenceText.includes("# Failure recovery request") &&
        !recoveryEvidenceText.includes("# Failure recovery evidence"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "FAILURE_RECOVERY_REQUEST.md" });
    }
    if (
      recoveryEvidenceText.includes("# Failure recovery request") &&
      recoveryEvidenceText.includes("# Failure recovery evidence")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-failure-recovery.txt",
        content: [
          "Personal failure recovery",
          "Completed: request reviewed and local evidence captured",
          "Failed step: external calendar update was not attempted because explicit approval is missing",
          "Retry boundary: do not retry the external step until approval is given",
          "Next step: ask for approval before any external update",
        ].join("\n"),
      });
    }
    if (recoveryEvidenceText.includes("# Failure recovery request")) {
      return buildToolCallEventsWithArgs("read", { path: "FAILURE_RECOVERY_EVIDENCE.md" });
    }
  }
  if (/lobster invaders/i.test(prompt)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return buildToolCallEventsWithArgs("write", {
        path: "lobster-invaders.html",
        content: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Lobster Invaders</title></head>
  <body><h1>Lobster Invaders</h1><p>Tiny playable stub.</p></body>
</html>`,
      });
    }
  }
  if (/memory tools check/i.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "hidden project codename",
        maxResults: 3,
      });
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (typeof first?.path === "string") {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
  }
  if (isActiveMemorySubagentPrompt(allInputText) && isSnackRecallPrompt(allInputText)) {
    if (!hasCompletedToolOutput) {
      if (!hasDeclaredTool(body, "memory_recall")) {
        return buildToolCallEventsWithArgs("memory_search", {
          query: "QA movie night snack lemon pepper wings blue cheese",
          maxResults: /remember across conversations qa check/i.test(allInputText) ? 10 : 3,
        });
      }
      return buildToolCallEventsWithArgs("memory_recall", {
        query: "QA movie night snack lemon pepper wings blue cheese",
        limit: 3,
      });
    }
    const memoryText =
      typeof toolJson?.text === "string"
        ? toolJson.text
        : Array.isArray(toolJson?.content)
          ? toolJson.content
              .map((item) =>
                typeof item === "object" && item && "text" in item && typeof item.text === "string"
                  ? item.text
                  : "",
              )
              .filter(Boolean)
              .join("\n")
          : undefined;
    if (memoryText) {
      const snackPreference = extractSnackPreference(memoryText);
      if (snackPreference) {
        return buildAssistantEvents(`User usually wants ${snackPreference} for QA movie night.`);
      }
      return buildAssistantEvents("NONE");
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (typeof first?.path === "string" && hasDeclaredTool(body, "memory_get")) {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
    const memorySnippet = Array.isArray(toolJson?.results)
      ? JSON.stringify(toolJson.results)
      : toolOutput;
    const snackPreference = extractSnackPreference(memorySnippet);
    if (snackPreference) {
      return buildAssistantEvents(`User usually wants ${snackPreference} for QA movie night.`);
    }
    return buildAssistantEvents("NONE");
  }
  if (/session memory ranking check/i.test(prompt)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "current Project Nebula codename",
        maxResults: 6,
      });
    }
    if (memoryToolUnavailable) {
      return buildAssistantEvents("NONE");
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const preferredSessionResult = results.find((result) => {
      const resultPath = typeof result.path === "string" ? result.path : undefined;
      if (result.source !== "sessions" && !resultPath?.startsWith("sessions/")) {
        return false;
      }
      const memoryText =
        typeof result.snippet === "string"
          ? result.snippet
          : typeof result.text === "string"
            ? result.text
            : "";
      return extractOrbitCode(memoryText) !== null;
    });
    const sessionMemoryText =
      typeof preferredSessionResult?.snippet === "string"
        ? preferredSessionResult.snippet
        : typeof preferredSessionResult?.text === "string"
          ? preferredSessionResult.text
          : "";
    const retrievedOrbitCode =
      extractOrbitCode(sessionMemoryText) ??
      (typeof toolJson?.text === "string" ? extractOrbitCode(toolJson.text) : null);
    if (retrievedOrbitCode) {
      return buildAssistantEvents(
        `Protocol note: I checked memory and the current Project Nebula codename is ${retrievedOrbitCode}.`,
      );
    }
    const first =
      results.find((result) => {
        const resultPath = typeof result.path === "string" ? result.path : undefined;
        return result.source === "sessions" || resultPath?.startsWith("sessions/");
      }) ?? results[0];
    if (
      typeof first?.path === "string" &&
      (typeof first.startLine === "number" || typeof first.endLine === "number")
    ) {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
    return buildAssistantEvents("NONE");
  }
  if (/thread memory check/i.test(allInputText)) {
    if (!hasCompletedToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "hidden thread codename ORBIT-22",
        maxResults: 3,
      });
    }
    const directThreadMemoryJson =
      Array.isArray(toolJson?.results) || typeof toolJson?.text === "string" ? toolJson : null;
    const completedMemoryValue =
      toolJson?.status === "completed" &&
      (completedToolName === "memory_search" || completedToolName === "memory_get") &&
      toolJson.value !== null &&
      typeof toolJson.value === "object" &&
      !Array.isArray(toolJson.value)
        ? (toolJson.value as Record<string, unknown>)
        : null;
    const threadMemoryJson = completedMemoryValue ?? directThreadMemoryJson;
    const threadMemoryToolName = completedMemoryValue
      ? completedToolName
      : Array.isArray(threadMemoryJson?.results)
        ? "memory_search"
        : typeof threadMemoryJson?.text === "string"
          ? "memory_get"
          : undefined;
    const threadMemoryUnavailable =
      threadMemoryJson?.unavailable === true ||
      threadMemoryJson?.disabled === true ||
      (typeof threadMemoryJson?.error === "string" && threadMemoryJson.error.trim().length > 0);
    if (threadMemoryUnavailable) {
      return buildAssistantEvents("NONE");
    }
    if (threadMemoryToolName === "memory_search") {
      const results = Array.isArray(threadMemoryJson?.results)
        ? (threadMemoryJson.results as Array<Record<string, unknown>>)
        : [];
      const first = results[0];
      if (
        typeof first?.path === "string" &&
        (typeof first.startLine === "number" || typeof first.endLine === "number")
      ) {
        const from =
          typeof first.startLine === "number"
            ? Math.max(1, first.startLine)
            : typeof first.endLine === "number"
              ? Math.max(1, first.endLine)
              : 1;
        return buildToolCallEventsWithArgs("memory_get", {
          path: first.path,
          from,
          lines: 4,
        });
      }
    }
    const memoryGetText =
      threadMemoryToolName === "memory_get" && typeof threadMemoryJson?.text === "string"
        ? threadMemoryJson.text
        : "";
    const memoryGetOrbitCode = extractOrbitCode(memoryGetText);
    if (memoryGetOrbitCode) {
      return buildAssistantEvents(
        `Protocol note: I checked memory in-thread and the hidden thread codename is ${memoryGetOrbitCode}.`,
      );
    }
    return buildAssistantEvents("NONE");
  }
  if (
    QA_IMAGE_GENERATION_PROMPT_RE.test(allInputText) &&
    !hasCompletedToolOutput &&
    (hasToolDefinition(body, "image_generate") || hasCodeModeExecSurface(body))
  ) {
    return buildToolCallEventsWithArgs("image_generate", {
      prompt: "A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
      filename: "qa-lighthouse.png",
      size: "1024x1024",
    });
  }
  const isSubagentFanoutPrompt = /subagent fanout synthesis check/i.test(allInputText);
  const currentFanoutInstructions = extractAllRequestTexts(
    input.filter((item) => item.role === "system" || item.role === "developer"),
    body,
  );
  const fanoutRequiresFinalMessage =
    /visible source replies are not automatically delivered for this run\.\s*use `?message\(action=send\)`?[\s\S]*set `?final=true`?/i.test(
      currentFanoutInstructions,
    );
  // Delivery mode belongs to this turn's instructions, not earlier transcript
  // turns whose private-reply policy may no longer apply.
  const fanoutHasPrivateSourceReply =
    isSubagentFanoutPrompt &&
    (fanoutRequiresFinalMessage ||
      /visible reply must use `?message\(action=send\)`?;\s*final text is private/i.test(
        currentFanoutInstructions,
      ));
  const fanoutRequiresMessageTool =
    fanoutHasPrivateSourceReply &&
    (hasToolDefinition(toolDeclarationBody, "message") || hasCallableCodeMode);
  if (
    scenarioState.subagentFanoutPhase === 3 &&
    fanoutRequiresMessageTool &&
    hasCompletedToolOutput
  ) {
    return buildAssistantEvents("");
  }
  const completeSubagentFanout = () => {
    scenarioState.subagentFanoutPhase = 3;
    const message = "subagent-1: ok\nsubagent-2: ok";
    return fanoutRequiresMessageTool
      ? buildToolCallEventsWithArgs("message", {
          action: "send",
          message,
          ...(fanoutRequiresFinalMessage ? { final: true } : {}),
        })
      : buildAssistantEvents(message);
  };
  if (
    !hasCompletedToolOutput &&
    /subagent fanout synthesis check/i.test(prompt) &&
    scenarioState.subagentFanoutPhase !== 0
  ) {
    scenarioState.subagentFanoutPhase = 0;
    scenarioState.subagentFanoutCompletedWorkers.clear();
  }
  // A later requester-settle wake must replay the completed synthesis without spawning again.
  if (isSubagentFanoutPrompt && scenarioState.subagentFanoutPhase === 3) {
    return buildAssistantEvents("subagent-1: ok\nsubagent-2: ok");
  }
  if (canCallSessionsSpawn && isSubagentFanoutPrompt) {
    if (!hasCompletedToolOutput && scenarioState.subagentFanoutPhase === 0) {
      scenarioState.subagentFanoutPhase = 1;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "alpha"),
        label: "qa-fanout-alpha",
        thread: false,
      });
    }
    if (hasCompletedToolOutput && scenarioState.subagentFanoutPhase === 1) {
      scenarioState.subagentFanoutPhase = 2;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "beta"),
        label: "qa-fanout-beta",
        thread: false,
      });
    }
  }
  if (scenarioState.subagentFanoutPhase === 2) {
    if (/\bALPHA-OK\b/i.test(allInputText)) {
      scenarioState.subagentFanoutCompletedWorkers.add("alpha");
    }
    if (/\bBETA-OK\b/i.test(allInputText)) {
      scenarioState.subagentFanoutCompletedWorkers.add("beta");
    }
    // A frozen child envelope may deny message. Its private final cannot be
    // published; keep the batch for the requester-owned all-settled wake.
    if (fanoutHasPrivateSourceReply && !fanoutRequiresMessageTool) {
      return buildAssistantEvents("");
    }
    if (scenarioState.subagentFanoutCompletedWorkers.size === 2) {
      return completeSubagentFanout();
    }
    if (canCallSessionsYield) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: "Waiting for both QA fanout workers to finish.",
      });
    }
    if (fanoutRequiresMessageTool) {
      // Restricted completion turns cannot yield; stay silent until both
      // workers settle instead of advancing past the sole visible reply.
      return buildAssistantEvents("");
    }
    if (hasCompletedToolOutput) {
      return completeSubagentFanout();
    }
  }
  const explicitSessionsSpawnArgs = buildExplicitSessionsSpawnArgs(prompt);
  if (explicitSessionsSpawnArgs && canCallSessionsSpawn && !hasCompletedToolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", explicitSessionsSpawnArgs);
  }
  if (
    canCallSessionsSpawn &&
    /forked subagent context qa check/i.test(prompt) &&
    !hasCompletedToolOutput
  ) {
    return buildToolCallEventsWithArgs("sessions_spawn", {
      task: "Report the visible code from the requester transcript.",
      label: "qa-fork-context",
      mode: "run",
      context: "fork",
    });
  }
  if (/tool continuity check/i.test(prompt) && !hasCompletedToolOutput) {
    return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
  }
  if (/repo contract followthrough check/i.test(allInputText)) {
    const repoEvidenceText = [
      extractAllToolOutputText(input),
      extractUserTextAfterLatestToolOutput(input),
    ]
      .filter(Boolean)
      .join("\n");
    if (
      /successfully (?:wrote|created|updated|replaced)/i.test(repoEvidenceText) ||
      /status:\s*complete/i.test(repoEvidenceText)
    ) {
      return buildAssistantEvents(
        [
          "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
          "Wrote: repo-contract-summary.txt",
          "Status: complete",
        ].join("\n"),
      );
    }
    if (!repoEvidenceText) {
      return buildToolCallEventsWithArgs("read", { path: "AGENT.md" });
    }
    if (
      repoEvidenceText.includes("Mission: prove you followed the repo contract.") &&
      repoEvidenceText.includes("Evidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "repo-contract-summary.txt",
        content: [
          "Mission: prove you followed the repo contract.",
          "Evidence: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md",
          "Status: complete",
        ].join("\n"),
      });
    }
    if (repoEvidenceText.includes("# Execution style")) {
      return buildToolCallEventsWithArgs("read", { path: "FOLLOWTHROUGH_INPUT.md" });
    }
    if (repoEvidenceText.includes("# Repo contract")) {
      return buildToolCallEventsWithArgs("read", { path: "SOUL.md" });
    }
  }
  if (/personal task followthrough check/i.test(allInputText)) {
    const taskEvidenceText = [
      extractAllToolOutputText(input),
      extractUserTextAfterLatestToolOutput(input),
    ]
      .filter(Boolean)
      .join("\n");
    if (/successfully (?:wrote|created|updated|replaced)/i.test(taskEvidenceText)) {
      return buildAssistantEvents(
        [
          "Pending: maintainer feedback before publishing",
          "Blocked: publishing needs explicit user approval",
          "Done: local evidence captured in personal-task-status.txt",
        ].join("\n"),
      );
    }
    if (
      !taskEvidenceText ||
      (!taskEvidenceText.includes("# Personal task ledger") &&
        !taskEvidenceText.includes("Task: prepare a local OpenClaw PR readiness note."))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "PERSONAL_TASK_LEDGER.md" });
    }
    if (
      taskEvidenceText.includes("Task: prepare a local OpenClaw PR readiness note.") &&
      taskEvidenceText.includes("Done: local evidence captured in personal-task-status.txt.")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-task-status.txt",
        content: [
          "Personal task followthrough",
          "Pending: maintainer feedback before publishing",
          "Blocked: publishing needs explicit user approval",
          "Done: local evidence captured in personal-task-status.txt",
        ].join("\n"),
      });
    }
    if (taskEvidenceText.includes("# Personal task ledger")) {
      return buildToolCallEventsWithArgs("read", { path: "FOLLOWTHROUGH_NOTE.md" });
    }
  }
  if (
    canCallSessionsSpawn &&
    (/delegate (?:one |a )bounded qa task/i.test(allInputText) ||
      /subagent handoff/i.test(allInputText)) &&
    !hasCompletedToolOutput &&
    !scenarioState.subagentHandoffSpawned
  ) {
    scenarioState.subagentHandoffSpawned = true;
    return buildToolCallEventsWithArgs("sessions_spawn", {
      task: subagentHandoffTaskForProvider(providerVariant),
      label: "qa-sidecar",
      thread: false,
    });
  }
  if (
    /(worked, failed, blocked|worked\/failed\/blocked|source and docs)/i.test(prompt) &&
    !hasCompletedToolOutput
  ) {
    return buildToolCallEventsWithArgs("read", {
      path: sourceDiscoveryReadPathForProvider(providerVariant),
    });
  }
  if (!hasCompletedToolOutput && /\b(read|inspect|repo|docs|scenario|kickoff)\b/i.test(prompt)) {
    return buildToolCallEvents(prompt);
  }
  if (/visible skill marker/i.test(prompt) && !hasCompletedToolOutput) {
    return buildAssistantEvents("VISIBLE-SKILL-OK");
  }
  if (/hot install marker/i.test(prompt) && !hasCompletedToolOutput) {
    return buildAssistantEvents("HOT-INSTALL-OK");
  }
  if (isGroupChat && isBaselineUnmentionedChannelChatter && !hasCompletedToolOutput) {
    return buildAssistantEvents("NO_REPLY");
  }
  if (QA_NATIVE_STOP_DELAY_PROMPT_RE.test(prompt)) {
    await sleep(QA_NATIVE_STOP_DELAY_MS);
  }
  return buildAssistantEvents(buildAssistantText(input, body));
}

export async function startQaMockOpenAiServer(params?: {
  host?: string;
  port?: number;
  finalOnlyMarkerPauseMs?: number;
  modelRefs?: readonly string[];
}) {
  const host = params?.host ?? "127.0.0.1";
  const finalOnlyMarkerPauseMs = params?.finalOnlyMarkerPauseMs ?? 1_500;
  const terminalRequesterSettleGate = createTerminalRequesterSettleGate();
  const scenarioStates = new Map<string, MockScenarioState>();
  const servedCompactionSummaryFaultMarkers = new Set<string>();
  const scenarioStateFor = (body: Record<string, unknown>): MockScenarioState => {
    const input = normalizeResponsesInput(body.input);
    const sessionId =
      resolveQaRuntimeSessionId(input, body) ??
      (body.client_metadata as { session_id?: unknown } | undefined)?.session_id;
    const key = typeof sessionId === "string" ? sessionId : "";
    // Runtime session identity survives provider switches and cache-boundary changes.
    const state = scenarioStates.get(key) ?? {
      anthropicThinkingErrorScenarioKeys: new Set<string>(),
      compactionOverflowInjected: false,
      compactionRetryActive: false,
      subagentFanoutCompletedWorkers: new Set<"alpha" | "beta">(),
      subagentFanoutPhase: 0,
      subagentHandoffSpawned: false,
      toolLoopReadAttempts: 0,
    };
    scenarioStates.set(key, state);
    return state;
  };
  let lastRequest: MockOpenAiRequestSnapshot | null = null;
  const requests: MockOpenAiRequestSnapshot[] = [];
  let nextRequestCursor = 1;
  const recordRequest = (snapshot: MockOpenAiRequestSnapshotInput) => {
    const recorded = { ...snapshot, cursor: nextRequestCursor++ };
    lastRequest = recorded;
    requests.push(recorded);
    if (requests.length > MOCK_OPENAI_DEBUG_REQUEST_LIMIT) {
      requests.splice(0, requests.length - MOCK_OPENAI_DEBUG_REQUEST_LIMIT);
    }
    return recorded;
  };
  const inflightRequests = new Map<number, { prompt: string; allInputText: string }>();
  let nextInflightRequestId = 1;
  const imageGenerationRequests: Array<Record<string, unknown>> = [];
  const dispatchProvider = async (
    request: QaMockProviderDispatchRequest,
  ): Promise<QaMockProviderDispatchResult> => {
    const normalized =
      request.route === "anthropic-messages"
        ? normalizeAnthropicMessagesRequest(request.body as AnthropicMessagesRequest)
        : {
            body: request.body,
            input: normalizeResponsesInput(request.body.input),
            model: typeof request.body.model === "string" ? request.body.model : "",
          };
    const { body, input, model } = normalized;
    if (isRemoteCompactionV2Request(input)) {
      return { events: buildRemoteCompactionV2Events(), model };
    }
    const prompt = extractLastUserText(input);
    const allInputText = extractAllRequestTexts(input, body);
    const scenarioState = scenarioStateFor(body);
    const requestKind = classifyMockOpenAiRequest(input, body);
    const compactionSummaryFaultMode = resolveCompactionSummaryFaultMode({
      allInputText,
      requestKind,
      servedFaultMarkers: servedCompactionSummaryFaultMarkers,
    });
    if (requestKind !== "compaction-summary" && QA_COMPACTION_RETRY_PROMPT_RE.test(allInputText)) {
      scenarioState.compactionRetryActive = true;
    }
    const rawByteLength = Buffer.byteLength(request.raw);
    const compactionOverflowThresholdBytes = hasCompactionOutputRecoveryMarker(allInputText)
      ? QA_COMPACTION_OUTPUT_RECOVERY_OVERFLOW_THRESHOLD_BYTES
      : QA_COMPACTION_RETRY_OVERFLOW_THRESHOLD_BYTES;
    const requestSnapshotBase = {
      raw: request.raw,
      body,
      prompt,
      allInputText,
      instructions: extractInstructionsText(body) || undefined,
      toolOutput: extractToolOutput(input),
      model,
      providerVariant: resolveProviderVariant(model),
      imageInputCount: countImageInputs(input),
      requestKind,
      compactionSummaryFaultMode,
      rawByteLength,
    } satisfies Omit<
      MockOpenAiRequestSnapshotInput,
      | "outcome"
      | "errorCode"
      | "plannedToolCallId"
      | "plannedToolItemId"
      | "plannedToolName"
      | "plannedWireToolName"
      | "plannedToolArgs"
      | "toolOutputCallId"
      | "toolOutputStructuredError"
    >;
    if (
      requestKind === "agent-initial" &&
      (QA_COMPACTION_RETRY_PROMPT_RE.test(allInputText) ||
        hasCompactionOutputRecoveryMarker(allInputText)) &&
      rawByteLength > compactionOverflowThresholdBytes &&
      !scenarioState.compactionOverflowInjected
    ) {
      scenarioState.compactionOverflowInjected = true;
      recordRequest({
        ...requestSnapshotBase,
        outcome: "error",
        errorCode: "context_length_exceeded",
      });
      return {
        events: [],
        model,
        failure: {
          status: 400,
          type: "invalid_request_error",
          code: "context_length_exceeded",
          message: "This model's maximum context length was exceeded.",
        },
      };
    }
    const inflightRequestId = nextInflightRequestId++;
    inflightRequests.set(inflightRequestId, { prompt, allInputText });
    let events: StreamEvent[];
    let injectedFailure: QaMockProviderDispatchResult["failure"];
    try {
      if (
        request.route === "anthropic-messages" &&
        QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE.test(allInputText)
      ) {
        const toolOutput = extractToolOutput(input);
        const toolOutputCallId = extractToolOutputCallId(input);
        const scenarioKey = `${model}\n${extractLastUserText(input)}`;
        const shouldFail =
          toolOutput.length > 0 &&
          toolOutputCallId.length > 0 &&
          !scenarioState.anthropicThinkingErrorScenarioKeys.has(scenarioKey);
        if (shouldFail) {
          scenarioState.anthropicThinkingErrorScenarioKeys.add(scenarioKey);
          injectedFailure = {
            status: 200,
            type: "api_error",
            message: "QA injected provider stream failure",
            presentation: "anthropic-thinking",
          };
        }
        events =
          toolOutput.length === 0
            ? buildRawToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" })
            : shouldFail
              ? buildAssistantEvents("")
              : buildAssistantEvents("ANTHROPIC-THINKING-ERROR-RECOVERED-OK");
      } else {
        events = await buildResponsesPayload(body, scenarioState, {
          waitForTerminalRequesterSettled: terminalRequesterSettleGate.waitUntilSettled,
          requestKind,
          compactionSummaryFaultMode,
        });
      }
    } finally {
      inflightRequests.delete(inflightRequestId);
    }
    if (request.route === "anthropic-messages") {
      events = adaptAnthropicToolCallIds(events);
    }
    const plannedToolIdentity = extractPlannedToolIdentity(events);
    const plannedTool = extractScenarioPlannedTool(events);
    const terminalRequesterCase = extractLastMatchingUserTurn(
      input,
      QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE,
    )
      ?.text.match(QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE)?.[1]
      ?.toLowerCase();
    const settledTerminalRequester =
      terminalRequesterCase && resolveQaRuntimeSessionId(input, body)
        ? {
            caseName: terminalRequesterCase,
            childSessionKey: resolveAcceptedChildSessionKey(input),
          }
        : undefined;
    const settledTerminalCaseName = settledTerminalRequester?.caseName;
    const settledChildSessionKey = settledTerminalRequester?.childSessionKey;
    const failure =
      injectedFailure ??
      (QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE.test(allInputText) && hasToolOutput(input)
        ? {
            status: 503,
            type: "server_error",
            message: "Service Unavailable",
          }
        : undefined);
    recordRequest({
      ...requestSnapshotBase,
      outcome:
        failure || events.some((event) => event.type === "response.failed") ? "error" : "success",
      ...(events.some((event) => event.type === "response.failed")
        ? { errorCode: "response_failed_no_details" }
        : {}),
      plannedToolCallId: plannedToolIdentity.callId,
      ...(request.route === "responses" && plannedToolIdentity.itemId
        ? { plannedToolItemId: plannedToolIdentity.itemId }
        : {}),
      plannedToolName: plannedTool.name,
      ...(plannedTool.wireName && plannedTool.wireName !== plannedTool.name
        ? { plannedWireToolName: plannedTool.wireName }
        : {}),
      plannedToolArgs: plannedTool.args,
      toolOutputCallId: extractToolOutputCallId(input) || undefined,
      ...(extractToolOutputStructuredError(input) ? { toolOutputStructuredError: true } : {}),
    });
    return {
      events,
      model,
      ...(settledTerminalCaseName && settledChildSessionKey
        ? {
            onResponseSent: () =>
              terminalRequesterSettleGate.markSettled(
                settledTerminalCaseName,
                settledChildSessionKey,
              ),
          }
        : {}),
      ...(failure ? { failure } : {}),
      ...(QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE.test(allInputText)
        ? { previewPauseMs: finalOnlyMarkerPauseMs }
        : {}),
      ...(QA_REPEATED_REQUEST_RECOVERY_PROMPT_RE.test(allInputText) &&
      !QA_REPEATED_REQUEST_QUEUED_REPLY_PROMPT_RE.test(prompt)
        ? { responsePauseMs: QA_REPEATED_REQUEST_RESPONSE_PAUSE_MS }
        : {}),
    };
  };
  const dispatchResponses = (request: Omit<QaMockProviderDispatchRequest, "route">) =>
    dispatchProvider({ ...request, route: "responses" });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(res, 200, { ok: true, status: "live" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, {
          data: listMockOpenAiServerModelIds(params?.modelRefs).map((id) => ({
            id,
            object: "model",
          })),
          models: listMockCodexModelInfos(params?.modelRefs),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/last-request") {
        writeJson(res, 200, lastRequest ?? { ok: false, error: "no request recorded" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/request-cursor") {
        writeJson(res, 200, { cursor: nextRequestCursor - 1 });
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/requests") {
        const afterText = url.searchParams.get("after");
        if (afterText === null) {
          writeJson(res, 200, requests);
          return;
        }
        const after = parseQaDebugRequestCursor(afterText);
        if (after === null) {
          writeJson(res, 400, { error: "after must be a non-negative safe integer" });
          return;
        }
        const latestCursor = nextRequestCursor - 1;
        const oldestCursor = requests[0]?.cursor ?? nextRequestCursor;
        if (after > latestCursor) {
          writeJson(res, 409, {
            error: "request cursor is ahead of the latest recorded request",
            after,
            latestCursor,
          });
          return;
        }
        if (after < oldestCursor - 1) {
          writeJson(res, 409, {
            error: "request cursor expired",
            after,
            oldestCursor,
            latestCursor,
          });
          return;
        }
        writeJson(
          res,
          200,
          requests.filter((request) => request.cursor > after),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/inflight-requests") {
        writeJson(res, 200, [...inflightRequests.values()]);
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/image-generations") {
        writeJson(res, 200, imageGenerationRequests);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/images/generations") {
        const raw = await readBody(req);
        const body = parseJsonObjectBody(raw);
        if (!body) {
          writeOpenAiMalformedJsonError(res, "OpenAI Images");
          return;
        }
        imageGenerationRequests.push(body);
        if (imageGenerationRequests.length > 20) {
          imageGenerationRequests.splice(0, imageGenerationRequests.length - 20);
        }
        writeJson(res, 200, {
          data: [
            {
              b64_json: TINY_PNG_BASE64,
              revised_prompt: "A QA lighthouse with protocol droid silhouette.",
            },
          ],
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
        const raw = await readBody(req);
        writeJson(res, 200, {
          text: transcriptionTextForAudioRequest(raw),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/embeddings") {
        const raw = await readBody(req);
        const body = parseJsonObjectBody(raw);
        if (!body) {
          writeOpenAiMalformedJsonError(res, "OpenAI Embeddings");
          return;
        }
        const inputs = extractEmbeddingInputTexts(body.input);
        writeJson(res, 200, {
          object: "list",
          data: inputs.map((text, index) => ({
            object: "embedding",
            index,
            embedding: buildDeterministicEmbedding(text),
          })),
          model:
            typeof body.model === "string" && body.model.trim()
              ? body.model
              : "text-embedding-3-small",
          usage: {
            prompt_tokens: inputs.reduce((sum, text) => sum + countApproxTokens(text), 0),
            total_tokens: inputs.reduce((sum, text) => sum + countApproxTokens(text), 0),
          },
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const raw = await readBody(req);
        const body = parseJsonObjectBody(raw);
        if (!body) {
          writeOpenAiMalformedJsonError(res, "OpenAI Responses");
          return;
        }
        const dispatched = await dispatchResponses({ body, raw });
        if (dispatched.failure) {
          writeJson(res, dispatched.failure.status, {
            error: {
              type: dispatched.failure.type,
              ...(dispatched.failure.code ? { code: dispatched.failure.code } : {}),
              message: dispatched.failure.message,
            },
          });
          return;
        }
        const { events } = dispatched;
        if (dispatched.responsePauseMs !== undefined) {
          await sleep(dispatched.responsePauseMs);
        }
        if (body.stream === false) {
          const completion = events.at(-1);
          if (!completion || completion.type !== "response.completed") {
            writeJson(res, 500, { error: "mock completion failed" });
            return;
          }
          writeJson(res, 200, completion.response);
          dispatched.onResponseSent?.();
          return;
        }
        if (dispatched.previewPauseMs !== undefined) {
          await writeSseWithPreviewPause(res, events, dispatched.previewPauseMs);
        } else {
          writeSse(res, events);
        }
        dispatched.onResponseSent?.();
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const raw = await readBody(req);
        const body = parseJsonObjectBody(raw) as AnthropicMessagesRequest | null;
        if (!body) {
          writeJson(res, 400, {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Malformed JSON body for Anthropic Messages request.",
            },
          });
          return;
        }
        const dispatched = await dispatchProvider({
          route: "anthropic-messages",
          body: body as Record<string, unknown>,
          raw,
        });
        const { responseBody, streamEvents } = buildMessagesPayload(dispatched);
        if (dispatched.failure?.presentation !== "anthropic-thinking") {
          if (dispatched.failure) {
            writeJson(res, dispatched.failure.status, responseBody);
            return;
          }
        }
        if (body.stream === true) {
          writeAnthropicSse(res, streamEvents);
          dispatched.onResponseSent?.();
          return;
        }
        writeJson(res, dispatched.failure?.status ?? 200, responseBody);
        dispatched.onResponseSent?.();
        return;
      }
      writeJson(res, 404, { error: "not found" });
    })();
  });
  const responsesWebSocket = attachQaMockResponsesWebSocketServer({
    server,
    dispatch: dispatchResponses,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params?.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa mock openai failed to bind");
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    async stop() {
      await responsesWebSocket.close();
      await closeQaHttpServer(server);
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
