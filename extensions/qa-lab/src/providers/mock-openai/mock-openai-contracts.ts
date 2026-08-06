// QA Lab mock provider contracts, wire helpers, and scenario constants.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { writeJson } from "../shared/http-json.js";

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
};

export type StreamEvent =
  | { type: "response.created"; response: { id: string } }
  | {
      type: "response.output_item.added";
      output_index?: number;
      item: Record<string, unknown>;
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
      item_id?: string;
      output_index?: number;
      delta: string;
    }
  | {
      type: "response.custom_tool_call_input.delta";
      item_id: string;
      call_id: string;
      delta: string;
    }
  | {
      type: "response.output_item.done";
      output_index?: number;
      item: Record<string, unknown>;
    }
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
export const QA_COMPACTION_RETRY_PROMPT_RE = /compaction retry mutating tool check/i;
export const QA_COMPACTION_SUMMARY_INSTRUCTIONS_RE =
  /context summarization assistant[\s\S]*structured summary[\s\S]*do not continue/i;
export const QA_COMPACTION_RETRY_OVERFLOW_THRESHOLD_BYTES = 256 * 1024;
export const QA_COMPACTION_OUTPUT_RECOVERY_OVERFLOW_THRESHOLD_BYTES = 96 * 1024;
export const QA_COMPACTION_RETRY_DURABLE_MARKER = "QA-COMPACTION-DURABLE-MARKER";
export const QA_COMPACTION_RETRY_BULKY_MARKER = "QA-COMPACTION-BULKY-HISTORICAL-MARKER";
export const QA_COMPACTION_RETRY_HISTORICAL_PHRASE = "post-marker historical user block";
export const QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-EMPTY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
export const QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
export const QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY";
export const QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER =
  "QA-COMPACTION-REASONING-RECOVERED-SUMMARY";
export const QA_COMPACTION_RETRY_SUMMARY = `## Decisions
- Continue the compaction retry from durable context without replaying a completed mutation.

## Open TODOs
- Write compaction-retry-summary.txt exactly once.
- Return the final replay-safety marker.

## Constraints/Rules
- Preserve ${QA_COMPACTION_RETRY_DURABLE_MARKER}.
- Write exactly: Replay safety: unsafe after write.

## Pending user asks
- Create compaction-retry-summary.txt, then reply exactly: Protocol note: replay unsafe after write.

## Exact identifiers
- ${QA_COMPACTION_RETRY_DURABLE_MARKER}
- compaction-retry-summary.txt`;
export const QA_COMPACTION_RETRY_HISTORICAL_SUMMARY = `## Decisions
- Preserve the latest ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} context through staged compaction.

## Open TODOs
- Continue summarizing the ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} sequence.

## Constraints/Rules
- Keep historical content distinct from live task state.
- Do not invent durable context absent from the summarized history.

## Pending user asks
- Retain the ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} details.

## Exact identifiers
- None captured.`;
export const QA_GENERIC_COMPACTION_SUMMARY = `## Decisions
- Continue from the summary without restarting completed work.

## Open TODOs
- Continue the active task.

## Constraints/Rules
- Keep current requirements and identifiers.

## Pending user asks
- Continue the active task from the retained context.

## Exact identifiers
- None captured.`;
export const QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY = `## Decisions
- Retry the typed compaction-summary fault at the compaction owner.

## Open TODOs
- Continue the active task after compaction.

## Constraints/Rules
- Preserve the historical recovery user block and current continuation.

## Pending user asks
- Retain the historical recovery user block context.

## Exact identifiers`;
export const QA_STREAMING_TOOL_PROGRESS_FAMILY_PROMPT_RE =
  /(?:partial|quiet) streaming qa check|final-only marker streaming qa check|block streaming qa check|tool progress(?: error)? qa check/i;
export const QA_STREAMING_TOOL_PROGRESS_CONTINUATION_RE =
  /^Continue with (?:the current Matrix QA scenario|the QA scenario plan and report worked, failed, and blocked items)\.$/i;
export const QA_CODE_MODE_TARGET_MARKER = "qa-code-mode-target:";
export const QA_FAILED_TOOL_TERMINAL_RECOVERY_PROMPT_RE = /failed tool terminal recovery qa check/i;
export const QA_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3RQQkAMAzAwPg33Wnos+wgBo40dboAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANYADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAC+Azy47PDiI4pA2wAAAABJRU5ErkJggg==";
export const QA_REASONING_ONLY_RECOVERY_PROMPT =
  "Reasoning-only continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly REASONING-RECOVERED-OK.";
