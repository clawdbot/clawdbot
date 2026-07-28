import {
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from "@opentelemetry/semantic-conventions/incubating";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  MAX_OTEL_CONTENT_ARRAY_ITEMS,
  MAX_OTEL_CONTENT_ATTRIBUTE_CHARS,
  normalizeOtelContentValue,
  safeJsonString,
  type OtelContentCapturePolicy,
} from "./service-content-normalization.js";

export type OtelModelCallContent = {
  inputMessages?: unknown;
  outputMessages?: unknown;
  systemPrompt?: string;
  toolDefinitions?: unknown;
};

export type OtelToolCallContent = {
  toolInput?: unknown;
  toolOutput?: unknown;
};

function textPart(content: string): Record<string, unknown> {
  return { type: "text", content };
}

// Shared text-part reading for gen_ai message normalization: OpenClaw emits
// {type:"text", text}; some harness shapes carry {type:"text", content}.
function textPartContent(part: Record<string, unknown>): string | undefined {
  if (part.type !== "text") {
    return undefined;
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  return typeof part.content === "string" ? part.content : undefined;
}

// Tool results usually arrive as arrays of text parts. Flatten pure-text arrays
// into one plain string so the part's `response` renders as readable text in
// trace viewers; mixed/structured results keep their raw (bounded, redacted) shape.
function toolCallResponseValue(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const textItems: string[] = [];
  for (const item of value) {
    const text =
      typeof item === "string" ? item : isRecord(item) ? textPartContent(item) : undefined;
    if (typeof text !== "string") {
      return value;
    }
    textItems.push(text);
  }
  const kept = textItems.slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS);
  const joined = kept.filter((text) => text.length > 0).join("\n");
  if (joined.length === 0) {
    return value;
  }
  const omitted = textItems.length - kept.length;
  return omitted > 0 ? `${joined}\n...(${omitted} more text parts omitted)` : joined;
}

function toolCallResponsePart(part: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool_call_response",
    ...(typeof part.id === "string" ? { id: part.id } : {}),
    // Semconv gen_ai.*.messages requires the `response` key on tool_call_response
    // parts (gen-ai-input-messages.json, since v1.37). Schema-validating viewers
    // (e.g. Phoenix) silently drop parts keyed `result`, hiding tool output.
    response: toolCallResponseValue(
      part.response ?? part.result ?? part.content ?? part.details ?? "",
    ),
  };
}

function contentParts(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    return value.length > 0 ? [textPart(value)] : [];
  }
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) {
      return [];
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return [textPart(String(value))];
    }
    const json = safeJsonString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    return json ? [textPart(json)] : [];
  }
  const parts: Record<string, unknown>[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      if (part.length > 0) {
        parts.push(textPart(part));
      }
      continue;
    }
    if (!isRecord(part)) {
      continue;
    }
    const text = textPartContent(part);
    if (text !== undefined) {
      parts.push(textPart(text));
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      parts.push({ type: "reasoning", content: part.thinking });
    } else if (part.type === "toolCall" && typeof part.name === "string") {
      parts.push({
        type: "tool_call",
        name: part.name,
        ...(typeof part.id === "string" ? { id: part.id } : {}),
        ...(part.arguments !== undefined ? { arguments: part.arguments } : {}),
      });
    } else if (part.type === "tool_call" && typeof part.name === "string") {
      parts.push({
        type: "tool_call",
        name: part.name,
        ...(typeof part.id === "string" ? { id: part.id } : {}),
        ...(part.arguments !== undefined ? { arguments: part.arguments } : {}),
      });
    } else if (part.type === "tool_call_response") {
      parts.push(toolCallResponsePart(part));
    } else if (part.type === "image") {
      const data = typeof part.data === "string" ? part.data : undefined;
      parts.push({
        type: "blob",
        modality: "image",
        ...(typeof part.mimeType === "string" ? { mime_type: part.mimeType } : {}),
        ...(typeof part.mime_type === "string" ? { mime_type: part.mime_type } : {}),
        ...(data ? { content: data } : {}),
      });
    }
  }
  return parts;
}

function normalizeGenAiMessage(
  value: unknown,
  fallbackRole = "user",
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    return { role: fallbackRole, parts: [textPart(value)] };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const rawRole = typeof value.role === "string" ? value.role : fallbackRole;
  const role = rawRole === "toolResult" ? "tool" : rawRole;
  let parts: Record<string, unknown>[];
  if (role === "tool") {
    const explicitParts = contentParts(value.parts);
    parts =
      explicitParts.length > 0
        ? explicitParts
        : [
            toolCallResponsePart({
              id: value.toolCallId,
              response: value.content ?? value.details ?? "",
            }),
          ];
  } else {
    parts = contentParts(value.parts ?? value.content);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return {
    role,
    parts,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.finish_reason === "string" ? { finish_reason: value.finish_reason } : {}),
    ...(typeof value.stopReason === "string" ? { finish_reason: value.stopReason } : {}),
  };
}

