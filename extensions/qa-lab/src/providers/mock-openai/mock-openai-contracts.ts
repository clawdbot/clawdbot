// QA Lab mock provider contracts, wire helpers, and scenario constants.
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { writeJson } from "../shared/http-json.js";

export type ResponsesInputItem = Record<string, unknown>;

export type StreamEvent =
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
 * so an Anthropic request with an `openai/gpt-5.6-luna` model string is still
 * classified as `"openai"`. That matches the parity program's convention
 * where the provider label is the source of truth, not the HTTP route.
 */
type MockOpenAiProviderVariant = "openai" | "anthropic" | "unknown";

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
  // `gpt-5.6-luna` or `claude-opus-4-8`.
  if (/^(?:gpt-|o1-|openai-)/.test(trimmed)) {
    return "openai";
  }
  if (/^(?:claude-|anthropic-)/.test(trimmed)) {
    return "anthropic";
  }
  return "unknown";
}

export type MockOpenAiRequestSnapshot = {
  cursor: number;
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

export type MockOpenAiRequestSnapshotInput = Omit<MockOpenAiRequestSnapshot, "cursor">;

// Runtime-context delimiters are owned by src/agents/internal-runtime-context.ts.
// This mock mirrors the wire shape so delimiter drift fails through QA timeouts.
export const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
export const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

// Anthropic /v1/messages request/response shapes the mock actually needs.
// This is a subset of the real Anthropic Messages API — just enough so the
// QA suite can run its parity pack against a "baseline" Anthropic provider
// without needing real API keys. The scenarios drive their dispatch through
// the shared mock scenario logic (buildResponsesPayload), with `model`
// preserved so provider-aware branches can intentionally diverge.
export type AnthropicMessageContentBlock =
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

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicMessageContentBlock[];
};

export type AnthropicMessagesRequest = {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type: "text"; text: string }>;
  messages?: AnthropicMessage[];
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
};

export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";
export const QA_REASONING_ONLY_RECOVERY_PROMPT_RE = /reasoning-only continuation qa check/i;
export const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE = /reasoning-only after write safety check/i;
export const QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE = /anthropic thinking error qa check/i;
export const QA_THINKING_VISIBILITY_OFF_PROMPT_RE = /qa thinking visibility check off/i;
export const QA_THINKING_VISIBILITY_MAX_PROMPT_RE = /qa thinking visibility check max/i;
export const QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE = /empty response continuation qa check/i;
export const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE = /empty response exhaustion qa check/i;
export const QA_STREAMING_PROMPT_RE = /(?:partial|quiet) streaming qa check/i;
export const QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE = /final-only marker streaming qa check/i;
export const QA_BLOCK_STREAMING_PROMPT_RE = /block streaming qa check/i;
export const QA_TOOL_PROGRESS_ERROR_PROMPT_RE = /tool progress error qa check/i;
export const QA_TOOL_PROGRESS_PROMPT_RE = /tool progress qa check/i;
export const QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE = /qa group visible reply tool check/i;
export const QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE = /qa a2a message-tool mirror check/i;
export const QA_GROUP_MESSAGE_UNAVAILABLE_FALLBACK_PROMPT_RE =
  /qa group message unavailable fallback check/i;
export const QA_STRANDED_FINAL_RECOVERY_PROMPT_RE = /qa stranded final recovery check/i;
const QA_STRANDED_FINAL_RETRY_FAILURE_PROMPT_RE = /qa stranded final retry failure check/i;
export const QA_STRANDED_FINAL_RETRY_PROMPT_RE = /you did not call message\(action=send\)/i;
const QA_STRANDED_FINAL_RETRY_FAILURE_MARKER = "QA-STRANDED-RETRY-FAIL-RAW";
export const QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE =
  /telegram current session_status qa check/i;
export const QA_TELEGRAM_STREAM_SINGLE_MARKER = "QA-TELEGRAM-STREAM-SINGLE-OK";
export const QA_TELEGRAM_LONG_FINAL_THREE_CHUNK_PROMPT_RE =
  /telegram long final three chunk qa check/i;
export const QA_TELEGRAM_LONG_FINAL_PROMPT_RE = /telegram long final qa check/i;
export const QA_WHATSAPP_LONG_FINAL_PROMPT_RE = /whatsapp long final qa check/i;
export const QA_SLACK_CHART_PRESENTATION_PROMPT_RE =
  /Slack native chart QA check\s+(SLACK_QA_CHART_SUMMARY_[A-Z0-9]+)[\s\S]*?reply with only this exact marker:\s*(SLACK_QA_CHART_DONE_[A-Z0-9]+)/i;
