// Qa Lab plugin module implements server behavior.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { escapeRegExp, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { closeQaHttpServer } from "../../bus-server.js";
import { QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY } from "../../qa-web-search-provider.js";
import { writeJson } from "../shared/http-json.js";

type ResponsesInputItem = Record<string, unknown>;

let mockFunctionCallSequence = 0;

type StreamEvent =
  | { type: "response.output_item.added"; item: Record<string, unknown> }
  | {
      type: "response.output_text.delta";
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.output_text.done";
      item_id: string;
      output_index: number;
      content_index: number;
      text: string;
    }
  | { type: "response.function_call_arguments.delta"; delta: string }
  | { type: "response.output_item.done"; item: Record<string, unknown> }
  | {
      type: "response.completed";
      response: {
        id: string;
        status: "completed";
        output: Array<Record<string, unknown>>;
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        };
      };
    };

/**
 * Provider variant tag for `body.model`. The mock previously ignored
 * `body.model` for dispatch and only echoed it in the prose output, which
 * made the parity gate tautological when run against the mock alone
 * (both providers produced identical scenario plans by construction).
 * Tagging requests with a normalized variant lets individual scenario
 * branches opt into provider-specific behavior while the rest of the
 * dispatcher stays shared, and lets `/debug/requests` consumers verify
 * which provider lane a given request came from without re-parsing the
 * raw model string.
 *
 * Policy:
 * - `openai/*`, `gpt-*`, `o1-*`, anything starting with `gpt-` → `"openai"`
 * - `anthropic/*`, `claude-*` → `"anthropic"`
 * - Everything else (including empty strings) → `"unknown"`
 *
 * The `/v1/messages` route always feeds `body.model` straight through,
 * so an Anthropic request with an `openai/gpt-5.5` model string is still
 * classified as `"openai"`. That matches the parity program's convention
 * where the provider label is the source of truth, not the HTTP route.
 */
export type MockOpenAiProviderVariant = "openai" | "anthropic" | "unknown";

export function resolveProviderVariant(model: string | undefined): MockOpenAiProviderVariant {
  if (typeof model !== "string") {
    return "unknown";
  }
  const trimmed = model.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "unknown";
  }
  // Prefer the explicit `provider/model` or `provider:model` prefix when
  // the caller supplied one — that's the most reliable signal.
  const separatorMatch = /^([^/:]+)[/:]/.exec(trimmed);
  const provider = separatorMatch?.[1] ?? trimmed;
  if (provider === "openai") {
    return "openai";
  }
  if (provider === "anthropic" || provider === "claude-cli") {
    return "anthropic";
  }
  // Fall back to model-name prefix matching for bare model strings like
  // `gpt-5.5` or `claude-opus-4-8`.
  if (/^(?:gpt-|o1-|openai-)/.test(trimmed)) {
    return "openai";
  }
  if (/^(?:claude-|anthropic-)/.test(trimmed)) {
    return "anthropic";
  }
  return "unknown";
}

type MockOpenAiRequestSnapshot = {
  raw: string;
  body: Record<string, unknown>;
  prompt: string;
  allInputText: string;
  instructions?: string;
  toolOutput: string;
  model: string;
  providerVariant: MockOpenAiProviderVariant;
  imageInputCount: number;
  plannedToolCallId?: string;
  plannedToolName?: string;
  plannedToolArgs?: Record<string, unknown>;
  toolOutputCallId?: string;
  toolOutputStructuredError?: true;
};

// Runtime-context delimiters are owned by src/agents/internal-runtime-context.ts.
// This mock mirrors the wire shape so delimiter drift fails through QA timeouts.
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

// Anthropic /v1/messages request/response shapes the mock actually needs.
// This is a subset of the real Anthropic Messages API — just enough so the
// QA suite can run its parity pack against a "baseline" Anthropic provider
// without needing real API keys. The scenarios drive their dispatch through
// the shared mock scenario logic (buildResponsesPayload), with `model`
// preserved so provider-aware branches can intentionally diverge.
type AnthropicMessageContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      is_error?: boolean;
      content: string | Array<{ type: "text"; text: string }>;
    }
  | { type: "image"; source: Record<string, unknown> };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicMessageContentBlock[];
};

type AnthropicMessagesRequest = {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type: "text"; text: string }>;
  messages?: AnthropicMessage[];
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";
const QA_REASONING_ONLY_RECOVERY_PROMPT_RE = /reasoning-only continuation qa check/i;
const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE = /reasoning-only after write safety check/i;
const QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE = /anthropic thinking error qa check/i;
const QA_THINKING_VISIBILITY_OFF_PROMPT_RE = /qa thinking visibility check off/i;
const QA_THINKING_VISIBILITY_MAX_PROMPT_RE = /qa thinking visibility check max/i;
const QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE = /empty response continuation qa check/i;
const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE = /empty response exhaustion qa check/i;
const QA_STREAMING_PROMPT_RE = /(?:partial|quiet) streaming qa check/i;
const QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE = /final-only marker streaming qa check/i;
const QA_BLOCK_STREAMING_PROMPT_RE = /block streaming qa check/i;
const QA_TOOL_PROGRESS_ERROR_PROMPT_RE = /tool progress error qa check/i;
const QA_TOOL_PROGRESS_PROMPT_RE = /tool progress qa check/i;
const QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE = /qa group visible reply tool check/i;
const QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE = /qa a2a message-tool mirror check/i;
const QA_GROUP_MESSAGE_UNAVAILABLE_FALLBACK_PROMPT_RE =
  /qa group message unavailable fallback check/i;
const QA_STRANDED_FINAL_RECOVERY_PROMPT_RE = /qa stranded final recovery check/i;
const QA_STRANDED_FINAL_RETRY_FAILURE_PROMPT_RE = /qa stranded final retry failure check/i;
const QA_STRANDED_FINAL_RETRY_PROMPT_RE = /you did not call message\(action=send\)/i;
const QA_STRANDED_FINAL_RETRY_FAILURE_MARKER = "QA-STRANDED-RETRY-FAIL-RAW";
const QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE = /telegram current session_status qa check/i;
const QA_TELEGRAM_STREAM_SINGLE_MARKER = "QA-TELEGRAM-STREAM-SINGLE-OK";
const QA_TELEGRAM_LONG_FINAL_THREE_CHUNK_PROMPT_RE = /telegram long final three chunk qa check/i;
const QA_TELEGRAM_LONG_FINAL_PROMPT_RE = /telegram long final qa check/i;
const QA_WHATSAPP_LONG_FINAL_PROMPT_RE = /whatsapp long final qa check/i;
const QA_SLACK_CHART_PRESENTATION_PROMPT_RE =
  /Slack native chart QA check\s+(SLACK_QA_CHART_SUMMARY_[A-Z0-9]+)[\s\S]*?reply with only this exact marker:\s*(SLACK_QA_CHART_DONE_[A-Z0-9]+)/i;
const QA_WHATSAPP_AGENT_MESSAGE_ACTION_REACT_PROMPT_RE =
  /react to this whatsapp(?: group)? message with thumbs up for qa action check\s+(?:WHATSAPP_QA_AGENT_REACT|WHATSAPP_QA_GROUP_AGENT_REACT)_[A-Z0-9]+/i;
const QA_WHATSAPP_AGENT_MESSAGE_ACTION_UPLOAD_PROMPT_RE =
  /upload-file action to send a PNG with caption\s+((?:WHATSAPP_QA_AGENT_UPLOAD|WHATSAPP_QA_GROUP_AGENT_UPLOAD)_[A-Z0-9]+)/i;
const QA_WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER_RE =
  /\bWHATSAPP_QA_PENDING_HISTORY_TRIGGER_([A-Z0-9]+)\b/u;
const QA_WHATSAPP_PENDING_HISTORY_STRUCTURED_LABEL =
  "Chat history since last reply (untrusted, for context):";
const QA_WHATSAPP_BROADCAST_PROMPT_RE = /\bopenclawqa broadcast fanout check\s+([A-Z0-9_]+)\b/i;
const QA_WHATSAPP_RUNTIME_AGENT_RE = /\bRuntime:\s*[^\n]*\bagent=([A-Za-z0-9_-]+)/i;
const QA_WHATSAPP_ACTIVATION_ALWAYS_MARKER_RE = /\bWHATSAPP_QA_ACTIVATION_ALWAYS_([A-Z0-9]+)\b/u;
const QA_WHATSAPP_REPLY_TO_BOT_SEED_MARKER_RE = /\bWHATSAPP_QA_REPLY_TO_BOT_SEED_[A-Z0-9]+\b/u;
const QA_WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER_RE =
  /\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u;
const QA_WHATSAPP_BATCHED_FINAL_MARKER_RE = /\bWHATSAPP_QA_BATCHED_FINAL_([A-Z0-9]+)\b/u;
const QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE = /subagent direct fallback qa check/i;
const QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE = /subagent direct fallback worker/i;

function buildStrandedFinalRecoveryText(): string {
  return [
    "QA-STRANDED-85714 confirms this is a substantive private final reply that initially skipped the message tool.",
    "The reply is intentionally long enough to exercise message_tool_only stranded-final recovery before the retry delivers it visibly.",
  ].join(" ");
}

function buildStrandedFinalRetryFailureText(): string {
  return [
    "QA-STRANDED-RETRY-FAIL-RAW confirms this retry also produced a substantive private final reply instead of calling the message tool.",
    "This text must remain private so the gateway can deliver only its sanitized failure diagnostic to the source chat.",
  ].join(" ");
}

function isStrandedFinalRetryFailureRequest(allInputText: string): boolean {
  return (
    QA_STRANDED_FINAL_RETRY_FAILURE_PROMPT_RE.test(allInputText) ||
    (QA_STRANDED_FINAL_RETRY_PROMPT_RE.test(allInputText) &&
      allInputText.includes(QA_STRANDED_FINAL_RETRY_FAILURE_MARKER))
  );
}
const QA_SUBAGENT_DIRECT_FALLBACK_MARKER = "QA-SUBAGENT-DIRECT-FALLBACK-OK";
const QA_IMAGE_GENERATION_PROMPT_RE =
  /image generation check|capability flip image check|\/tool\s+image_generate/i;
const QA_REASONING_ONLY_RETRY_NEEDLE =
  "recorded reasoning but did not produce a user-visible answer";
const QA_EMPTY_RESPONSE_RETRY_NEEDLE =
  "The previous attempt did not produce a user-visible answer.";
const QA_SKILL_WORKSHOP_GIF_PROMPT_RE =
  /externally sourced animated GIF asset|animated GIF asset in a product UI/i;
const QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE = /Review transcript for durable skill updates/i;
const QA_RELEASE_AUDIT_PROMPT_RE = /release readiness audit for the small project/i;
const QA_TOOL_SEARCH_PROMPT_RE = /tool search qa check/i;
const QA_TOOL_SEARCH_FAILURE_PROMPT_RE = /tool search qa failure/i;
const QA_MCP_CODE_MODE_PROMPT_RE = /mcp code mode qa check/i;
const QA_AUDIO_TRANSCRIPTION_TEXT =
  "Reply with only this exact marker: WHATSAPP_QA_AUDIO_TRANSCRIPT_OK";
const QA_GROUP_AUDIO_TRANSCRIPTION_TEXT =
  "openclawqa reply with only this exact marker after group audio preflight: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK";
const QA_GROUP_AUDIO_TRIGGER_SENTINEL = "OPENCLAW_QA_GROUP_AUDIO_TRIGGER";
const QA_MCP_CODE_MODE_API_FILE_PROMPT_RE = /mcp code mode api file qa check/i;

type MockScenarioState = {
  anthropicThinkingErrorPhase: number;
  subagentFanoutPhase: number;
  subagentHandoffSpawned: boolean;
};

function sourceDiscoveryReadPathForProvider(providerVariant: MockOpenAiProviderVariant) {
  return providerVariant === "anthropic"
    ? "repo/docs/help/testing.md"
    : "repo/qa/scenarios/index.yaml";
}

function subagentHandoffTaskForProvider(providerVariant: MockOpenAiProviderVariant) {
  return providerVariant === "anthropic"
    ? "Inspect the QA docs fixture and return one concise protocol note."
    : "Inspect the QA workspace and return one concise protocol note.";
}

function subagentFanoutTaskForProvider(
  providerVariant: MockOpenAiProviderVariant,
  worker: "alpha" | "beta",
) {
  const marker = worker === "alpha" ? "ALPHA-OK" : "BETA-OK";
  const scope = providerVariant === "anthropic" ? "the QA docs fixture" : "the QA workspace";
  return `Fanout worker ${worker}: inspect ${scope} and finish with exactly ${marker}.`;
}

const MOCK_OPENAI_MAX_BODY_BYTES = 16 * 1024 * 1024;
const MOCK_OPENAI_BODY_TIMEOUT_MS = 30_000;
const MOCK_OPENAI_DEBUG_REQUEST_LIMIT = 2_000;

function readBody(req: IncomingMessage): Promise<string> {
  return readRequestBodyWithLimit(req, {
    maxBytes: MOCK_OPENAI_MAX_BODY_BYTES,
    timeoutMs: MOCK_OPENAI_BODY_TIMEOUT_MS,
  });
}

function parseJsonObjectBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeOpenAiMalformedJsonError(res: ServerResponse, label: string) {
  writeJson(res, 400, {
    error: {
      type: "invalid_request_error",
      message: `Malformed JSON body for ${label} request.`,
    },
  });
}

function transcriptionTextForAudioRequest(rawBody: string) {
  if (rawBody.includes(QA_GROUP_AUDIO_TRIGGER_SENTINEL)) {
    return QA_GROUP_AUDIO_TRANSCRIPTION_TEXT;
  }
  return QA_AUDIO_TRANSCRIPTION_TEXT;
}

function writeSse(res: ServerResponse, events: StreamEvent[]) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function writeSseWithPreviewPause(
  res: ServerResponse,
  events: StreamEvent[],
  pauseMs: number,
) {
  const completionIndex = events.findIndex((event) => event.type === "response.output_text.done");
  if (completionIndex < 0) {
    writeSse(res, events);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  for (const event of events.slice(0, completionIndex)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  await sleep(pauseMs);
  for (const event of events.slice(completionIndex)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

type AnthropicStreamEvent = Record<string, unknown> & {
  type: string;
};

function writeAnthropicSse(res: ServerResponse, events: AnthropicStreamEvent[]) {
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function countApproxTokens(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function extractEmbeddingInputTexts(input: unknown): string[] {
  if (typeof input === "string") {
    return [input];
  }
  if (Array.isArray(input)) {
    return input.flatMap((entry) => extractEmbeddingInputTexts(entry));
  }
  if (
    input &&
    typeof input === "object" &&
    typeof (input as { text?: unknown }).text === "string"
  ) {
    return [(input as { text: string }).text];
  }
  return [];
}

function buildDeterministicEmbedding(text: string, dimensions = 16) {
  const values = Array.from({ length: dimensions }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    values[index % dimensions] += text.charCodeAt(index) / 255;
  }
  const magnitude = Math.hypot(...values) || 1;
  return values.map((value) => Number((value / magnitude).toFixed(8)));
}

function extractLastUserText(input: ResponsesInputItem[]) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text && !isInternalRuntimeContextCarrierText(text)) {
      return text;
    }
  }
  return "";
}

function findLastUserIndex(input: ResponsesInputItem[]) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    if (!isInternalRuntimeContextCarrierText(extractInputText(item.content))) {
      return index;
    }
  }
  return -1;
}

function isInternalRuntimeContextCarrierText(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) &&
    trimmed.endsWith(INTERNAL_RUNTIME_CONTEXT_END)
  );
}

