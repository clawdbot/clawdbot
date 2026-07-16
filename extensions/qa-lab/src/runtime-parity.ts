import {
  listSessionEntries,
  loadTranscriptEventsSync,
} from "openclaw/plugin-sdk/session-store-runtime";
// Qa Lab plugin module implements runtime parity behavior.
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asFiniteNumber as readFiniteNumber,
  isRecord as isMessageRecord,
  normalizeOptionalString as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  scanDirectReplyTranscriptSentinels,
  scanGatewayLogSentinels,
  type GatewayLogSentinelFinding,
} from "./gateway-log-sentinel.js";
import * as parity from "./parity-shared.js";

export type RuntimeId = "openclaw" | "codex";

export type RuntimeParityToolCall = {
  tool: string;
  argsHash: string;
  resultHash: string;
  errorClass?: string;
};

export type RuntimeParityUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type RuntimeParityUsagePolicy =
  | { expectation: "assistant-message-required" }
  | { expectation: "not-applicable"; reason: string };

export type RuntimeParityCell = {
  runtime: RuntimeId;
  transcriptBytes: string;
  toolCalls: RuntimeParityToolCall[];
  finalText: string;
  usage: RuntimeParityUsage;
  wallClockMs: number;
  transportErrorClass?: string;
  runtimeErrorClass?: string;
  bootStateLines: string[];
  sentinelFindings?: GatewayLogSentinelFinding[];
};

export type RuntimeParityDrift =
  | "none"
  | "text-only"
  | "tool-call-shape"
  | "tool-result-shape"
  | "structural"
  | "failure-mode";

export type RuntimeParityResult = {
  scenarioId: string;
  runtimeParityUsage?: RuntimeParityUsagePolicy;
  cells: {
    openclaw: RuntimeParityCell;
    codex: RuntimeParityCell;
  };
  drift: RuntimeParityDrift;
  driftDetails?: string;
};

export function resolveRuntimeParityUsagePolicy(value: unknown): RuntimeParityUsagePolicy {
  // Legacy or malformed summaries must not silently disable live-usage proof.
  if (!value || typeof value !== "object") {
    return { expectation: "assistant-message-required" };
  }
  const candidate = value as { expectation?: unknown; reason?: unknown };
  if (
    candidate.expectation === "not-applicable" &&
    typeof candidate.reason === "string" &&
    candidate.reason.trim()
  ) {
    return { expectation: "not-applicable", reason: candidate.reason.trim() };
  }
  return { expectation: "assistant-message-required" };
}

export type RuntimeParityScenarioExecution = {
  scenarioStatus: "pass" | "fail";
  scenarioDetails?: string;
  cell: RuntimeParityCell;
};

export function runtimeParityCellStatus(
  cell: RuntimeParityCell | undefined,
): "pass" | "fail" | "missing" {
  if (!cell) {
    return "missing";
  }
  return cell.runtimeErrorClass || cell.transportErrorClass ? "fail" : "pass";
}

export function isRuntimeParityResultPass(result: RuntimeParityResult) {
  return (
    result.drift !== "failure-mode" &&
    isRuntimeParityCellPassable(result.cells.openclaw) &&
    isRuntimeParityCellPassable(result.cells.codex)
  );
}

type QaGatewayLike = {
  logs?: () => string;
  tempRoot: string;
};

type QaSuiteScenarioLike = {
  details?: string;
  status: "pass" | "fail" | "skip";
  steps?: Array<{ details?: string; status?: "pass" | "fail" | "skip" }>;
};

type RuntimeParityCaptureParams = {
  runtime: RuntimeId;
  gateway: QaGatewayLike;
  scenarioResult: QaSuiteScenarioLike;
  wallClockMs: number;
  agentId?: string;
  mockBaseUrl?: string;
};

type RuntimeParitySessionEntry = {
  sessionId?: string;
  sessionFile?: string;
  updatedAt?: number;
  spawnedBy?: string;
  parentSessionKey?: string;
  spawnDepth?: number;
  subagentRole?: string;
};

type RuntimeParitySessionCandidate = {
  entry: RuntimeParitySessionEntry;
  sessionKey: string;
};

type RuntimeParityTranscriptRecord = {
  message: Record<string, unknown>;
  role: "user" | "assistant" | "tool" | "toolResult";
};

type RuntimeParityMockRequestSnapshot = {
  prompt?: string;
  allInputText?: string;
  plannedToolName?: string;
  plannedToolArgs?: unknown;
  toolOutput?: string;
};

type RuntimeParityPendingToolCall = RuntimeParityToolCall & {
  _resolved: boolean;
};

