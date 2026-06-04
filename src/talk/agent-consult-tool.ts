/**
 * Realtime voice tool definition and helpers for delegating work to OpenClaw.
 *
 * Voice providers call this function tool when a spoken request needs normal
 * agent tools, memory, workspace context, or current information before reply.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { RealtimeVoiceTool } from "./provider-types.js";

/** Stable provider-facing tool name for realtime voice agent delegation. */
export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
/** Closed policy set controlling whether the consult tool is exposed. */
export const REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES = [
  "safe-read-only",
  "owner",
  "none",
] as const;
/** Tool exposure policy for the shared realtime voice consult tool. */
export type RealtimeVoiceAgentConsultToolPolicy =
  (typeof REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES)[number];
/** Normalized tool-call arguments accepted from realtime providers. */
export type RealtimeVoiceAgentConsultArgs = {
  question: string;
  context?: string;
  responseStyle?: string;
};
/** Compact transcript entry included in delegated agent prompts. */
export type RealtimeVoiceAgentConsultTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};

/** Shared realtime voice function-tool descriptor projected to providers. */
export const REALTIME_VOICE_AGENT_CONSULT_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  description:
    "Delegate the caller's request to the configured OpenClaw agent for normal tool-backed work, actions, context, memory, or reasoning before speaking.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The concrete question or task the user asked.",
      },
      context: {
        type: "string",
        description: "Optional relevant context or transcript summary.",
      },
      responseStyle: {
        type: "string",
        description: "Optional style hint for the spoken answer.",
      },
    },
    required: ["question"],
  },
};

/** Build the interim spoken instruction while the delegated agent turn runs. */
export function buildRealtimeVoiceAgentConsultWorkingResponse(
  audienceLabel = "person",
): Record<string, unknown> {
  return {
    status: "working",
    tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    message: `Tell the ${audienceLabel} briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.`,
  };
}

/** Default safe tool allowlist for voice consults in read-only mode. */
const SAFE_READ_ONLY_TOOLS = [
  "read",
  "web_search",
  "web_fetch",
  "x_search",
  "memory_search",
  "memory_get",
] as const;

/** Type guard for user/config supplied consult tool policies. */
export function isRealtimeVoiceAgentConsultToolPolicy(
  value: unknown,
): value is RealtimeVoiceAgentConsultToolPolicy {
  return (
    typeof value === "string" &&
    REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES.includes(
      value as RealtimeVoiceAgentConsultToolPolicy,
    )
  );
}

/** Normalize a configured consult tool policy with a caller-owned fallback. */
export function resolveRealtimeVoiceAgentConsultToolPolicy(
  value: unknown,
  fallback: RealtimeVoiceAgentConsultToolPolicy,
): RealtimeVoiceAgentConsultToolPolicy {
  const normalized = normalizeOptionalLowercaseString(value);
  return isRealtimeVoiceAgentConsultToolPolicy(normalized) ? normalized : fallback;
}

