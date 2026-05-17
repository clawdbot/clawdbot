import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  scanDirectReplyTranscriptSentinels,
  scanGatewayLogSentinels,
  type GatewayLogSentinelFinding,
} from "./gateway-log-sentinel.js";

export type RuntimeId = "pi" | "codex";

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
  cells: { pi: RuntimeParityCell; codex: RuntimeParityCell };
  drift: RuntimeParityDrift;
  driftDetails?: string;
};

export type RuntimeParityScenarioExecution = {
  scenarioStatus: "pass" | "fail";
  scenarioDetails?: string;
  cell: RuntimeParityCell;
};

type QaGatewayLike = {
  logs?: () => string;
  tempRoot: string;
};

type QaSuiteScenarioLike = {
  details?: string;
  status: "pass" | "fail";
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

type RuntimeParityTranscriptRecord = {
  message: Record<string, unknown>;
  role: "user" | "assistant" | "tool" | "toolResult";
};

type RuntimeParityMockRequestSnapshot = {
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
const BOOT_STATE_LINE_RE =
  /\b(?:FailoverError|No API key found|Codex app-server|auth profile|runtime policy|restart mode:|plugin|doctor)\b/i;
const TOOL_RESULT_ERROR_RE = /\b(?:error|failed|failure|timeout|denied|enoent|not found)\b/i;

function normalizeTextForParity(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeForStableHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHash(record[key])]),
    );
  }
  return value;
}

function stableHash(value: unknown) {
  return sha256(JSON.stringify(normalizeForStableHash(value)) ?? "null");
}

function isMessageRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
      ...(TOOL_RESULT_ERROR_RE.test(contentText) ? { errorClass: "tool-result-error" } : {}),
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
    ordered[index] = { ...ordered[index], _resolved: true };
    const unresolvedIndex = unresolvedOrder.indexOf(index);
    if (unresolvedIndex >= 0) {
      unresolvedOrder.splice(unresolvedIndex, 1);
    }
    const toolIndices = unresolvedByTool.get(ordered[index].tool);
    if (!toolIndices) {
      return;
    }
    const nextIndices = toolIndices.filter((candidate) => candidate !== index);
    if (nextIndices.length > 0) {
      unresolvedByTool.set(ordered[index].tool, nextIndices);
      return;
    }
    unresolvedByTool.delete(ordered[index].tool);
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
            argsHash: stableHash(call.args),
            resultHash: stableHash(null),
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
              ? (ordered[pendingIndex]?.argsHash ?? stableHash(null))
              : stableHash(null),
          resultHash: stableHash(result.result),
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

  return ordered.map(({ _resolved: _ignored, ...toolCall }) => toolCall);
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
    ordered[index] = { ...ordered[index], _resolved: true };
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
            ? (ordered[pendingIndex]?.argsHash ?? stableHash(null))
            : stableHash(null),
        resultHash: stableHash(parsedOutput ?? rawToolOutput),
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
      argsHash: stableHash(request.plannedToolArgs ?? null),
      resultHash: stableHash(null),
      _resolved: false,
    });
    enqueueUnresolved(ordered.length - 1);
  }

  return ordered.map(({ _resolved: _ignored, ...toolCall }) => toolCall);
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

function compareToolCallShape(
  left: RuntimeParityToolCall[],
  right: RuntimeParityToolCall[],
): string | undefined {
  if (left.length !== right.length) {
    return `tool call count differs (${left.length} vs ${right.length})`;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCall = left[index];
    const rightCall = right[index];
    if (!leftCall || !rightCall) {
      return `tool call row ${index + 1} missing`;
    }
    if (leftCall.tool !== rightCall.tool || leftCall.argsHash !== rightCall.argsHash) {
      return `tool call ${index + 1} differs (${leftCall.tool}/${leftCall.argsHash} vs ${rightCall.tool}/${rightCall.argsHash})`;
    }
  }
  return undefined;
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
  pi: RuntimeParityCell;
  codex: RuntimeParityCell;
  piScenarioStatus: "pass" | "fail";
  codexScenarioStatus: "pass" | "fail";
}): Pick<RuntimeParityResult, "drift" | "driftDetails"> {
  if (
    isHardFailureRuntimeError(params.pi.runtimeErrorClass) ||
    isHardFailureRuntimeError(params.codex.runtimeErrorClass) ||
    params.pi.transportErrorClass ||
    params.codex.transportErrorClass
  ) {
    return {
      drift: "failure-mode",
      driftDetails:
        params.pi.transportErrorClass || params.codex.transportErrorClass
          ? "at least one runtime hit a transport failure"
          : "at least one runtime hit a hard runtime failure",
    };
  }

  const toolCallShapeDetails = compareToolCallShape(params.pi.toolCalls, params.codex.toolCalls);
  if (toolCallShapeDetails) {
    return { drift: "tool-call-shape", driftDetails: toolCallShapeDetails };
  }

  const toolResultShapeDetails = compareToolResultShape(
    params.pi.toolCalls,
    params.codex.toolCalls,
  );
  if (toolResultShapeDetails) {
    return { drift: "tool-result-shape", driftDetails: toolResultShapeDetails };
  }

  const piTranscriptLines = params.pi.transcriptBytes.trim().length
    ? params.pi.transcriptBytes.trim().split(/\r?\n/u).length
    : 0;
  const codexTranscriptLines = params.codex.transcriptBytes.trim().length
    ? params.codex.transcriptBytes.trim().split(/\r?\n/u).length
    : 0;
  if (
    piTranscriptLines !== codexTranscriptLines ||
    (!params.pi.finalText && !!params.codex.finalText) ||
    (!!params.pi.finalText && !params.codex.finalText)
  ) {
    return {
      drift: "structural",
      driftDetails: `transcript/final-text structure differs (${piTranscriptLines} lines vs ${codexTranscriptLines})`,
    };
  }

  if (
    params.piScenarioStatus === "fail" ||
    params.codexScenarioStatus === "fail" ||
    params.pi.runtimeErrorClass ||
    params.codex.runtimeErrorClass
  ) {
    return {
      drift: "failure-mode",
      driftDetails:
        params.piScenarioStatus === params.codexScenarioStatus
          ? "at least one runtime failed"
          : `scenario status differs (${params.piScenarioStatus} vs ${params.codexScenarioStatus})`,
    };
  }

  if (
    normalizeTextForParity(params.pi.finalText) === normalizeTextForParity(params.codex.finalText)
  ) {
    return { drift: "none" };
  }

  return { drift: "text-only", driftDetails: "final text differs after whitespace normalization" };
}