const DEFAULT_AGENT_ID = "qa";
const HEARTBEAT_RESPONSE_TOOL_NAME = "heartbeat_respond";
const HEARTBEAT_TRANSCRIPT_PROMPT = "[OpenClaw heartbeat poll]";
const HEARTBEAT_TASK_PROMPT_PREFIX =
  "Run the following periodic tasks (only those due based on their intervals):";
const TOOL_RESULT_MISSING_ERROR_CLASS = "tool-result-missing";
const BOOT_STATE_LINE_RE =
  /\b(?:FailoverError|No API key found|Codex app-server|auth profile|runtime policy|restart mode:|plugin|doctor)\b/i;
const TOOL_RESULT_ERROR_RE = /\b(?:error|failed|failure|timeout|denied|enoent|not found)\b/i;

function normalizeTextForParity(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function readUsageTotals(raw: unknown): RuntimeParityUsage {
  const usage = isMessageRecord(raw) ? raw : {};
  const inputTokens =
    readFiniteNumber(usage.input) ??
    readFiniteNumber(usage.inputTokens) ??
    readFiniteNumber(usage.input_tokens) ??
    0;
  const outputTokens =
    readFiniteNumber(usage.output) ??
    readFiniteNumber(usage.outputTokens) ??
    readFiniteNumber(usage.output_tokens) ??
    0;
  const cacheRead = readFiniteNumber(usage.cacheRead) ?? readFiniteNumber(usage.cache_read_tokens);
  const cacheWrite =
    readFiniteNumber(usage.cacheWrite) ?? readFiniteNumber(usage.cache_write_tokens);
  const componentTotal = inputTokens + outputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const totalTokens =
    readFiniteNumber(usage.total) ??
    readFiniteNumber(usage.totalTokens) ??
    readFiniteNumber(usage.total_tokens) ??
    componentTotal;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function addUsage(target: RuntimeParityUsage, next: RuntimeParityUsage) {
  target.inputTokens += next.inputTokens;
  target.outputTokens += next.outputTokens;
  target.totalTokens += next.totalTokens;
  if (next.cacheRead !== undefined) {
    target.cacheRead = (target.cacheRead ?? 0) + next.cacheRead;
  }
  if (next.cacheWrite !== undefined) {
    target.cacheWrite = (target.cacheWrite ?? 0) + next.cacheWrite;
  }
}

function extractAssistantText(message: Record<string, unknown>) {
  const rawContent = message.content;
  if (typeof rawContent === "string") {
    return rawContent.trim();
  }
  if (!Array.isArray(rawContent)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of rawContent) {
    if (typeof block === "string") {
      if (block.trim()) {
        parts.push(block.trim());
      }
      continue;
    }
    if (!isMessageRecord(block)) {
      continue;
    }
    const text = readNonEmptyString(block.text);
    if (text) {
      parts.push(text);
      continue;
    }
    const nestedText = readNonEmptyString(block.content);
    if (
      nestedText &&
      (block.type === "output_text" || block.type === "text" || block.type === "message")
    ) {
      parts.push(nestedText);
    }
  }
  return parts.join("\n").trim();
}

function normalizeToolCallId(value: unknown) {
  return readNonEmptyString(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isMessageRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractToolCalls(message: Record<string, unknown>): Array<{
  id?: string;
  tool: string;
  args: unknown;
}> {
  const calls: Array<{ id?: string; tool: string; args: unknown }> = [];
  const rawContent = message.content;
  if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (!isMessageRecord(block)) {
        continue;
      }
      const type = readNonEmptyString(block.type)?.toLowerCase();
      if (type !== "tool_use" && type !== "toolcall" && type !== "tool_call") {
        continue;
      }
      const tool = readNonEmptyString(block.name) ?? "unknown";
      calls.push({
        id:
          normalizeToolCallId(block.id) ??
          normalizeToolCallId(block.toolCallId) ??
          normalizeToolCallId(block.toolUseId),
        tool,
        args: block.input ?? block.arguments ?? block.args ?? block.payload ?? null,
      });
    }
  }
  const rawToolCalls =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : rawToolCalls ? [rawToolCalls] : [];
  for (const call of toolCalls) {
    if (!isMessageRecord(call)) {
      continue;
    }
    const functionRecord = isMessageRecord(call.function) ? call.function : undefined;
    const tool =
      readNonEmptyString(call.name) ?? readNonEmptyString(functionRecord?.name) ?? "unknown";
    calls.push({
      id:
        normalizeToolCallId(call.id) ??
        normalizeToolCallId(call.toolCallId) ??
        normalizeToolCallId(call.toolUseId),
      tool,
      args:
        call.arguments ?? functionRecord?.arguments ?? call.input ?? functionRecord?.input ?? null,
    });
  }
  return calls;
}

function extractToolResults(message: Record<string, unknown>): Array<{
  id?: string;
  tool?: string;
  result: unknown;
  errorClass?: string;
}> {
  const results: Array<{ id?: string; tool?: string; result: unknown; errorClass?: string }> = [];
  const toolName =
    readNonEmptyString(message.toolName) ??
    readNonEmptyString(message.tool_name) ??
    readNonEmptyString(message.name) ??
    readNonEmptyString(message.tool);
  if ((message.role === "tool" || message.role === "toolResult") && message.content !== undefined) {
    const contentText = extractAssistantText(message);
    results.push({
      tool: toolName,
      result: message.content,
      ...(message.isError === true || TOOL_RESULT_ERROR_RE.test(contentText)
        ? { errorClass: "tool-result-error" }
        : {}),
    });
  }
  const rawContent = message.content;
  if (!Array.isArray(rawContent)) {
    return results;
  }
  for (const block of rawContent) {
    if (!isMessageRecord(block)) {
      continue;
    }
    const type = readNonEmptyString(block.type)?.toLowerCase();
    if (type !== "tool_result" && type !== "tool_result_error") {
      continue;
    }
    const content = block.content ?? block.result ?? block.output ?? block.text ?? null;
    const contentText =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? JSON.stringify(content)
          : JSON.stringify(content ?? "");
    results.push({
      id:
        normalizeToolCallId(block.tool_use_id) ??
        normalizeToolCallId(block.toolUseId) ??
        normalizeToolCallId(block.tool_call_id) ??
        normalizeToolCallId(block.toolCallId),
      tool: toolName,
      result: content,
      ...(block.is_error === true ||
      type === "tool_result_error" ||
      TOOL_RESULT_ERROR_RE.test(contentText)
        ? { errorClass: "tool-result-error" }
        : {}),
    });
  }
  return results;
}

function classifyToolResultError(params: {
  rawOutput: string;
  parsedOutput: Record<string, unknown> | undefined;
}) {
  const error = readNonEmptyString(params.parsedOutput?.error);
  if (error) {
    return "tool-result-error";
  }
  const status = readNonEmptyString(params.parsedOutput?.status);
  if (status && /\b(?:error|failed|failure)\b/i.test(status)) {
    return "tool-result-error";
  }
  if (!params.parsedOutput) {
    const normalized = params.rawOutput.trim().toLowerCase();
    if (
      normalized.startsWith("error:") ||
      normalized.startsWith("failed:") ||
      normalized.includes("unsupported call:") ||
      normalized.includes("permission denied") ||
      normalized.includes("no such file") ||
      normalized.includes("enoent")
    ) {
      return "tool-result-error";
    }
  }
  return undefined;
}

function finalizeToolCallOrder(ordered: RuntimeParityPendingToolCall[]): RuntimeParityToolCall[] {
  return ordered.map(({ _resolved, ...toolCall }) =>
    _resolved
      ? toolCall
      : {
          ...toolCall,
          errorClass: toolCall.errorClass ?? TOOL_RESULT_MISSING_ERROR_CLASS,
        },
  );
}

function resolveToolCallOrder(records: RuntimeParityTranscriptRecord[]): RuntimeParityToolCall[] {
  const ordered: RuntimeParityPendingToolCall[] = [];
  const byId = new Map<string, number>();
  const unresolvedByTool = new Map<string, number[]>();
  const unresolvedOrder: number[] = [];

  const enqueueUnresolved = (tool: string, index: number) => {
    const indices = unresolvedByTool.get(tool) ?? [];
    indices.push(index);
    unresolvedByTool.set(tool, indices);
    unresolvedOrder.push(index);
  };

  const markResolved = (index: number) => {
    const pending = ordered[index];
    if (!pending) {
      return;
    }
    ordered[index] = { ...pending, _resolved: true };
    const unresolvedIndex = unresolvedOrder.indexOf(index);
    if (unresolvedIndex >= 0) {
      unresolvedOrder.splice(unresolvedIndex, 1);
    }
    const toolIndices = unresolvedByTool.get(pending.tool);
    if (!toolIndices) {
      return;
    }
    const nextIndices = toolIndices.filter((candidate) => candidate !== index);
    if (nextIndices.length > 0) {
      unresolvedByTool.set(pending.tool, nextIndices);
      return;
    }
    unresolvedByTool.delete(pending.tool);
  };

  const matchPendingIndex = (result: { id?: string; tool?: string }) => {
    if (result.id && byId.has(result.id)) {
      return byId.get(result.id);
    }
    if (result.tool) {
      const toolIndices = unresolvedByTool.get(result.tool);
      if (toolIndices && toolIndices.length > 0) {
        return toolIndices[0];
      }
    }
    return unresolvedOrder[0];
  };

  for (const record of records) {
    if (record.role === "assistant") {
      for (const call of extractToolCalls(record.message)) {
        const index =
          ordered.push({
            tool: call.tool,
            argsHash: parity.stableHash(call.args),
            resultHash: parity.stableHash(null),
            _resolved: false,
          }) - 1;
        if (call.id) {
          byId.set(call.id, index);
        }
        enqueueUnresolved(call.tool, index);
      }
    }
    if (record.role === "user" || record.role === "tool" || record.role === "toolResult") {
      for (const result of extractToolResults(record.message)) {
        const pendingIndex = matchPendingIndex(result);
        const nextValue: RuntimeParityToolCall = {
          tool:
            result.tool ??
            (pendingIndex !== undefined ? ordered[pendingIndex]?.tool : undefined) ??
            "unknown",
          argsHash:
            pendingIndex !== undefined
              ? (ordered[pendingIndex]?.argsHash ?? parity.stableHash(null))
              : parity.stableHash(null),
          resultHash: parity.stableHash(result.result),
          ...(result.errorClass ? { errorClass: result.errorClass } : {}),
        };
        if (pendingIndex === undefined || !ordered[pendingIndex]) {
          ordered.push({ ...nextValue, _resolved: true });
          continue;
        }
        ordered[pendingIndex] = {
          ...nextValue,
          _resolved: true,
        };
        markResolved(pendingIndex);
      }
    }
  }

  return finalizeToolCallOrder(ordered);
}

function resolveToolCallOrderFromMockRequests(
  requests: RuntimeParityMockRequestSnapshot[],
): RuntimeParityToolCall[] {
  const ordered: RuntimeParityPendingToolCall[] = [];
  const unresolvedOrder: number[] = [];

  const enqueueUnresolved = (index: number) => {
    unresolvedOrder.push(index);
  };

  const markResolved = (index: number) => {
    const pending = ordered[index];
    if (!pending) {
      return;
    }
    ordered[index] = { ...pending, _resolved: true };
    const unresolvedIndex = unresolvedOrder.indexOf(index);
    if (unresolvedIndex >= 0) {
      unresolvedOrder.splice(unresolvedIndex, 1);
    }
  };

  for (const request of requests) {
    const rawToolOutput = readNonEmptyString(request.toolOutput) ?? "";
    if (rawToolOutput) {
      const pendingIndex = unresolvedOrder[0];
      const parsedOutput = parseJsonRecord(rawToolOutput);
      const resolvedCall: RuntimeParityToolCall = {
        tool: pendingIndex !== undefined ? (ordered[pendingIndex]?.tool ?? "unknown") : "unknown",
        argsHash:
          pendingIndex !== undefined
            ? (ordered[pendingIndex]?.argsHash ?? parity.stableHash(null))
            : parity.stableHash(null),
        resultHash: parity.stableHash(parsedOutput ?? rawToolOutput),
        ...(classifyToolResultError({
          rawOutput: rawToolOutput,
          parsedOutput,
        })
          ? { errorClass: "tool-result-error" }
          : {}),
      };
      if (pendingIndex === undefined || !ordered[pendingIndex]) {
        ordered.push({ ...resolvedCall, _resolved: true });
      } else {
        ordered[pendingIndex] = {
          ...resolvedCall,
          _resolved: true,
        };
        markResolved(pendingIndex);
      }
    }

    const plannedToolName = readNonEmptyString(request.plannedToolName);
    if (!plannedToolName) {
      continue;
    }
    ordered.push({
      tool: plannedToolName,
      argsHash: parity.stableHash(request.plannedToolArgs ?? null),
      resultHash: parity.stableHash(null),
      _resolved: false,
    });
    enqueueUnresolved(ordered.length - 1);
  }

  return finalizeToolCallOrder(ordered);
}

function classifyScenarioError(details: string | undefined): string | undefined {
  const normalized = normalizeTextForParity(details ?? "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("no api key found")) {
    return "missing-api-key";
  }
  if (normalized.includes("failover")) {
    return "failover";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "timeout";
  }
  if (normalized.includes("codex app-server")) {
    return "codex-app-server";
  }
  if (
    normalized.includes("auth profile") ||
    normalized.includes("oauth") ||
    normalized.includes("api key")
  ) {
    return "auth";
  }
  if (normalized.includes("tool")) {
    return "tool-error";
  }
  return "scenario-failure";
}

function extractBootStateLines(logs: string | undefined): string[] {
  if (!logs) {
    return [];
  }
  return logs
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && BOOT_STATE_LINE_RE.test(line))
    .slice(-30);
}

function buildTranscriptRecords(transcriptBytes: string): RuntimeParityTranscriptRecord[] {
  const records: RuntimeParityTranscriptRecord[] = [];
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const message = isMessageRecord(parsed.message) ? parsed.message : undefined;
      const role = readNonEmptyString(message?.role);
      if (
        !message ||
        (role !== "user" && role !== "assistant" && role !== "tool" && role !== "toolResult")
      ) {
        continue;
      }
      records.push({
        message,
        role,
      });
    } catch {
      // Ignore malformed QA transcript rows and keep the classifier deterministic.
    }
  }
  return records;
}

