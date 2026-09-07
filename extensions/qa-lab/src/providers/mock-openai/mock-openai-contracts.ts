// QA Lab mock provider contracts, wire helpers, and scenario constants.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";

export type ResponsesInputItem = Record<string, unknown>;

export type MockOpenAiRequestKind = "agent-initial" | "compaction-summary" | "tool-continuation";
export type MockCompactionSummaryFaultMode =
  | "none"
  | "empty-output-once"
  | "reasoning-only-output-once";

type MockOpenAiRequestOutcome = "success" | "error";

export type QaMockProviderDispatchRequest = {
  route: "responses" | "anthropic-messages";
  body: Record<string, unknown>;
  raw: string;
};

export type QaMockProviderFailure = {
  status: number;
  type: string;
  code?: string;
  message: string;
  presentation?: "anthropic-thinking";
};

export type QaMockProviderDispatchResult = {
  events: StreamEvent[];
  model: string;
  failure?: QaMockProviderFailure;
  onResponseSent?: () => void;
  previewPauseMs?: number;
  responsePauseMs?: number;
};

export type StreamEvent =
  | {
      type: "response.created";
      response: {
        id: string;
        object: "response";
        status: "in_progress";
        output: Array<Record<string, unknown>>;
        created_at: number;
        model?: string;
      };
    }
  | {
      type: "response.failed";
      response: {
        id: string;
        object: "response";
        status: "failed";
        output: Array<Record<string, unknown>>;
        error?: { code: string; message: string };
      };
    }
  | {
      type: "response.output_item.added";
      output_index: number;
      item: Record<string, unknown>;
    }
  | {
      type: "response.content_part.added" | "response.content_part.done";
      item_id: string;
      output_index: number;
      content_index: number;
      part: MockOutputText;
    }
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
  | {
      type: "response.function_call_arguments.delta";
      item_id: string;
      output_index: number;
      delta: string;
    }
  | {
      type: "response.function_call_arguments.done";
      item_id: string;
      output_index: number;
      name: string;
      arguments: string;
    }
  | {
      type: "response.custom_tool_call_input.delta";
      item_id: string;
      call_id: string;
      output_index: number;
      delta: string;
    }
  | {
      type: "response.custom_tool_call_input.done";
      item_id: string;
      output_index: number;
      input: string;
    }
  | {
      type: "response.output_item.done";
      output_index: number;
      item: Record<string, unknown>;
    }
  | {
      type: "response.completed";
      response: {
        id: string;
        object: "response";
        status: "completed";
        output: Array<Record<string, unknown>>;
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        };
      };
    };

export type MockOutputText = { type: "output_text"; text: string; annotations: [] };

export type MockAssistantMessageSpec = {
  id: string;
  phase?: "commentary" | "final_answer";
  streamDeltas?: string[];
  text: string;
};

export type MockToolCallItem = { id: string; call_id: string; name: string; namespace?: string } & (
  | { type: "function_call"; arguments: string }
  | { type: "custom_tool_call"; input: string; status: "completed" }
);

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
  requestKind: MockOpenAiRequestKind;
  compactionSummaryFaultMode: MockCompactionSummaryFaultMode;
  outcome: MockOpenAiRequestOutcome;
  errorCode?: string;
  rawByteLength: number;
  plannedToolCallId?: string;
  plannedToolItemId?: string;
  plannedToolName?: string;
  plannedWireToolName?: string;
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
export const QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT_RE =
  /mixed reasoning blank fallback qa check/i;
export const QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE = /anthropic thinking error qa check/i;
export const QA_THINKING_VISIBILITY_OFF_PROMPT_RE = /qa thinking visibility check off/i;
export const QA_THINKING_VISIBILITY_MAX_PROMPT_RE = /qa thinking visibility check max/i;
export const QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE = /empty response continuation qa check/i;
export const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE = /empty response exhaustion qa check/i;
export const QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT_RE =
  /empty response after write recovery qa check/i;
export const QA_EMPTY_RESPONSE_SIDE_EFFECT_EXHAUSTION_PROMPT_RE =
  /empty response after write exhaustion qa check/i;
export const QA_REPEATED_REQUEST_RECOVERY_PROMPT_RE = /repeated request recovery gateway qa check/i;
export const QA_REPEATED_REQUEST_QUEUED_REPLY_PROMPT_RE =
  /repeated request queued reply gateway qa check/i;