function isToolOutputContinuationText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^(?:continue|keep going|resume|retry|carry on)(?:[.!?])?$/i.test(trimmed) ||
    /\b(?:continue|continuation|compaction|post-compaction|retry|resume)\b/i.test(trimmed)
  );
}

function stringifyFunctionCallOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.text === "string") {
          return record.text;
        }
        if (typeof record.output_text === "string") {
          return record.output_text;
        }
        if (typeof record.content === "string") {
          return record.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.output_text === "string") {
      return record.output_text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return "";
}

function extractFunctionCallOutputText(item: ResponsesInputItem) {
  if (item.type !== "function_call_output") {
    return "";
  }
  return stringifyFunctionCallOutput(item.output);
}

function extractFunctionCallOutputCallId(item: ResponsesInputItem) {
  if (item.type !== "function_call_output") {
    return "";
  }
  const record = item as {
    call_id?: unknown;
    tool_call_id?: unknown;
    tool_use_id?: unknown;
  };
  return (
    [record.call_id, record.tool_call_id, record.tool_use_id].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ) ?? ""
  );
}

function functionCallOutputIsStructuredError(item: ResponsesInputItem) {
  if (item.type !== "function_call_output") {
    return false;
  }
  return item.is_error === true || item.isError === true;
}

function extractToolOutput(input: ResponsesInputItem[]) {
  const lastUserIndex = findLastUserIndex(input);
  for (let index = input.length - 1; index > lastUserIndex; index -= 1) {
    const item = input[index];
    const output = extractFunctionCallOutputText(item);
    if (output) {
      return output;
    }
  }
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    const output = extractFunctionCallOutputText(item);
    if (output) {
      const laterUserTexts = input
        .slice(index + 1)
        .filter((laterItem) => laterItem.role === "user" && Array.isArray(laterItem.content))
        .map((laterItem) => extractInputText(laterItem.content as unknown[]))
        .filter(Boolean);
      if (
        laterUserTexts.length > 0 &&
        laterUserTexts.every((text) => isToolOutputContinuationText(text))
      ) {
        return output;
      }
      continue;
    }
  }
  return "";
}

function extractToolOutputStructuredError(input: ResponsesInputItem[]) {
  const lastUserIndex = findLastUserIndex(input);
  for (let index = input.length - 1; index > lastUserIndex; index -= 1) {
    const item = input[index];
    const output = extractFunctionCallOutputText(item);
    if (output) {
      return functionCallOutputIsStructuredError(item);
    }
  }
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    const output = extractFunctionCallOutputText(item);
    if (output) {
      const laterUserTexts = input
        .slice(index + 1)
        .filter((laterItem) => laterItem.role === "user" && Array.isArray(laterItem.content))
        .map((laterItem) => extractInputText(laterItem.content as unknown[]))
        .filter(Boolean);
      if (
        laterUserTexts.length > 0 &&
        laterUserTexts.every((text) => isToolOutputContinuationText(text))
      ) {
        return functionCallOutputIsStructuredError(item);
      }
    }
  }
  return false;
}

function extractToolOutputCallId(input: ResponsesInputItem[]) {
  const lastUserIndex = findLastUserIndex(input);
  for (let index = input.length - 1; index > lastUserIndex; index -= 1) {
    const item = input[index];
    const output = extractFunctionCallOutputText(item);
    if (output) {
      return extractFunctionCallOutputCallId(item);
    }
  }
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    const output = extractFunctionCallOutputText(item);
    if (output) {
      const laterUserTexts = input
        .slice(index + 1)
        .filter((laterItem) => laterItem.role === "user" && Array.isArray(laterItem.content))
        .map((laterItem) => extractInputText(laterItem.content as unknown[]))
        .filter(Boolean);
      if (
        laterUserTexts.length > 0 &&
        laterUserTexts.every((text) => isToolOutputContinuationText(text))
      ) {
        return extractFunctionCallOutputCallId(item);
      }
    }
  }
  return "";
}

function extractLatestToolOutput(input: ResponsesInputItem[]) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    const output = extractFunctionCallOutputText(item);
    if (output) {
      return output;
    }
  }
  return "";
}

function extractAllToolOutputText(input: ResponsesInputItem[]) {
  return input
    .map((item) => extractFunctionCallOutputText(item))
    .filter(Boolean)
    .join("\n");
}

function extractUserTextAfterLatestToolOutput(input: ResponsesInputItem[]) {
  let latestToolOutputIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (extractFunctionCallOutputText(input[index])) {
      latestToolOutputIndex = index;
      break;
    }
  }
  if (latestToolOutputIndex < 0) {
    return "";
  }
  return input
    .slice(latestToolOutputIndex + 1)
    .filter((item) => item.role === "user" && Array.isArray(item.content))
    .map((item) => extractInputText(item.content as unknown[]))
    .filter(Boolean)
    .join("\n");
}

function extractInputText(content: unknown[]): string {
  return content
    .filter(
      (entry): entry is { type: "input_text"; text: string } =>
        Boolean(entry) &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "input_text" &&
        typeof (entry as { text?: unknown }).text === "string",
    )
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function extractAllUserTexts(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}

function extractSystemInputText(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (item.role !== "system") {
      continue;
    }
    if (typeof item.content === "string" && item.content.trim()) {
      texts.push(item.content.trim());
      continue;
    }
    if (!Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      texts.push(text);
    }
  }
  return texts.join("\n");
}

function extractAllInputTexts(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (typeof item.output === "string" && item.output.trim()) {
      texts.push(item.output.trim());
    }
    if (!Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      texts.push(text);
    }
  }
  return texts.join("\n");
}

function extractInstructionsText(body: Record<string, unknown>) {
  return typeof body.instructions === "string" ? body.instructions.trim() : "";
}

function extractAllRequestTexts(input: ResponsesInputItem[], body: Record<string, unknown>) {
  const texts: string[] = [];
  const instructions = extractInstructionsText(body);
  if (instructions) {
    texts.push(instructions);
  }
  const inputText = extractAllInputTexts(input);
  if (inputText) {
    texts.push(inputText);
  }
  return texts.join("\n");
}

function buildWhatsAppPendingHistoryReply(allInputText: string) {
  const triggerMatch = QA_WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER_RE.exec(allInputText);
  if (!triggerMatch?.[1]) {
    return undefined;
  }
  const suffix = triggerMatch[1];
  const beforeTrigger = allInputText.slice(0, triggerMatch.index);
  const priorGroupContext = extractStructuredWhatsAppPendingHistoryContext(beforeTrigger);
  const quietMarkerPattern = new RegExp(`\\bWHATSAPP_QA_PENDING_HISTORY_QUIET_${suffix}\\b`, "u");
  const contextSentinelPattern = new RegExp(
    `\\bWHATSAPP_QA_PENDING_HISTORY_CONTEXT_ONLY_${suffix}\\b`,
    "u",
  );
  if (
    !quietMarkerPattern.test(priorGroupContext) ||
    !contextSentinelPattern.test(priorGroupContext)
  ) {
    return "WHATSAPP_QA_PENDING_HISTORY_MISSING_CONTEXT";
  }
  return `WHATSAPP_QA_PENDING_HISTORY_OK_${suffix}`;
}

function extractStructuredWhatsAppPendingHistoryContext(beforeTrigger: string) {
  const blockRe = new RegExp(
    `${escapeRegExp(QA_WHATSAPP_PENDING_HISTORY_STRUCTURED_LABEL)}\\n((?:(?!\\n\\n)[\\s\\S])+)\\n\\n`,
    "gu",
  );
  return Array.from(beforeTrigger.matchAll(blockRe), (match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block))
    .join("\n");
}

function buildWhatsAppBroadcastReply(allInputText: string) {
  const promptMatch = QA_WHATSAPP_BROADCAST_PROMPT_RE.exec(allInputText);
  const token = promptMatch?.[1];
  if (!token) {
    return undefined;
  }
  const agentId = QA_WHATSAPP_RUNTIME_AGENT_RE.exec(allInputText)?.[1];
  if (agentId === "main") {
    return `${token}_MAIN`;
  }
  if (agentId === "qa-second") {
    return `${token}_SECOND`;
  }
  return "WHATSAPP_QA_BROADCAST_AGENT_CONTEXT_MISSING";
}

function buildWhatsAppGroupDispatchReply(allInputText: string) {
  const activationMatch = QA_WHATSAPP_ACTIVATION_ALWAYS_MARKER_RE.exec(allInputText);
  if (activationMatch?.[1]) {
    return `WHATSAPP_QA_ACTIVATION_ALWAYS_${activationMatch[1]}`;
  }
  const triggerMatch = QA_WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER_RE.exec(allInputText);
  if (triggerMatch?.[0]) {
    return triggerMatch[0];
  }
  return QA_WHATSAPP_REPLY_TO_BOT_SEED_MARKER_RE.exec(allInputText)?.[0];
}

function buildWhatsAppBatchedReply(allInputText: string) {
  const finalMatch = QA_WHATSAPP_BATCHED_FINAL_MARKER_RE.exec(allInputText);
  const suffix = finalMatch?.[1];
  if (!suffix) {
    return undefined;
  }
  const firstMarker = `WHATSAPP_QA_BATCHED_FIRST_${suffix}`;
  if (!allInputText.includes(firstMarker)) {
    return `WHATSAPP_QA_BATCHED_MISSING_CONTEXT_${suffix}`;
  }
  return finalMatch[0];
}

function countImageInputs(value: unknown): number {
  const seen = new WeakSet<object>();
  const stack = [value];
  let count = 0;
  let visited = 0;
  while (stack.length > 0 && visited < 50_000) {
    visited += 1;
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "input_image" || type === "image" || type === "image_url" || type === "media") {
      count += 1;
    }
    stack.push(record.content, record.image_url, record.source);
  }
  return count;
}

function extractLatestImageUserTurn(input: ResponsesInputItem[]) {
  const latestUserIndex = findLastUserIndex(input);
  if (latestUserIndex < 0) {
    return { text: "", imageInputCount: 0 };
  }

  const latestUserItem = input[latestUserIndex];
  if (!latestUserItem) {
    return { text: "", imageInputCount: 0 };
  }

  const imageTurnItems = [latestUserItem];
  const imageInputCount = countImageInputs(imageTurnItems.map((item) => item.content));
  if (imageInputCount === 0) {
    return { text: "", imageInputCount: 0 };
  }
  return {
    text: imageTurnItems
      .map((item) => extractInputText(item.content as unknown[]))
      .filter(Boolean)
      .join("\n"),
    imageInputCount,
  };
}