function isHeartbeatOnlyRuntimeTranscript(transcriptBytes: string) {
  const records = buildTranscriptRecords(transcriptBytes);
  if (records.length === 0) {
    return false;
  }
  const userTexts = records
    .filter((record) => record.role === "user" && !isToolResultLikeMessage(record.message))
    .map((record) => extractAssistantText(record.message));
  return userTexts.length > 0 && userTexts.every(isHeartbeatRuntimeUserText);
}

function isToolResultLikeMessage(message: Record<string, unknown>) {
  if (message.role === "tool" || message.role === "toolResult") {
    return true;
  }
  const rawContent = message.content;
  if (!Array.isArray(rawContent)) {
    return false;
  }
  return rawContent.some((block) => {
    if (!isMessageRecord(block)) {
      return false;
    }
    const type = readNonEmptyString(block.type)?.toLowerCase();
    return type === "tool_result" || type === "toolresult" || type === "tool_result_error";
  });
}

function isHeartbeatRuntimeUserText(text: string) {
  const normalized = normalizeTextForParity(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === HEARTBEAT_TRANSCRIPT_PROMPT.toLowerCase()) {
    return true;
  }
  if (normalized.startsWith("read heartbeat.md") && normalized.includes("heartbeat_ok")) {
    return true;
  }
  if (
    normalized.startsWith("read heartbeat.md") &&
    normalized.includes(HEARTBEAT_RESPONSE_TOOL_NAME)
  ) {
    return true;
  }
  return (
    normalized.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX.toLowerCase()) &&
    (normalized.includes("heartbeat_ok") || normalized.includes(HEARTBEAT_RESPONSE_TOOL_NAME))
  );
}