export const QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER = "GATEWAY_REPEATED_REQUEST_QUEUED_OK";
export const QA_STREAMING_PROMPT_RE = /(?:partial|quiet) streaming qa check/i;
export const QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE = /final-only marker streaming qa check/i;
export const QA_BLOCK_STREAMING_PROMPT_RE = /block streaming qa check/i;
export const QA_TOOL_PROGRESS_PROMPT_RE = /tool progress( error)? qa check/i;
export const QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE = /global tool loop breaker qa check/i;
export const QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE = /provider http 503 after tool qa check/i;
export const QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE = /qa group visible reply tool check/i;
export const QA_MSTEAMS_AMBIGUOUS_TIMEOUT_PROMPT_RE = /qa msteams ambiguous gateway timeout/i;
export const QA_MSTEAMS_THREAD_DEDUPE_PROMPT_RE = /qa msteams thread message-tool final dedupe/i;
export const QA_THREAD_REPLY_RECEIPT_PROMPT_RE =
  /qa thread reply receipt check[\s\S]*channel id: `([^`]+)`[\s\S]*thread id: `([^`]+)`/i;
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
export const QA_MESSAGE_DECISION_SUPPRESSION_PROMPT_RE =
  /message delivery decision suppression qa check/i;
export const QA_MESSAGE_DECISION_SEND_PROMPT_RE = /message delivery decision send qa check/i;
export const QA_SLACK_MPIM_HISTORY_SEED_PROMPT_RE =
  /Slack MPIM assistant-history seed check[\s\S]*?exact format:\s*(SLACK_QA_MPIM_SEED_[A-Z0-9]+)_BOT_<NONCE>/i;
export const QA_SLACK_MPIM_HISTORY_RECALL_PROMPT_RE =
  /Slack MPIM assistant-history recall check[\s\S]*?previous reply beginning with\s+(SLACK_QA_MPIM_SEED_[A-Z0-9]+_BOT_)[\s\S]*?exact format:\s*(SLACK_QA_MPIM_RECALL_[A-Z0-9]+)_<NONCE>[\s\S]*?otherwise reply with only:\s*(SLACK_QA_MPIM_MISSING_[A-Z0-9]+)/i;

export function buildSlackMpimHistoryBotReply(seedMarker: string) {
  return `${seedMarker}_BOT_${randomUUID().replaceAll("-", "").toUpperCase()}`;
}
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
// A subagent that yields on its own behalf, then finishes on a later follow-up
// dispatched to the same paused child session. The worker regex must not match
// the follow-up text, so the two turns carry deliberately disjoint wording: the
// kickoff yields, and only the follow-up may finish.
export const QA_SUBAGENT_SELF_YIELD_WORKER_RE = /subagent self yield qa worker/i;
export const QA_SUBAGENT_SELF_YIELD_FOLLOW_UP_RE = /subagent self yield qa remote job finished/i;
export const QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE =
  /subagent terminal reply qa check:\s*(visible|silent|empty|restart|fallback)/i;
export const QA_SUBAGENT_TERMINAL_MATRIX_WORKER_RE =
  /subagent terminal reply qa worker:\s*(visible|silent|empty|restart|fallback)/i;
export const QA_SUBAGENT_EMPTY_PARENT_VISIBLE_PROMPT_RE = /reply to the requester after spawning/i;
export const QA_SUBAGENT_EMPTY_WORKER_NO_OUTPUT_PROMPT_RE =
  /return no assistant output after the write/i;

export function buildStrandedFinalRecoveryText(): string {
  return [
    "QA-STRANDED-85714：近 7 日營收較前期增加 5.09%，已連續兩週回升。最大風險是集中：前五大站台占正營收 86.5%，已超過 85% 觀察門檻。",
    "近 30 日最大單一產品占 44.2%，亦超過 40% 門檻。建議先維持成長節奏並優先降低集中風險，不建議只看總額就全面加碼。",
    "成長主因仍待業務確認，我尚未取得該線的回覆。",
  ].join("");
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
export const QA_SUBAGENT_SELF_YIELD_MARKER = "QA-SUBAGENT-SELF-YIELD-FOLLOW-UP-OK";
export const QA_SUBAGENT_TERMINAL_MARKERS = {
  visible: "QA-SUBAGENT-TERMINAL-VISIBLE-OK",
  silent: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
  empty: "QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED",
  restart: "QA-SUBAGENT-TERMINAL-RESTART-OK",
  fallback: "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
} as const;
export const QA_SUBAGENT_EMPTY_PARENT_VISIBLE_MARKER = "QA-SUBAGENT-EMPTY-PARENT-ACK";
export const QA_SUBAGENT_TERMINAL_METADATA_SENTINEL = "QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK";
export const QA_NATIVE_STOP_DELAY_PROMPT_RE =
  /subagent recovery worker native command target proof\.\s*wait until stopped\./i;
export const QA_NATIVE_STOP_DELAY_MS = 180_000;
export const QA_IMAGE_GENERATION_PROMPT_RE =
  /image generation check|capability flip image check|\/tool\s+image_generate/i;
export const QA_REASONING_ONLY_RETRY_NEEDLE =
  "recorded reasoning but did not produce a user-visible answer";
export const QA_EMPTY_RESPONSE_RETRY_NEEDLE =
  "The previous attempt did not produce a user-visible answer.";
export const QA_SETTLED_TOOL_TERMINAL_CONTINUATION_NEEDLE =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer.";
export const QA_SKILL_WORKSHOP_GIF_PROMPT_RE =
  /externally sourced animated GIF asset|animated GIF asset in a product UI/i;
export const QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE = /Review transcript for durable skill updates/i;
export const QA_RELEASE_AUDIT_PROMPT_RE = /release readiness audit for the small project/i;
export const QA_TOOL_SEARCH_PROMPT_RE = /tool search qa check/i;
export const QA_TOOL_SEARCH_FAILURE_PROMPT_RE = /tool search qa failure/i;
export const QA_MCP_CODE_MODE_PROMPT_RE = /mcp code mode qa check/i;
export const QA_RESTART_CODE_MODE_WAIT_PROMPT_RE = /code mode restart wait qa check/i;
export const QA_RESTART_RECOVERY_PROMPT_RE = /previous turn was interrupted by a gateway restart/i;
export const QA_KILL_RESTART_PROMPT_RE = /\bKILL-RESTART-PROMPT\b/u;
export const QA_KILL_RESTART_RECOVERED_MARKER = "KILL-RESTART-RECOVERED-OK";
const QA_AUDIO_TRANSCRIPTION_TEXT =
  "Reply with only this exact marker: WHATSAPP_QA_AUDIO_TRANSCRIPT_OK";
const QA_GROUP_AUDIO_TRANSCRIPTION_TEXT =
  "openclawqa reply with only this exact marker after group audio preflight: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK";
const QA_GROUP_AUDIO_TRIGGER_SENTINEL = "OPENCLAW_QA_GROUP_AUDIO_TRIGGER";
const QA_MATRIX_VOICE_TRANSCRIPTION_TRIGGER = "MATRIX_QA_VOICE_PREFLIGHT_TRIGGER";
const QA_MATRIX_VOICE_TRANSCRIPTION_TEXT =
  "C3PLQA reply with only these words Matrix QA voice pre-flight OK.";
export const QA_MCP_CODE_MODE_API_FILE_PROMPT_RE = /mcp code mode api file qa check/i;

export type MockScenarioState = {
  anthropicThinkingErrorScenarioKeys: Set<string>;
  compactionOverflowInjected: boolean;
  compactionRetryActive: boolean;
  subagentFanoutCompletedWorkers: Set<"alpha" | "beta">;
  subagentFanoutPhase: number;
  subagentHandoffSpawned: boolean;
  repeatedRequestRecoveryAttempts: number;
  toolLoopReadAttempts: number;
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
    // The HTTP handler must deliver the rejection before closing the request.
    destroyOnLimit: false,
  });
}

export function parseJsonObjectBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return asNullableRecord(parsed);
  } catch {
    return null;
  }
}

