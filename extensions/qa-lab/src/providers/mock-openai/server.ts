// QA Lab mock Responses dispatcher, HTTP transport, and debug endpoints.
import { createServer } from "node:http";
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
  createMockFixtureContext,
  findMockFixturePlan,
  type MockFixturePlan,
} from "./mock-fixtures.js";
import { buildAssistantText } from "./mock-openai-assistant-text.js";
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
  QA_COMPACTION_RETRY_PROMPT_RE,
  QA_COMPACTION_SUMMARY_INSTRUCTIONS_RE,
  QA_COMPACTION_RETRY_OVERFLOW_THRESHOLD_BYTES,
  QA_COMPACTION_OUTPUT_RECOVERY_OVERFLOW_THRESHOLD_BYTES,
  QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE,
  QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE,
  QA_CODE_MODE_TARGET_MARKER,
  QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE,
  QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE,
  QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE,
  QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE,
  type MockScenarioState,
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
import { hasToolDefinition } from "./mock-openai-directives.js";
import {
  buildToolCallEvents,
  extractPlannedToolName,
  extractPlannedToolIdentity,
  extractPlannedToolArgs,
  buildAssistantThenToolCallEvents,
  buildAssistantEvents,
  buildReasoningOnlyEvents,
  buildReasoningAndAssistantEvents,
} from "./mock-openai-events.js";
import {
  extractLastUserText,
  extractLastMatchingUserTurn,
  hasToolOutput,
  extractToolOutput,
  extractToolOutputValue,
  extractToolOutputStructuredError,
  extractToolOutputCallId,
  extractInstructionsText,
  extractAllRequestTexts,
  countImageInputs,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import { attachQaMockResponsesWebSocketServer } from "./mock-openai-responses-websocket.js";
import {
  buildCustomToolCallEventsWithInput,
  buildToolCallEventsWithArgs as buildRawToolCallEventsWithArgs,
} from "./mock-openai-tooling.js";

function hasCompactionOutputRecoveryMarker(allInputText: string) {
  return (
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.test(allInputText) ||
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.test(allInputText)
  );
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

async function renderMockFixturePlan(
  plan: MockFixturePlan,
  toolDeclarationBody: Record<string, unknown>,
) {
  switch (plan.kind) {
    case "reply":
      return buildAssistantEvents(plan.text);
    case "tool":
      return plan.raw
        ? buildRawToolCallEventsWithArgs(plan.name, plan.args)
        : buildScenarioToolCallEvents(toolDeclarationBody, plan.name, plan.args);
    case "stream":
      return buildAssistantEvents([plan.message]);
    case "assistant-tool":
      return buildAssistantThenToolCallEvents(plan.message, plan.tool.name, plan.tool.args);
    case "reasoning":
      return buildReasoningOnlyEvents(plan.text, plan.id);
    case "reasoning-reply":
      return buildReasoningAndAssistantEvents({
        reasoningId: plan.reasoningId,
        answerText: plan.answerText,
      });
    case "custom":
      return await plan.render();
    case "fault":
      throw new Error(
        `fixture fault plans must be rendered by the provider dispatch: ${plan.type}`,
      );
  }
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
  const providerVariant = resolveProviderVariant(
    typeof body.model === "string" ? body.model : undefined,
  );
  const input = normalizeResponsesInput(body.input);
  const toolDeclarationBody = resolveCurrentToolDeclarationSurface(body, input);
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
  const context = createMockFixtureContext({
    body,
    input,
    scenarioState,
    requestKind: options.requestKind ?? classifyMockOpenAiRequest(input, body),
    compactionSummaryFaultMode: options.compactionSummaryFaultMode ?? "none",
    toolDeclarationBody,
    toolOutput,
    completedToolName,
    codeModeControlJson,
    hasCallableCodeMode: hasCodeModeExecSurface(toolDeclarationBody),
    providerVariant,
    childSessionKey: resolveQaChildSessionKey(input, body),
    waitForTerminalRequesterSettled: options.waitForTerminalRequesterSettled,
    buildPromptToolEvents: buildToolCallEvents,
  });
  const plan = await findMockFixturePlan(context);
  return plan
    ? await renderMockFixturePlan(plan, toolDeclarationBody)
    : buildAssistantEvents(buildAssistantText(input, body));
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
      outcome: failure ? "error" : "success",
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
