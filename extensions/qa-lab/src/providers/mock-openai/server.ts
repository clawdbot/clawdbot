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
import { buildMessagesPayload } from "./mock-anthropic-messages.js";
import { buildAssistantText } from "./mock-openai-assistant-text.js";
import {
  type ResponsesInputItem,
  type StreamEvent,
  resolveProviderVariant,
  type MockOpenAiRequestSnapshot,
  type MockOpenAiRequestSnapshotInput,
  type AnthropicMessagesRequest,
  TINY_PNG_BASE64,
  QA_REASONING_ONLY_RECOVERY_PROMPT_RE,
  QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE,
  QA_THINKING_VISIBILITY_OFF_PROMPT_RE,
  QA_THINKING_VISIBILITY_MAX_PROMPT_RE,
  QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE,
  QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE,
  QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT_RE,
  QA_STREAMING_PROMPT_RE,
  QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE,
  QA_BLOCK_STREAMING_PROMPT_RE,
  QA_TOOL_PROGRESS_ERROR_PROMPT_RE,
  QA_TOOL_PROGRESS_PROMPT_RE,
  QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE,
  QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE,
  QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE,
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
  buildStrandedFinalRecoveryText,
  buildStrandedFinalRetryFailureText,
  isStrandedFinalRetryFailureRequest,
  QA_SUBAGENT_DIRECT_FALLBACK_MARKER,
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
  hasDeclaredCustomTool,
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
  extractPlannedToolCallId,
  extractPlannedToolArgs,
  splitMockStreamingText,
  buildQaLongFinalText,
  buildAssistantThenToolCallEvents,
  buildAssistantEvents,
  buildReasoningOnlyEvents,
  buildReasoningAndAssistantEvents,
} from "./mock-openai-events.js";
import {
  extractLastUserText,
  extractLastMatchingUserTurn,
  extractToolOutput,
  extractToolOutputStructuredError,
  extractToolOutputCallId,
  extractLatestToolOutput,
  extractAllToolOutputText,
  extractUserTextAfterLatestToolOutput,
  extractSlackMpimRetainedBotNonce,
  extractAllUserTexts,
  extractAllInputTexts,
  extractInstructionsText,
  extractAllRequestTexts,
  buildWhatsAppPendingHistoryReply,
  buildWhatsAppBroadcastReply,
  buildWhatsAppGroupDispatchReply,
  buildWhatsAppBatchedReply,
  countImageInputs,
  extractLatestImageUserTurn,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import {
  attachQaMockResponsesWebSocketServer,
  type QaMockResponsesDispatchResult,
} from "./mock-openai-responses-websocket.js";
import {
  readTargetFromPrompt,
  execCommandFromToolProgressPrompt,
  buildCustomToolCallEventsWithInput,
  buildToolCallEventsWithArgs as buildRawToolCallEventsWithArgs,
  extractOrbitCode,
  extractToolSearchTarget,
  buildQaToolSearchArgs,
  isActiveMemorySubagentPrompt,
  isSnackRecallPrompt,
  extractSnackPreference,
} from "./mock-openai-tooling.js";

const QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE =
  /(?:partial|quiet) streaming qa check|final-only marker streaming qa check|block streaming qa check|tool progress(?: error)? qa check/i;
const QA_STREAMING_TOOL_PROGRESS_CONTINUATION_RE =
  /^Continue with (?:the current Matrix QA scenario|the QA scenario plan and report worked, failed, and blocked items)\.$/i;
const QA_CODE_MODE_TARGET_MARKER = "qa-code-mode-target:";

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

function hasCodeModeExecSurface(body: Record<string, unknown>) {
  const tools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
  ];
  const execDefinition = findNamedToolDefinition(tools, "exec");
  if (!execDefinition || !hasToolDefinition(body, "wait")) {
    return false;
  }
  const schema =
    (execDefinition.input_schema as Record<string, unknown> | undefined) ??
    (execDefinition.parameters as Record<string, unknown> | undefined);
  if (!schema) {
    return false;
  }
  const properties = schema.properties;
  const required = schema.required;
  return (
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, "code") &&
    Array.isArray(required) &&
    required.includes("code")
  );
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

function isGeneratedCodeModeExecCall(toolCall: ResponsesInputItem | undefined) {
  if (!toolCall || toolCall.name !== "exec") {
    return false;
  }
  const args = parseToolCallArguments(toolCall);
  return typeof args?.code === "string" && decodeCodeModeTarget(args.code) !== null;
}