function extractFinalAssistantText(records: RuntimeParityTranscriptRecord[]) {
  let lastAssistantText = "";
  for (const record of records) {
    if (record.role !== "assistant") {
      continue;
    }
    const text = extractAssistantText(record.message);
    if (text) {
      lastAssistantText = text;
    }
  }
  return normalizeTextForParity(lastAssistantText);
}

function aggregateUsage(records: RuntimeParityTranscriptRecord[]): RuntimeParityUsage {
  const totals: RuntimeParityUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  for (const record of records) {
    if (record.role !== "assistant") {
      continue;
    }
    const usage = readUsageTotals(record.message.usage ?? null);
    addUsage(totals, usage);
  }
  return totals;
}

function compareToolResultShape(
  left: RuntimeParityToolCall[],
  right: RuntimeParityToolCall[],
): string | undefined {
  const total = Math.min(left.length, right.length);
  for (let index = 0; index < total; index += 1) {
    const leftCall = left[index];
    const rightCall = right[index];
    if (!leftCall || !rightCall) {
      continue;
    }
    if (
      leftCall.errorClass === "tool-result-error" &&
      rightCall.errorClass === "tool-result-error"
    ) {
      continue;
    }
    if (
      leftCall.resultHash !== rightCall.resultHash ||
      (leftCall.errorClass ?? "") !== (rightCall.errorClass ?? "")
    ) {
      return `tool result ${index + 1} differs (${leftCall.tool})`;
    }
  }
  return undefined;
}