export const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT =
  "Reasoning-only after write safety check: write reasoning-only-side-effect.txt, then answer with exactly SIDE-EFFECT-GUARD-OK.";
export const QA_THINKING_VISIBILITY_OFF_PROMPT =
  "QA thinking visibility check off: answer exactly THINKING-OFF-OK.";
export const QA_THINKING_VISIBILITY_MAX_PROMPT =
  "QA thinking visibility check max: verify 17+24=41 internally, then answer exactly THINKING-MAX-OK.";
export const QA_EMPTY_RESPONSE_RECOVERY_PROMPT =
  "Empty response continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-RECOVERED-OK.";
export const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT =
  "Empty response exhaustion QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-EXHAUSTED-OK.";
export const QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT =
  "Empty response after write recovery QA check: write qa-empty-response-side-effect.txt, then answer with exactly TELEGRAM-EMPTY-WRITE-RECOVERED-OK.";
export const QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT =
  "Anthropic thinking error QA check: read QA_KICKOFF_TASK.md, then answer with exactly ANTHROPIC-THINKING-ERROR-RECOVERED-OK.";
export const QA_REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
export const QA_EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
export const QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";
export const QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT = {
  status: "completed",
  value: {
    changed: true,
    created: true,
    diff: "+1 Replay safety: unsafe after write.",
    patch: [
      "--- compaction-retry-summary.txt",
      "+++ compaction-retry-summary.txt",
      "@@ -0,0 +1,1 @@",
      "+Replay safety: unsafe after write.",
      "",
    ].join("\n"),
    firstChangedLine: 1,
  },
  output: [],
  replaySafe: false,
  telemetry: {
    catalogSize: 32,
    sources: { openclaw: 32, mcp: 0, client: 0 },
    counterScope: "qaFixtureScope01",
    searchCount: 0,
    describeCount: 0,
    callCount: 1,
  },
} as const;
export const QA_COMPACTION_RETRY_PROMPT =
  "Compaction retry mutating tool check. Current durable context marker: QA-COMPACTION-DURABLE-MARKER. Create compaction-retry-summary.txt.";
export const QA_COMPACTION_RETRY_OVERFLOW_PADDING = "x".repeat(300_000);
export const QA_COMPACTION_SUMMARY_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
export const QA_COMPACTION_SUMMARY_INSTRUCTIONS = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
export const QA_REMEMBER_FACT_PROMPT_RE = /remember this fact/i;
export const QA_FANOUT_WORKER_ALPHA_PROMPT_RE = /fanout worker alpha/i;
export const QA_FANOUT_WORKER_BETA_PROMPT_RE = /fanout worker beta/i;
export const QA_ROUNDTRIP_IMAGE_INSPECTION_PROMPT_RE = /roundtrip image inspection check/i;
export const QA_IMAGE_UNDERSTANDING_PROMPT_RE = /image understanding check/i;
export const QA_EXACT_MARKER_PROMPT_RE = /\bmarker\b/i;
export const QA_PERSONAL_SHARE_SAFE_DIAGNOSTICS_PROMPT_RE =
  /personal share-safe diagnostics check/i;
export const QA_PERSONAL_NO_FAKE_PROGRESS_PROMPT_RE = /personal no-fake-progress check/i;
export const QA_PERSONAL_FAILURE_RECOVERY_PROMPT_RE = /personal failure recovery check/i;
export const QA_LOBSTER_INVADERS_PROMPT_RE = /lobster invaders/i;
export const QA_MEMORY_TOOLS_PROMPT_RE = /memory tools check/i;
export const QA_SESSION_MEMORY_RANKING_PROMPT_RE = /session memory ranking check/i;
export const QA_THREAD_MEMORY_PROMPT_RE = /thread memory check/i;
export const QA_SUBAGENT_FANOUT_PROMPT_RE = /subagent fanout synthesis check/i;
export const QA_SUBAGENT_INTERNAL_COMPLETION_RE = /Internal task completion event/i;
export const QA_SUBAGENT_ALPHA_RESULT_RE = /\bALPHA-OK\b/i;
export const QA_SUBAGENT_BETA_RESULT_RE = /\bBETA-OK\b/i;
export const QA_REMEMBER_ACROSS_CONVERSATIONS_PROMPT_RE = /remember across conversations qa check/i;
export const QA_FORKED_SUBAGENT_CONTEXT_PROMPT_RE = /forked subagent context qa check/i;
export const QA_TOOL_CONTINUITY_PROMPT_RE = /tool continuity check/i;
export const QA_REPO_CONTRACT_FOLLOWTHROUGH_PROMPT_RE = /repo contract followthrough check/i;
export const QA_PERSONAL_TASK_FOLLOWTHROUGH_PROMPT_RE = /personal task followthrough check/i;
export const QA_SUBAGENT_HANDOFF_PROMPT_RE =
  /delegate (?:one |a )bounded qa task|subagent handoff/i;