function isGeneratedCodeModeWaitCall(input: ResponsesInputItem[], toolCall: ResponsesInputItem) {
  if (toolCall.name !== "wait") {
    return false;
  }
  const runId = parseToolCallArguments(toolCall)?.runId;
  if (typeof runId !== "string") {
    return false;
  }
  return input.some((item) => {
    if (
      (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") ||
      typeof item.call_id !== "string"
    ) {
      return false;
    }
    const output = stringifyScenarioToolOutput(item.output);
    const parsed = parseToolOutputJson(output);
    return (
      parsed?.status === "waiting" &&
      parsed.runId === runId &&
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
    return buildRawToolCallEventsWithArgs(name, args);
  }
  const encodedTarget = encodeCodeModeTarget(name, args);
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
  if (wireName !== "exec" || typeof wireArgs?.code !== "string") {
    return { name: wireName, args: wireArgs, wireName };
  }
  const target = decodeCodeModeTarget(wireArgs.code);
  return target
    ? { name: target.name, args: target.args, wireName }
    : { name: wireName, args: wireArgs, wireName };
}

async function buildResponsesPayload(
  body: Record<string, unknown>,
  scenarioState: MockScenarioState,
) {
  const providerVariant = resolveProviderVariant(
    typeof body.model === "string" ? body.model : undefined,
  );
  const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
  const prompt = extractLastUserText(input);
  const rawToolOutput = extractToolOutput(input);
  const codeModeControlJson = isCodeModeControlToolOutput(body, input)
    ? parseToolOutputJson(rawToolOutput)
    : null;
  const toolOutput =
    codeModeControlJson?.status === "completed" && Object.hasOwn(codeModeControlJson, "value")
      ? stringifyScenarioToolOutput(codeModeControlJson.value)
      : rawToolOutput;
  const buildToolCallEventsWithArgs = (name: string, args: Record<string, unknown>) =>
    buildScenarioToolCallEvents(body, name, args);
  const allInputText = extractAllRequestTexts(input, body);
  const scenarioToolOutput =
    toolOutput ||
    (/thread memory check|session memory ranking check|memory tools check|repo contract followthrough check/i.test(
      allInputText,
    )
      ? extractLatestToolOutput(input)
      : "");
  const toolJson = parseToolOutputJson(scenarioToolOutput);
  if (
    codeModeControlJson?.status === "waiting" &&
    typeof codeModeControlJson.runId === "string" &&
    hasToolDefinition(body, "wait")
  ) {
    return buildRawToolCallEventsWithArgs("wait", { runId: codeModeControlJson.runId });
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
  const latestImageUserTurn = extractLatestImageUserTurn(input);
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
  const canCallMockSubagentTool =
    QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText) ||
    /subagent fanout synthesis check/i.test(allInputText) ||
    /forked subagent context qa check/i.test(allInputText) ||
    /delegate (?:one |a )bounded qa task/i.test(allInputText) ||
    /subagent handoff/i.test(allInputText) ||
    buildExplicitSessionsSpawnArgs(prompt) !== null;
  const canCallSessionsSpawn = hasDeclaredTool(body, "sessions_spawn") || canCallMockSubagentTool;
  const canCallSessionsYield =
    hasDeclaredTool(body, "sessions_yield") ||
    QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText);
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
  if (QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE.test(allInputText)) {
    if (!toolOutput) {
      scenarioState.toolLoopReadAttempts = 0;
    }
    if (/global circuit breaker/i.test(toolOutput)) {
      return buildAssistantEvents(exactReplyDirective ?? "GLOBAL-LOOP-BREAKER-OK");
    }
    scenarioState.toolLoopReadAttempts += 1;
    if (scenarioState.toolLoopReadAttempts > 31) {
      return buildAssistantEvents("GLOBAL-LOOP-BREAKER-NOT-REACHED");
    }
    return buildToolCallEventsWithArgs("read", { path: "LOOP_STEADY.txt" });
  }
  if (
    (QA_TOOL_SEARCH_PROMPT_RE.test(allInputText) ||
      QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText)) &&
    !toolOutput
  ) {
    const targetTool = extractToolSearchTarget(allInputText);
    const plannedArgs = targetTool
      ? buildQaToolSearchArgs(targetTool, QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText))
      : {};
    if (
      targetTool === "apply_patch" &&
      hasDeclaredCustomTool(body, targetTool) &&
      typeof plannedArgs.input === "string"
    ) {
      return buildCustomToolCallEventsWithInput(targetTool, plannedArgs.input);
    }
    if (targetTool && hasDeclaredTool(body, "tool_search_code")) {
      return buildToolCallEventsWithArgs("tool_search_code", {
        code: [
          `const hits = await openclaw.tools.search(${JSON.stringify(targetTool)}, { limit: 1 });`,
          "const match = hits.find((tool) => tool.name === " + JSON.stringify(targetTool) + ");",
          "if (!match) throw new Error('target tool not found');",
          `return await openclaw.tools.call(match.id, ${JSON.stringify(plannedArgs)});`,
        ].join("\n"),
      });
    }
    if (targetTool && (hasDeclaredTool(body, targetTool) || isQaToolSearchFixture(allInputText))) {
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
    if (!toolOutput && hasDeclaredTool(body, "exec")) {
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
    if (!toolOutput && hasDeclaredTool(body, "exec")) {
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
  if (
    allInputText.includes(QA_SUBAGENT_DIRECT_FALLBACK_MARKER) &&
    /Internal task completion event/i.test(allInputText)
  ) {
    return buildAssistantEvents("");
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText)) {
    if (!toolOutput && canCallSessionsSpawn) {
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: `Subagent direct fallback worker: finish with exactly ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
        label: "qa-direct-fallback-worker",
        thread: false,
        mode: "run",
      });
    }
    if (toolOutput && canCallSessionsYield && !/\byielded\b/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: `Waiting for ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
      });
    }
  }
  if (/remember this fact/i.test(prompt)) {
    return buildAssistantEvents(buildAssistantText(input, body, scenarioState));
  }
  if (isActiveEmptyResponseSideEffectRecovery) {
    if (allInputText.includes(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE)) {
      return buildAssistantEvents(
        exactMarkerDirective ?? exactReplyDirective ?? "TELEGRAM-EMPTY-WRITE-RECOVERED-OK",
      );
    }
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "qa-empty-response-side-effect.txt",
        content: "side effect completed once\n",
      });
    }
    return buildAssistantEvents("");
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
    /roundtrip image inspection check/i.test(latestImageUserTurn.text) &&
    latestImageUserTurn.imageInputCount > 0
  ) {
    return buildAssistantEvents(
      "Protocol note: the generated attachment shows the same QA lighthouse scene from the previous step.",
    );
  }
  if (
    /image understanding check/i.test(latestImageUserTurn.text) &&
    latestImageUserTurn.imageInputCount > 0
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
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasEmptyResponseRetryInstruction) {
      return buildAssistantEvents("");
    }
    return buildAssistantEvents("EMPTY-RECOVERED-OK");
  }
  if (QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE.test(allInputText)) {
    if (!toolOutput) {
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
    if (!toolOutput && hasDeclaredTool(body, "message")) {
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
    if (toolOutput) {
      return buildAssistantEvents(slackChartMatch[2]);
    }
  }
  if (QA_WHATSAPP_AGENT_MESSAGE_ACTION_REACT_PROMPT_RE.test(allInputText)) {
    if (!toolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "react",
        emoji: "👍",
      });
    }
    if (toolOutput) {
      return buildAssistantEvents("");
    }
  }
  const whatsAppUploadMatch = QA_WHATSAPP_AGENT_MESSAGE_ACTION_UPLOAD_PROMPT_RE.exec(allInputText);
  if (whatsAppUploadMatch?.[1]) {
    if (!toolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "upload-file",
        buffer: TINY_PNG_BASE64,
        caption: whatsAppUploadMatch[1],
        contentType: "image/png",
        filename: "whatsapp-qa-agent-upload.png",
      });
    }
    if (toolOutput) {
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
    if (!toolOutput) {
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
      if (!toolOutput && hasDeclaredTool(body, "message")) {
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
    if (toolOutput) {
      return buildAssistantEvents("");
    }
    const sessionsSendArgs = buildQaA2aMessageToolMirrorSessionsSendArgs(prompt);
    if (sessionsSendArgs && hasDeclaredTool(body, "sessions_send")) {
      return buildToolCallEventsWithArgs("sessions_send", sessionsSendArgs);
    }
  }
  if (QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE.test(allInputText)) {
    const marker = exactMarkerDirective ?? exactReplyDirective ?? "QA-GROUP-TOOL-OK";
    if (!toolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: marker,
      });
    }
    return buildAssistantEvents("");
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
    (Boolean(toolOutput) && QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(allInputText));
  if (isTelegramCurrentSessionStatusTurn) {
    if (!toolOutput && hasDeclaredTool(body, "session_status")) {
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
  if (QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(prompt) && !toolOutput) {
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
    if (!toolOutput) {
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
    if (!toolOutput) {
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
  if (
    /compaction retry mutating tool check/i.test(allInputText) ||
    /compaction retry evidence/i.test(toolOutput) ||
    /compaction-retry-summary\.txt/i.test(toolOutput)
  ) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "COMPACTION_RETRY_CONTEXT.md" });
    }
    if (toolOutput.includes("compaction retry evidence")) {
      return buildToolCallEventsWithArgs("write", {
        path: "compaction-retry-summary.txt",
        content: "Replay safety: unsafe after write.\n",
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
    if (!toolOutput) {
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
        query: "current Project Nebula codename ORBIT-10",
        maxResults: 3,
        corpus: "sessions",
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
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "hidden thread codename ORBIT-22",
        maxResults: 3,
      });
    }
    if (memoryToolUnavailable) {
      return buildAssistantEvents("NONE");
    }
    const transcriptOrbitCode = extractOrbitCode(scenarioToolOutput);
    if (transcriptOrbitCode) {
      return buildAssistantEvents(
        `Protocol note: I checked memory in-thread and the hidden thread codename is ${transcriptOrbitCode}.`,
      );
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
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
    return buildAssistantEvents("NONE");
  }
  if (
    QA_IMAGE_GENERATION_PROMPT_RE.test(allInputText) &&
    !toolOutput &&
    (hasToolDefinition(body, "image_generate") || hasCodeModeExecSurface(body))
  ) {
    return buildToolCallEventsWithArgs("image_generate", {
      prompt: "A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
      filename: "qa-lighthouse.png",
      size: "1024x1024",
    });
  }
  const isSubagentFanoutPrompt = /subagent fanout synthesis check/i.test(allInputText);
  if (
    !toolOutput &&
    /subagent fanout synthesis check/i.test(prompt) &&
    scenarioState.subagentFanoutPhase !== 0
  ) {
    scenarioState.subagentFanoutPhase = 0;
    scenarioState.subagentFanoutCompletedWorkers.clear();
  }
  if (canCallSessionsSpawn && isSubagentFanoutPrompt) {
    if (!toolOutput && scenarioState.subagentFanoutPhase === 0) {
      scenarioState.subagentFanoutPhase = 1;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "alpha"),
        label: "qa-fanout-alpha",
        thread: false,
      });
    }
    if (toolOutput && scenarioState.subagentFanoutPhase === 1) {
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
    if (scenarioState.subagentFanoutCompletedWorkers.size === 2) {
      scenarioState.subagentFanoutPhase = 3;
      return buildAssistantEvents("subagent-1: ok\nsubagent-2: ok");
    }
    if (hasToolDefinition(body, "sessions_yield") || hasCodeModeExecSurface(body)) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: "Waiting for both QA fanout workers to finish.",
      });
    }
    if (toolOutput) {
      scenarioState.subagentFanoutPhase = 3;
      return buildAssistantEvents("subagent-1: ok\nsubagent-2: ok");
    }
  }
  const explicitSessionsSpawnArgs = buildExplicitSessionsSpawnArgs(prompt);
  if (explicitSessionsSpawnArgs && !toolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", explicitSessionsSpawnArgs);
  }
  if (canCallSessionsSpawn && /forked subagent context qa check/i.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", {
      task: "Report the visible code from the requester transcript.",
      label: "qa-fork-context",
      mode: "run",
      context: "fork",
    });
  }
  if (/tool continuity check/i.test(prompt) && !toolOutput) {
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
    !toolOutput &&
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
    !toolOutput
  ) {
    return buildToolCallEventsWithArgs("read", {
      path: sourceDiscoveryReadPathForProvider(providerVariant),
    });
  }
  if (!toolOutput && /\b(read|inspect|repo|docs|scenario|kickoff)\b/i.test(prompt)) {
    return buildToolCallEvents(prompt);
  }
  if (/visible skill marker/i.test(prompt) && !toolOutput) {
    return buildAssistantEvents("VISIBLE-SKILL-OK");
  }
  if (/hot install marker/i.test(prompt) && !toolOutput) {
    return buildAssistantEvents("HOT-INSTALL-OK");
  }
  if (isGroupChat && isBaselineUnmentionedChannelChatter && !toolOutput) {
    return buildAssistantEvents("NO_REPLY");
  }
  if (QA_NATIVE_STOP_DELAY_PROMPT_RE.test(prompt)) {
    await sleep(QA_NATIVE_STOP_DELAY_MS);
  }
  return buildAssistantEvents(buildAssistantText(input, body, scenarioState));
}