export function transcriptionTextForAudioRequest(rawBody: string) {
  if (rawBody.includes(QA_MATRIX_VOICE_TRANSCRIPTION_TRIGGER)) {
    return QA_MATRIX_VOICE_TRANSCRIPTION_TEXT;
  }
  if (rawBody.includes(QA_GROUP_AUDIO_TRIGGER_SENTINEL)) {
    return QA_GROUP_AUDIO_TRANSCRIPTION_TEXT;
  }
  return QA_AUDIO_TRANSCRIPTION_TEXT;
}

export function isPreviewCompletion(
  event: StreamEvent | AnthropicStreamEvent,
  previous: StreamEvent | AnthropicStreamEvent | undefined,
) {
  // Message builders keep each preview's last delta next to text.done.
  // Plain answers also finish text, but must not acquire a preview pause.
  return (
    event.type === "response.output_text.done" && previous?.type === "response.output_text.delta"
  );
}

export async function writeSse(
  res: ServerResponse,
  events: Array<StreamEvent | AnthropicStreamEvent>,
  protocol: "responses" | "anthropic",
  pauseMs?: number,
) {
  const frames = events.map(
    (event) =>
      `${protocol === "anthropic" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
  );
  const completionIndex =
    pauseMs === undefined
      ? -1
      : events.findIndex((event, index) => isPreviewCompletion(event, events[index - 1]));
  const body =
    frames.slice(Math.max(0, completionIndex)).join("") +
    (protocol === "responses" ? "data: [DONE]\n\n" : "");
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...(completionIndex < 0 ? { "content-length": Buffer.byteLength(body) } : {}),
  });
  if (completionIndex >= 0) {
    // Flush preview deltas before delaying the final text and completion frames.
    res.write(frames.slice(0, completionIndex).join(""));
    await sleep(pauseMs);
  }
  res.end(body);
}

export function isRemoteCompactionV2Request(input: ResponsesInputItem[]) {
  // Codex sends compaction through /responses with a trigger item. Keep it
  // outside scenario dispatch so maintenance calls never become tool evidence.
  return input.some((item) => item.type === "compaction_trigger");
}

export type AnthropicStreamEvent = Record<string, unknown> & {
  type: string;
};

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
