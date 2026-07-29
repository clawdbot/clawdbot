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
  const value = (message as unknown as Record<string, unknown>)[OMITTED_CHARS_FIELD];
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

function projectToolArguments(
  value: unknown,
  budget: ProjectionBudget,
): { value: Record<string, never>; omittedChars: number; changed: boolean } {
  const length = jsonLengthWithin(value, budget.remainingChars);
  if (length !== undefined) {
    budget.remainingChars -= length;
    return { value: {}, omittedChars: 0, changed: false };
  }
  budget.remainingChars = 0;
  return {
    value: {},
    // Unmeasurable arguments must force an oversized plan, never understate token pressure.
    omittedChars:
      jsonLengthWithin(value, MAX_ARGUMENT_ESTIMATE_CHARS) ?? UNMEASURABLE_ARGUMENT_OMITTED_CHARS,
    changed: true,
  };
}

function projectContentBlock(
  block: unknown,
  projectTextContent: boolean,
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
  if (!projectTextContent) {
    return { block, omittedChars: 0, changed: false };
  }
  const hasText = typeof record.text === "string" && record.text.length > 0;
  const textIsModelVisible =
    type === "text" || ((type === "toolResult" || type === "tool_result") && hasText);
  const contentIsModelVisible =
    (type === "toolResult" || type === "tool_result") &&
    !hasText &&
    typeof record.content === "string";
  const projectedText = typeof record.text === "string" ? projectText(record.text, budget) : null;
  const projectedContent =
    typeof record.content === "string" ? projectText(record.content, budget) : null;
  const projectedThinking =
    type === "thinking" && typeof record.thinking === "string"
      ? projectText(record.thinking, budget)
      : null;
  const projectedArguments =
    type === "toolCall" ? projectToolArguments(record.arguments, budget) : undefined;
  // Tool-call IDs are provider-generated and bounded in practice. Planning never uses them as
  // durable keys, so malformed giant IDs do not justify an ID-remapping protocol here.
  const hasPlanningIrrelevantSignature =
    "textSignature" in record || "thinkingSignature" in record || "thoughtSignature" in record;
  if (
    !projectedText &&
    !projectedContent &&
    !projectedThinking &&
    !projectedArguments?.changed &&
    !hasPlanningIrrelevantSignature
  ) {
    return { block, omittedChars: 0, changed: false };
  }
  const next = { ...record };
  let omittedChars = 0;
  if (projectedText) {
    next.text = projectedText.text;
    omittedChars += textIsModelVisible ? projectedText.omittedChars : 0;
  }
  if (projectedContent) {
    next.content = projectedContent.text;
    omittedChars += contentIsModelVisible ? projectedContent.omittedChars : 0;
  }
  if (projectedThinking) {
    next.thinking = projectedThinking.text;
    omittedChars += projectedThinking.omittedChars;
  }
  if (projectedArguments?.changed) {
    next.arguments = projectedArguments.value;
    omittedChars += projectedArguments.omittedChars;
  }
  delete next.textSignature;
  delete next.thinkingSignature;
  delete next.thoughtSignature;
  return { block: next, omittedChars, changed: true };
}

function projectStringFields(
  message: AgentMessage,
  fields: readonly string[],
  budget: ProjectionBudget,
): AgentMessage {
  const record = message as unknown as Record<string, unknown>;
  let omittedChars = readCompactionPlanningOmittedChars(message);
  let next: Record<string, unknown> | undefined;
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string") {
      continue;
    }
    const projected = projectText(value, budget);
    if (!projected) {
      continue;
    }
    next ??= { ...record };
    next[field] = projected.text;
    omittedChars += projected.omittedChars;
  }
  return next
    ? ({ ...next, [OMITTED_CHARS_FIELD]: omittedChars } as unknown as AgentMessage)
    : message;
}

function projectMessage(message: AgentMessage, budget: ProjectionBudget): AgentMessage {
  const source = (() => {
    switch (message.role) {
      case "assistant":
        return {
          role: message.role,
          content: message.content,
          stopReason: message.stopReason,
          timestamp: message.timestamp,
        } as AgentMessage;
      case "bashExecution": {
        const { fullOutputPath: _, ...rest } = message;
        return rest as AgentMessage;
      }
      case "compactionSummary": {
        const { details: _, ...rest } = message;
        return rest as AgentMessage;
      }
      case "custom": {
        const { details: _, ...rest } = message;
        return rest as AgentMessage;
      }
      default:
        return message;
    }
  })();
  const currentOmittedChars = readCompactionPlanningOmittedChars(source);
  const content = (source as { content?: unknown }).content;
  if (typeof content === "string") {
    const projected = projectText(content, budget);
    if (!projected) {
      return source;
    }
    return {
      ...(source as unknown as Record<string, unknown>),
      content: projected.text,
      [OMITTED_CHARS_FIELD]: currentOmittedChars + projected.omittedChars,
    } as unknown as AgentMessage;
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
    const projected = projectContentBlock(block, true, budget);
    omittedChars += projected.omittedChars;
    changed ||= projected.changed;
    return projected.block;
  });
  if (!changed) {
    return source;
  }
  return {
    ...(source as unknown as Record<string, unknown>),
    content: projectedContent,
    [OMITTED_CHARS_FIELD]: currentOmittedChars + omittedChars,
  } as unknown as AgentMessage;
}

export function projectCompactionPlanningMessages(messages: AgentMessage[]): AgentMessage[] {
  const budget = { remainingChars: PLANNING_MAX_CHARS };
  return messages.map((message) => projectMessage(message, budget));
}
