import {
  inferToolMetaFromArgs,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  itemName,
  itemStatus,
  shouldSynthesizeToolProgressForItem,
} from "./event-projector-items.js";
import {
  collectDynamicToolContentText,
  truncateToolTranscriptText,
} from "./event-projector-tool-output.js";
import {
  normalizeNonEmptyString,
  readNonEmptyString,
  readNonEmptyStringArray,
} from "./event-projector-values.js";
import { isJsonObject, type CodexThreadItem, type JsonObject } from "./protocol.js";
import {
  sanitizeCodexAgentEventRecord,
  sanitizeCodexToolArguments,
} from "./tool-progress-normalization.js";

export function nativeToolActionFingerprint(item: CodexThreadItem): string | undefined {
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return JSON.stringify({
      type: item.type,
      command: item.command,
      cwd: typeof item.cwd === "string" ? item.cwd : "",
    });
  }
  if (item.type === "fileChange") {
    return JSON.stringify({
      type: item.type,
      changes: itemFileChanges(item),
    });
  }
  return undefined;
}

export function isNativePostToolUseRelayItem(item: CodexThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
      return true;
    default:
      return false;
  }
}

export function shouldSuppressChannelProgressForItem(item: CodexThreadItem): boolean {
  if (shouldSynthesizeToolProgressForItem(item)) {
    return true;
  }
  // Dynamic OpenClaw tool requests are emitted at the item/tool/call request
  // boundary. Re-emitting item notifications can duplicate start/result progress.
  return item.type === "dynamicToolCall";
}

export function itemToolArgs(item: CodexThreadItem): Record<string, unknown> | undefined {
  if (item.type === "commandExecution") {
    return sanitizeCodexAgentEventRecord({
      command: item.command,
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
    });
  }
  if (item.type === "fileChange") {
    return sanitizeCodexAgentEventRecord({
      changes: itemFileChangesForTranscript(item),
    });
  }
  if (item.type === "webSearch") {
    return webSearchToolArgs(item);
  }
  if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") {
    return sanitizeCodexToolArguments(item.arguments);
  }
  return undefined;
}

function webSearchToolArgs(item: CodexThreadItem): Record<string, unknown> {
  const action = isJsonObject(item.action) ? item.action : undefined;
  const actionType = action ? readNonEmptyString(action, "type") : undefined;
  const queries =
    action && actionType === "search" ? readNonEmptyStringArray(action, "queries") : [];
  const query =
    normalizeNonEmptyString(item.query) ??
    (action && actionType === "search" ? readNonEmptyString(action, "query") : undefined) ??
    queries[0];
  const url = action ? readNonEmptyString(action, "url") : undefined;
  const pattern = action ? readNonEmptyString(action, "pattern") : undefined;
  const args: Record<string, unknown> = {};
  if (query) {
    args.query = query;
  }
  if (queries.length > 0) {
    args.queries = queries;
  }
  if (actionType && actionType !== "search") {
    args.action = actionType;
  }
  if (url) {
    args.url = url;
  }
  if (pattern) {
    args.pattern = pattern;
  }
  if (!query && !url && !pattern) {
    args.queryUnavailable = true;
  }
  return sanitizeCodexAgentEventRecord(args);
}

export function itemToolResult(item: CodexThreadItem): { result?: Record<string, unknown> } {
  if (item.type === "commandExecution") {
    return {
      result: sanitizeCodexAgentEventRecord({
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      }),
    };
  }
  if (item.type === "fileChange") {
    return {
      result: sanitizeCodexAgentEventRecord({
        status: item.status,
        changes: itemFileChanges(item),
      }),
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      result: sanitizeCodexAgentEventRecord({
        status: item.status,
        durationMs: item.durationMs,
        ...(item.error ? { error: item.error } : {}),
        ...(item.result ? { result: item.result } : {}),
      }),
    };
  }
  if (item.type === "webSearch") {
    return { result: webSearchToolResult(item) };
  }
  return {};
}

function webSearchToolResult(item: CodexThreadItem): Record<string, unknown> {
  return sanitizeCodexAgentEventRecord({
    status: itemStatus(item),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...webSearchToolArgs(item),
  });
}

type CodexFileChangeSummary = {
  path: string;
  kind: unknown;
};

type CodexTranscriptFileChange = CodexFileChangeSummary & {
  diff?: string;
  diffTruncated?: true;
  stat?: { added: number; removed: number };
};

