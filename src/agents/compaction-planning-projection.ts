/** Builds bounded transcript projections for compaction worker planning. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "./runtime/index.js";

const TEXT_TRUNCATE_THRESHOLD_CHARS = 32_768;
const TEXT_SAMPLE_CHARS = 8_192;
const PLANNING_MAX_CHARS = 256 * 1024;
const MAX_ARGUMENT_ESTIMATE_CHARS = 1_000_000;
const UNMEASURABLE_ARGUMENT_OMITTED_CHARS = Number.MAX_SAFE_INTEGER;
const OMITTED_CHARS_FIELD = "__openclawCompactionPlanningOmittedChars";

type ProjectionBudget = {
  remainingChars: number;
};

export function readCompactionPlanningOmittedChars(message: AgentMessage): number {
  const value = Reflect.get(message, OMITTED_CHARS_FIELD);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function projectText(
  text: string,
  budget: ProjectionBudget,
): { text: string; omittedChars: number } | null {
  if (text.length <= TEXT_TRUNCATE_THRESHOLD_CHARS && text.length <= budget.remainingChars) {
    budget.remainingChars -= text.length;
    return null;
  }
  const sample = truncateUtf16Safe(text, Math.min(TEXT_SAMPLE_CHARS, budget.remainingChars));
  budget.remainingChars -= sample.length;
  return {
    text: sample,
    omittedChars: text.length - sample.length,
  };
}

function jsonStringLengthWithin(text: string, maxChars: number): number | undefined {
  let length = 2;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const code = text.charCodeAt(index);
    const nextCode = text.charCodeAt(index + 1);
    const pairedSurrogate =
      code >= 0xd800 && code <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff;
    length += pairedSurrogate
      ? 2
      : code >= 0xd800 && code <= 0xdfff
        ? 6
        : char === '"' ||
            char === "\\" ||
            code === 8 ||
            code === 9 ||
            code === 10 ||
            code === 12 ||
            code === 13
          ? 2
          : code < 32
            ? 6
            : 1;
    if (pairedSurrogate) {
      index += 1;
    }
    if (length > maxChars) {
      return undefined;
    }
  }
  return length;
}

function jsonLengthWithin(
  value: unknown,
  maxChars: number,
  seen = new Set<object>(),
): number | undefined {
  if (typeof value === "string") {
    return jsonStringLengthWithin(value, maxChars);
  }
  if (value === null) {
    return 4;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const length = String(value).length;
    return length <= maxChars ? length : undefined;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return undefined;
  }

  seen.add(value);
  let length = 2;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const separatorLength = length === 2 ? 0 : 1;
      const entryLength = jsonLengthWithin(entry, maxChars - length - separatorLength, seen);
      if (entryLength === undefined) {
        return undefined;
      }
      length += separatorLength + entryLength;
      if (length > maxChars) {
        return undefined;
      }
    }
  } else {
    const record = value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) {
        continue;
      }
      const separatorLength = length === 2 ? 0 : 1;
      const keyLength = jsonStringLengthWithin(key, maxChars - length - separatorLength);
      const entryLength = jsonLengthWithin(
        record[key],
        maxChars - length - separatorLength - (keyLength ?? 0) - 1,
        seen,
      );
      if (keyLength === undefined || entryLength === undefined) {
        return undefined;
      }
      length += separatorLength + keyLength + entryLength + 1;
      if (length > maxChars) {
        return undefined;
      }
    }
  }
  seen.delete(value);
  return length;
}

function projectToolArguments(value: unknown, budget: ProjectionBudget): number | undefined {
  const length = jsonLengthWithin(value, budget.remainingChars);
  if (length !== undefined) {
    budget.remainingChars -= length;
    return undefined;
  }
  budget.remainingChars = 0;
  // Unmeasurable arguments must force an oversized plan, never understate token pressure.
  return (
    jsonLengthWithin(value, MAX_ARGUMENT_ESTIMATE_CHARS) ?? UNMEASURABLE_ARGUMENT_OMITTED_CHARS
  );
}

function projectContentBlock(
  block: unknown,
  budget: ProjectionBudget,
): { block: unknown; omittedChars: number; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, omittedChars: 0, changed: false };
  }
  const record = block as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "image" && typeof record.data === "string" && record.data.length > 0) {
    return {
      block: { ...record, data: "" },
      omittedChars: 0,
      changed: true,
    };
  }
  const hasText = typeof record.text === "string" && record.text.length > 0;
  const textIsModelVisible =
    type === "text" || ((type === "toolResult" || type === "tool_result") && hasText);
  const contentIsModelVisible =
    (type === "toolResult" || type === "tool_result") &&
    !hasText &&
    typeof record.content === "string";
  let next: Record<string, unknown> | undefined;
  let omittedChars = 0;
  for (const field of ["text", "content", "thinking"] as const) {
    if (field === "thinking" && type !== "thinking") {
      continue;
    }
    const value = record[field];
    const projected = typeof value === "string" ? projectText(value, budget) : null;
    if (!projected) {
      continue;
    }
    next ??= { ...record };
    next[field] = projected.text;
    const modelVisible =
      field === "thinking" || (field === "text" ? textIsModelVisible : contentIsModelVisible);
    omittedChars += modelVisible ? projected.omittedChars : 0;
  }
  if (type === "toolCall") {
    const omittedArguments = projectToolArguments(record.arguments, budget);
    if (omittedArguments !== undefined) {
      next ??= { ...record };
      next.arguments = {};
      omittedChars += omittedArguments;
    }
  }
  // Signatures never contribute model-visible compaction text and can dwarf the planning payload.
  for (const signature of ["textSignature", "thinkingSignature", "thoughtSignature"]) {
    if (signature in record) {
      next ??= { ...record };
      delete next[signature];
    }
  }
  return next
    ? { block: next, omittedChars, changed: true }
    : { block, omittedChars, changed: false };
}

function projectStringFields(
  message: AgentMessage,
  fields: readonly string[],
  budget: ProjectionBudget,
): AgentMessage {
  let omittedChars = readCompactionPlanningOmittedChars(message);
  let next: AgentMessage | undefined;
  for (const field of fields) {
    const value = Reflect.get(message, field);
    if (typeof value !== "string") {
      continue;
    }
    const projected = projectText(value, budget);
    if (!projected) {
      continue;
    }
    next ??= { ...message };
    Reflect.set(next, field, projected.text);
    omittedChars += projected.omittedChars;
  }
  return next ? Object.assign(next, { [OMITTED_CHARS_FIELD]: omittedChars }) : message;
}

function projectMessage(message: AgentMessage, budget: ProjectionBudget): AgentMessage {
  let source = message;
  if (message.role === "assistant") {
    source = {
      role: message.role,
      content: message.content,
      stopReason: message.stopReason,
      timestamp: message.timestamp,
    } as AgentMessage;
  } else if (message.role === "bashExecution") {
    const { fullOutputPath: _, ...rest } = message;
    source = rest as AgentMessage;
  } else if (message.role === "compactionSummary" || message.role === "custom") {
    const { details: _, ...rest } = message;
    source = rest as AgentMessage;
  }
  const content = (source as { content?: unknown }).content;
  if (typeof content === "string") {
    return projectStringFields(source, ["content"], budget);
  }
  if (!Array.isArray(content)) {
    switch (source.role) {
      case "bashExecution":
        return projectStringFields(source, ["command", "output"], budget);
      case "branchSummary":
      case "compactionSummary":
        return projectStringFields(source, ["summary"], budget);
      default:
        return source;
    }
  }

  let omittedChars = 0;
  let changed = false;
  const projectedContent = content.map((block) => {
    const projected = projectContentBlock(block, budget);
    omittedChars += projected.omittedChars;
    changed ||= projected.changed;
    return projected.block;
  });
  if (!changed) {
    return source;
  }
  return Object.assign({}, source, {
    content: projectedContent,
    [OMITTED_CHARS_FIELD]: readCompactionPlanningOmittedChars(source) + omittedChars,
  });
}

export function projectCompactionPlanningMessages(messages: AgentMessage[]): AgentMessage[] {
  const budget = { remainingChars: PLANNING_MAX_CHARS };
  return messages.map((message) => projectMessage(message, budget));
}
