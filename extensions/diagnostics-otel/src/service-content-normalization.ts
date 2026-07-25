import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { redactSensitiveText } from "../api.js";

export const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
export const MAX_OTEL_CONTENT_ARRAY_ITEMS = 200;
const MAX_OTEL_ERROR_MESSAGE_CHARS = 4 * 1024;
const PRELOADED_OTEL_SDK_ENV = "OPENCLAW_OTEL_PRELOADED";

export type OtelContentCapturePolicy = {
  inputMessages: boolean;
  outputMessages: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  systemPrompt: boolean;
  toolDefinitions: boolean;
  logBodies: boolean;
};

const NO_CONTENT_CAPTURE: OtelContentCapturePolicy = {
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
  toolDefinitions: false,
  logBodies: false,
};

function clampOtelLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${truncateUtf16Safe(value, maxChars)}...(truncated)` : value;
}

export function normalizeOtelLogString(value: string, maxChars: number): string {
  return clampOtelLogText(redactSensitiveText(value), maxChars);
}

export function normalizeOtelErrorMessage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeOtelLogString(value.trim(), MAX_OTEL_ERROR_MESSAGE_CHARS);
  return normalized || undefined;
}

export function resolveContentCapturePolicy(value: unknown): OtelContentCapturePolicy {
  if (value === true) {
    return {
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: true,
      logBodies: true,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return NO_CONTENT_CAPTURE;
  }

  const config = value as Record<string, unknown>;
  if (config.enabled !== true) {
    return NO_CONTENT_CAPTURE;
  }
  return {
    inputMessages: config.inputMessages === true,
    outputMessages: config.outputMessages === true,
    toolInputs: config.toolInputs === true,
    toolOutputs: config.toolOutputs === true,
    systemPrompt: config.systemPrompt === true,
    toolDefinitions: config.toolDefinitions === true,
    logBodies: false,
  };
}

export function hasPreloadedOtelSdk(): boolean {
  return process.env[PRELOADED_OTEL_SDK_ENV] === "1";
}

export function normalizeOtelContentValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOtelLogString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value.slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)) {
      if (typeof item === "string") {
        items.push(item);
      }
    }
    if (items.length > 0) {
      return normalizeOtelLogString(items.join("\n"), MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    }
  }
  const json = safeJsonString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  if (json) {
    return json;
  }
  return undefined;
}

const TRUNCATED_JSON_TEXT_SUFFIX = "...(truncated)";
const JSON_TRUNCATION_STRING_BUDGETS = [8192, 4096, 2048, 1024, 512, 256, 128, 64, 32] as const;
const JSON_TRUNCATION_ARRAY_ITEM_BUDGETS = [
  MAX_OTEL_CONTENT_ARRAY_ITEMS,
  100,
  50,
  25,
  10,
  5,
  1,
] as const;
const JSON_TRUNCATION_MAX_OBJECT_FIELDS = 64;
const JSON_TRUNCATION_MAX_DEPTH = 8;

type JsonTruncationOptions = {
  maxArrayItems: number;
  maxDepth: number;
  maxObjectFields: number;
  maxStringChars: number;
  seen: WeakSet<object>;
};

export function safeJsonString(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  const exact = stringifyJsonForOtelAttribute(value);
  if (exact && exact.length <= maxChars) {
    return exact;
  }
  for (const maxArrayItems of JSON_TRUNCATION_ARRAY_ITEM_BUDGETS) {
    for (const maxStringChars of JSON_TRUNCATION_STRING_BUDGETS) {
      const candidate = truncateJsonValueForOtelAttribute(value, {
        maxArrayItems,
        maxDepth: JSON_TRUNCATION_MAX_DEPTH,
        maxObjectFields: JSON_TRUNCATION_MAX_OBJECT_FIELDS,
        maxStringChars,
        seen: new WeakSet<object>(),
      });
      const json = stringifyJsonForOtelAttribute(candidate);
      if (json && json.length <= maxChars) {
        return json;
      }
    }
  }
  const summary = stringifyJsonForOtelAttribute({
    truncated: true,
    reason: exact ? "max_attribute_size" : "unserializable_value",
    type: describeJsonValue(value),
  });
  return summary && summary.length <= maxChars ? summary : undefined;
}

function stringifyJsonForOtelAttribute(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    if (!json) {
      return undefined;
    }
    return redactSensitiveText(json);
  } catch {
    return undefined;
  }
}

function truncateJsonValueForOtelAttribute(
  value: unknown,
  options: JsonTruncationOptions,
): unknown {
  if (typeof value === "string") {
    return truncateJsonTextForOtelAttribute(value, options.maxStringChars);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "bigint") {
    return truncateJsonTextForOtelAttribute(String(value), options.maxStringChars);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (options.maxDepth <= 0) {
    return { truncated: true, reason: "max_depth" };
  }
  if (Array.isArray(value)) {
    return truncateJsonArrayForOtelAttribute(value, options);
  }
  if (typeof value === "object") {
    return truncateJsonObjectForOtelAttribute(value as Record<string, unknown>, options);
  }
  return undefined;
}

function truncateJsonArrayForOtelAttribute(
  value: readonly unknown[],
  options: JsonTruncationOptions,
): unknown[] {
  if (options.seen.has(value)) {
    return [{ truncated: true, reason: "circular_reference" }];
  }
  options.seen.add(value);
  const nextOptions = { ...options, maxDepth: options.maxDepth - 1 };
  const items = value
    .slice(0, options.maxArrayItems)
    .map((item) => truncateJsonValueForOtelAttribute(item, nextOptions));
  if (value.length > items.length) {
    items.push({ truncated: true, omittedItems: value.length - items.length });
  }
  options.seen.delete(value);
  return items;
}

function truncateJsonObjectForOtelAttribute(
  value: Record<string, unknown>,
  options: JsonTruncationOptions,
): Record<string, unknown> {
  if (options.seen.has(value)) {
    return { truncated: true, reason: "circular_reference" };
  }
  options.seen.add(value);
  const nextOptions = { ...options, maxDepth: options.maxDepth - 1 };
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).filter(
    ([, field]) => field !== undefined && typeof field !== "function" && typeof field !== "symbol",
  );
  for (const [key, field] of entries.slice(0, options.maxObjectFields)) {
    result[key] = truncateJsonValueForOtelAttribute(field, nextOptions);
  }
  if (entries.length > options.maxObjectFields) {
    result.truncated = true;
    result.omittedFields = entries.length - options.maxObjectFields;
  }
  options.seen.delete(value);
  return result;
}

function truncateJsonTextForOtelAttribute(value: string, maxChars: number): string {
  const redacted = redactSensitiveText(value);
  if (redacted.length <= maxChars) {
    return redacted;
  }
  const suffixBudget = Math.min(TRUNCATED_JSON_TEXT_SUFFIX.length, maxChars);
  const prefixBudget = Math.max(0, maxChars - suffixBudget);
  return `${truncateUtf16Safe(redacted, prefixBudget)}${TRUNCATED_JSON_TEXT_SUFFIX.slice(
    TRUNCATED_JSON_TEXT_SUFFIX.length - suffixBudget,
  )}`;
}

function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
