import { SpanKind } from "@opentelemetry/api";
import type { DiagnosticEventPayload } from "../api.js";
import { redactSensitiveText } from "../api.js";
import { lowCardinalityAttr } from "./service-attributes.js";
import {
  GEN_AI_LATEST_EXPERIMENTAL_OPT_IN,
  OTEL_SEMCONV_STABILITY_OPT_IN_ENV,
} from "./service-constants.js";
import type { ModelCallLifecycleDiagnosticEvent } from "./service-types.js";

function hasOtelSemconvOptIn(value: string | undefined, optIn: string): boolean {
  return (
    value
      ?.split(",")
      .map((part) => part.trim())
      .includes(optIn) ?? false
  );
}

function emitLatestGenAiSemconv(): boolean {
  return hasOtelSemconvOptIn(
    process.env[OTEL_SEMCONV_STABILITY_OPT_IN_ENV],
    GEN_AI_LATEST_EXPERIMENTAL_OPT_IN,
  );
}

export function genAiOperationName(
  api: string | undefined,
): "chat" | "generate_content" | "text_completion" {
  const normalized = api?.trim().toLowerCase();
  if (!normalized) {
    return "chat";
  }
  if (normalized === "completions" || normalized.endsWith("-completions")) {
    return "text_completion";
  }
  if (normalized === "generate_content" || normalized.includes("generative-ai")) {
    return "generate_content";
  }
  return "chat";
}

export function positiveFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function assignPositiveNumberAttr(
  attrs: Record<string, string | number | boolean>,
  key: string,
  value: number | undefined,
): void {
  const normalized = positiveFiniteNumber(value);
  if (normalized !== undefined) {
    attrs[key] = normalized;
  }
}

export function assignModelCallSizeTimingAttrs(
  attrs: Record<string, string | number | boolean>,
  evt: {
    requestPayloadBytes?: number;
    responseStreamBytes?: number;
    timeToFirstByteMs?: number;
  },
): void {
  assignPositiveNumberAttr(attrs, "openclaw.model_call.request_bytes", evt.requestPayloadBytes);
  assignPositiveNumberAttr(attrs, "openclaw.model_call.response_bytes", evt.responseStreamBytes);
  assignPositiveNumberAttr(
    attrs,
    "openclaw.model_call.time_to_first_byte_ms",
    evt.timeToFirstByteMs,
  );
}

function assignNumberAttr(
  attrs: Record<string, string | number | boolean>,
  key: string,
  value: number | undefined,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    attrs[key] = value;
  }
}

function modelCallPromptTokens(usage: {
  promptTokens?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number | undefined {
  if (typeof usage.promptTokens === "number" && Number.isFinite(usage.promptTokens)) {
    return usage.promptTokens;
  }
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const total = input + cacheRead + cacheWrite;
  return total > 0 ? total : undefined;
}

export function assignModelCallPromptStatsAttrs(
  attrs: Record<string, string | number | boolean>,
  evt: Pick<Extract<DiagnosticEventPayload, { type: "model.call.started" }>, "promptStats">,
): void {
  const stats = evt.promptStats;
  if (!stats) {
    return;
  }
  for (const [key, value] of [
    ["openclaw.model_call.prompt.input_messages_count", stats.inputMessagesCount],
    ["openclaw.model_call.prompt.input_messages_chars", stats.inputMessagesChars],
    ["openclaw.model_call.prompt.system_prompt_chars", stats.systemPromptChars],
    ["openclaw.model_call.prompt.tool_definitions_count", stats.toolDefinitionsCount],
    ["openclaw.model_call.prompt.tool_definitions_chars", stats.toolDefinitionsChars],
    ["openclaw.model_call.prompt.total_chars", stats.totalChars],
  ] as const) {
    assignNumberAttr(attrs, key, value);
  }
}

export function assignModelCallUsageAttrs(
  attrs: Record<string, string | number | boolean>,
  evt: Pick<ModelCallLifecycleDiagnosticEvent, "usage">,
): void {
  const usage = evt.usage;
  if (!usage) {
    return;
  }
  const promptTokens = modelCallPromptTokens(usage);
  for (const [key, value] of [
    ["openclaw.model_call.usage.input_tokens", usage.input],
    ["openclaw.model_call.usage.output_tokens", usage.output],
    ["openclaw.model_call.usage.cache_read_input_tokens", usage.cacheRead],
    ["openclaw.model_call.usage.cache_creation_input_tokens", usage.cacheWrite],
    ["openclaw.model_call.usage.reasoning_output_tokens", usage.reasoningTokens],
    ["openclaw.model_call.usage.prompt_tokens", promptTokens],
    ["openclaw.model_call.usage.total_tokens", usage.total],
    ["gen_ai.usage.input_tokens", promptTokens],
    ["gen_ai.usage.output_tokens", usage.output],
    ["gen_ai.usage.cache_read.input_tokens", usage.cacheRead],
    ["gen_ai.usage.cache_creation.input_tokens", usage.cacheWrite],
  ] as const) {
    assignPositiveNumberAttr(attrs, key, value);
  }
}

export function assignGenAiSpanIdentityAttrs(
  attrs: Record<string, string | number | boolean>,
  input: { api?: string; model?: string; provider?: string },
): void {
  if (emitLatestGenAiSemconv()) {
    attrs["gen_ai.provider.name"] = lowCardinalityAttr(input.provider);
  } else {
    attrs["gen_ai.system"] = lowCardinalityAttr(input.provider);
  }
  if (input.model) {
    // Span attributes carry the full model id; only metric labels need bounded cardinality
    // (the gen_ai metrics below still use lowCardinalityAttr). The low-cardinality allowlist
    // regex rejects "/", so provider-qualified ids like "anthropic/claude-sonnet-4.6" collapse
    // to "unknown" on the SPAN — breaking model attribution in trace backends (e.g. Langfuse
    // reads gen_ai.request.model). Keep the redacted raw model on the span.
    attrs["gen_ai.request.model"] = redactSensitiveText(input.model.trim());
  }
  attrs["gen_ai.operation.name"] = genAiOperationName(input.api);
}

export function assignGenAiModelCallAttrs(
  attrs: Record<string, string | number | boolean>,
  evt: { api?: string; model?: string; provider?: string },
): void {
  assignGenAiSpanIdentityAttrs(attrs, evt);
}

export function modelCallSpanName(evt: { api?: string; model?: string }): string {
  if (!emitLatestGenAiSemconv()) {
    return "openclaw.model.call";
  }
  return `${genAiOperationName(evt.api)} ${lowCardinalityAttr(evt.model)}`;
}

export function modelCallSpanKind(): SpanKind | undefined {
  return emitLatestGenAiSemconv() ? SpanKind.CLIENT : undefined;
}

export function addUpstreamRequestIdSpanEvent(
  span: { addEvent?: (name: string, attributes?: Record<string, string>) => void },
  upstreamRequestIdHash: string | undefined,
): void {
  if (!upstreamRequestIdHash) {
    return;
  }
  const boundedHash = lowCardinalityAttr(upstreamRequestIdHash);
  if (boundedHash === "unknown") {
    return;
  }
  span.addEvent?.("openclaw.provider.request", {
    "openclaw.upstreamRequestIdHash": boundedHash,
  });
}