function isHardFailureRuntimeError(errorClass: string | undefined) {
  return (
    errorClass === "missing-api-key" ||
    errorClass === "failover" ||
    errorClass === "codex-app-server" ||
    errorClass === "auth" ||
    errorClass === "capture-missing" ||
    errorClass?.startsWith("sentinel:") === true
  );
}

export function isRuntimeParityCellPassable(cell: RuntimeParityCell | undefined) {
  if (!cell || cell.transportErrorClass || isHardFailureRuntimeError(cell.runtimeErrorClass)) {
    return false;
  }
  return !cell.runtimeErrorClass || cell.runtimeErrorClass === "tool-error";
}

function hasMissingToolResult(toolCalls: readonly RuntimeParityToolCall[]) {
  return toolCalls.some((toolCall) => toolCall.errorClass === TOOL_RESULT_MISSING_ERROR_CLASS);
}

function hasProvenTerminalImageResult(scenarioResult: QaSuiteScenarioLike) {
  return (
    scenarioResult.status === "pass" &&
    (scenarioResult.steps ?? []).some(
      (step) =>
        step.status === "pass" &&
        /(?:^|\n)image_generate=true\r?\nMEDIA:\S+/u.test(step.details ?? ""),
    )
  );
}

const PROVEN_TERMINAL_IMAGE_RESULT_HASH = parity.stableHash({ kind: "media", status: "success" });