export const QA_WHATSAPP_AGENT_MESSAGE_ACTION_REACT_PROMPT_RE =
  /react to this whatsapp(?: group)? message with thumbs up for qa action check\s+(?:WHATSAPP_QA_AGENT_REACT|WHATSAPP_QA_GROUP_AGENT_REACT)_[A-Z0-9]+/i;
export const QA_WHATSAPP_AGENT_MESSAGE_ACTION_UPLOAD_PROMPT_RE =
  /upload-file action to send a PNG with caption\s+((?:WHATSAPP_QA_AGENT_UPLOAD|WHATSAPP_QA_GROUP_AGENT_UPLOAD)_[A-Z0-9]+)/i;
export const QA_WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER_RE =
  /\bWHATSAPP_QA_PENDING_HISTORY_TRIGGER_([A-Z0-9]+)\b/u;
export const QA_WHATSAPP_BROADCAST_PROMPT_RE =
  /\bopenclawqa broadcast fanout check\s+([A-Z0-9_]+)\b/i;
export const QA_WHATSAPP_RUNTIME_AGENT_RE = /\bRuntime:\s*[^\n]*\bagent=([A-Za-z0-9_-]+)/i;
export const QA_WHATSAPP_ACTIVATION_ALWAYS_MARKER_RE =
  /\bWHATSAPP_QA_ACTIVATION_ALWAYS_([A-Z0-9]+)\b/u;
export const QA_WHATSAPP_REPLY_TO_BOT_SEED_MARKER_RE =
  /\bWHATSAPP_QA_REPLY_TO_BOT_SEED_[A-Z0-9]+\b/u;
export const QA_WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER_RE =
  /\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u;
export const QA_WHATSAPP_BATCHED_FINAL_MARKER_RE = /\bWHATSAPP_QA_BATCHED_FINAL_([A-Z0-9]+)\b/u;
export const QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE = /subagent direct fallback qa check/i;
export const QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE = /subagent direct fallback worker/i;

export function buildStrandedFinalRecoveryText(): string {
  return [
    "QA-STRANDED-85714 confirms this is a substantive private final reply that initially skipped the message tool.",
    "The reply is intentionally long enough to exercise message_tool_only stranded-final recovery before the retry delivers it visibly.",
  ].join(" ");
}

export function buildStrandedFinalRetryFailureText(): string {
  return [
    "QA-STRANDED-RETRY-FAIL-RAW confirms this retry also produced a substantive private final reply instead of calling the message tool.",
    "This text must remain private so the gateway can deliver only its sanitized failure diagnostic to the source chat.",
  ].join(" ");
}

export function isStrandedFinalRetryFailureRequest(allInputText: string): boolean {
  return (
    QA_STRANDED_FINAL_RETRY_FAILURE_PROMPT_RE.test(allInputText) ||
    (QA_STRANDED_FINAL_RETRY_PROMPT_RE.test(allInputText) &&
      allInputText.includes(QA_STRANDED_FINAL_RETRY_FAILURE_MARKER))
  );
}
export const QA_SUBAGENT_DIRECT_FALLBACK_MARKER = "QA-SUBAGENT-DIRECT-FALLBACK-OK";
export const QA_NATIVE_STOP_DELAY_PROMPT_RE =
  /subagent recovery worker native command target proof\.\s*wait until stopped\./i;
export const QA_NATIVE_STOP_DELAY_MS = 180_000;
export const QA_IMAGE_GENERATION_PROMPT_RE =
  /image generation check|capability flip image check|\/tool\s+image_generate/i;
export const QA_REASONING_ONLY_RETRY_NEEDLE =
  "recorded reasoning but did not produce a user-visible answer";
export const QA_EMPTY_RESPONSE_RETRY_NEEDLE =
  "The previous attempt did not produce a user-visible answer.";
export const QA_SKILL_WORKSHOP_GIF_PROMPT_RE =
  /externally sourced animated GIF asset|animated GIF asset in a product UI/i;
export const QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE = /Review transcript for durable skill updates/i;
export const QA_RELEASE_AUDIT_PROMPT_RE = /release readiness audit for the small project/i;
export const QA_TOOL_SEARCH_PROMPT_RE = /tool search qa check/i;
export const QA_TOOL_SEARCH_FAILURE_PROMPT_RE = /tool search qa failure/i;
export const QA_MCP_CODE_MODE_PROMPT_RE = /mcp code mode qa check/i;
export const QA_RESTART_CODE_MODE_WAIT_PROMPT_RE = /code mode restart wait qa check/i;
export const QA_RESTART_RECOVERY_PROMPT_RE = /previous turn was interrupted by a gateway restart/i;
const QA_AUDIO_TRANSCRIPTION_TEXT =
  "Reply with only this exact marker: WHATSAPP_QA_AUDIO_TRANSCRIPT_OK";