export async function startQaMockOpenAiServer(params?: {
  host?: string;
  port?: number;
  finalOnlyMarkerPauseMs?: number;
  modelRefs?: readonly string[];
}) {
  const host = params?.host ?? "127.0.0.1";
  const finalOnlyMarkerPauseMs = params?.finalOnlyMarkerPauseMs ?? 1_500;
  const scenarioState: MockScenarioState = {
    anthropicThinkingErrorScenarioKeys: new Set<string>(),
    subagentFanoutCompletedWorkers: new Set<"alpha" | "beta">(),
    subagentFanoutPhase: 0,
    subagentHandoffSpawned: false,
    toolLoopReadAttempts: 0,
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
  const dispatchResponses = async (request: {
    body: Record<string, unknown>;
    raw: string;
  }): Promise<QaMockResponsesDispatchResult> => {
    const input = Array.isArray(request.body.input)
      ? (request.body.input as ResponsesInputItem[])
      : [];
    if (isRemoteCompactionV2Request(input)) {
      return { events: buildRemoteCompactionV2Events() };
    }
    const prompt = extractLastUserText(input);
    const allInputText = extractAllRequestTexts(input, request.body);
    const inflightRequestId = nextInflightRequestId++;
    inflightRequests.set(inflightRequestId, { prompt, allInputText });
    let events: StreamEvent[];
    try {
      events = await buildResponsesPayload(request.body, scenarioState);
    } finally {
      inflightRequests.delete(inflightRequestId);
    }
    const resolvedModel = typeof request.body.model === "string" ? request.body.model : "";
    const plannedTool = extractScenarioPlannedTool(events);
    recordRequest({
      raw: request.raw,
      body: request.body,
      prompt,
      allInputText,
      instructions: extractInstructionsText(request.body) || undefined,
      toolOutput: extractToolOutput(input),
      model: resolvedModel,
      providerVariant: resolveProviderVariant(resolvedModel),
      imageInputCount: countImageInputs(input),
      plannedToolCallId: extractPlannedToolCallId(events),
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
      ...(QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE.test(allInputText) && extractToolOutput(input)
        ? {
            failure: {
              status: 503,
              type: "server_error",
              message: "Service Unavailable",
            },
          }
        : {}),
      ...(QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE.test(allInputText)
        ? { previewPauseMs: finalOnlyMarkerPauseMs }
        : {}),
    };
  };
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
        const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
        if (isRemoteCompactionV2Request(input)) {
          const events = buildRemoteCompactionV2Events();
          if (body.stream === false) {
            writeJson(res, 200, events[1].response);
          } else {
            writeSse(res, events);
          }
          return;
        }
        const dispatched = await dispatchResponses({ body, raw });
        if (dispatched.failure) {
          writeJson(res, dispatched.failure.status, {
            error: {
              type: dispatched.failure.type,
              message: dispatched.failure.message,
            },
          });
          return;
        }
        const { events } = dispatched;
        if (body.stream === false) {
          const completion = events.at(-1);
          if (!completion || completion.type !== "response.completed") {
            writeJson(res, 500, { error: "mock completion failed" });
            return;
          }
          writeJson(res, 200, completion.response);
          return;
        }
        if (dispatched.previewPauseMs !== undefined) {
          await writeSseWithPreviewPause(res, events, dispatched.previewPauseMs);
        } else {
          writeSse(res, events);
        }
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
        const {
          events,
          input,
          responseBody,
          streamEvents,
          model: normalizedModel,
        } = await buildMessagesPayload(body, scenarioState, buildResponsesPayload);
        const plannedTool = extractScenarioPlannedTool(events);
        // Record the adapted request snapshot so /debug/requests gives the QA
        // suite the same plannedToolName / allInputText / toolOutput signals
        // on the Anthropic route that the OpenAI route already exposes. This
        // is what lets a single parity run diff assertions across both lanes.
        // Reuse the normalized model so an empty-string body.model no longer
        // leaks through to `lastRequest.model`.
        recordRequest({
          raw,
          body: body as Record<string, unknown>,
          prompt: extractLastUserText(input),
          allInputText: extractAllInputTexts(input),
          toolOutput: extractToolOutput(input),
          model: normalizedModel,
          providerVariant: resolveProviderVariant(normalizedModel),
          imageInputCount: countImageInputs(input),
          plannedToolCallId: extractPlannedToolCallId(events),
          plannedToolName: plannedTool.name,
          ...(plannedTool.wireName && plannedTool.wireName !== plannedTool.name
            ? { plannedWireToolName: plannedTool.wireName }
            : {}),
          plannedToolArgs: plannedTool.args,
          toolOutputCallId: extractToolOutputCallId(input) || undefined,
          ...(extractToolOutputStructuredError(input) ? { toolOutputStructuredError: true } : {}),
        });
        if (body.stream === true) {
          writeAnthropicSse(res, streamEvents);
          return;
        }
        writeJson(res, 200, responseBody);
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