/** Merge the shared consult tool with provider/plugin custom realtime tools. */
export function resolveRealtimeVoiceAgentConsultTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
  customTools: RealtimeVoiceTool[] = [],
): RealtimeVoiceTool[] {
  const tools = new Map<string, RealtimeVoiceTool>();
  if (policy !== "none") {
    tools.set(REALTIME_VOICE_AGENT_CONSULT_TOOL.name, REALTIME_VOICE_AGENT_CONSULT_TOOL);
  }
  // Keep the built-in consult tool first and prevent custom tools from
  // replacing its provider-facing contract by name.
  for (const tool of customTools) {
    if (!tools.has(tool.name)) {
      tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

/** Resolve the OpenClaw tool allowlist paired with the consult exposure policy. */
export function resolveRealtimeVoiceAgentConsultToolsAllow(
  policy: RealtimeVoiceAgentConsultToolPolicy,
): string[] | undefined {
  if (policy === "owner") {
    return undefined;
  }
  if (policy === "safe-read-only") {
    return [...SAFE_READ_ONLY_TOOLS];
  }
  return [];
}

/** Build model instructions for when the voice agent should call the consult tool. */
export function buildRealtimeVoiceAgentConsultPolicyInstructions(config: {
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultPolicy?: "auto" | "substantive" | "always";
}): string | undefined {
  if (config.toolPolicy === "none" || !config.consultPolicy || config.consultPolicy === "auto") {
    return undefined;
  }
  if (config.consultPolicy === "always") {
    return [
      "Consult behavior:",
      "- Call openclaw_agent_consult before every substantive answer.",
      "- You may answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting for the consult result.",
      "- After the consult result arrives, speak that result concisely.",
    ].join("\n");
  }
  return [
    "Consult behavior:",
    "- Answer directly for greetings, acknowledgements, simple conversational glue, and brief latency tests.",
    "- Call openclaw_agent_consult before answering requests that need facts, memory, current information, tools, workspace state, or the user's OpenClaw-specific context.",
    "- Keep spoken replies concise and natural.",
  ].join("\n");
}

/** Parse provider-owned consult tool arguments into the normalized contract. */
export function parseRealtimeVoiceAgentConsultArgs(args: unknown): RealtimeVoiceAgentConsultArgs {
  const question =
    readConsultStringArg(args, "question") ??
    readConsultStringArg(args, "prompt") ??
    readConsultStringArg(args, "query") ??
    readConsultStringArg(args, "task");
  if (!question) {
    throw new Error("question required");
  }
  return {
    question,
    context: readConsultStringArg(args, "context"),
    responseStyle: readConsultStringArg(args, "responseStyle"),
  };
}

/** Build the plain chat message used by browser/chat forwarding paths. */
export function buildRealtimeVoiceAgentConsultChatMessage(args: unknown): string {
  const parsed = parseRealtimeVoiceAgentConsultArgs(args);
  return [
    parsed.question,
    parsed.context ? `Context:\n${parsed.context}` : undefined,
    parsed.responseStyle ? `Spoken style:\n${parsed.responseStyle}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Build the delegated OpenClaw agent prompt for a live voice consult. */
export function buildRealtimeVoiceAgentConsultPrompt(params: {
  args: unknown;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  surface: string;
  userLabel: string;
  assistantLabel?: string;
  questionSourceLabel?: string;
}): string {
  const parsed = parseRealtimeVoiceAgentConsultArgs(params.args);
  const assistantLabel = params.assistantLabel ?? "Agent";
  const questionSourceLabel = params.questionSourceLabel ?? params.userLabel.toLowerCase();
  // Bound transcript context so long meetings do not crowd out the live request.
  const transcript = params.transcript
    .slice(-12)
    .map(
      (entry) => `${entry.role === "assistant" ? assistantLabel : params.userLabel}: ${entry.text}`,
    )
    .join("\n");

  return [
    `Live voice request from the ${questionSourceLabel} during ${params.surface}.`,
    "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
    "When finished, return only the concise result the realtime voice agent should speak back.",
    "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
    parsed.responseStyle ? `Spoken style: ${parsed.responseStyle}` : undefined,
    transcript ? `Recent voice transcript for context:\n${transcript}` : undefined,
    parsed.context ? `Additional realtime context:\n${parsed.context}` : undefined,
    `User request:\n${parsed.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Collect only visible answer text from streamed delegated-agent payloads. */
export function collectRealtimeVoiceAgentConsultVisibleText(
  payloads: Array<{ text?: unknown; isError?: boolean; isReasoning?: boolean }>,
): string | null {
  const chunks: string[] = [];
  for (const payload of payloads) {
    // Spoken replies must not include hidden reasoning or error-channel text.
    if (payload.isError || payload.isReasoning) {
      continue;
    }
    const text = normalizeOptionalString(payload.text);
    if (text) {
      chunks.push(text);
    }
  }
  return chunks.length > 0 ? chunks.join("\n\n").trim() : null;
}

function readConsultStringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  return normalizeOptionalString((args as Record<string, unknown>)[key]);
}