function parseToolOutputJson(toolOutput: string): Record<string, unknown> | null {
  if (!toolOutput.trim()) {
    return null;
  }
  try {
    return JSON.parse(toolOutput) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizePromptPathCandidate(candidate: string) {
  const trimmed = candidate.trim().replace(/^`+|`+$/g, "");
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/^\.\//, "");
  if (
    normalized.includes("/") ||
    /\.(?:md|json|ts|tsx|js|mjs|cjs|txt|yaml|yml)$/i.test(normalized)
  ) {
    return normalized;
  }
  return null;
}

function readTargetFromPrompt(prompt: string) {
  const backtickedMatches = Array.from(prompt.matchAll(/`([^`]+)`/g))
    .map((match) => normalizePromptPathCandidate(match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
  if (backtickedMatches.length > 0) {
    return backtickedMatches[0];
  }

  const quotedMatches = Array.from(prompt.matchAll(/"([^"]+)"/g))
    .map((match) => normalizePromptPathCandidate(match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
  if (quotedMatches.length > 0) {
    return quotedMatches[0];
  }

  const repoScoped = /\b(?:repo\/[^\s`",)]+|QA_[A-Z_]+\.md)\b/.exec(prompt)?.[0]?.trim();
  if (repoScoped) {
    return repoScoped;
  }

  const loosePath = /\b[A-Za-z0-9._-]+\.(?:md|json|ts|tsx|js|mjs|cjs|txt|yaml|yml)\b/i
    .exec(prompt)?.[0]
    ?.trim();
  if (loosePath) {
    return loosePath;
  }

  if (/\bdocs?\b/i.test(prompt)) {
    return "repo/docs/help/testing.md";
  }
  if (/\bscenario|kickoff|qa\b/i.test(prompt)) {
    return "QA_KICKOFF_TASK.md";
  }
  return "repo/package.json";
}

function execCommandFromToolProgressPrompt(prompt: string) {
  return (
    /call the exec tool exactly once with this exact command before answering:\s*`([^`]+)`/i
      .exec(prompt)?.[1]
      ?.trim() || null
  );
}

function buildMockFunctionCall(name: string, args: Record<string, unknown>) {
  const serialized = JSON.stringify(args);
  const callSuffix = createHash("sha256")
    .update(name)
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 10);
  const sequence = ++mockFunctionCallSequence;
  const uniqueSuffix = `${callSuffix}_${sequence}`;
  const callId = `call_mock_${name}_${uniqueSuffix}`;
  const itemId = `fc_mock_${name}_${uniqueSuffix}`;
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: serialized,
  };
  return {
    callId,
    item,
    itemId,
    responseId: `resp_mock_${name}_${uniqueSuffix}`,
    serialized,
  };
}

function buildToolCallEventsWithArgs(name: string, args: Record<string, unknown>): StreamEvent[] {
  const call = buildMockFunctionCall(name, args);
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: call.itemId,
        call_id: call.callId,
        name,
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: call.serialized },
    {
      type: "response.output_item.done",
      item: call.item,
    },
    {
      type: "response.completed",
      response: {
        id: call.responseId,
        status: "completed",
        output: [call.item],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

function extractRememberedFact(userTexts: string[]) {
  for (const text of userTexts) {
    const qaCanaryMatch = /\bqa canary code is\s+([A-Za-z0-9-]+)/i.exec(text);
    if (qaCanaryMatch?.[1]) {
      return qaCanaryMatch[1];
    }
  }
  for (const text of userTexts) {
    const match = /remember(?: this fact for later)?:\s*([A-Za-z0-9-]+)/i.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function extractOrbitCode(text: string) {
  return /\bORBIT-\d+\b/i.exec(text)?.[0]?.toUpperCase() ?? null;
}

function decodeXmlEntities(text: string) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractActiveMemorySummary(text: string) {
  const match = /<active_memory_plugin>\s*([\s\S]*?)\s*<\/active_memory_plugin>/i.exec(text);
  return match?.[1] ? decodeXmlEntities(match[1]).trim() : null;
}

function extractToolSearchTarget(text: string): string | null {
  const match = /\btarget=([A-Za-z0-9_.:-]+)\b/.exec(text);
  return match?.[1]?.trim() || null;
}

function buildQaToolSearchArgs(targetTool: string, failureMode: boolean): Record<string, unknown> {
  if (failureMode && targetTool === "web_search") {
    return { query: QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY };
  }
  if (failureMode) {
    return { __qaFailureMode: "denied-input" };
  }
  if (targetTool === "exec") {
    return { command: "echo runtime-tool-fixture", timeout: 5 };
  }
  if (targetTool === "read") {
    return { path: "QA_KICKOFF_TASK.md" };
  }
  if (targetTool === "write") {
    return { path: "runtime-tool-fixture-write.txt", content: "runtime tool fixture\n" };
  }
  if (targetTool === "edit") {
    return {
      path: "runtime-tool-fixture-edit.txt",
      edits: [{ oldText: "before edit\n", newText: "after edit\n" }],
    };
  }
  if (targetTool === "apply_patch") {
    return {
      input: [
        "*** Begin Patch",
        "*** Add File: runtime-tool-fixture-patch.txt",
        "+runtime patch",
        "*** End Patch",
        "",
      ].join("\n"),
    };
  }
  if (targetTool === "web_search") {
    return { query: "OpenClaw runtime parity fixed query", count: 1 };
  }
  if (targetTool === "web_fetch") {
    return { url: "https://example.com/", maxChars: 500 };
  }
  if (targetTool === "image_generate") {
    return { prompt: "QA lighthouse runtime parity fixture", filename: "runtime-tool-fixture" };
  }
  if (targetTool === "tts") {
    return { text: "Runtime parity voice fixture." };
  }
  if (targetTool === "message") {
    return { action: "send", message: "runtime parity message fixture" };
  }
  if (targetTool === "session_status") {
    return { sessionKey: "current" };
  }
  if (targetTool === "sessions_spawn") {
    return {
      task: "Runtime tool fixture subagent: reply exactly RUNTIME-TOOL-FIXTURE.",
      label: "runtime-tool-fixture",
      mode: "run",
      thread: false,
    };
  }
  if (targetTool === "memory_recall") {
    return { query: "runtime parity memory fixture" };
  }
  return { marker: "normal" };
}

function isActiveMemorySubagentPrompt(text: string) {
  return text.includes("You are a memory search agent.");
}

function extractSnackPreference(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match =
    /(lemon pepper wings(?:\s+with\s+blue cheese)?|blue cheese(?:\s+with\s+lemon pepper wings)?)/i.exec(
      normalized,
    );
  return match?.[0]?.trim() ?? null;
}

function extractLastCapture(text: string, pattern: RegExp) {
  let lastMatch: RegExpExecArray | null = null;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  for (let match = globalPattern.exec(text); match; match = globalPattern.exec(text)) {
    lastMatch = match;
  }
  return lastMatch?.[1]?.trim() || null;
}

function extractCaptures(text: string, pattern: RegExp) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  return Array.from(text.matchAll(globalPattern), (match) => match[1]?.trim()).filter(Boolean);
}

function extractLastMatchingUserText(texts: string[], pattern: RegExp) {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index] ?? "";
    if (pattern.test(text)) {
      return text;
    }
  }
  return "";
}

function extractExactReplyDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /reply(?: with)? exactly\s+`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return (
    extractLastCapture(text, /reply(?: with)? exactly:\s*([^\n]+)/i) ??
    extractLastCapture(text, /reply(?: with)? exactly\s+(?!with\b)([^\s`.,;:!?]+)/i)
  );
}

function extractFinishExactlyDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /finish with exactly\s+`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(text, /finish with exactly\s+([^\s`.,;:!?]+)/i);
}

function extractExactMarkerDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /exact marker\b[^:\n]{0,120}:\s*`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(
    text,
    /exact marker\b[^:\n]{0,120}:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i,
  );
}

function extractWhatsAppLocationMarkerDirective(text: string) {
  return extractLastCapture(
    text,
    /WhatsApp location marker:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i,
  );
}

function extractWhatsAppContactMarkerDirective(text: string) {
  return extractLastCapture(text, /WhatsApp contact marker:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i);
}

function extractWhatsAppStickerMarkerDirective(text: string) {
  return extractLastCapture(text, /WhatsApp sticker marker:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i);
}

function shouldUseWhatsAppLocationMarker(prompt: string) {
  return /(?:^|[\n:]\s*)📍\s*37\.774900,\s*-122\.419400\b/u.test(prompt.trim());
}

function shouldUseWhatsAppContactMarker(prompt: string) {
  return /(?:^|[\n:]\s*)<contacts?(?::|>)/iu.test(prompt.trim());
}

function shouldUseWhatsAppStickerMarker(prompt: string) {
  return /(?:^|[\n:]\s*)<media:sticker>(?:\s|$)/iu.test(prompt.trim());
}

function extractLabeledMarkerDirective(text: string, label: string) {
  const escapedLabel = escapeRegExp(label);
  const backtickedMatch = extractLastCapture(
    text,
    new RegExp(`${escapedLabel}:\\s*\`([^\\\`]+)\``, "i"),
  );
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(
    text,
    new RegExp(`${escapedLabel}:\\s*([^\\s\\\`.,;:!?]+(?:-[^\\s\\\`.,;:!?]+)*)`, "i"),
  );
}

function extractBlockStreamingMarkerDirectives(text: string) {
  const firstLabeledMarker = extractLabeledMarkerDirective(text, "first exact marker");
  const secondLabeledMarker = extractLabeledMarkerDirective(text, "second exact marker");
  if (firstLabeledMarker && secondLabeledMarker) {
    return {
      first: firstLabeledMarker,
      second: secondLabeledMarker,
    };
  }

  const markers = extractCaptures(text, /exact marker\b[^:\n]{0,120}:\s*`([^`]+)`/i);
  if (markers.length < 2) {
    return null;
  }
  const [first, second] = markers.slice(-2);
  return first && second
    ? {
        first,
        second,
      }
    : null;
}

function extractQuotedToolArg(text: string, name: string) {
  const escapedName = escapeRegExp(name);
  return extractLastCapture(text, new RegExp(`\\b${escapedName}\\s*=\\s*"([^"]+)"`, "i"));
}

function extractBareToolArg(text: string, name: string) {
  const escapedName = escapeRegExp(name);
  return extractLastCapture(text, new RegExp(`\\b${escapedName}\\s*=\\s*([^\\s\\\`.,;:!?]+)`, "i"));
}

function hasDeclaredTool(body: Record<string, unknown>, name: string) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const dynamicTools = Array.isArray(body.dynamicTools) ? body.dynamicTools : [];
  if (
    [...tools, ...dynamicTools].some((tool) => toolDefinitionMentionsName(tool, name)) ||
    instructionTextMentionsToolName(extractInstructionsText(body), name)
  ) {
    return true;
  }
  return false;
}

function toolDefinitionMentionsName(value: unknown, name: string, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => toolDefinitionMentionsName(item, name, depth + 1));
  }
  const record = value as Record<string, unknown>;
  for (const key of ["name", "tool", "functionName"]) {
    if (record[key] === name) {
      return true;
    }
  }
  return Object.values(record).some((item) => toolDefinitionMentionsName(item, name, depth + 1));
}

function instructionTextMentionsToolName(text: string, name: string) {
  if (!text) {
    return false;
  }
  const escapedName = escapeRegExp(name);
  return new RegExp(`(^|[^A-Za-z0-9_])${escapedName}([^A-Za-z0-9_]|$)`).test(text);
}

function isQaToolSearchFixture(text: string) {
  return QA_TOOL_SEARCH_PROMPT_RE.test(text) || QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(text);
}

function buildExplicitSessionsSpawnArgs(text: string): Record<string, unknown> | null {
  if (!/\bsessions_spawn\b/i.test(text)) {
    return null;
  }
  const task = extractQuotedToolArg(text, "task");
  if (!task) {
    return null;
  }
  const label = extractQuotedToolArg(text, "label") ?? extractBareToolArg(text, "label");
  const mode = extractBareToolArg(text, "mode")?.toLowerCase();
  const context = extractBareToolArg(text, "context")?.toLowerCase();
  return {
    task,
    ...(label ? { label } : {}),
    ...(extractBareToolArg(text, "thread")?.toLowerCase() === "true" ? { thread: true } : {}),
    ...(mode === "session" || mode === "run" ? { mode } : {}),
    ...(context === "fork" || context === "isolated" ? { context } : {}),
  };
}

function buildQaA2aMessageToolMirrorSessionsSendArgs(text: string): Record<string, unknown> | null {
  if (!QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE.test(text)) {
    return null;
  }
  const sessionKey =
    extractQuotedToolArg(text, "sessionKey") ?? extractBareToolArg(text, "sessionKey");
  if (!sessionKey) {
    return null;
  }
  const marker =
    extractExactMarkerDirective(text) ??
    extractExactReplyDirective(text) ??
    "QA-A2A-MESSAGE-TOOL-MIRROR-OK";
  return {
    sessionKey,
    message: `qa group visible reply tool check. Use the visible room reply path. exact marker: \`${marker}\``,
    timeoutSeconds: 0,
  };
}

function extractToolErrorForNamedCall(params: {
  input: ResponsesInputItem[];
  name: string;
  toolJson: Record<string, unknown> | null;
}) {
  const error = typeof params.toolJson?.error === "string" ? params.toolJson.error.trim() : "";
  if (!error) {
    return undefined;
  }
  const namedFunctionCall = params.input.some(
    (item) => item.type === "function_call" && item.name === params.name,
  );
  if (namedFunctionCall) {
    return error;
  }
  return undefined;
}

function hasToolErrorOutput(toolJson: Record<string, unknown> | null, toolOutput: string) {
  if (typeof toolJson?.error === "string" && toolJson.error.trim()) {
    return true;
  }
  if (
    typeof toolJson?.status === "string" &&
    /\b(?:error|failed|failure)\b/i.test(toolJson.status)
  ) {
    return true;
  }
  return /\b(?:error|failed|failure|not found|no such file|enoent)\b/i.test(toolOutput);
}

function extractSessionStatusSessionKey(
  toolJson: Record<string, unknown> | null,
  toolOutput: string,
) {
  const details = toolJson?.details;
  if (details && typeof details === "object") {
    const sessionKey = (details as { sessionKey?: unknown }).sessionKey;
    if (typeof sessionKey === "string" && sessionKey.trim()) {
      return sessionKey.trim();
    }
  }
  const topLevelSessionKey = toolJson?.sessionKey;
  if (typeof topLevelSessionKey === "string" && topLevelSessionKey.trim()) {
    return topLevelSessionKey.trim();
  }
  const statusLineSessionKey = /(?:^|\n)[^\n]*Session:\s*([^\s•\n]+)/u.exec(toolOutput)?.[1];
  if (statusLineSessionKey?.trim()) {
    return statusLineSessionKey.trim();
  }
  return /"sessionKey"\s*:\s*"([^"]+)"/.exec(toolOutput)?.[1]?.trim() ?? "";
}

function isHeartbeatPrompt(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /remember this fact/i.test(trimmed)) {
    return false;
  }
  return /(?:^|\n)Read HEARTBEAT\.md if it exists\b/i.test(trimmed);
}