function resolveRuntimeParityToolCalls(params: {
  mockToolCalls: RuntimeParityToolCall[] | null;
  transcriptToolCalls: RuntimeParityToolCall[];
  terminalImageResultProven?: boolean;
}): RuntimeParityToolCall[] {
  const mockImageCalls = (params.mockToolCalls ?? []).filter(
    (toolCall) => toolCall.tool === "image_generate",
  );
  const transcriptImageCalls = params.transcriptToolCalls.filter(
    (toolCall) => toolCall.tool === "image_generate",
  );
  const imageCaptureIsUnambiguous = parity.hasSingleDistinctLeftToolCallShape(
    mockImageCalls,
    transcriptImageCalls,
  );
  let selected: RuntimeParityToolCall[];
  if (!params.mockToolCalls) {
    selected = params.transcriptToolCalls;
  } else if (
    hasMissingToolResult(params.mockToolCalls) &&
    !hasMissingToolResult(params.transcriptToolCalls) &&
    parity.compareCapturedToolCallShape(params.mockToolCalls, params.transcriptToolCalls) ===
      undefined
  ) {
    selected = params.transcriptToolCalls;
  } else {
    selected = params.mockToolCalls;
  }
  const imageCalls = selected.filter((toolCall) => toolCall.tool === "image_generate");
  if (params.terminalImageResultProven && imageCaptureIsUnambiguous && imageCalls.length === 1) {
    selected = selected.map((toolCall) => {
      if (
        toolCall.tool !== "image_generate" ||
        (toolCall.errorClass !== undefined &&
          toolCall.errorClass !== TOOL_RESULT_MISSING_ERROR_CLASS)
      ) {
        return toolCall;
      }
      return {
        ...toolCall,
        resultHash: PROVEN_TERMINAL_IMAGE_RESULT_HASH,
        errorClass: undefined,
      };
    });
  }
  return selected;
}

function filterMockRequestsForParentPrompt(
  requests: RuntimeParityMockRequestSnapshot[],
  parentPrompt: string,
  parentPrompts: readonly string[] = [parentPrompt],
) {
  const normalizedParentPrompts = parentPrompts
    .map(normalizeTextForParity)
    .filter((prompt) => prompt.length > 0);
  if (normalizedParentPrompts.length === 0) {
    return requests;
  }
  const matching = requests.filter((request) => {
    const normalizedPrompt = normalizeTextForParity(request.prompt ?? "");
    if (normalizedPrompt) {
      return normalizedParentPrompts.some((prompt) => normalizedPrompt.includes(prompt));
    }
    const normalizedHistory = normalizeTextForParity(request.allInputText ?? "");
    return normalizedParentPrompts.some((prompt) => normalizedHistory.includes(prompt));
  });
  return matching.length > 0 ? matching : requests;
}

function summarizeSentinelErrorClass(findings: readonly GatewayLogSentinelFinding[]) {
  if (findings.length === 0) {
    return undefined;
  }
  return `sentinel:${findings
    .map((finding) => finding.kind)
    .toSorted((left, right) => left.localeCompare(right))
    .join(",")}`;
}

