import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { RealtimeVoiceTool } from "./provider-types.js";
import type { TalkEvent } from "./talk-events.js";

export const REALTIME_VOICE_AGENT_CONTROL_MODES = [
  "status",
  "steer",
  "cancel",
  "followup",
] as const;

export type RealtimeVoiceAgentControlMode = (typeof REALTIME_VOICE_AGENT_CONTROL_MODES)[number];

export type RealtimeVoiceAgentControlProviderResult = {
  status: "cancelled";
  message: string;
};

export const REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME = "openclaw_agent_control";

export const REALTIME_VOICE_AGENT_CONTROL_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  description:
    "Control an active OpenClaw tool-backed voice run. Use this when the caller asks in any language for status/progress, cancellation, a redirect/change to the active work, or a follow-up after the current work. Do not use this for ordinary greetings or chatter unless the caller is asking about the active work.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The caller's exact spoken request or a concise semantic equivalent.",
      },
      mode: {
        type: "string",
        enum: REALTIME_VOICE_AGENT_CONTROL_MODES,
        description:
          "status for progress questions, cancel for stop/abort, steer for changing the current work, followup for work to do after the current result.",
      },
    },
    required: ["text", "mode"],
  },
};

export type RealtimeVoiceAgentControlIntent = {
  mode: RealtimeVoiceAgentControlMode;
  confidence: "high" | "medium" | "low";
  reason:
    | "explicit_mode"
    | "cancel_safety"
    | "status_query"
    | "followup_marker"
    | "steer_command"
    | "safe_default";
  shouldAutoControl: boolean;
};

export type RealtimeVoiceAgentRunActivity = {
  activeWorkKind?: "tool_call" | "model_call" | "embedded_run";
  hasActiveEmbeddedRun?: boolean;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
};

export type RealtimeVoiceAgentControlResult = {
  ok: boolean;
  mode: RealtimeVoiceAgentControlMode;
  sessionKey: string;
  sessionId?: string;
  active: boolean;
  queued?: boolean;
  aborted?: boolean;
  target?: "embedded_run" | "reply_run";
  reason?: string;
  message: string;
  speak: boolean;
  show: boolean;
  suppress: boolean;
  providerResult?: RealtimeVoiceAgentControlProviderResult;
  enqueuedAtMs?: number;
  deliveredAtMs?: number;
};

export function normalizeRealtimeVoiceAgentControlMode(
  value: unknown,
): RealtimeVoiceAgentControlMode | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  return REALTIME_VOICE_AGENT_CONTROL_MODES.includes(normalized as RealtimeVoiceAgentControlMode)
    ? (normalized as RealtimeVoiceAgentControlMode)
    : undefined;
}

const CANCEL_CONTROL_PATTERNS = [
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:please\s+)?(?:cancel|cancle|abort)(?:\s+(?:that|this|it|the\s+(?:check|run|task|work)))?(?:\s*[.!?])?$/,
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:please\s+)?(?:never mind|nevermind|forget it|kill it|end that)(?:\s*[.!?])?$/,
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:please\s+)?stop(?:\s+(?:that|this|it|the\s+(?:check|run|task|work)))?(?:\s*[.!?])?$/,
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:can|could|would)\s+you\s+(?:please\s+)?(?:cancel|cancle|stop|abort)(?:\s+(?:that|this|it|the\s+(?:check|run|task|work)))?(?:\s*[.!?])?$/,
  /^(?:(?:ok|okay|alright|all right|actually)[,\s]+)?(?:can|could|would)\s+(?:we|you)\s+(?:just\s+)?(?:cancel|cancle|stop|abort)(?:\s+(?:that|this|it|the\s+(?:check|run|task|work)))?(?:\s*[.!?])?$/,
  /\b(?:cancel|cancle|stop|abort)\s+(?:that|this|it|the\s+(?:check|run|task|work))\b/,
] as const;

const STATUS_CONTROL_PATTERNS = [
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:status|progress|update)(?:\s*[.!?])?$/,
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:give me|what'?s|any)\s+(?:an?\s+)?update(?:\s*[.!?])?$/,
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(where are we|what'?s happening|what (?:are you|is it) doing|what'?s it doing|how (?:is|are) (?:it|you|that|this) going|how'?s it going|are you still working|is it done|did it finish)(\b|[.!?])/,
] as const;