function itemFileChangeRecords(item: CodexThreadItem): JsonObject[] {
  const changes = (item as Record<string, unknown>).changes;
  return Array.isArray(changes) ? changes.filter(isJsonObject) : [];
}

function itemFileChanges(item: CodexThreadItem): CodexFileChangeSummary[] {
  return itemFileChangeRecords(item).flatMap((change) => {
    const path = normalizeNonEmptyString(change.path);
    if (!path || change.kind === undefined) {
      return [];
    }
    return [{ path, kind: change.kind }];
  });
}

function fileChangeKindType(kind: unknown): string | undefined {
  if (typeof kind === "string") {
    return kind;
  }
  return isJsonObject(kind) ? normalizeNonEmptyString(kind.type) : undefined;
}

function countFileContentLines(content: string): number {
  if (!content) {
    return 0;
  }
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}

function fileChangeDiffStat(diff: string, kind: unknown): { added: number; removed: number } {
  const kindType = fileChangeKindType(kind);
  if (kindType === "add") {
    return { added: countFileContentLines(diff), removed: 0 };
  }
  if (kindType === "delete") {
    return { added: 0, removed: countFileContentLines(diff) };
  }
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function truncateFileChangeDiffAtLineBoundary(
  diff: string,
  maxChars: number,
): { diff?: string; diffTruncated?: true } {
  if (diff.length <= maxChars) {
    return { diff };
  }
  if (maxChars <= 0) {
    return { diffTruncated: true };
  }
  const boundary = diff.lastIndexOf("\n", maxChars - 1);
  return boundary >= 0
    ? { diff: diff.slice(0, boundary + 1), diffTruncated: true }
    : { diffTruncated: true };
}

function itemFileChangesForTranscript(item: CodexThreadItem): CodexTranscriptFileChange[] {
  let remainingDiffChars = 10_000;
  return itemFileChangeRecords(item).flatMap((change) => {
    const path = normalizeNonEmptyString(change.path);
    if (!path || change.kind === undefined) {
      return [];
    }
    const result: CodexTranscriptFileChange = { path, kind: change.kind };
    if (typeof change.diff !== "string") {
      return [result];
    }
    result.stat = fileChangeDiffStat(change.diff, change.kind);
    const bounded = truncateFileChangeDiffAtLineBoundary(change.diff, remainingDiffChars);
    if (bounded.diff !== undefined) {
      result.diff = bounded.diff;
      remainingDiffChars -= bounded.diff.length;
    }
    if (bounded.diffTruncated) {
      result.diffTruncated = true;
    }
    return [result];
  });
}

export function itemToolError(
  item: CodexThreadItem,
  status: ReturnType<typeof itemStatus>,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  if (status === "blocked") {
    return "codex native tool blocked";
  }
  if (status !== "failed") {
    return undefined;
  }
  return itemOutputText(item, outputTextByItem) ?? "codex native tool failed";
}

export function itemMeta(
  item: CodexThreadItem,
  detailMode: ToolProgressDetailMode = "explain",
): string | undefined {
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return inferToolMetaFromArgs(
      "exec",
      {
        command: item.command,
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      },
      { detailMode },
    );
  }
  if (item.type === "webSearch") {
    return inferToolMetaFromArgs("web_search", webSearchToolArgs(item), { detailMode });
  }
  const toolName = itemName(item);
  if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") && toolName) {
    return inferToolMetaFromArgs(toolName, item.arguments, { detailMode });
  }
  return undefined;
}

export function itemOutputText(
  item: CodexThreadItem,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput?.trim() || outputTextByItem?.get(item.id)?.trim();
    return output ? truncateToolTranscriptText(output) : undefined;
  }
  if (item.type === "dynamicToolCall") {
    const output = collectDynamicToolContentText(item.contentItems).trim();
    return output ? truncateToolTranscriptText(output) : undefined;
  }
  if (item.type === "mcpToolCall") {
    const output = item.error
      ? stringifyJsonValue(item.error)
      : item.result
        ? stringifyJsonValue(item.result)
        : undefined;
    return output ? truncateToolTranscriptText(output) : undefined;
  }
  return undefined;
}

export function itemTranscriptResultText(
  item: CodexThreadItem,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  const output = itemOutputText(item, outputTextByItem);
  if (output) {
    return output;
  }
  const result = itemToolResult(item).result;
  const resultText = result ? stringifyJsonValue(result) : undefined;
  return resultText ? truncateToolTranscriptText(resultText) : itemStatus(item);
}

function stringifyJsonValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}