const QA_GROUP_AUDIO_TRANSCRIPTION_TEXT =
  "openclawqa reply with only this exact marker after group audio preflight: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK";
const QA_GROUP_AUDIO_TRIGGER_SENTINEL = "OPENCLAW_QA_GROUP_AUDIO_TRIGGER";
export const QA_MCP_CODE_MODE_API_FILE_PROMPT_RE = /mcp code mode api file qa check/i;

export type MockScenarioState = {
  anthropicThinkingErrorPhase: number;
  subagentFanoutPhase: number;
  subagentHandoffSpawned: boolean;
};

export function sourceDiscoveryReadPathForProvider(providerVariant: MockOpenAiProviderVariant) {
  return providerVariant === "anthropic"
    ? "repo/docs/help/testing.md"
    : "repo/qa/scenarios/index.yaml";
}

export function subagentHandoffTaskForProvider(providerVariant: MockOpenAiProviderVariant) {
  return providerVariant === "anthropic"
    ? "Inspect the QA docs fixture and return one concise protocol note."
    : "Inspect the QA workspace and return one concise protocol note.";
}

export function subagentFanoutTaskForProvider(
  providerVariant: MockOpenAiProviderVariant,
  worker: "alpha" | "beta",
) {
  const marker = worker === "alpha" ? "ALPHA-OK" : "BETA-OK";
  const scope = providerVariant === "anthropic" ? "the QA docs fixture" : "the QA workspace";
  return `Fanout worker ${worker}: inspect ${scope} and finish with exactly ${marker}.`;
}

const MOCK_OPENAI_MAX_BODY_BYTES = 16 * 1024 * 1024;
const MOCK_OPENAI_BODY_TIMEOUT_MS = 30_000;
export const MOCK_OPENAI_DEBUG_REQUEST_LIMIT = 2_000;

export function readBody(req: IncomingMessage): Promise<string> {
  return readRequestBodyWithLimit(req, {
    maxBytes: MOCK_OPENAI_MAX_BODY_BYTES,
    timeoutMs: MOCK_OPENAI_BODY_TIMEOUT_MS,
  });
}

export function parseJsonObjectBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function writeOpenAiMalformedJsonError(res: ServerResponse, label: string) {
  writeJson(res, 400, {
    error: {
      type: "invalid_request_error",
      message: `Malformed JSON body for ${label} request.`,
    },
  });
}

export function transcriptionTextForAudioRequest(rawBody: string) {
  if (rawBody.includes(QA_GROUP_AUDIO_TRIGGER_SENTINEL)) {
    return QA_GROUP_AUDIO_TRANSCRIPTION_TEXT;
  }
  return QA_AUDIO_TRANSCRIPTION_TEXT;
}

export function writeSse(res: ServerResponse, events: StreamEvent[]) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function isRemoteCompactionV2Request(input: ResponsesInputItem[]) {
  // Codex sends compaction through /responses with a trigger item. Keep it
  // outside scenario dispatch so maintenance calls never become tool evidence.
  return input.some((item) => item.type === "compaction_trigger");
}

export function buildRemoteCompactionV2Events(): [
  Extract<StreamEvent, { type: "response.output_item.done" }>,
  Extract<StreamEvent, { type: "response.completed" }>,
] {
  const item = {
    type: "compaction",
    encrypted_content: "QA_MOCK_REMOTE_COMPACTION_SUMMARY",
  };
  return [
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: "resp_mock_compaction_1",
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

export async function writeSseWithPreviewPause(
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

export type AnthropicStreamEvent = Record<string, unknown> & {
  type: string;
};

export function writeAnthropicSse(res: ServerResponse, events: AnthropicStreamEvent[]) {
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

export function countApproxTokens(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function extractEmbeddingInputTexts(input: unknown): string[] {
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

export function buildDeterministicEmbedding(text: string, dimensions = 16) {
  const values = Array.from({ length: dimensions }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    const embeddingIndex = index % dimensions;
    values[embeddingIndex] = (values[embeddingIndex] ?? 0) + text.charCodeAt(index) / 255;
  }
  const magnitude = Math.hypot(...values) || 1;
  return values.map((value) => Number((value / magnitude).toFixed(8)));
}