const FOLLOWUP_CONTROL_PATTERNS = [
  /^(after that|when you'?re done|when it'?s done|next|then|also|one more thing|follow up)(\b|[,.!?])/,
] as const;

const STEER_CONTROL_PATTERNS = [
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:please\s+)?update\s+\S/,
  /^(?:actually|instead|change|switch|focus|use|try|prefer|make|do|check|look at|go with|redirect|steer|tell it to)\b/,
  /^(?:can|could|would)\s+you\s+(?:actually\s+)?(?:change|switch|focus|use|try|prefer|make|do|check|look at|go with|redirect|steer)\b/,
  /\b(?:instead|not that|rather than|change that|switch to|focus on|use the|try the|go with|tell it to)\b/,
] as const;

const STOP_REDIRECT_CONTROL_PATTERNS = [
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:please\s+)?stop\s+(?:using|doing|checking|looking at|focusing on|trying)\b/,
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:can|could|would)\s+(?:you|we)\s+(?:please\s+)?stop\s+(?:using|doing|checking|looking at|focusing on|trying)\b/,
  /^(?:(?:ok|okay|alright|all right)[,\s]+)?(?:please\s+)?stop\s+(?:that|this|it|the\s+(?:check|run|task|work))\s+from\b/,
] as const;

function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasNegatedCancelIntent(text: string): boolean {
  return (
    /\b(?:don'?t|do\s+not|not|never)\s+(?:please\s+)?(?:cancel|cancle|stop|abort|kill|end)\b/.test(
      text,
    ) || /\bstop\s+(?:it|that|this)\s+from\b/.test(text)
  );
}

export function resolveRealtimeVoiceAgentControlIntent(params: {
  text: string;
  mode?: unknown;
}): RealtimeVoiceAgentControlIntent {
  const explicitMode = normalizeRealtimeVoiceAgentControlMode(params.mode);
  if (explicitMode) {
    return {
      mode: explicitMode,
      confidence: "high",
      reason: "explicit_mode",
      shouldAutoControl: true,
    };
  }

  const text = params.text;
  const normalized = text.trim().toLowerCase();
  if (matchesAnyPattern(normalized, STOP_REDIRECT_CONTROL_PATTERNS)) {
    return {
      mode: "steer",
      confidence: "medium",
      reason: "steer_command",
      shouldAutoControl: true,
    };
  }
  if (
    !hasNegatedCancelIntent(normalized) &&
    matchesAnyPattern(normalized, CANCEL_CONTROL_PATTERNS)
  ) {
    return {
      mode: "cancel",
      confidence: "high",
      reason: "cancel_safety",
      shouldAutoControl: true,
    };
  }
  if (matchesAnyPattern(normalized, STATUS_CONTROL_PATTERNS)) {
    return {
      mode: "status",
      confidence: "high",
      reason: "status_query",
      shouldAutoControl: true,
    };
  }
  if (matchesAnyPattern(normalized, FOLLOWUP_CONTROL_PATTERNS)) {
    return {
      mode: "followup",
      confidence: "high",
      reason: "followup_marker",
      shouldAutoControl: true,
    };
  }
  if (matchesAnyPattern(normalized, STEER_CONTROL_PATTERNS)) {
    return {
      mode: "steer",
      confidence: "medium",
      reason: "steer_command",
      shouldAutoControl: true,
    };
  }
  return {
    mode: "status",
    confidence: "low",
    reason: "safe_default",
    shouldAutoControl: false,
  };
}

export function classifyRealtimeVoiceAgentControlText(text: string): RealtimeVoiceAgentControlMode {
  return resolveRealtimeVoiceAgentControlIntent({ text }).mode;
}

export function shouldAutoControlRealtimeVoiceAgentText(text: string): boolean {
  return resolveRealtimeVoiceAgentControlIntent({ text }).shouldAutoControl;
}