function classifyRuntimeParityCells(params: {
  openclaw: RuntimeParityCell;
  codex: RuntimeParityCell;
  openclawScenarioStatus: "pass" | "fail";
  codexScenarioStatus: "pass" | "fail";
}): Pick<RuntimeParityResult, "drift" | "driftDetails"> {
  if (
    isHardFailureRuntimeError(params.openclaw.runtimeErrorClass) ||
    isHardFailureRuntimeError(params.codex.runtimeErrorClass) ||
    params.openclaw.transportErrorClass ||
    params.codex.transportErrorClass
  ) {
    return {
      drift: "failure-mode",
      driftDetails:
        params.openclaw.transportErrorClass || params.codex.transportErrorClass
          ? "at least one runtime hit a transport failure"
          : "at least one runtime hit a hard runtime failure",
    };
  }

  if (
    hasMissingToolResult(params.openclaw.toolCalls) ||
    hasMissingToolResult(params.codex.toolCalls)
  ) {
    return {
      drift: "failure-mode",
      driftDetails: "at least one runtime planned a tool call without a tool result",
    };
  }

  if (
    params.openclawScenarioStatus === "fail" ||
    params.codexScenarioStatus === "fail" ||
    !isRuntimeParityCellPassable(params.openclaw) ||
    !isRuntimeParityCellPassable(params.codex)
  ) {
    return {
      drift: "failure-mode",
      driftDetails:
        params.openclawScenarioStatus === params.codexScenarioStatus
          ? "at least one runtime failed"
          : `scenario status differs (${params.openclawScenarioStatus} vs ${params.codexScenarioStatus})`,
    };
  }

  const toolCallShapeDetails = parity.compareToolCallShape(
    params.openclaw.toolCalls,
    params.codex.toolCalls,
  );
  if (toolCallShapeDetails) {
    return { drift: "tool-call-shape", driftDetails: toolCallShapeDetails };
  }

  const toolResultShapeDetails = compareToolResultShape(
    params.openclaw.toolCalls,
    params.codex.toolCalls,
  );
  if (toolResultShapeDetails) {
    return { drift: "tool-result-shape", driftDetails: toolResultShapeDetails };
  }

  const openclawTranscriptLines = params.openclaw.transcriptBytes.trim().length
    ? params.openclaw.transcriptBytes.trim().split(/\r?\n/u).length
    : 0;
  const codexTranscriptLines = params.codex.transcriptBytes.trim().length
    ? params.codex.transcriptBytes.trim().split(/\r?\n/u).length
    : 0;
  if (
    openclawTranscriptLines !== codexTranscriptLines ||
    (!params.openclaw.finalText && Boolean(params.codex.finalText)) ||
    (Boolean(params.openclaw.finalText) && !params.codex.finalText)
  ) {
    return {
      drift: "structural",
      driftDetails: `transcript/final-text structure differs (${openclawTranscriptLines} lines vs ${codexTranscriptLines})`,
    };
  }

  if (
    normalizeTextForParity(params.openclaw.finalText) ===
    normalizeTextForParity(params.codex.finalText)
  ) {
    return { drift: "none" };
  }

  return { drift: "text-only", driftDetails: "final text differs after whitespace normalization" };
}

function isRuntimeParityRootSession(entry: RuntimeParitySessionEntry) {
  if (readNonEmptyString(entry.spawnedBy) || readNonEmptyString(entry.parentSessionKey)) {
    return false;
  }
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return false;
  }
  if (readNonEmptyString(entry.subagentRole)) {
    return false;
  }
  return true;
}