function readFirstMediaPath(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const media = value as {
    mediaUrl?: unknown;
    mediaUrls?: unknown;
    path?: unknown;
    filePath?: unknown;
    attachments?: unknown;
  };
  for (const candidate of [media.mediaUrl, media.path, media.filePath]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (Array.isArray(media.mediaUrls)) {
    const mediaUrl = media.mediaUrls.find(
      (candidate) => typeof candidate === "string" && candidate.trim(),
    );
    if (typeof mediaUrl === "string" && mediaUrl.trim()) {
      return mediaUrl.trim();
    }
  }
  if (Array.isArray(media.attachments)) {
    for (const attachment of media.attachments) {
      const mediaPath = readFirstMediaPath(attachment);
      if (mediaPath) {
        return mediaPath;
      }
    }
  }
  return "";
}

function buildAssistantText(
  input: ResponsesInputItem[],
  body: Record<string, unknown>,
  scenarioState: MockScenarioState,
) {
  const prompt = extractLastUserText(input);
  const toolOutput = extractToolOutput(input);
  const scenarioToolOutput =
    toolOutput ||
    (/thread memory check|session memory ranking check|memory tools check|repo contract followthrough check/i.test(
      extractAllRequestTexts(input, body),
    )
      ? extractLatestToolOutput(input)
      : "");
  const toolJson = parseToolOutputJson(scenarioToolOutput);
  const userTexts = extractAllUserTexts(input);
  const allInputText = extractAllRequestTexts(input, body);
  const rememberedFact = extractRememberedFact(userTexts);
  const model = typeof body.model === "string" ? body.model : "";
  const memorySnippet =
    typeof toolJson?.text === "string"
      ? toolJson.text
      : Array.isArray(toolJson?.results)
        ? JSON.stringify(toolJson.results)
        : scenarioToolOutput;
  const orbitCode = extractOrbitCode(memorySnippet) ?? extractOrbitCode(allInputText);
  const mediaPath =
    typeof toolJson?.details === "object" &&
    toolJson.details !== null &&
    !Array.isArray(toolJson.details)
      ? readFirstMediaPath((toolJson.details as { media?: unknown }).media)
      : "";
  const promptExactReplyDirective = extractExactReplyDirective(prompt);
  const promptExactMarkerDirective = extractExactMarkerDirective(prompt);
  const exactReplyDirective = promptExactReplyDirective ?? extractExactReplyDirective(allInputText);
  const exactMarkerDirective =
    promptExactMarkerDirective ?? extractExactMarkerDirective(allInputText);
  const whatsAppLocationMarker = shouldUseWhatsAppLocationMarker(prompt)
    ? extractWhatsAppLocationMarkerDirective(allInputText)
    : "";
  const whatsAppContactMarker = shouldUseWhatsAppContactMarker(prompt)
    ? extractWhatsAppContactMarkerDirective(allInputText)
    : "";
  const whatsAppStickerMarker = shouldUseWhatsAppStickerMarker(prompt)
    ? extractWhatsAppStickerMarkerDirective(allInputText)
    : "";
  const finishExactlyDirective =
    extractFinishExactlyDirective(prompt) ?? extractFinishExactlyDirective(allInputText);
  const latestImageUserTurn = extractLatestImageUserTurn(input);
  const activeMemorySummary = extractActiveMemorySummary(allInputText);
  const snackPreference = extractSnackPreference(activeMemorySummary ?? memorySnippet);
  const sessionsSpawnError = extractToolErrorForNamedCall({
    input,
    name: "sessions_spawn",
    toolJson,
  });

  if (/what was the qa canary code/i.test(prompt) && rememberedFact) {
    return `Protocol note: the QA canary code was ${rememberedFact}.`;
  }
  if (sessionsSpawnError) {
    return `Protocol note: sessions_spawn failed: ${sessionsSpawnError}`;
  }
  if (/remember this fact/i.test(prompt) && exactReplyDirective) {
    return exactReplyDirective;
  }
  if (/remember this fact/i.test(prompt) && rememberedFact) {
    return `Protocol note: acknowledged. I will remember ${rememberedFact}.`;
  }
  if (/memory unavailable check/i.test(prompt)) {
    return "Protocol note: I checked the available runtime context but could not confirm the hidden memory-only fact, so I will not guess.";
  }
  if (isHeartbeatPrompt(prompt)) {
    return "HEARTBEAT_OK";
  }
  if (
    /roundtrip image inspection check/i.test(latestImageUserTurn.text) &&
    latestImageUserTurn.imageInputCount > 0
  ) {
    return "Protocol note: the generated attachment shows the same QA lighthouse scene from the previous step.";
  }
  if (
    /image understanding check/i.test(latestImageUserTurn.text) &&
    latestImageUserTurn.imageInputCount > 0
  ) {
    return "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.";
  }
  if (whatsAppLocationMarker) {
    return whatsAppLocationMarker;
  }
  if (whatsAppContactMarker) {
    return whatsAppContactMarker;
  }
  if (whatsAppStickerMarker) {
    return whatsAppStickerMarker;
  }
  if (/\bmarker\b/i.test(prompt) && promptExactMarkerDirective) {
    return promptExactMarkerDirective;
  }
  if (/\bmarker\b/i.test(prompt) && promptExactReplyDirective) {
    return promptExactReplyDirective;
  }
  if (/\bmarker\b/i.test(allInputText) && promptExactReplyDirective) {
    return promptExactReplyDirective;
  }
  if (/\bmarker\b/i.test(allInputText) && exactMarkerDirective) {
    return exactMarkerDirective;
  }
  if (/\bmarker\b/i.test(allInputText) && exactReplyDirective) {
    return exactReplyDirective;
  }
  if (promptExactReplyDirective) {
    return promptExactReplyDirective;
  }
  if (/visible skill marker/i.test(prompt)) {
    return "VISIBLE-SKILL-OK";
  }
  if (/hot install marker/i.test(prompt)) {
    return "HOT-INSTALL-OK";
  }
  if (/memory tools check/i.test(prompt) && orbitCode) {
    return `Protocol note: I checked memory and the project codename is ${orbitCode}.`;
  }
  if (/silent snack recall check/i.test(prompt) && snackPreference) {
    return `Protocol note: you usually want ${snackPreference} for QA movie night.`;
  }
  if (/silent snack recall check/i.test(prompt)) {
    return "Protocol note: I do not have enough context to say what you usually want for QA movie night.";
  }
  if (/qa private final reply warning check/i.test(prompt)) {
    return [
      "QA-STRANDED-85714 confirms this is a substantive private final reply that intentionally stays outside the message tool path for the warning check.",
      "The response is long enough to exercise message_tool_only private-final detection while remaining private to the agent transcript.",
    ].join(" ");
  }
  if (isStrandedFinalRetryFailureRequest(allInputText)) {
    return buildStrandedFinalRetryFailureText();
  }
  if (QA_STRANDED_FINAL_RECOVERY_PROMPT_RE.test(allInputText)) {
    return QA_STRANDED_FINAL_RETRY_PROMPT_RE.test(allInputText)
      ? "QA-STRANDED-85714"
      : buildStrandedFinalRecoveryText();
  }
  if (/tool continuity check/i.test(prompt) && toolOutput) {
    return `Protocol note: model switch handoff confirmed on ${model || "the requested model"}. QA mission from QA_KICKOFF_TASK.md still applies: understand this OpenClaw repo from source + docs before acting.`;
  }
  if (toolOutput && promptExactReplyDirective) {
    return promptExactReplyDirective;
  }
  if ((toolOutput || allInputText) && /repo contract followthrough check/i.test(allInputText)) {
    const repoEvidenceText = [scenarioToolOutput, allInputText].filter(Boolean).join("\n");
    if (
      /successfully (?:wrote|created|updated|replaced)/i.test(repoEvidenceText) ||
      /status:\s*complete/i.test(repoEvidenceText)
    ) {
      return [
        "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
        "Wrote: repo-contract-summary.txt",
        "Status: complete",
      ].join("\n");
    }
    return [
      "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
      "Wrote: repo-contract-summary.txt",
      "Status: blocked",
    ].join("\n");
  }
  if (toolOutput && /personal task followthrough check/i.test(allInputText)) {
    const taskEvidenceText = scenarioToolOutput;
    if (/successfully (?:wrote|created|updated|replaced)/i.test(taskEvidenceText)) {
      return [
        "Pending: maintainer feedback before publishing",
        "Blocked: publishing needs explicit user approval",
        "Done: local evidence captured in personal-task-status.txt",
      ].join("\n");
    }
    return [
      "Pending: maintainer feedback before publishing",
      "Blocked: publishing needs explicit user approval",
      "Done: blocked until personal-task-status.txt exists",
    ].join("\n");
  }
  if (/session memory ranking check/i.test(prompt) && orbitCode) {
    return `Protocol note: I checked memory and the current Project Nebula codename is ${orbitCode}.`;
  }
  if (/thread memory check/i.test(allInputText) && orbitCode) {
    return `Protocol note: I checked memory in-thread and the hidden thread codename is ${orbitCode}.`;
  }
  if (/switch(?:ing)? models?/i.test(prompt)) {
    return `Protocol note: model switch acknowledged. Continuing on ${model || "the requested model"}.`;
  }
  if (QA_IMAGE_GENERATION_PROMPT_RE.test(allInputText) && mediaPath) {
    return `Protocol note: generated the QA lighthouse image successfully. Attachment: ${mediaPath}`;
  }
  if (QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(prompt) && toolOutput) {
    return [
      "Animated GIF QA checklist ready.",
      "- Confirm true animation, not a static preview.",
      "- Verify dimensions and product UI fit.",
      "- Record attribution and license.",
      "- Keep a local copy before using the asset.",
      "- Re-open the copied file for final verification.",
    ].join("\n");
  }
  if (
    /interrupted by a gateway reload/i.test(prompt) &&
    /subagent recovery worker/i.test(allInputText)
  ) {
    return "RECOVERED-SUBAGENT-OK";
  }
  if (/subagent recovery worker/i.test(prompt)) {
    return "RECOVERED-SUBAGENT-OK";
  }
  if (/fanout worker alpha/i.test(prompt)) {
    return "ALPHA-OK";
  }
  if (/fanout worker beta/i.test(prompt)) {
    return "BETA-OK";
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE.test(prompt)) {
    return QA_SUBAGENT_DIRECT_FALLBACK_MARKER;
  }
  if (/report the visible code/i.test(prompt) && /FORKED-CONTEXT-ALPHA/i.test(allInputText)) {
    return "FORKED-CONTEXT-ALPHA";
  }
  const fanoutCompleteReply = "subagent-1: ok\nsubagent-2: ok";
  if (scenarioState.subagentFanoutPhase === 2 && prompt) {
    scenarioState.subagentFanoutPhase = 3;
    return fanoutCompleteReply;
  }
  if (
    /forked subagent context qa check/i.test(prompt) &&
    /FORKED-CONTEXT-ALPHA/i.test(allInputText)
  ) {
    return [
      "Worked",
      "- FORKED-CONTEXT-ALPHA",
      "Evidence",
      "- The forked child recovered the visible code from requester transcript context.",
      "Blocked",
      "- None.",
    ].join("\n");
  }
  if (
    toolOutput &&
    (/delegate (?:one |a )bounded qa task/i.test(allInputText) ||
      /subagent handoff/i.test(allInputText))
  ) {
    const compact = toolOutput.replace(/\s+/g, " ").trim() || "no delegated output";
    return `Delegated task:\n- Inspect the QA workspace via a bounded subagent.\nResult:\n- ${compact}\nEvidence:\n- The child result was folded back into the main thread exactly once.`;
  }
  if (toolOutput && /worked, failed, blocked|worked\/failed\/blocked|follow-up/i.test(prompt)) {
    return `Worked:\n- Read seeded QA material.\n- Expanded the report structure.\nFailed:\n- None observed in mock mode.\nBlocked:\n- No live provider evidence in this lane.\nFollow-up:\n- Re-run with a real model for qualitative coverage.`;
  }
  if (toolOutput && /lobster invaders/i.test(prompt)) {
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return "";
    }
    return `Protocol note: Lobster Invaders built at lobster-invaders.html.`;
  }
  if (
    toolOutput &&
    (/compaction retry mutating tool check/i.test(allInputText) ||
      /compaction-retry-summary\.txt/i.test(toolOutput))
  ) {
    if (
      toolOutput.includes("Replay safety: unsafe after write.") ||
      /compaction-retry-summary\.txt/i.test(toolOutput) ||
      /successfully (?:wrote|replaced)/i.test(toolOutput) ||
      /\bwrote\b.*\bcompaction-retry-summary\.txt\b/i.test(toolOutput)
    ) {
      return "Protocol note: replay unsafe after write.";
    }
    return "";
  }
  if (
    toolOutput &&
    (QA_TOOL_SEARCH_PROMPT_RE.test(allInputText) ||
      QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText))
  ) {
    const targetTool = extractToolSearchTarget(allInputText);
    if (targetTool && toolOutput.includes(targetTool) && toolOutput.includes("FAKE_PLUGIN_OK")) {
      return `FAKE_PLUGIN_OK ${targetTool}`;
    }
  }
  if (
    toolOutput &&
    /(worked, failed, blocked|worked\/failed\/blocked|source and docs)/i.test(allInputText)
  ) {
    return [
      "Worked:",
      "- Read all three seeded files: repo/qa/scenarios/index.yaml, repo/extensions/qa-lab/src/suite.ts, and repo/docs/help/testing.md.",
      "- Extra QA scenario candidates: config restart capability flip and image generation roundtrip.",
      "Failed:",
      "- None observed in mock mode.",
      "Blocked:",
      "- No live provider evidence in this lane.",
      "Follow-up:",
      "- Re-run with a real model for qualitative coverage.",
    ].join("\n");
  }
  if (toolOutput) {
    const snippet = truncateUtf16Safe(toolOutput.replace(/\s+/g, " ").trim(), 220);
    return `Protocol note: I reviewed the requested material. Evidence snippet: ${snippet || "no content"}`;
  }
  if (finishExactlyDirective) {
    return finishExactlyDirective;
  }
  if (prompt) {
    return `Protocol note: acknowledged. Continue with the QA scenario plan and report worked, failed, and blocked items.`;
  }
  return "Protocol note: mock OpenAI server ready.";
}

function buildToolCallEvents(prompt: string): StreamEvent[] {
  const targetPath = readTargetFromPrompt(prompt);
  return buildToolCallEventsWithArgs("read", { path: targetPath });
}

