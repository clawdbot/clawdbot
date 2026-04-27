export type ToolCallShapedTextDetection = {
  kind: "json_tool_call" | "xml_tool_call" | "bracketed_tool_call" | "react_action";
  toolName?: string;
};

const TOOL_TEXT_PREFILTER_RE =
  /(?:tool[_\s-]?calls?|function[_\s-]?call|["'](?:name|tool_name|function|arguments|args|input|parameters|tool_calls)["']|<\s*tool_call\b|Action\s*:|\[END_TOOL_REQUEST\])/i;
const MAX_SCAN_CHARS = 20_000;
const MAX_JSON_CANDIDATES = 20;
const MAX_JSON_CANDIDATE_CHARS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readToolName(record: Record<string, unknown>): string | undefined {
  return (
    readTrimmedString(record.name) ??
    readTrimmedString(record.tool_name) ??
    readTrimmedString(record.tool) ??
    readTrimmedString(record.function_name)
  );
}

function hasToolArgs(record: Record<string, unknown>): boolean {
  return "arguments" in record || "args" in record || "input" in record || "parameters" in record;
}

function classifyJsonValue(value: unknown): ToolCallShapedTextDetection | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const detection = classifyJsonValue(item);
      if (detection) {
        return detection;
      }
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const toolCalls = record.tool_calls ?? record.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      const detection = classifyJsonValue(toolCall);
      if (detection) {
        return detection;
      }
    }
    return { kind: "json_tool_call" };
  }

  const functionRecord = asRecord(record.function);
  if (functionRecord) {
    const toolName = readToolName(functionRecord);
    if (toolName && hasToolArgs(functionRecord)) {
      return { kind: "json_tool_call", toolName };
    }
  }

  const toolName = readToolName(record);
  if (toolName && hasToolArgs(record)) {
    return { kind: "json_tool_call", toolName };
  }

  const type = readTrimmedString(record.type)?.toLowerCase();
  if (
    toolName &&
    (type === "tool_call" ||
      type === "toolcall" ||
      type === "tooluse" ||
      type === "tool_use" ||
      type === "function_call" ||
      type === "functioncall")
  ) {
    return { kind: "json_tool_call", toolName };
  }

  return null;
}

function collectFencedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenceRe = /```(?:json|tool|tool_call|function_call)?[^\n\r]*[\r\n]([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    const candidate = match[1]?.trim();
    if (candidate && candidate.length <= MAX_JSON_CANDIDATE_CHARS) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function findBalancedJsonEnd(text: string, start: number): number | null {
  const opening = text[start];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : "";
  if (!closing) {
    return null;
  }

  const stack = [closing];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    if (index - start > MAX_JSON_CANDIDATE_CHARS) {
      return null;
    }
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack.at(-1) !== ch) {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

function collectBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < text.length && candidates.length < MAX_JSON_CANDIDATES; index += 1) {
    const ch = text[index];
    if (ch !== "{" && ch !== "[") {
      continue;
    }
    const end = findBalancedJsonEnd(text, index);
    if (end === null) {
      continue;
    }
    const candidate = text.slice(index, end).trim();
    if (candidate.length > 1) {
      candidates.push(candidate);
    }
    index = end - 1;
  }
  return candidates;
}

function detectJsonToolCall(text: string): ToolCallShapedTextDetection | null {
  const candidates = [...collectFencedJsonCandidates(text), ...collectBalancedJsonCandidates(text)];
  for (const candidate of candidates) {
    try {
      const detection = classifyJsonValue(JSON.parse(candidate));
      if (detection) {
        return detection;
      }
    } catch {
      // Text only needs to be diagnostic-grade; malformed JSON stays text.
    }
  }
  return null;
}

function detectXmlToolCall(text: string): ToolCallShapedTextDetection | null {
  if (!/<\s*tool_call\b/i.test(text)) {
    return null;
  }
  if (!/<\s*function=/i.test(text) && !/["']name["']\s*:\s*["'][^"']{1,120}["']/i.test(text)) {
    return null;
  }
  const toolName =
    /<\s*function=([A-Za-z0-9_.:-]{1,120})\b/i.exec(text)?.[1] ??
    /["']name["']\s*:\s*["']([^"']{1,120})["']/i.exec(text)?.[1]?.trim();
  return { kind: "xml_tool_call", ...(toolName ? { toolName } : {}) };
}

function detectBracketedToolCall(text: string): ToolCallShapedTextDetection | null {
  const match =
    /^\s*\[([A-Za-z_][A-Za-z0-9_.:-]{0,119})\]\s+[\s\S]*?\[END_TOOL_REQUEST\]\s*$/i.exec(text);
  if (!match?.[1]) {
    return null;
  }
  return { kind: "bracketed_tool_call", toolName: match[1] };
}

function detectReactAction(text: string): ToolCallShapedTextDetection | null {
  const match =
    /(?:^|\n)\s*Action\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})\s*(?:\r?\n)+\s*Action Input\s*:/i.exec(
      text,
    );
  if (!match?.[1]) {
    return null;
  }
  return { kind: "react_action", toolName: match[1] };
}

export function detectToolCallShapedText(text: string): ToolCallShapedTextDetection | null {
  const trimmed = text.slice(0, MAX_SCAN_CHARS).trim();
  if (!trimmed || !TOOL_TEXT_PREFILTER_RE.test(trimmed)) {
    return null;
  }
  return (
    detectBracketedToolCall(trimmed) ??
    detectXmlToolCall(trimmed) ??
    detectJsonToolCall(trimmed) ??
    detectReactAction(trimmed)
  );
}