export const QA_SOURCE_DISCOVERY_PROMPT_RE =
  /worked, failed, blocked|worked\/failed\/blocked|source and docs/i;
export const QA_GENERIC_READ_PROMPT_RE = /\b(read|inspect|repo|docs|scenario|kickoff)\b/i;
export const QA_VISIBLE_SKILL_MARKER_PROMPT_RE = /visible skill marker/i;
export const QA_HOT_INSTALL_MARKER_PROMPT_RE = /hot install marker/i;
export const QA_UNMENTIONED_GROUP_CHATTER_PROMPT_RE = /\bno bot ping here\b/i;
export const QA_REASONING_ONLY_RECOVERY_PROMPT_RE = /reasoning-only continuation qa check/i;
export const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE = /reasoning-only after write safety check/i;
export const QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT_RE = /anthropic thinking error qa check/i;
export const QA_THINKING_VISIBILITY_OFF_PROMPT_RE = /qa thinking visibility check off/i;
export const QA_THINKING_VISIBILITY_MAX_PROMPT_RE = /qa thinking visibility check max/i;
export const QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE = /empty response continuation qa check/i;
export const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE = /empty response exhaustion qa check/i;
export const QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT_RE =
  /empty response after write recovery qa check/i;
export const QA_STREAMING_PROMPT_RE = /(?:partial|quiet) streaming qa check/i;
export const QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE = /final-only marker streaming qa check/i;
export const QA_BLOCK_STREAMING_PROMPT_RE = /block streaming qa check/i;
export const QA_TOOL_PROGRESS_ERROR_PROMPT_RE = /tool progress error qa check/i;
export const QA_TOOL_PROGRESS_PROMPT_RE = /tool progress qa check/i;
export const QA_TOOL_PROGRESS_FAMILY_PROMPT_RE = /tool progress(?: error)? qa check/i;
export const QA_TOOL_LOOP_GLOBAL_BREAKER_PROMPT_RE = /global tool loop breaker qa check/i;
export const QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE = /provider http 503 after tool qa check/i;
export const QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE = /qa group visible reply tool check/i;
export const QA_MSTEAMS_THREAD_DEDUPE_PROMPT_RE = /qa msteams thread message-tool final dedupe/i;
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
export const SLACK_CHART_SUMMARY_TOKEN = "SLACK_QA_CHART_SUMMARY_TEST";
export const SLACK_CHART_DONE_TOKEN = "SLACK_QA_CHART_DONE_TEST";
export const SLACK_CHART_MESSAGE_TOOL_ARGS = {
  action: "send",
  message: SLACK_CHART_SUMMARY_TOKEN,
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
} as const;
export const SLACK_CHART_PROMPT = [
  `Slack native chart QA check ${SLACK_CHART_SUMMARY_TOKEN}.`,
  `Call the message tool exactly once with these exact arguments: ${JSON.stringify(SLACK_CHART_MESSAGE_TOOL_ARGS)}.`,
  `After the chart send succeeds, reply with only this exact marker: ${SLACK_CHART_DONE_TOKEN}`,
].join(" ");
export const QA_SLACK_CHART_PRESENTATION_PROMPT_RE =
  /Slack native chart QA check\s+(SLACK_QA_CHART_SUMMARY_[A-Z0-9]+)[\s\S]*?reply with only this exact marker:\s*(SLACK_QA_CHART_DONE_[A-Z0-9]+)/i;
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
export const WHATSAPP_AGENT_REACT_PROMPT =
  "React to this WhatsApp message with thumbs up for QA action check WHATSAPP_QA_AGENT_REACT_TEST.";