function normalizeGenAiMessages(value: unknown, fallbackRole: "user" | "assistant") {
  const source = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const messages: Record<string, unknown>[] = [];
  for (const item of source.slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)) {
    const message = normalizeGenAiMessage(item, fallbackRole);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function normalizeGenAiToolDefinition(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length === 0) {
    return undefined;
  }
  return {
    type: typeof value.type === "string" ? value.type : "function",
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(value.parameters !== undefined ? { parameters: value.parameters } : {}),
  };
}

function normalizeGenAiToolDefinitions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  const definitions: Record<string, unknown>[] = [];
  for (const item of value.slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)) {
    const definition = normalizeGenAiToolDefinition(item);
    if (definition) {
      definitions.push(definition);
    }
  }
  return definitions;
}

function assignJsonAttribute(
  attributes: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
): void {
  const json = safeJsonString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  if (json) {
    attributes[key] = json;
  }
}

function assignGenAiModelContentAttributes(
  attributes: Record<string, string | number | boolean>,
  content: OtelModelCallContent | undefined,
  policy: OtelContentCapturePolicy,
): void {
  if (policy.systemPrompt && typeof content?.systemPrompt === "string") {
    const systemInstructions = [textPart(content.systemPrompt)];
    assignJsonAttribute(attributes, ATTR_GEN_AI_SYSTEM_INSTRUCTIONS, systemInstructions);
  }
  if (policy.inputMessages) {
    const inputMessages = normalizeGenAiMessages(content?.inputMessages, "user");
    if (inputMessages.length > 0) {
      assignJsonAttribute(attributes, ATTR_GEN_AI_INPUT_MESSAGES, inputMessages);
      assignJsonAttribute(attributes, "input.value", inputMessages);
      attributes["input.mime_type"] = "application/json";
    }
  }
  if (policy.toolDefinitions) {
    const toolDefinitions = normalizeGenAiToolDefinitions(content?.toolDefinitions);
    if (toolDefinitions.length > 0) {
      assignJsonAttribute(attributes, ATTR_GEN_AI_TOOL_DEFINITIONS, toolDefinitions);
    }
  }
  if (policy.outputMessages) {
    const outputMessages = normalizeGenAiMessages(content?.outputMessages, "assistant");
    if (outputMessages.length > 0) {
      assignJsonAttribute(attributes, ATTR_GEN_AI_OUTPUT_MESSAGES, outputMessages);
      assignJsonAttribute(attributes, "output.value", outputMessages);
      attributes["output.mime_type"] = "application/json";
    }
  }
}

function assignOtelContentAttribute(
  attributes: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
): void {
  const normalized = normalizeOtelContentValue(value);
  if (normalized) {
    attributes[key] = normalized;
  }
}

export function assignOtelToolIdentityAttributes(
  attributes: Record<string, string | number | boolean>,
  evt: { toolCallId?: string },
): void {
  // Semconv execute_tool identity, span-only by design: metric attrs must stay
  // low-cardinality, and unlike the dropped openclaw.toolCallId passthrough keys
  // (DROPPED_OTEL_ATTRIBUTE_KEYS) the semconv id is a deliberate per-span export.
  attributes["gen_ai.operation.name"] = GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL;
  const toolCallId = evt.toolCallId?.trim();
  if (toolCallId) {
    attributes[ATTR_GEN_AI_TOOL_CALL_ID] = toolCallId;
  }
}

export function assignOtelModelContentAttributes(
  attributes: Record<string, string | number | boolean>,
  content: OtelModelCallContent | undefined,
  policy: OtelContentCapturePolicy,
): void {
  assignGenAiModelContentAttributes(attributes, content, policy);
  if (policy.inputMessages) {
    assignOtelContentAttribute(
      attributes,
      "openclaw.content.input_messages",
      content?.inputMessages,
    );
  }
  if (policy.toolDefinitions) {
    assignOtelContentAttribute(
      attributes,
      "openclaw.content.tool_definitions",
      content?.toolDefinitions,
    );
  }
  if (policy.outputMessages) {
    assignOtelContentAttribute(
      attributes,
      "openclaw.content.output_messages",
      content?.outputMessages,
    );
  }
  if (policy.systemPrompt) {
    assignOtelContentAttribute(attributes, "openclaw.content.system_prompt", content?.systemPrompt);
  }
}

export function assignOtelToolContentAttributes(
  attributes: Record<string, string | number | boolean>,
  content: OtelToolCallContent | undefined,
  policy: OtelContentCapturePolicy,
): void {
  // Mirror captured content onto the semconv keys next to the shipped
  // openclaw.content.* names; normalize once so both copies stay byte-identical.
  if (policy.toolInputs) {
    const toolInput = normalizeOtelContentValue(content?.toolInput);
    if (toolInput) {
      attributes[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS] = toolInput;
      attributes["openclaw.content.tool_input"] = toolInput;
    }
  }
  if (policy.toolOutputs) {
    const toolOutput = normalizeOtelContentValue(content?.toolOutput);
    if (toolOutput) {
      attributes[ATTR_GEN_AI_TOOL_CALL_RESULT] = toolOutput;
      attributes["openclaw.content.tool_output"] = toolOutput;
    }
  }
}