function resolveSessionTranscriptFile(params: {
  sessionsDir: string;
  sessionId: string;
  sessionEntry?: RuntimeParitySessionEntry;
}): string | undefined {
  const explicitSessionFile = readNonEmptyString(params.sessionEntry?.sessionFile);
  if (explicitSessionFile) {
    const candidate = path.isAbsolute(explicitSessionFile)
      ? explicitSessionFile
      : path.join(params.sessionsDir, explicitSessionFile);
    return candidate;
  }
  const baseName = `${params.sessionId}.jsonl`;
  return path.join(params.sessionsDir, baseName);
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

async function readRuntimeParitySessionEntries(params: {
  stateDir: string;
  agentId: string;
}): Promise<Array<RuntimeParitySessionEntry>> {
  const storePath = path.join(
    params.stateDir,
    "agents",
    params.agentId,
    "sessions",
    "sessions.json",
  );
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, RuntimeParitySessionEntry>;
    const entries = Object.values(parsed).filter((entry) => readNonEmptyString(entry?.sessionId));
    const rootEntries = entries.filter(isRuntimeParityRootSession);
    const candidates = rootEntries.length > 0 ? rootEntries : entries;
    return candidates.toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  } catch {
    return [];
  }
}

async function loadRuntimeParityTranscripts(params: {
  gateway: QaGatewayLike;
  agentId: string;
}): Promise<string> {
  const sessionsDir = path.join(
    params.gateway.tempRoot,
    "state",
    "agents",
    params.agentId,
    "sessions",
  );
  const sessionEntries = await readRuntimeParitySessionEntries({
    stateDir: path.join(params.gateway.tempRoot, "state"),
    agentId: params.agentId,
  });
  const transcripts: string[] = [];
  for (const sessionEntry of sessionEntries) {
    const sessionId = readNonEmptyString(sessionEntry.sessionId);
    if (!sessionId) {
      continue;
    }
    const sessionFile = resolveSessionTranscriptFile({
      sessionsDir,
      sessionId,
      sessionEntry,
    });
    if (!sessionFile) {
      continue;
    }
    try {
      const transcript = await fs.readFile(sessionFile, "utf8");
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
        plannedToolName: readNonEmptyString(entry.plannedToolName),
        plannedToolArgs: entry.plannedToolArgs ?? null,
        toolOutput: readNonEmptyString(entry.toolOutput) ?? "",
      }),
    );
    return resolveToolCallOrderFromMockRequests(requests);
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
  const mockToolCalls = await loadRuntimeParityMockToolCalls(params.mockBaseUrl);
  const gatewayLogs = params.gateway.logs?.();
  const sentinelFindings = [
    ...scanGatewayLogSentinels(gatewayLogs),
    ...scanDirectReplyTranscriptSentinels(transcriptBytes),
  ];
  const scenarioErrorClass = classifyScenarioError(params.scenarioResult.details);
  const sentinelErrorClass = summarizeSentinelErrorClass(sentinelFindings);
  return {
    runtime: params.runtime,
    transcriptBytes,
    toolCalls: mockToolCalls ?? resolveToolCallOrder(transcriptRecords),
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
  runCell: (runtime: RuntimeId) => Promise<RuntimeParityScenarioExecution>;
}): Promise<RuntimeParityResult> {
  const pi = await params.runCell("pi");
  const codex = await params.runCell("codex");
  const drift = classifyRuntimeParityCells({
    pi: pi.cell,
    codex: codex.cell,
    piScenarioStatus: pi.scenarioStatus,
    codexScenarioStatus: codex.scenarioStatus,
  });
  return {
    scenarioId: params.scenarioId,
    cells: {
      pi: pi.cell,
      codex: codex.cell,
    },
    drift: drift.drift,
    ...(drift.driftDetails ? { driftDetails: drift.driftDetails } : {}),
  };
}
