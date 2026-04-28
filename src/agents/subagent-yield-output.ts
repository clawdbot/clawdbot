function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readToolName(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of ["name", "toolName", "tool_name", "functionName", "function_name"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function isToolCallBlock(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return (
    record.type === "toolCall" ||
    record.type === "tool_use" ||
    record.type === "toolUse" ||
    record.type === "functionCall" ||
    record.type === "function_call"
  );
}

export function assistantCallsSessionsYield(message: unknown): boolean {
  const record = asRecord(message);
  if (!record || record.role !== "assistant" || !Array.isArray(record.content)) {
    return false;
  }
  return record.content.some(
    (block) => isToolCallBlock(block) && readToolName(block) === "sessions_yield",
  );
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function readStructuredToolPayload(content: unknown): Record<string, unknown> | undefined {
  const record = asRecord(content);
  if (record) {
    return record;
  }
  if (typeof content === "string") {
    return parseJsonObject(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const blockRecord = asRecord(block);
    if (!blockRecord) {
      continue;
    }
    const text = blockRecord.text;
    if (typeof text !== "string") {
      continue;
    }
    const parsed = parseJsonObject(text);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

export function isSessionsYieldToolResult(
  message: unknown,
  previousAssistantCalledYield: boolean,
): boolean {
  const record = asRecord(message);
  if (!record || (record.role !== "toolResult" && record.role !== "tool")) {
    return false;
  }
  const toolName = readToolName(record);
  if (toolName === "sessions_yield") {
    return true;
  }
  if (!previousAssistantCalledYield) {
    return false;
  }
  const details = asRecord(record.details);
  if (details?.status === "yielded") {
    return true;
  }
  const payload = readStructuredToolPayload(record.content);
  return payload?.status === "yielded";
}