function buildReleaseAuditJson() {
  return `${JSON.stringify(
    {
      verified: false,
      findings: [
        {
          id: "REL-GATEWAY-417",
          source: "src/gateway/reconnect.ts",
          status: "retry jitter verified, resume token fallback still needs manual spot check",
          verified: true,
        },
        {
          id: "REL-CHANNEL-238",
          source: "src/channels/delivery.ts",
          status: "thread replies preserve ordering, root-channel fallback needs handoff note",
          verified: true,
        },
        {
          id: "REL-CRON-904",
          source: "src/scheduling/cron.ts",
          status: "single-run lock verified for restart wakeups",
          verified: true,
        },
        {
          id: "REL-MEMORY-552",
          source: "src/memory/recall.ts",
          status:
            "fallback summary survives empty memory search; ranking sample needs second reviewer",
          verified: true,
        },
        {
          id: "REL-PLUGIN-319",
          source: "src/plugins/runtime.ts",
          status: "bundled runtime manifest loads cleanly after restart",
          verified: true,
        },
        {
          id: "REL-INSTALL-846",
          source: "install/update.ts",
          status: "update smoke passed from previous stable tag",
          verified: true,
        },
        {
          id: "REL-DOCS-611",
          source: "docs/operator-notes.md",
          status:
            "docs mention reconnect, cron, memory, plugin, and installer checks; channel ordering and UI notes need maintainer handoff",
          verified: true,
        },
        {
          id: "REL-UI-BLOCKED",
          source: "ui/control-panel.ts",
          status: "blocked: source file was referenced by checklist but missing from the fixture",
          verified: false,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function buildReleaseHandoffMarkdown() {
  return [
    "# Release Handoff",
    "",
    "Ready:",
    "- REL-GATEWAY-417: gateway reconnect handling checked in `src/gateway/reconnect.ts`.",
    "- REL-CRON-904: cron duplicate prevention checked in `src/scheduling/cron.ts`.",
    "- REL-PLUGIN-319: plugin runtime loading checked in `src/plugins/runtime.ts`.",
    "- REL-INSTALL-846: installer update path checked in `install/update.ts`.",
    "",
    "Follow-up:",
    "- REL-CHANNEL-238: channel delivery ordering needs maintainer handoff.",
    "- REL-MEMORY-552: memory recall fallback ranking sample needs a second reviewer.",
    "- REL-DOCS-611: docs update status needs channel ordering and UI notes.",
    "- `ui/control-panel.ts` is blocked/not found in the fixture.",
    "",
  ].join("\n");
}

function extractPlannedToolName(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; name?: unknown };
    if (item.type === "function_call" && typeof item.name === "string") {
      return item.name;
    }
  }
  return undefined;
}

function extractPlannedToolCallId(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; call_id?: unknown };
    if (item.type === "function_call" && typeof item.call_id === "string") {
      return item.call_id;
    }
  }
  return undefined;
}

function extractPlannedToolArgs(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; arguments?: unknown };
    if (item.type !== "function_call" || typeof item.arguments !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(item.arguments);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

type MockAssistantMessageSpec = {
  id: string;
  phase?: "commentary" | "final_answer";
  streamDeltas?: string[];
  text: string;
};

function splitMockStreamingText(text: string, parts = 3) {
  if (text.length <= 1) {
    return [text];
  }
  const chunkSize = Math.max(1, Math.ceil(text.length / parts));
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks.length > 1 ? chunks : [text.slice(0, 1), text.slice(1)];
}

function buildQaLongFinalText({
  endMarker = "TELEGRAM-LONG-FINAL-END",
  segmentPrefix = "telegram-long-final-segment",
  segmentCount = 42,
  startMarker = "TELEGRAM-LONG-FINAL-BEGIN",
}: {
  endMarker?: string;
  segmentPrefix?: string;
  segmentCount?: number;
  startMarker?: string;
} = {}) {
  const body = Array.from(
    { length: segmentCount },
    (_, index) => `${segmentPrefix}-${String(index + 1).padStart(3, "0")} ${"x".repeat(54)}`,
  ).join("\n");
  return `${startMarker}\n${body}\n${endMarker}`;
}

function buildAssistantOutputItem(spec: MockAssistantMessageSpec) {
  return {
    type: "message",
    id: spec.id,
    role: "assistant",
    status: "completed",
    ...(spec.phase ? { phase: spec.phase } : {}),
    content: [{ type: "output_text", text: spec.text, annotations: [] }],
  } as const;
}

function appendAssistantMessageEvents(events: StreamEvent[], spec: MockAssistantMessageSpec) {
  events.push({
    type: "response.output_item.added",
    item: {
      type: "message",
      id: spec.id,
      role: "assistant",
      ...(spec.phase ? { phase: spec.phase } : {}),
      content: [],
      status: "in_progress",
    },
  });
  for (const delta of spec.streamDeltas ?? []) {
    events.push({
      type: "response.output_text.delta",
      item_id: spec.id,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }
  if ((spec.streamDeltas ?? []).length > 0) {
    events.push({
      type: "response.output_text.done",
      item_id: spec.id,
      output_index: 0,
      content_index: 0,
      text: spec.text,
    });
  }
  events.push({
    type: "response.output_item.done",
    item: buildAssistantOutputItem(spec),
  });
}

function buildAssistantThenToolCallEvents(
  spec: MockAssistantMessageSpec,
  name: string,
  args: Record<string, unknown>,
): StreamEvent[] {
  const call = buildMockFunctionCall(name, args);
  const message = buildAssistantOutputItem(spec);
  const events: StreamEvent[] = [];
  appendAssistantMessageEvents(events, spec);
  events.push({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: call.itemId,
      call_id: call.callId,
      name,
      arguments: "",
    },
  });
  events.push({ type: "response.function_call_arguments.delta", delta: call.serialized });
  events.push({
    type: "response.output_item.done",
    item: call.item,
  });
  events.push({
    type: "response.completed",
    response: {
      id: call.responseId,
      status: "completed",
      output: [message, call.item],
      usage: { input_tokens: 64, output_tokens: 32, total_tokens: 96 },
    },
  });
  return events;
}

function buildAssistantEvents(specsOrText: MockAssistantMessageSpec[] | string): StreamEvent[] {
  const specs =
    typeof specsOrText === "string"
      ? [
          {
            id: "msg_mock_1",
            text: specsOrText,
          },
        ]
      : specsOrText;
  const output = specs.map((spec) => buildAssistantOutputItem(spec));
  const events: StreamEvent[] = [];

  for (const [outputIndex, spec] of specs.entries()) {
    events.push({
      type: "response.output_item.added",
      item: {
        type: "message",
        id: spec.id,
        role: "assistant",
        ...(spec.phase ? { phase: spec.phase } : {}),
        content: [],
        status: "in_progress",
      },
    });
    for (const delta of spec.streamDeltas ?? []) {
      events.push({
        type: "response.output_text.delta",
        item_id: spec.id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    if ((spec.streamDeltas ?? []).length > 0) {
      events.push({
        type: "response.output_text.done",
        item_id: spec.id,
        output_index: outputIndex,
        content_index: 0,
        text: spec.text,
      });
    }
    events.push({
      type: "response.output_item.done",
      item: output[outputIndex],
    });
  }

  events.push({
    type: "response.completed",
    response: {
      id: "resp_mock_msg_1",
      status: "completed",
      output,
      usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
    },
  });
  return events;
}

function buildReasoningOnlyEvents(summaryText: string, id: string): StreamEvent[] {
  const reasoningItem = {
    type: "reasoning",
    id,
    summary: [{ text: summaryText }],
  } as const;
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "reasoning",
        id,
        summary: [],
      },
    },
    {
      type: "response.output_item.done",
      item: reasoningItem,
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [reasoningItem],
        usage: { input_tokens: 64, output_tokens: 8, total_tokens: 72 },
      },
    },
  ];
}

function buildReasoningAndAssistantEvents(params: {
  reasoningId: string;
  answerText: string;
  answerId?: string;
}): StreamEvent[] {
  const reasoningItem = {
    type: "reasoning",
    id: params.reasoningId,
    summary: [],
  } as const;
  const answerItem = buildAssistantOutputItem({
    id: params.answerId ?? "msg_mock_reasoned_answer",
    phase: "final_answer",
    text: params.answerText,
  });
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "reasoning",
        id: params.reasoningId,
        summary: [],
      },
    },
    {
      type: "response.output_item.done",
      item: reasoningItem,
    },
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: answerItem.id,
        role: "assistant",
        phase: "final_answer",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_text.delta",
      item_id: answerItem.id,
      output_index: 1,
      content_index: 0,
      delta: params.answerText,
    },
    {
      type: "response.output_text.done",
      item_id: answerItem.id,
      output_index: 1,
      content_index: 0,
      text: params.answerText,
    },
    {
      type: "response.output_item.done",
      item: answerItem,
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${params.reasoningId}`,
        status: "completed",
        output: [reasoningItem, answerItem],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

async function buildResponsesPayload(
  body: Record<string, unknown>,
  scenarioState: MockScenarioState,
) {
  const providerVariant = resolveProviderVariant(
    typeof body.model === "string" ? body.model : undefined,
  );
  const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
  const prompt = extractLastUserText(input);
  const toolOutput = extractToolOutput(input);
  const allInputText = extractAllRequestTexts(input, body);
  const scenarioToolOutput =
    toolOutput ||
    (/thread memory check|session memory ranking check|memory tools check|repo contract followthrough check/i.test(
      allInputText,
    )
      ? extractLatestToolOutput(input)
      : "");
  const toolJson = parseToolOutputJson(scenarioToolOutput);
  const promptExactReplyDirective = extractExactReplyDirective(prompt);
  const promptExactMarkerDirective = extractExactMarkerDirective(prompt);
  const exactReplyDirective = promptExactReplyDirective ?? extractExactReplyDirective(allInputText);
  const exactMarkerDirective =
    promptExactMarkerDirective ?? extractExactMarkerDirective(allInputText);
  const whatsAppLocationMarker = shouldUseWhatsAppLocationMarker(prompt)
    ? extractWhatsAppLocationMarkerDirective(allInputText)
    : "";
  const whatsAppContactMarker = shouldUseWhatsAppContactMarker(prompt)
    ? extractWhatsAppContactMarkerDirective(allInputText)
    : "";
  const whatsAppStickerMarker = shouldUseWhatsAppStickerMarker(prompt)
    ? extractWhatsAppStickerMarkerDirective(allInputText)
    : "";
  const blockStreamingPrompt =
    extractLastMatchingUserText(extractAllUserTexts(input), QA_BLOCK_STREAMING_PROMPT_RE) ||
    prompt ||
    allInputText;
  const blockStreamingMarkers =
    extractBlockStreamingMarkerDirectives(blockStreamingPrompt) ??
    extractBlockStreamingMarkerDirectives(allInputText);
  const latestImageUserTurn = extractLatestImageUserTurn(input);
  const isGroupChat = allInputText.includes('"is_group_chat": true');
  const isBaselineUnmentionedChannelChatter = /\bno bot ping here\b/i.test(prompt);
  const hasReasoningOnlyRetryInstruction = allInputText.includes(QA_REASONING_ONLY_RETRY_NEEDLE);
  const hasEmptyResponseRetryInstruction = allInputText.includes(QA_EMPTY_RESPONSE_RETRY_NEEDLE);
  const canCallMockSubagentTool =
    QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText) ||
    /subagent fanout synthesis check/i.test(allInputText) ||
    /forked subagent context qa check/i.test(allInputText) ||
    /delegate (?:one |a )bounded qa task/i.test(allInputText) ||
    /subagent handoff/i.test(allInputText) ||
    buildExplicitSessionsSpawnArgs(allInputText) !== null;
  const canCallSessionsSpawn = hasDeclaredTool(body, "sessions_spawn") || canCallMockSubagentTool;
  const canCallSessionsYield =
    hasDeclaredTool(body, "sessions_yield") ||
    QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText);
  const buildToolProgressReadEvents = (pattern: RegExp) => {
    const toolProgressPrompt = extractLastMatchingUserText(extractAllUserTexts(input), pattern);
    return buildToolCallEventsWithArgs("read", {
      path: readTargetFromPrompt(toolProgressPrompt || prompt || allInputText),
    });
  };
  const buildToolProgressExecEvents = (pattern: RegExp) => {
    const toolProgressPrompt = extractLastMatchingUserText(extractAllUserTexts(input), pattern);
    const command = execCommandFromToolProgressPrompt(toolProgressPrompt || prompt || allInputText);
    return command ? buildToolCallEventsWithArgs("exec", { command }) : null;
  };
  if (
    (QA_TOOL_SEARCH_PROMPT_RE.test(allInputText) ||
      QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText)) &&
    !toolOutput
  ) {
    const targetTool = extractToolSearchTarget(allInputText);
    const plannedArgs = targetTool
      ? buildQaToolSearchArgs(targetTool, QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText))
      : {};
    if (targetTool && hasDeclaredTool(body, "tool_search_code")) {
      return buildToolCallEventsWithArgs("tool_search_code", {
        code: [
          `const hits = await openclaw.tools.search(${JSON.stringify(targetTool)}, { limit: 1 });`,
          "const match = hits.find((tool) => tool.name === " + JSON.stringify(targetTool) + ");",
          "if (!match) throw new Error('target tool not found');",
          `return await openclaw.tools.call(match.id, ${JSON.stringify(plannedArgs)});`,
        ].join("\n"),
      });
    }
    if (targetTool && (hasDeclaredTool(body, targetTool) || isQaToolSearchFixture(allInputText))) {
      return buildToolCallEventsWithArgs(targetTool, plannedArgs);
    }
  }
  if (
    QA_MCP_CODE_MODE_API_FILE_PROMPT_RE.test(allInputText) ||
    QA_MCP_CODE_MODE_PROMPT_RE.test(allInputText)
  ) {
    if (!toolOutput && hasDeclaredTool(body, "exec")) {
      const useApiFiles = QA_MCP_CODE_MODE_API_FILE_PROMPT_RE.test(allInputText);
      return buildToolCallEventsWithArgs("exec", {
        language: "javascript",
        code: useApiFiles
          ? [
              'const files = await API.list("mcp");',
              'const root = await API.read("mcp/index.d.ts");',
              'const api = await API.read("mcp/fixture.d.ts");',
              'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
              "return {",
              '  marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",',
              "  files: files.files.map((file) => file.path),",
              "  rootHasFixture: root.content.includes('fixture'),",
              "  headerHasLookup: api.content.includes('function lookupNote'),",
              "  resultText: result.content?.[0]?.text,",
              "  allHasMcp: ALL_TOOLS.some((tool) => tool.source === 'mcp'),",
              "};",
            ].join("\n")
          : [
              "const rootApi = await MCP.$api();",
              'const api = await MCP.fixture.$api("lookupNote", { schema: true });',
              'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
              "return {",
              '  marker: "MCP_CODE_MODE_TOOL_RESULT",',
              "  rootServers: rootApi.servers,",
              "  headerHasLookup: api.header.includes('function lookupNote'),",
              "  schemaKeys: Object.keys(api.schemas),",
              "  resultText: result.content?.[0]?.text,",
              "  allHasMcp: ALL_TOOLS.some((tool) => tool.source === 'mcp'),",
              "};",
            ].join("\n"),
      });
    }
    if (
      toolJson?.status === "waiting" &&
      typeof toolJson.runId === "string" &&
      hasDeclaredTool(body, "wait")
    ) {
      return buildToolCallEventsWithArgs("wait", { runId: toolJson.runId });
    }
    if (
      toolOutput.includes("MCP_CODE_MODE_FILE_TOOL_RESULT") &&
      toolOutput.includes("fixture-note-alpha")
    ) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none improvement=virtual-api-files-were-clear-and-needed-one-exec",
      );
    }
    if (toolOutput.includes("MCP_CODE_MODE_FILE_TOOL_RESULT")) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_FILE_FAIL unclear=code-mode-exec-did-not-return-fixture-note",
      );
    }
    if (/MCP_CODE_MODE_TOOL_RESULT|fixture-note-alpha/.test(toolOutput)) {
      return buildAssistantEvents(
        "MCP_CODE_MODE_OK unclear=none improvement=virtual-header-files-would-avoid-the-first-api-call",
      );
    }
  }
  if (
    allInputText.includes(QA_SUBAGENT_DIRECT_FALLBACK_MARKER) &&
    /Internal task completion event/i.test(allInputText)
  ) {
    return buildAssistantEvents("");
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText)) {
    if (!toolOutput && canCallSessionsSpawn) {
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: `Subagent direct fallback worker: finish with exactly ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
        label: "qa-direct-fallback-worker",
        thread: false,
        mode: "run",
      });
    }
    if (toolOutput && canCallSessionsYield && !/\byielded\b/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: `Waiting for ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
      });
    }
  }
  if (/remember this fact/i.test(prompt)) {
    return buildAssistantEvents(buildAssistantText(input, body, scenarioState));
  }
  if (isHeartbeatPrompt(prompt)) {
    return buildAssistantEvents("HEARTBEAT_OK");
  }
  if (/fanout worker alpha/i.test(prompt)) {
    return buildAssistantEvents("ALPHA-OK");
  }
  if (/fanout worker beta/i.test(prompt)) {
    return buildAssistantEvents("BETA-OK");
  }
  if (
    /roundtrip image inspection check/i.test(latestImageUserTurn.text) &&
    latestImageUserTurn.imageInputCount > 0
  ) {
    return buildAssistantEvents(
      "Protocol note: the generated attachment shows the same QA lighthouse scene from the previous step.",
    );
  }
  if (
    /image understanding check/i.test(latestImageUserTurn.text) &&
    latestImageUserTurn.imageInputCount > 0
  ) {
    return buildAssistantEvents(
      "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.",
    );
  }
  if (QA_REASONING_ONLY_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasReasoningOnlyRetryInstruction) {
      return buildReasoningOnlyEvents(
        "Need visible answer after reading the QA kickoff task.",
        "rs_mock_reasoning_recovery",
      );
    }
    return buildAssistantEvents("REASONING-RECOVERED-OK");
  }
  if (QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "reasoning-only-side-effect.txt",
        content: "side effects already happened\n",
      });
    }
    if (!hasReasoningOnlyRetryInstruction) {
      return buildReasoningOnlyEvents(
        "Need visible answer after the write, but the write already happened.",
        "rs_mock_reasoning_side_effect",
      );
    }
    return buildAssistantEvents("BUG-SHOULD-NOT-AUTO-RETRY");
  }
  if (QA_THINKING_VISIBILITY_MAX_PROMPT_RE.test(prompt)) {
    return buildReasoningAndAssistantEvents({
      reasoningId: "rs_mock_thinking_visibility_max",
      answerText: "THINKING-MAX-OK",
    });
  }
  if (QA_THINKING_VISIBILITY_OFF_PROMPT_RE.test(prompt)) {
    return buildAssistantEvents("THINKING-OFF-OK");
  }
  if (QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasEmptyResponseRetryInstruction) {
      return buildAssistantEvents("");
    }
    return buildAssistantEvents("EMPTY-RECOVERED-OK");
  }
  if (QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE.test(allInputText)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    return buildAssistantEvents("");
  }
  if (QA_TELEGRAM_LONG_FINAL_THREE_CHUNK_PROMPT_RE.test(allInputText)) {
    const text = buildQaLongFinalText({
      endMarker: "TELEGRAM-LONG-FINAL-3CHUNK-END",
      segmentCount: 96,
      startMarker: "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN",
    });
    return buildAssistantEvents([
      {
        id: "msg_mock_telegram_long_final_three_chunk",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(text),
        text,
      },
    ]);
  }
  if (QA_TELEGRAM_LONG_FINAL_PROMPT_RE.test(allInputText)) {
    const text = buildQaLongFinalText();
    return buildAssistantEvents([
      {
        id: "msg_mock_telegram_long_final",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(text),
        text,
      },
    ]);
  }
  if (QA_WHATSAPP_LONG_FINAL_PROMPT_RE.test(allInputText)) {
    const text = buildQaLongFinalText({
      endMarker: "WHATSAPP-LONG-FINAL-END",
      segmentPrefix: "whatsapp-long-final-segment",
      segmentCount: 64,
      startMarker: "WHATSAPP-LONG-FINAL-BEGIN",
    });
    return buildAssistantEvents([
      {
        id: "msg_mock_whatsapp_long_final",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(text),
        text,
      },
    ]);
  }
  const whatsAppPendingHistoryReply = buildWhatsAppPendingHistoryReply(allInputText);
  if (whatsAppPendingHistoryReply) {
    return buildAssistantEvents(whatsAppPendingHistoryReply);
  }
  const whatsAppBroadcastReply = buildWhatsAppBroadcastReply(allInputText);
  if (whatsAppBroadcastReply) {
    return buildAssistantEvents(whatsAppBroadcastReply);
  }
  const whatsAppGroupDispatchReply = buildWhatsAppGroupDispatchReply(allInputText);
  if (whatsAppGroupDispatchReply) {
    return buildAssistantEvents(whatsAppGroupDispatchReply);
  }
  const whatsAppBatchedReply = buildWhatsAppBatchedReply(allInputText);
  if (whatsAppBatchedReply) {
    return buildAssistantEvents(whatsAppBatchedReply);
  }
  const slackChartMatch = QA_SLACK_CHART_PRESENTATION_PROMPT_RE.exec(allInputText);
  if (slackChartMatch?.[1] && slackChartMatch[2]) {
    if (!toolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: slackChartMatch[1],
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "line",
              title: "QA latency trend",
              categories: ["P50", "P95"],
              series: [{ name: "Latency", values: [120, 240] }],
              xLabel: "Percentile",
              yLabel: "Milliseconds",
            },
          ],
        },
      });
    }
    if (toolOutput) {
      return buildAssistantEvents(slackChartMatch[2]);
    }
  }
  if (QA_WHATSAPP_AGENT_MESSAGE_ACTION_REACT_PROMPT_RE.test(allInputText)) {
    if (!toolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "react",
        emoji: "👍",
      });
    }
    if (toolOutput) {
      return buildAssistantEvents("");
    }
  }
  const whatsAppUploadMatch = QA_WHATSAPP_AGENT_MESSAGE_ACTION_UPLOAD_PROMPT_RE.exec(allInputText);
  if (whatsAppUploadMatch?.[1]) {
    if (!toolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "upload-file",
        buffer: TINY_PNG_BASE64,
        caption: whatsAppUploadMatch[1],
        contentType: "image/png",
        filename: "whatsapp-qa-agent-upload.png",
      });
    }
    if (toolOutput) {
      return buildAssistantEvents("");
    }
  }
  if (
    QA_STREAMING_PROMPT_RE.test(allInputText) &&
    allInputText.includes(QA_TELEGRAM_STREAM_SINGLE_MARKER)
  ) {
    return buildAssistantEvents([
      {
        id: "msg_mock_telegram_quiet_stream",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(QA_TELEGRAM_STREAM_SINGLE_MARKER),
        text: QA_TELEGRAM_STREAM_SINGLE_MARKER,
      },
    ]);
  }
  if (QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE.test(allInputText) && exactReplyDirective) {
    return buildAssistantEvents([
      {
        id: "msg_mock_final_only_marker_stream",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText("QA streaming preview in progress"),
        text: exactReplyDirective,
      },
    ]);
  }
  if (QA_STREAMING_PROMPT_RE.test(allInputText) && exactReplyDirective) {
    return buildAssistantEvents([
      {
        id: "msg_mock_quiet_stream",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(exactReplyDirective),
        text: exactReplyDirective,
      },
    ]);
  }
  const toolProgressReplyDirective = exactReplyDirective ?? exactMarkerDirective;
  if (QA_TOOL_PROGRESS_ERROR_PROMPT_RE.test(allInputText) && toolProgressReplyDirective) {
    if (!toolOutput) {
      return buildToolProgressReadEvents(QA_TOOL_PROGRESS_ERROR_PROMPT_RE);
    }
    return buildAssistantEvents(
      hasToolErrorOutput(toolJson, toolOutput)
        ? toolProgressReplyDirective
        : "BUG-TOOL-DID-NOT-FAIL",
    );
  }
  if (QA_TOOL_PROGRESS_PROMPT_RE.test(allInputText) && toolProgressReplyDirective) {
    if (!toolOutput) {
      return (
        buildToolProgressExecEvents(QA_TOOL_PROGRESS_PROMPT_RE) ??
        buildToolProgressReadEvents(QA_TOOL_PROGRESS_PROMPT_RE)
      );
    }
    return buildAssistantEvents(toolProgressReplyDirective);
  }
  if (QA_BLOCK_STREAMING_PROMPT_RE.test(allInputText) && blockStreamingMarkers) {
    if (!toolOutput) {
      return buildAssistantThenToolCallEvents(
        {
          id: "msg_mock_block_1",
          phase: "final_answer",
          streamDeltas: splitMockStreamingText(blockStreamingMarkers.first),
          text: blockStreamingMarkers.first,
        },
        "read",
        {
          path: readTargetFromPrompt(blockStreamingPrompt),
        },
      );
    }
    return buildAssistantEvents([
      {
        id: "msg_mock_block_2",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(blockStreamingMarkers.second),
        text: blockStreamingMarkers.second,
      },
    ]);
  }
  if (isStrandedFinalRetryFailureRequest(allInputText)) {
    return buildAssistantEvents(buildStrandedFinalRetryFailureText());
  }
  if (QA_STRANDED_FINAL_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (QA_STRANDED_FINAL_RETRY_PROMPT_RE.test(allInputText)) {
      if (!toolOutput && hasDeclaredTool(body, "message")) {
        return buildToolCallEventsWithArgs("message", {
          action: "send",
          message: "QA-STRANDED-85714",
        });
      }
      return buildAssistantEvents("");
    }
    return buildAssistantEvents(buildStrandedFinalRecoveryText());
  }
  if (QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE.test(prompt)) {
    if (toolOutput) {
      return buildAssistantEvents("");
    }
    const sessionsSendArgs = buildQaA2aMessageToolMirrorSessionsSendArgs(prompt);
    if (sessionsSendArgs && hasDeclaredTool(body, "sessions_send")) {
      return buildToolCallEventsWithArgs("sessions_send", sessionsSendArgs);
    }
  }
  if (QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE.test(allInputText)) {
    const marker = exactMarkerDirective ?? exactReplyDirective ?? "QA-GROUP-TOOL-OK";
    if (!toolOutput && hasDeclaredTool(body, "message")) {
      return buildToolCallEventsWithArgs("message", {
        action: "send",
        message: marker,
      });
    }
    return buildAssistantEvents("");
  }
  if (QA_GROUP_MESSAGE_UNAVAILABLE_FALLBACK_PROMPT_RE.test(allInputText)) {
    return buildAssistantEvents(
      exactMarkerDirective ?? exactReplyDirective ?? "QA-GROUP-FALLBACK-OK",
    );
  }
  if (whatsAppLocationMarker) {
    return buildAssistantEvents(whatsAppLocationMarker);
  }
  if (whatsAppContactMarker) {
    return buildAssistantEvents(whatsAppContactMarker);
  }
  if (whatsAppStickerMarker) {
    return buildAssistantEvents(whatsAppStickerMarker);
  }
  if (/\bmarker\b/i.test(prompt) && promptExactMarkerDirective) {
    return buildAssistantEvents(promptExactMarkerDirective);
  }
  if (/\bmarker\b/i.test(prompt) && promptExactReplyDirective) {
    return buildAssistantEvents(promptExactReplyDirective);
  }
  const isTelegramCurrentSessionStatusTurn =
    QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(prompt) ||
    (Boolean(toolOutput) && QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(allInputText));
  if (isTelegramCurrentSessionStatusTurn) {
    if (!toolOutput && hasDeclaredTool(body, "session_status")) {
      return buildToolCallEventsWithArgs("session_status", { sessionKey: "current" });
    }
    const sessionKey = extractSessionStatusSessionKey(toolJson, toolOutput);
    return buildAssistantEvents(
      sessionKey.includes(":telegram:group:")
        ? `QA-TELEGRAM-CURRENT-SESSION-OK ${sessionKey}`
        : `QA-TELEGRAM-CURRENT-SESSION-BAD ${sessionKey || "missing-session-key"}`,
    );
  }
  if (/\bmarker\b/i.test(allInputText) && promptExactReplyDirective) {
    return buildAssistantEvents(promptExactReplyDirective);
  }
  if (/\bmarker\b/i.test(allInputText) && exactMarkerDirective) {
    return buildAssistantEvents(exactMarkerDirective);
  }
  if (/\bmarker\b/i.test(allInputText) && exactReplyDirective) {
    return buildAssistantEvents(exactReplyDirective);
  }
  if (QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE.test(allInputText)) {
    return buildAssistantEvents(
      JSON.stringify({
        action: "create",
        skillName: "animated-gif-workflow",
        title: "Animated GIF Workflow",
        reason: "Transcript captured a reusable animated media QA checklist.",
        description: "Reusable workflow notes for animated GIF QA tasks.",
        body: [
          "- Confirm the asset has true animation, not a static preview.",
          "- Check dimensions against the target product UI slot.",
          "- Record attribution and license before using the file.",
          "- Keep a local copy under the workspace before integration.",
          "- Re-open the local copy for final verification.",
        ].join("\n"),
      }),
    );
  }
  if (QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("write", {
      path: "animated-gif-qa-checklist.md",
      content: [
        "# Animated GIF QA Checklist",
        "",
        "- Confirm true animation.",
        "- Verify dimensions.",
        "- Record attribution.",
        "- Keep a local copy.",
        "- Perform final verification.",
      ].join("\n"),
    });
  }
  if (QA_RELEASE_AUDIT_PROMPT_RE.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "audit-fixture/README.md" });
    }
    if (/Release readiness task|current checklist/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("read", {
        path: "audit-fixture/docs/current-readiness-checklist.md",
      });
    }
    if (/Current release readiness requires checking eight areas/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("write", {
        path: "audit-fixture/release-audit.json",
        content: buildReleaseAuditJson(),
      });
    }
    if (/release-audit\.json/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("write", {
        path: "audit-fixture/release-handoff.md",
        content: buildReleaseHandoffMarkdown(),
      });
    }
    if (/release-handoff\.md/i.test(toolOutput)) {
      return buildAssistantEvents("RELEASE-AUDIT-COMPLETE");
    }
  }
  if (/dreaming shadow trial report check/i.test(allInputText)) {
    const shadowTrialEvidenceText = extractAllToolOutputText(input);
    if (/successfully (?:wrote|created|updated|replaced)/i.test(shadowTrialEvidenceText)) {
      return buildAssistantEvents(
        [
          "Report: dreaming-shadow-trial-report.md",
          "Promotion action: report-only",
          "DREAMING-SHADOW-TRIAL-OK",
        ].join("\n"),
      );
    }
    if (
      !shadowTrialEvidenceText ||
      (!shadowTrialEvidenceText.includes("# Dreaming shadow trial brief") &&
        !shadowTrialEvidenceText.includes("# Candidate evidence"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "DREAMING_SHADOW_TRIAL_BRIEF.md" });
    }
    if (
      shadowTrialEvidenceText.includes("# Dreaming shadow trial brief") &&
      shadowTrialEvidenceText.includes("# Candidate evidence")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "dreaming-shadow-trial-report.md",
        content: [
          "Candidate: The user prefers release reports that include exact verification commands and remaining risk.",
          "Trial prompt: Prepare a release readiness reply for a local OpenClaw QA change.",
          "Baseline outcome: mentions tests passed but omits the exact command and remaining risk.",
          "Candidate outcome: includes the exact verification command and calls out the remaining review risk.",
          "Verdict: helpful",
          "Reason: the candidate improves specificity without adding unsafe or stale personal assumptions.",
          "Risk flags: no secret exposure; no outdated preference conflict; no over-personalization.",
          "Promotion action: report-only",
        ].join("\n"),
      });
    }
    if (shadowTrialEvidenceText.includes("# Dreaming shadow trial brief")) {
      return buildToolCallEventsWithArgs("read", { path: "DREAMING_CANDIDATE_EVIDENCE.md" });
    }
  }
  if (/personal share-safe diagnostics check/i.test(allInputText)) {
    const diagnosticsEvidenceText = extractAllToolOutputText(input);
    if (/successfully (?:wrote|created|updated|replaced)/i.test(diagnosticsEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-diagnostics-summary.txt",
          "Status: share-safe diagnostics summary ready",
          "PERSONAL-DIAGNOSTICS-SAFE-OK",
        ].join("\n"),
      );
    }
    if (
      !diagnosticsEvidenceText ||
      (!diagnosticsEvidenceText.includes("# Personal diagnostics request") &&
        !diagnosticsEvidenceText.includes("# Raw personal diagnostics fixture"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "DIAGNOSTICS_REQUEST.md" });
    }
    if (
      diagnosticsEvidenceText.includes("# Personal diagnostics request") &&
      diagnosticsEvidenceText.includes("# Raw personal diagnostics fixture")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-diagnostics-summary.txt",
        content: [
          "Status: blocked waiting for explicit publish approval",
          "Affected surface: telegram direct message",
          "Omitted content: raw chat text, raw tool output, account id, message id, and fake secret",
          "Redaction confirmed: yes",
          "Next step: ask maintainer whether manually landed commits can count for contributor credit",
        ].join("\n"),
      });
    }
    if (diagnosticsEvidenceText.includes("# Personal diagnostics request")) {
      return buildToolCallEventsWithArgs("read", { path: "PERSONAL_DIAGNOSTICS_RAW.md" });
    }
  }
  if (/personal no-fake-progress check/i.test(allInputText)) {
    const progressEvidenceText = [
      extractAllToolOutputText(input),
      extractUserTextAfterLatestToolOutput(input),
    ]
      .filter(Boolean)
      .join("\n");
    if (/successfully (?:wrote|created|updated|replaced)/i.test(progressEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-progress-proof.txt",
          "Status: local proof artifact written",
          "External status: not sent, not published, not uploaded, not merged",
          "PERSONAL-NO-FAKE-PROGRESS-OK",
        ].join("\n"),
      );
    }
    if (
      !progressEvidenceText ||
      (!progressEvidenceText.includes("# Progress request") &&
        !progressEvidenceText.includes("# Progress evidence"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "PROGRESS_REQUEST.md" });
    }
    if (
      progressEvidenceText.includes("# Progress request") &&
      progressEvidenceText.includes("# Progress evidence")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-progress-proof.txt",
        content: [
          "Personal no-fake-progress",
          "Status: local proof artifact written",
          "External status: not sent; not published; not uploaded; not merged",
          "Evidence: PROGRESS_REQUEST.md and PROGRESS_EVIDENCE.md were read before this artifact was written",
        ].join("\n"),
      });
    }
    if (progressEvidenceText.includes("# Progress request")) {
      return buildToolCallEventsWithArgs("read", { path: "PROGRESS_EVIDENCE.md" });
    }
  }
  if (/personal failure recovery check/i.test(allInputText)) {
    const recoveryEvidenceText = [
      extractAllToolOutputText(input),
      extractUserTextAfterLatestToolOutput(input),
    ]
      .filter(Boolean)
      .join("\n");
    if (/successfully (?:wrote|created|updated|replaced)/i.test(recoveryEvidenceText)) {
      return buildAssistantEvents(
        [
          "Artifact: personal-failure-recovery.txt",
          "Failed step: external calendar update was not attempted",
          "Retry boundary: do not retry until approval is given",
          "PERSONAL-FAILURE-RECOVERY-OK",
        ].join("\n"),
      );
    }
    if (
      !recoveryEvidenceText ||
      (!recoveryEvidenceText.includes("# Failure recovery request") &&
        !recoveryEvidenceText.includes("# Failure recovery evidence"))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "FAILURE_RECOVERY_REQUEST.md" });
    }
    if (
      recoveryEvidenceText.includes("# Failure recovery request") &&
      recoveryEvidenceText.includes("# Failure recovery evidence")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-failure-recovery.txt",
        content: [
          "Personal failure recovery",
          "Completed: request reviewed and local evidence captured",
          "Failed step: external calendar update was not attempted because explicit approval is missing",
          "Retry boundary: do not retry the external step until approval is given",
          "Next step: ask for approval before any external update",
        ].join("\n"),
      });
    }
    if (recoveryEvidenceText.includes("# Failure recovery request")) {
      return buildToolCallEventsWithArgs("read", { path: "FAILURE_RECOVERY_EVIDENCE.md" });
    }
  }
  if (/lobster invaders/i.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return buildToolCallEventsWithArgs("write", {
        path: "lobster-invaders.html",
        content: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Lobster Invaders</title></head>
  <body><h1>Lobster Invaders</h1><p>Tiny playable stub.</p></body>
</html>`,
      });
    }
  }
  if (
    /compaction retry mutating tool check/i.test(allInputText) ||
    /compaction retry evidence/i.test(toolOutput) ||
    /compaction-retry-summary\.txt/i.test(toolOutput)
  ) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "COMPACTION_RETRY_CONTEXT.md" });
    }
    if (toolOutput.includes("compaction retry evidence")) {
      return buildToolCallEventsWithArgs("write", {
        path: "compaction-retry-summary.txt",
        content: "Replay safety: unsafe after write.\n",
      });
    }
  }
  if (/memory tools check/i.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "hidden project codename",
        maxResults: 3,
      });
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (typeof first?.path === "string") {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
  }
  if (
    isActiveMemorySubagentPrompt(allInputText) &&
    /silent snack recall check/i.test(allInputText)
  ) {
    if (!toolOutput) {
      if (!hasDeclaredTool(body, "memory_recall")) {
        return buildToolCallEventsWithArgs("memory_search", {
          query: "QA movie night snack lemon pepper wings blue cheese",
          maxResults: 3,
        });
      }
      return buildToolCallEventsWithArgs("memory_recall", {
        query: "QA movie night snack lemon pepper wings blue cheese",
        limit: 3,
      });
    }
    const memoryText =
      typeof toolJson?.text === "string"
        ? toolJson.text
        : Array.isArray(toolJson?.content)
          ? toolJson.content
              .map((item) =>
                typeof item === "object" && item && "text" in item && typeof item.text === "string"
                  ? item.text
                  : "",
              )
              .filter(Boolean)
              .join("\n")
          : undefined;
    if (memoryText) {
      const snackPreference = extractSnackPreference(memoryText);
      if (snackPreference) {
        return buildAssistantEvents(`User usually wants ${snackPreference} for QA movie night.`);
      }
      return buildAssistantEvents("NONE");
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (typeof first?.path === "string") {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
    const memorySnippet = Array.isArray(toolJson?.results)
      ? JSON.stringify(toolJson.results)
      : toolOutput;
    const snackPreference = extractSnackPreference(memorySnippet);
    if (snackPreference) {
      return buildAssistantEvents(`User usually wants ${snackPreference} for QA movie night.`);
    }
    return buildAssistantEvents("NONE");
  }
  if (/session memory ranking check/i.test(prompt)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "current Project Nebula codename ORBIT-10",
        maxResults: 3,
        corpus: "sessions",
      });
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const preferredSessionResult = results.find((result) => {
      const resultPath = typeof result.path === "string" ? result.path : undefined;
      return result.source === "sessions" || resultPath?.startsWith("sessions/");
    });
    if (preferredSessionResult) {
      return buildAssistantEvents(
        "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
      );
    }
    const first = results[0];
    if (
      typeof first?.path === "string" &&
      (typeof first.startLine === "number" || typeof first.endLine === "number")
    ) {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
  }
  if (/thread memory check/i.test(allInputText)) {
    if (!scenarioToolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "hidden thread codename ORBIT-22",
        maxResults: 3,
      });
    }
    const transcriptOrbitCode =
      extractOrbitCode(scenarioToolOutput) ??
      extractOrbitCode(extractUserTextAfterLatestToolOutput(input)) ??
      extractOrbitCode(extractSystemInputText(input));
    if (transcriptOrbitCode) {
      return buildAssistantEvents(
        `Protocol note: I checked memory in-thread and the hidden thread codename is ${transcriptOrbitCode}.`,
      );
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (
      typeof first?.path === "string" &&
      (typeof first.startLine === "number" || typeof first.endLine === "number")
    ) {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
  }
  if (QA_IMAGE_GENERATION_PROMPT_RE.test(allInputText) && !toolOutput) {
    return buildToolCallEventsWithArgs("image_generate", {
      prompt: "A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
      filename: "qa-lighthouse.png",
      size: "1024x1024",
    });
  }
  if (canCallSessionsSpawn && /subagent fanout synthesis check/i.test(allInputText)) {
    if (!toolOutput && scenarioState.subagentFanoutPhase === 0) {
      scenarioState.subagentFanoutPhase = 1;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "alpha"),
        label: "qa-fanout-alpha",
        thread: false,
      });
    }
    if (toolOutput && scenarioState.subagentFanoutPhase === 1) {
      scenarioState.subagentFanoutPhase = 2;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: subagentFanoutTaskForProvider(providerVariant, "beta"),
        label: "qa-fanout-beta",
        thread: false,
      });
    }
  }
  if (scenarioState.subagentFanoutPhase === 2 && prompt) {
    scenarioState.subagentFanoutPhase = 3;
    return buildAssistantEvents("subagent-1: ok\nsubagent-2: ok");
  }
  const explicitSessionsSpawnArgs = buildExplicitSessionsSpawnArgs(allInputText);
  if (explicitSessionsSpawnArgs && !toolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", explicitSessionsSpawnArgs);
  }
  if (canCallSessionsSpawn && /forked subagent context qa check/i.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", {
      task: "Report the visible code from the requester transcript.",
      label: "qa-fork-context",
      mode: "run",
      context: "fork",
    });
  }
  if (/tool continuity check/i.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
  }
  if (/repo contract followthrough check/i.test(allInputText)) {
    const repoEvidenceText = [
      extractAllToolOutputText(input),
      extractUserTextAfterLatestToolOutput(input),
    ]
      .filter(Boolean)
      .join("\n");
    if (
      /successfully (?:wrote|created|updated|replaced)/i.test(repoEvidenceText) ||
      /status:\s*complete/i.test(repoEvidenceText)
    ) {
      return buildAssistantEvents(
        [
          "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
          "Wrote: repo-contract-summary.txt",
          "Status: complete",
        ].join("\n"),
      );
    }
    if (!repoEvidenceText) {
      return buildToolCallEventsWithArgs("read", { path: "AGENT.md" });
    }
    if (
      repoEvidenceText.includes("Mission: prove you followed the repo contract.") &&
      repoEvidenceText.includes("Evidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "repo-contract-summary.txt",
        content: [
          "Mission: prove you followed the repo contract.",
          "Evidence: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md",
          "Status: complete",
        ].join("\n"),
      });
    }
    if (repoEvidenceText.includes("# Execution style")) {
      return buildToolCallEventsWithArgs("read", { path: "FOLLOWTHROUGH_INPUT.md" });
    }
    if (repoEvidenceText.includes("# Repo contract")) {
      return buildToolCallEventsWithArgs("read", { path: "SOUL.md" });
    }
  }
  if (/personal task followthrough check/i.test(allInputText)) {
    const taskEvidenceText = [
      extractAllToolOutputText(input),
      extractUserTextAfterLatestToolOutput(input),
    ]
      .filter(Boolean)
      .join("\n");
    if (/successfully (?:wrote|created|updated|replaced)/i.test(taskEvidenceText)) {
      return buildAssistantEvents(
        [
          "Pending: maintainer feedback before publishing",
          "Blocked: publishing needs explicit user approval",
          "Done: local evidence captured in personal-task-status.txt",
        ].join("\n"),
      );
    }
    if (
      !taskEvidenceText ||
      (!taskEvidenceText.includes("# Personal task ledger") &&
        !taskEvidenceText.includes("Task: prepare a local OpenClaw PR readiness note."))
    ) {
      return buildToolCallEventsWithArgs("read", { path: "PERSONAL_TASK_LEDGER.md" });
    }
    if (
      taskEvidenceText.includes("Task: prepare a local OpenClaw PR readiness note.") &&
      taskEvidenceText.includes("Done: local evidence captured in personal-task-status.txt.")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "personal-task-status.txt",
        content: [
          "Personal task followthrough",
          "Pending: maintainer feedback before publishing",
          "Blocked: publishing needs explicit user approval",
          "Done: local evidence captured in personal-task-status.txt",
        ].join("\n"),
      });
    }
    if (taskEvidenceText.includes("# Personal task ledger")) {
      return buildToolCallEventsWithArgs("read", { path: "FOLLOWTHROUGH_NOTE.md" });
    }
  }
  if (
    canCallSessionsSpawn &&
    (/delegate (?:one |a )bounded qa task/i.test(allInputText) ||
      /subagent handoff/i.test(allInputText)) &&
    !toolOutput &&
    !scenarioState.subagentHandoffSpawned
  ) {
    scenarioState.subagentHandoffSpawned = true;
    return buildToolCallEventsWithArgs("sessions_spawn", {
      task: subagentHandoffTaskForProvider(providerVariant),
      label: "qa-sidecar",
      thread: false,
    });
  }
  if (
    /(worked, failed, blocked|worked\/failed\/blocked|source and docs)/i.test(prompt) &&
    !toolOutput
  ) {
    return buildToolCallEventsWithArgs("read", {
      path: sourceDiscoveryReadPathForProvider(providerVariant),
    });
  }
  if (!toolOutput && /\b(read|inspect|repo|docs|scenario|kickoff)\b/i.test(prompt)) {
    return buildToolCallEvents(prompt);
  }
  if (/visible skill marker/i.test(prompt) && !toolOutput) {
    return buildAssistantEvents("VISIBLE-SKILL-OK");
  }
  if (/hot install marker/i.test(prompt) && !toolOutput) {
    return buildAssistantEvents("HOT-INSTALL-OK");
  }
  if (isGroupChat && isBaselineUnmentionedChannelChatter && !toolOutput) {
    return buildAssistantEvents("NO_REPLY");
  }
  if (
    /subagent recovery worker/i.test(prompt) &&
    !/interrupted by a gateway reload/i.test(prompt)
  ) {
    await sleep(60_000);
  }
  return buildAssistantEvents(buildAssistantText(input, body, scenarioState));
}

// ---------------------------------------------------------------------------
// Anthropic /v1/messages adapter
// ---------------------------------------------------------------------------
//
// The QA parity gate needs two comparable scenario runs: one against the
// "candidate" (openai/gpt-5.5) and one against the "baseline"
// (anthropic/claude-opus-4-8). The OpenAI mock above already dispatches all
// the scenario prompt branches we care about. Rather than duplicating that
// machinery, the /v1/messages route below translates Anthropic request
// shapes into the shared ResponsesInputItem[] format, calls the same
// buildResponsesPayload() dispatcher, and then re-serializes the resulting
// events into an Anthropic response. This gives the parity harness a
// baseline lane that exercises the same scenario logic and selected
// provider-specific plans without requiring real Anthropic API keys.
//
// Scope: handles Anthropic Messages requests with text and tool_result
// content blocks, supporting both non-streaming JSON responses and the
// streaming SSE path used by the parity harness.

function normalizeAnthropicSystemToString(
  system: AnthropicMessagesRequest["system"],
): string | undefined {
  if (typeof system === "string") {
    return system.trim() || undefined;
  }
  if (Array.isArray(system)) {
    const joined = system
      .map((block) => (block?.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    return joined || undefined;
  }
  return undefined;
}

function stringifyToolResultContent(
  content: Extract<AnthropicMessageContentBlock, { type: "tool_result" }>["content"],
): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function convertAnthropicMessagesToResponsesInput(params: {
  system?: AnthropicMessagesRequest["system"];
  messages: AnthropicMessage[];
}): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const systemText = normalizeAnthropicSystemToString(params.system);
  if (systemText) {
    items.push({
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    });
  }
  for (const message of params.messages) {
    const content = message.content;
    if (typeof content === "string") {
      items.push({
        role: message.role,
        content: [
          message.role === "assistant"
            ? { type: "output_text", text: content }
            : { type: "input_text", text: content },
        ],
      });
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    // Buffer each block type so we can push in OpenAI-Responses order instead
    // of the order they appear in the Anthropic content array. The parent
    // role message must precede any function_call_output items from the same
    // turn, otherwise extractToolOutput() (which scans for
    // function_call_output AFTER the last user-role index) will not see the
    // output and the downstream scenario dispatcher will behave as if no
    // tool output was returned. Similarly, assistant tool_use blocks become
    // function_call items that must follow the assistant text message they
    // narrate.
    const textPieces: Array<{ type: "input_text" | "output_text"; text: string }> = [];
    const imagePieces: Array<{ type: "input_image"; image_url: string }> = [];
    const toolResultItems: ResponsesInputItem[] = [];
    const toolUseItems: ResponsesInputItem[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "text") {
        textPieces.push({
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: block.text ?? "",
        });
        continue;
      }
      if (block.type === "image") {
        // Mock only needs to count image inputs; a placeholder URL is fine.
        imagePieces.push({ type: "input_image", image_url: "anthropic-mock:image" });
        continue;
      }
      if (block.type === "tool_result") {
        const output = stringifyToolResultContent(block.content);
        if (output.trim()) {
          toolResultItems.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output,
            ...(block.is_error === true ? { is_error: true } : {}),
          });
        }
        continue;
      }
      if (block.type === "tool_use") {
        // Mirror OpenAI's function_call output_item shape so downstream
        // prompt extraction still sees "the assistant just emitted a tool
        // call". The scenario dispatcher looks for tool_output on the next
        // user turn, not the assistant's prior tool_use, so a minimal
        // placeholder is enough.
        toolUseItems.push({
          type: "function_call",
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
          call_id: block.id,
        });
        continue;
      }
    }
    if (textPieces.length > 0 || imagePieces.length > 0) {
      const combinedContent: Array<Record<string, unknown>> = [...textPieces, ...imagePieces];
      items.push({ role: message.role, content: combinedContent });
    }
    // Emit tool_use (assistant prior calls) and tool_result (user-side
    // returns) AFTER the parent role message so extractLastUserText and
    // extractToolOutput walk the array in the order they expect. For a
    // tool_result-only user turn with no text/image blocks, the parent
    // message is intentionally omitted — the function_call_output itself
    // represents the user's "return the tool output" turn.
    for (const toolUse of toolUseItems) {
      items.push(toolUse);
    }
    for (const toolResult of toolResultItems) {
      items.push(toolResult);
    }
  }
  return items;
}

type ExtractedAssistantOutput = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
};

function extractFinalAssistantOutputFromEvents(events: StreamEvent[]): ExtractedAssistantOutput {
  const toolCalls: ExtractedAssistantOutput["toolCalls"] = [];
  let text = "";
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as {
      type?: unknown;
      name?: unknown;
      call_id?: unknown;
      id?: unknown;
      arguments?: unknown;
      content?: unknown;
    };
    if (item.type === "function_call" && typeof item.name === "string") {
      let input: Record<string, unknown> = {};
      if (typeof item.arguments === "string" && item.arguments.trim()) {
        try {
          const parsed = JSON.parse(item.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // keep empty input on malformed args — mock dispatcher owns arg shape
        }
      }
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `toolu_mock_${toolCalls.length + 1}`,
        name: item.name,
        input,
      });
      continue;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const piece of item.content as Array<{ type?: unknown; text?: unknown }>) {
        if (piece?.type === "output_text" && typeof piece.text === "string") {
          text = piece.text;
        }
      }
    }
  }
  return { text, toolCalls };
}

function buildAnthropicMessageResponse(params: {
  model: string;
  extracted: ExtractedAssistantOutput;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (params.extracted.text) {
    content.push({ type: "text", text: params.extracted.text });
  }
  for (const call of params.extracted.toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  const stopReason = params.extracted.toolCalls.length > 0 ? "tool_use" : "end_turn";
  const approxInputTokens = 64;
  const approxOutputTokens = Math.max(
    16,
    countApproxTokens(params.extracted.text) + params.extracted.toolCalls.length * 16,
  );
  return {
    id: `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`,
    type: "message",
    role: "assistant",
    model: params.model || "claude-opus-4-8",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: approxInputTokens,
      output_tokens: approxOutputTokens,
    },
  };
}

const QA_ANTHROPIC_THINKING_ERROR_TEXT =
  "QA replay-safe read completed, but the provider stream failed after signed thinking.";
const QA_ANTHROPIC_THINKING_ERROR_SIGNATURE = "qa_signed_thinking_block_91953";
const QA_ANTHROPIC_THINKING_ERROR_MESSAGE = "QA injected provider stream failure";

function buildAnthropicThinkingErrorResponse(params: { model: string }): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: QA_ANTHROPIC_THINKING_ERROR_MESSAGE,
    },
    model: params.model || "claude-opus-4-8",
  };
}

function buildAnthropicThinkingErrorStreamEvents(params: {
  model: string;
}): AnthropicStreamEvent[] {
  const messageId = `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`;
  return [
    {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: params.model || "claude-opus-4-8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 64,
          output_tokens: 0,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "thinking",
        thinking: "",
        signature: "",
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: QA_ANTHROPIC_THINKING_ERROR_TEXT,
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: QA_ANTHROPIC_THINKING_ERROR_SIGNATURE,
      },
    },
    {
      type: "content_block_stop",
      index: 0,
    },
    {
      type: "message_delta",
      delta: {},
      usage: {
        input_tokens: 64,
        output_tokens: 1120,
      },
    },
    {
      type: "error",
      error: {
        type: "api_error",
        message: QA_ANTHROPIC_THINKING_ERROR_MESSAGE,
      },
    },
  ];
}

function buildAnthropicMessageStreamEvents(params: {
  model: string;
  extracted: ExtractedAssistantOutput;
}): AnthropicStreamEvent[] {
  const approxInputTokens = 64;
  const approxOutputTokens = Math.max(
    16,
    countApproxTokens(params.extracted.text) + params.extracted.toolCalls.length * 16,
  );
  const messageId = `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`;
  const events: AnthropicStreamEvent[] = [
    {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: params.model || "claude-opus-4-8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: approxInputTokens,
          output_tokens: 0,
        },
      },
    },
  ];
  let index = 0;
  if (params.extracted.text || params.extracted.toolCalls.length === 0) {
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "text",
        text: "",
      },
    });
    if (params.extracted.text) {
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: params.extracted.text,
        },
      });
    }
    events.push({
      type: "content_block_stop",
      index,
    });
    index += 1;
  }
  for (const call of params.extracted.toolCalls) {
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: {},
      },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(call.input ?? {}),
      },
    });
    events.push({
      type: "content_block_stop",
      index,
    });
    index += 1;
  }
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: params.extracted.toolCalls.length > 0 ? "tool_use" : "end_turn",
    },
    usage: {
      input_tokens: approxInputTokens,
      output_tokens: approxOutputTokens,
    },
  });
  events.push({
    type: "message_stop",
  });
  return events;
}

async function buildMessagesPayload(
  body: AnthropicMessagesRequest,
  scenarioState: MockScenarioState,
): Promise<{
  events: StreamEvent[];
  input: ResponsesInputItem[];
  extracted: ExtractedAssistantOutput;
  responseBody: Record<string, unknown>;
  streamEvents: AnthropicStreamEvent[];
  model: string;
}> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = convertAnthropicMessagesToResponsesInput({
    system: body.system,
    messages,
  });
  // Treat empty-string model the same as absent. A bare typeof check lets
  // `""` leak through to `responseBody.model` and `lastRequest.model`,
  // which then confuses parity consumers that assume the mock always
  // echoes the real provider label. Normalize once and reuse everywhere.
  const normalizedModel =
    typeof body.model === "string" && body.model.trim() !== "" ? body.model : "claude-opus-4-8";
  // Dispatch through the same scenario logic the /v1/responses route uses.
  // Preserve declared tools so route-specific adapters mirror what the
  // real provider request made available to the model.
  const dispatchBody: Record<string, unknown> = {
    input,
    model: normalizedModel,
    stream: false,
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
  };
  const allInputText = extractAllRequestTexts(input, dispatchBody);
  if (QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE.test(allInputText)) {
    const toolOutput = extractToolOutput(input);
    const shouldEmitThinkingError =
      toolOutput.length > 0 && scenarioState.anthropicThinkingErrorPhase === 0;
    const events =
      toolOutput.length === 0
        ? buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" })
        : shouldEmitThinkingError
          ? (() => {
              scenarioState.anthropicThinkingErrorPhase = 1;
              return buildAssistantEvents("");
            })()
          : buildAssistantEvents("ANTHROPIC-THINKING-ERROR-RECOVERED-OK");
    const extracted = extractFinalAssistantOutputFromEvents(events);
    const responseBody = shouldEmitThinkingError
      ? buildAnthropicThinkingErrorResponse({ model: normalizedModel })
      : buildAnthropicMessageResponse({
          model: normalizedModel,
          extracted,
        });
    const streamEvents = shouldEmitThinkingError
      ? buildAnthropicThinkingErrorStreamEvents({ model: normalizedModel })
      : buildAnthropicMessageStreamEvents({
          model: normalizedModel,
          extracted,
        });
    return { events, input, extracted, responseBody, streamEvents, model: normalizedModel };
  }
  const events = await buildResponsesPayload(dispatchBody, scenarioState);
  const extracted = extractFinalAssistantOutputFromEvents(events);
  const responseBody = buildAnthropicMessageResponse({
    model: normalizedModel,
    extracted,
  });
  const streamEvents = buildAnthropicMessageStreamEvents({
    model: normalizedModel,
    extracted,
  });
  return { events, input, extracted, responseBody, streamEvents, model: normalizedModel };
}

export async function startQaMockOpenAiServer(params?: {
  host?: string;
  port?: number;
  finalOnlyMarkerPauseMs?: number;
}) {
  const host = params?.host ?? "127.0.0.1";
  const finalOnlyMarkerPauseMs = params?.finalOnlyMarkerPauseMs ?? 1_500;
  const scenarioState: MockScenarioState = {
    anthropicThinkingErrorPhase: 0,
    subagentFanoutPhase: 0,
    subagentHandoffSpawned: false,
  };
  let lastRequest: MockOpenAiRequestSnapshot | null = null;
  const requests: MockOpenAiRequestSnapshot[] = [];
  const inflightRequests = new Map<number, { prompt: string; allInputText: string }>();
  let nextInflightRequestId = 1;
  const imageGenerationRequests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(res, 200, { ok: true, status: "live" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, {
          data: [
            { id: "gpt-5.5", object: "model" },
            { id: "gpt-5.5-alt", object: "model" },
            { id: "gpt-image-1", object: "model" },
            { id: "gpt-4o-transcribe", object: "model" },
            { id: "text-embedding-3-small", object: "model" },
            { id: "claude-opus-4-8", object: "model" },
            { id: "claude-sonnet-4-6", object: "model" },
          ],
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/last-request") {
        writeJson(res, 200, lastRequest ?? { ok: false, error: "no request recorded" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/requests") {
        writeJson(res, 200, requests);
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/inflight-requests") {
        writeJson(res, 200, [...inflightRequests.values()]);
        return;
      }
      if (req.method === "GET" && url.pathname === "/debug/image-generations") {
        writeJson(res, 200, imageGenerationRequests);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/images/generations") {
        const raw = await readBody(req);
        const body = parseJsonObjectBody(raw);
        if (!body) {
          writeOpenAiMalformedJsonError(res, "OpenAI Images");
          return;
        }
        imageGenerationRequests.push(body);
        if (imageGenerationRequests.length > 20) {
          imageGenerationRequests.splice(0, imageGenerationRequests.length - 20);
        }
        writeJson(res, 200, {
          data: [
            {
              b64_json: TINY_PNG_BASE64,
              revised_prompt: "A QA lighthouse with protocol droid silhouette.",
            },
          ],
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
        const raw = await readBody(req);
        writeJson(res, 200, {
          text: transcriptionTextForAudioRequest(raw),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/embeddings") {
        const raw = await readBody(req);
        const body = parseJsonObjectBody(raw);
        if (!body) {
          writeOpenAiMalformedJsonError(res, "OpenAI Embeddings");
          return;
        }
        const inputs = extractEmbeddingInputTexts(body.input);
        writeJson(res, 200, {
          object: "list",
          data: inputs.map((text, index) => ({
            object: "embedding",
            index,
            embedding: buildDeterministicEmbedding(text),
          })),
          model:
            typeof body.model === "string" && body.model.trim()
              ? body.model
              : "text-embedding-3-small",
          usage: {
            prompt_tokens: inputs.reduce((sum, text) => sum + countApproxTokens(text), 0),
            total_tokens: inputs.reduce((sum, text) => sum + countApproxTokens(text), 0),
          },
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const raw = await readBody(req);
        const body = parseJsonObjectBody(raw);
        if (!body) {
          writeOpenAiMalformedJsonError(res, "OpenAI Responses");
          return;
        }
        const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
        const prompt = extractLastUserText(input);
        const allInputText = extractAllRequestTexts(input, body);
        const inflightRequestId = nextInflightRequestId++;
        inflightRequests.set(inflightRequestId, { prompt, allInputText });
        let events: StreamEvent[];
        try {
          events = await buildResponsesPayload(body, scenarioState);
        } finally {
          inflightRequests.delete(inflightRequestId);
        }
        const resolvedModel = typeof body.model === "string" ? body.model : "";
        lastRequest = {
          raw,
          body,
          prompt,
          allInputText,
          instructions: extractInstructionsText(body) || undefined,
          toolOutput: extractToolOutput(input),
          model: resolvedModel,
          providerVariant: resolveProviderVariant(resolvedModel),
          imageInputCount: countImageInputs(input),
          plannedToolCallId: extractPlannedToolCallId(events),
          plannedToolName: extractPlannedToolName(events),
          plannedToolArgs: extractPlannedToolArgs(events),
          toolOutputCallId: extractToolOutputCallId(input) || undefined,
          ...(extractToolOutputStructuredError(input) ? { toolOutputStructuredError: true } : {}),
        };
        requests.push(lastRequest);
        if (requests.length > MOCK_OPENAI_DEBUG_REQUEST_LIMIT) {
          requests.splice(0, requests.length - MOCK_OPENAI_DEBUG_REQUEST_LIMIT);
        }
        if (body.stream === false) {
          const completion = events.at(-1);
          if (!completion || completion.type !== "response.completed") {
            writeJson(res, 500, { error: "mock completion failed" });
            return;
          }
          writeJson(res, 200, completion.response);
          return;
        }
        if (QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE.test(allInputText)) {
          await writeSseWithPreviewPause(res, events, finalOnlyMarkerPauseMs);
        } else {
          writeSse(res, events);
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const raw = await readBody(req);
        const body = parseJsonObjectBody(raw) as AnthropicMessagesRequest | null;
        if (!body) {
          writeJson(res, 400, {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Malformed JSON body for Anthropic Messages request.",
            },
          });
          return;
        }
        const {
          events,
          input,
          responseBody,
          streamEvents,
          model: normalizedModel,
        } = await buildMessagesPayload(body, scenarioState);
        // Record the adapted request snapshot so /debug/requests gives the QA
        // suite the same plannedToolName / allInputText / toolOutput signals
        // on the Anthropic route that the OpenAI route already exposes. This
        // is what lets a single parity run diff assertions across both lanes.
        // Reuse the normalized model so an empty-string body.model no longer
        // leaks through to `lastRequest.model`.
        lastRequest = {
          raw,
          body: body as Record<string, unknown>,
          prompt: extractLastUserText(input),
          allInputText: extractAllInputTexts(input),
          toolOutput: extractToolOutput(input),
          model: normalizedModel,
          providerVariant: resolveProviderVariant(normalizedModel),
          imageInputCount: countImageInputs(input),
          plannedToolCallId: extractPlannedToolCallId(events),
          plannedToolName: extractPlannedToolName(events),
          plannedToolArgs: extractPlannedToolArgs(events),
          toolOutputCallId: extractToolOutputCallId(input) || undefined,
          ...(extractToolOutputStructuredError(input) ? { toolOutputStructuredError: true } : {}),
        };
        requests.push(lastRequest);
        if (requests.length > MOCK_OPENAI_DEBUG_REQUEST_LIMIT) {
          requests.splice(0, requests.length - MOCK_OPENAI_DEBUG_REQUEST_LIMIT);
        }
        if (body.stream === true) {
          writeAnthropicSse(res, streamEvents);
          return;
        }
        writeJson(res, 200, responseBody);
        return;
      }
      writeJson(res, 404, { error: "not found" });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params?.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa mock openai failed to bind");
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    async stop() {
      await closeQaHttpServer(server);
    },
  };
}