function runtimeParitySessionEnv(stateDir: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

function readRuntimeParitySessionEntries(params: {
  stateDir: string;
  agentId: string;
}): RuntimeParitySessionCandidate[] {
  try {
    const entries = listSessionEntries({
      agentId: params.agentId,
      env: runtimeParitySessionEnv(params.stateDir),
    })
      .filter(({ entry }) => readNonEmptyString(entry.sessionId))
      .map(({ entry, sessionKey }) => ({
        entry: entry as RuntimeParitySessionEntry,
        sessionKey,
      }));
    const rootEntries = entries.filter(({ entry }) => isRuntimeParityRootSession(entry));
    const candidates = rootEntries.length > 0 ? rootEntries : entries;
    return candidates.toSorted(
      (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
    );
  } catch {
    return [];
  }
}

async function loadRuntimeParityTranscripts(params: {
  gateway: QaGatewayLike;
  agentId: string;
}): Promise<string> {
  const stateDir = `${params.gateway.tempRoot}/state`;
  const sessionEntries = readRuntimeParitySessionEntries({
    stateDir,
    agentId: params.agentId,
  });
  const transcripts: string[] = [];
  for (const { entry, sessionKey } of sessionEntries) {
    const sessionId = readNonEmptyString(entry.sessionId);
    if (!sessionId) {
      continue;
    }
    try {
      const events = loadTranscriptEventsSync({
        agentId: params.agentId,
        env: runtimeParitySessionEnv(stateDir),
        sessionId,
        sessionKey,
      });
      const transcript = events.map((event) => JSON.stringify(event)).join("\n");
      if (transcript.trim().length > 0 && !isHeartbeatOnlyRuntimeTranscript(transcript)) {
        transcripts.push(transcript.trimEnd());
        break;
      }
    } catch {
      // Ignore missing transcript files so failed cells still render.
    }
  }
  return transcripts.join("\n");
}

async function loadRuntimeParityMockToolCalls(
  mockBaseUrl: string | undefined,
  parentPrompt: string,
  parentPrompts: readonly string[] = [parentPrompt],
): Promise<RuntimeParityToolCall[] | null> {
  const normalizedBaseUrl = mockBaseUrl?.trim().replace(/\/+$/u, "");
  if (!normalizedBaseUrl) {
    return null;
  }
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${normalizedBaseUrl}/debug/requests`,
      policy: { allowPrivateNetwork: true },
      auditContext: "qa-lab-runtime-parity-mock-tool-calls",
    });
    let payload: unknown;
    try {
      if (!response.ok) {
        return null;
      }
      payload = await response.json();
    } finally {
      await release();
    }
    if (!Array.isArray(payload)) {
      return null;
    }
    const requests = payload.filter(isMessageRecord).map(
      (entry): RuntimeParityMockRequestSnapshot => ({
        prompt: readNonEmptyString(entry.prompt),
        allInputText: readNonEmptyString(entry.allInputText),
        plannedToolName: readNonEmptyString(entry.plannedToolName),
        plannedToolArgs: entry.plannedToolArgs ?? null,
        toolOutput: readNonEmptyString(entry.toolOutput) ?? "",
      }),
    );
    return resolveToolCallOrderFromMockRequests(
      filterMockRequestsForParentPrompt(requests, parentPrompt, parentPrompts),
    );
  } catch {
    return null;
  }
}

export async function captureRuntimeParityCell(
  params: RuntimeParityCaptureParams,
): Promise<RuntimeParityCell> {
  const agentId = params.agentId ?? DEFAULT_AGENT_ID;
  const transcriptBytes = await loadRuntimeParityTranscripts({
    gateway: params.gateway,
    agentId,
  });
  const transcriptRecords = buildTranscriptRecords(transcriptBytes);
  const transcriptToolCalls = resolveToolCallOrder(transcriptRecords);
  const parentPrompts = transcriptRecords
    .filter((record) => record.role === "user")
    .map((record) => extractAssistantText(record.message))
    .filter((prompt) => prompt.length > 0);
  const parentPrompt = parentPrompts[0] ?? "";
  const mockToolCalls = await loadRuntimeParityMockToolCalls(
    params.mockBaseUrl,
    parentPrompt,
    parentPrompts,
  );
  const gatewayLogs = params.gateway.logs?.();
  const sentinelFindings = [
    ...scanGatewayLogSentinels(gatewayLogs),
    ...scanDirectReplyTranscriptSentinels(transcriptBytes),
  ];
  // Retry passes retain first-attempt diagnostics; only terminal failures may
  // classify that historical text as the cell's runtime error.
  const scenarioErrorClass =
    params.scenarioResult.status === "pass"
      ? undefined
      : classifyScenarioError(params.scenarioResult.details);
  const sentinelErrorClass = summarizeSentinelErrorClass(sentinelFindings);
  const terminalImageResultProven = hasProvenTerminalImageResult(params.scenarioResult);
  return {
    runtime: params.runtime,
    transcriptBytes,
    toolCalls: resolveRuntimeParityToolCalls({
      mockToolCalls,
      transcriptToolCalls,
      terminalImageResultProven,
    }),
    finalText: extractFinalAssistantText(transcriptRecords),
    usage: aggregateUsage(transcriptRecords),
    wallClockMs: params.wallClockMs,
    ...(scenarioErrorClass || sentinelErrorClass
      ? { runtimeErrorClass: scenarioErrorClass ?? sentinelErrorClass }
      : {}),
    bootStateLines: extractBootStateLines(gatewayLogs),
    ...(sentinelFindings.length > 0 ? { sentinelFindings } : {}),
  };
}

export async function runRuntimeParityScenario(params: {
  scenarioId: string;
  runtimeParityUsage?: RuntimeParityUsagePolicy;
  runCell: (runtime: RuntimeId) => Promise<RuntimeParityScenarioExecution>;
}): Promise<RuntimeParityResult> {
  const openclaw = await params.runCell("openclaw");
  const codex = await params.runCell("codex");
  const drift = classifyRuntimeParityCells({
    openclaw: openclaw.cell,
    codex: codex.cell,
    openclawScenarioStatus: openclaw.scenarioStatus,
    codexScenarioStatus: codex.scenarioStatus,
  });
  return {
    scenarioId: params.scenarioId,
    runtimeParityUsage: resolveRuntimeParityUsagePolicy(params.runtimeParityUsage),
    cells: {
      openclaw: openclaw.cell,
      codex: codex.cell,
    },
    drift: drift.drift,
    ...(drift.driftDetails ? { driftDetails: drift.driftDetails } : {}),
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