export const WHATSAPP_GROUP_AGENT_REACT_PROMPT =
  "openclawqa react to this WhatsApp group message with thumbs up for QA action check WHATSAPP_QA_GROUP_AGENT_REACT_TEST.";
export const WHATSAPP_AGENT_UPLOAD_TOKEN = "WHATSAPP_QA_AGENT_UPLOAD_TEST";
export const WHATSAPP_GROUP_AGENT_UPLOAD_TOKEN = "WHATSAPP_QA_GROUP_AGENT_UPLOAD_TEST";
export const WHATSAPP_AGENT_UPLOAD_PROMPT =
  `Use the WhatsApp message tool upload-file action to send a PNG with caption ${WHATSAPP_AGENT_UPLOAD_TOKEN}. ` +
  "Do not send any visible text reply after the upload.";
export const WHATSAPP_GROUP_AGENT_UPLOAD_PROMPT =
  `openclawqa use the WhatsApp message tool upload-file action to send a PNG with caption ${WHATSAPP_GROUP_AGENT_UPLOAD_TOKEN}. ` +
  "Do not send any visible text reply after the upload.";
export const WHATSAPP_PENDING_HISTORY_QUIET_MARKER = "WHATSAPP_QA_PENDING_HISTORY_QUIET_TEST";
export const WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL =
  "WHATSAPP_QA_PENDING_HISTORY_CONTEXT_ONLY_TEST";
export const WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER = "WHATSAPP_QA_PENDING_HISTORY_TRIGGER_TEST";
export const WHATSAPP_PENDING_HISTORY_OK_MARKER = "WHATSAPP_QA_PENDING_HISTORY_OK_TEST";
export const WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT = [
  "openclawqa pending history context check",
  WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER,
  `Return ${WHATSAPP_PENDING_HISTORY_OK_MARKER} only if prior group context contains ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}.`,
].join(" ");
export const WHATSAPP_BROADCAST_TOKEN = "WHATSAPP_QA_BROADCAST_TOKEN_TEST";
export const WHATSAPP_BROADCAST_PROMPT = `openclawqa broadcast fanout check ${WHATSAPP_BROADCAST_TOKEN}`;
export const WHATSAPP_ACTIVATION_ALWAYS_MARKER = "WHATSAPP_QA_ACTIVATION_ALWAYS_TEST";
export const WHATSAPP_ACTIVATION_ALWAYS_PROMPT = `Group activation visible behavior marker ${WHATSAPP_ACTIVATION_ALWAYS_MARKER}`;
export const WHATSAPP_REPLY_TO_BOT_SEED_MARKER = "WHATSAPP_QA_REPLY_TO_BOT_SEED_TEST";
export const WHATSAPP_REPLY_TO_BOT_SEED_PROMPT = `Mentioned group seed marker ${WHATSAPP_REPLY_TO_BOT_SEED_MARKER}`;
export const WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER = "WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_TEST";
export const WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT = `Quoted implicit reply trigger marker ${WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER}`;
export const QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE = /subagent direct fallback qa check/i;
export const QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE = /subagent direct fallback worker/i;
export const QA_SUBAGENT_TERMINAL_MATRIX_PROMPT_RE =
  /subagent terminal reply qa check:\s*(visible|silent|empty|restart|fallback)/i;
export const QA_SUBAGENT_TERMINAL_MATRIX_WORKER_RE =
  /subagent terminal reply qa worker:\s*(visible|silent|empty|restart|fallback)/i;

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
export const QA_SUBAGENT_TERMINAL_MARKERS = {
  visible: "QA-SUBAGENT-TERMINAL-VISIBLE-OK",
  empty: "QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED",
  restart: "QA-SUBAGENT-TERMINAL-RESTART-OK",
  fallback: "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
} as const;
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
export { MOCK_FIXTURE_CONFORMANCE_CONTRACTS } from "./mock-fixture-contracts.js";
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
  if (rawBody.includes(QA_MATRIX_VOICE_TRANSCRIPTION_TRIGGER)) {
    return QA_MATRIX_VOICE_TRANSCRIPTION_TEXT;
  }
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