export function parseRealtimeVoiceAgentControlToolArgs(args: unknown): {
  text: string;
  mode: RealtimeVoiceAgentControlMode;
} {
  const parsed = parseRealtimeVoiceAgentControlToolArgsRecord(args);
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const text =
    normalizeOptionalString((record as Record<string, unknown>).text) ??
    normalizeOptionalString((record as Record<string, unknown>).message) ??
    normalizeOptionalString((record as Record<string, unknown>).request) ??
    normalizeOptionalString((record as Record<string, unknown>).query);
  if (!text) {
    throw new Error("text required");
  }
  const mode =
    normalizeRealtimeVoiceAgentControlMode((record as Record<string, unknown>).mode) ??
    resolveRealtimeVoiceAgentControlIntent({ text }).mode;
  return { text, mode };
}

function parseRealtimeVoiceAgentControlToolArgsRecord(args: unknown): unknown {
  if (typeof args !== "string") {
    return args;
  }
  const trimmed = args.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { text: trimmed };
  }
}

export function buildRealtimeVoiceAgentControlSpeechMessage(text: string): string {
  return [
    "Internal OpenClaw voice control result.",
    "Do not call openclaw_agent_consult or any other tool for this message.",
    "Speak this exact OpenClaw status to the voice call, without adding, removing, or rephrasing words.",
    `Status: ${JSON.stringify(text)}`,
  ].join("\n");
}

export function buildRealtimeVoiceAgentCancelProviderResult(
  message = "Cancelled the active OpenClaw run.",
): RealtimeVoiceAgentControlProviderResult {
  return {
    status: "cancelled",
    message,
  };
}

export function buildRealtimeVoiceAgentFollowupSteeringText(text: string): string {
  return [
    "Spoken follow-up for the current voice call.",
    "If you are mid-task, incorporate this after the current step or result unless it directly changes the current task.",
    "",
    text,
  ].join("\n");
}

export function formatRealtimeVoiceAgentQueueRejection(
  mode: RealtimeVoiceAgentControlMode,
  reason: string,
): string {
  if (reason === "compacting") {
    return "OpenClaw is compacting the active run and cannot accept voice steering yet.";
  }
  if (reason === "not_streaming") {
    return "OpenClaw has an active run, but it is not currently accepting steering.";
  }
  return mode === "followup"
    ? "OpenClaw could not queue that follow-up."
    : "OpenClaw could not steer the active run.";
}

function isRealtimeVoiceAgentControlToolEvent(event: TalkEvent): boolean {
  if (!event.type.startsWith("tool.")) {
    return false;
  }
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  return normalizeOptionalString(payload.name) === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME;
}

export function formatRealtimeVoiceAgentStatus(params: {
  active: boolean;
  recentEvents?: readonly TalkEvent[];
  activity?: RealtimeVoiceAgentRunActivity;
}): string {
  const recent = (params.recentEvents ?? []).toReversed();
  if (!params.active) {
    const turnEnded = recent.find((event) => event.type === "turn.ended");
    return turnEnded
      ? "OpenClaw finished the last voice request."
      : "I'm not working on an active request right now.";
  }

  const toolEvent = recent.find(
    (event) => event.type.startsWith("tool.") && !isRealtimeVoiceAgentControlToolEvent(event),
  );
  if (toolEvent) {
    const payload =
      toolEvent.payload && typeof toolEvent.payload === "object"
        ? (toolEvent.payload as Record<string, unknown>)
        : {};
    const name = normalizeOptionalString(payload.name);
    const phase = normalizeOptionalString(payload.phase);
    if (toolEvent.type === "tool.call") {
      return name ? `OpenClaw is starting ${name}.` : "OpenClaw is starting a tool.";
    }
    if (toolEvent.type === "tool.result") {
      return name
        ? `OpenClaw finished ${name} and is continuing.`
        : "OpenClaw finished a tool and is continuing.";
    }
    if (toolEvent.type === "tool.progress") {
      return name
        ? `OpenClaw is working in ${name}${phase ? ` (${phase})` : ""}.`
        : "OpenClaw is still working.";
    }
  }

  if (params.activity?.activeToolName) {
    return `OpenClaw is running ${params.activity.activeToolName}.`;
  }
  if (params.activity?.activeWorkKind === "model_call") {
    return "OpenClaw is waiting on the model.";
  }
  if (params.activity?.activeWorkKind === "embedded_run" || params.activity?.hasActiveEmbeddedRun) {
    return "OpenClaw is working on the current voice request.";
  }

  return "OpenClaw is working on the current voice request.";
}
