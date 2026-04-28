import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { RealtimeVoiceTool } from "./provider-types.js";

export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
export const REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES = [
  "safe-read-only",
  "owner",
  "none",
] as const;
export type RealtimeVoiceAgentConsultToolPolicy =
  (typeof REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES)[number];
export type RealtimeVoiceAgentConsultArgs = {
  question: string;
  context?: string;
  responseStyle?: string;
};
export type RealtimeVoiceAgentConsultTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};

export const REALTIME_VOICE_AGENT_CONSULT_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  description:
    "Ask the full OpenClaw agent for deeper reasoning, current information, or tool-backed help before speaking.",
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

export function buildRealtimeVoiceAgentConsultWorkingResponse(
  audienceLabel = "person",
): Record<string, unknown> {
  return {
    status: "working",
    tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    message: `Tell the ${audienceLabel} briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.`,
  };
}

const SAFE_READ_ONLY_TOOLS = [
  "read",
  "web_search",
  "web_fetch",
  "x_search",
  "memory_search",
  "memory_get",
] as const;

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

export function resolveRealtimeVoiceAgentConsultToolPolicy(
  value: unknown,
  fallback: RealtimeVoiceAgentConsultToolPolicy,
): RealtimeVoiceAgentConsultToolPolicy {
  const normalized = normalizeOptionalLowercaseString(value);
  return isRealtimeVoiceAgentConsultToolPolicy(normalized) ? normalized : fallback;
}

export function resolveRealtimeVoiceAgentConsultTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
  customTools: RealtimeVoiceTool[] = [],
): RealtimeVoiceTool[] {
  const tools = new Map<string, RealtimeVoiceTool>();
  if (policy !== "none") {
    tools.set(REALTIME_VOICE_AGENT_CONSULT_TOOL.name, REALTIME_VOICE_AGENT_CONSULT_TOOL);
  }
  for (const tool of customTools) {
    if (!tools.has(tool.name)) {
      tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

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

export function parseRealtimeVoiceAgentConsultArgs(args: unknown): RealtimeVoiceAgentConsultArgs {
  const question = readConsultStringArg(args, "question");
  if (!question) {
    throw new Error("question required");
  }
  return {
    question,
    context: readConsultStringArg(args, "context"),
    responseStyle: readConsultStringArg(args, "responseStyle"),
  };
}

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
  const transcript = params.transcript
    .slice(-12)
    .map(
      (entry) => `${entry.role === "assistant" ? assistantLabel : params.userLabel}: ${entry.text}`,
    )
    .join("\n");

  return [
    `You are helping an OpenClaw realtime voice agent during ${params.surface}.`,
    `Answer the ${questionSourceLabel}'s question with the strongest useful reasoning and available tools.`,
    "Return only the concise answer the realtime voice agent should speak next.",
    "Do not include markdown, citations unless needed, tool logs, or private reasoning.",
    parsed.responseStyle ? `Spoken style: ${parsed.responseStyle}` : undefined,
    transcript ? `Recent transcript:\n${transcript}` : undefined,
    parsed.context ? `Additional context:\n${parsed.context}` : undefined,
    `Question:\n${parsed.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function collectRealtimeVoiceAgentConsultVisibleText(
  payloads: Array<{ text?: unknown; isError?: boolean; isReasoning?: boolean }>,
): string | null {
  const chunks: string[] = [];
  for (const payload of payloads) {
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
