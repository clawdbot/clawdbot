import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { GoogleMeetConfig, GoogleMeetToolPolicy } from "./config.js";

type AgentPayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
};

export const GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME = REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
export const GOOGLE_MEET_AGENT_CONSULT_TOOL = REALTIME_VOICE_AGENT_CONSULT_TOOL;

export function resolveGoogleMeetRealtimeTools(policy: GoogleMeetToolPolicy): RealtimeVoiceTool[] {
  return policy === "none" ? [] : [GOOGLE_MEET_AGENT_CONSULT_TOOL];
}

function normalizeToolArgString(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  return normalizeOptionalString((args as Record<string, unknown>)[key]);
}

function collectVisibleText(payloads: AgentPayload[]): string | null {
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

function resolveToolsAllow(policy: GoogleMeetToolPolicy): string[] | undefined {
  if (policy === "owner") {
    return undefined;
  }
  if (policy === "safe-read-only") {
    return ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"];
  }
  return [];
}

function buildPrompt(params: {
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): string {
  const question = normalizeToolArgString(params.args, "question");
  if (!question) {
    throw new Error("question required");
  }
  const context = normalizeToolArgString(params.args, "context");
  const responseStyle = normalizeToolArgString(params.args, "responseStyle");
  const transcript = params.transcript
    .slice(-12)
    .map((entry) => `${entry.role === "assistant" ? "Agent" : "Participant"}: ${entry.text}`)
    .join("\n");
  return [
    "You are helping an OpenClaw realtime voice agent during a private Google Meet.",
    "Answer the participant's question with the strongest useful reasoning and available tools.",
    "Return only the concise answer the realtime voice agent should speak next.",
    "Do not include markdown, citations unless needed, tool logs, or private reasoning.",
    responseStyle ? `Spoken style: ${responseStyle}` : undefined,
    transcript ? `Recent meeting transcript:\n${transcript}` : undefined,
    context ? `Additional context:\n${context}` : undefined,
    `Question:\n${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function consultOpenClawAgentForGoogleMeet(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  meetingSessionId: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): Promise<{ text: string }> {
  const agentId = "main";
  const sessionKey = `google-meet:${params.meetingSessionId}`;
  const cfg = params.fullConfig;
  const agentDir = params.runtime.agent.resolveAgentDir(cfg, agentId);
  const workspaceDir = params.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  await params.runtime.agent.ensureAgentWorkspace({ dir: workspaceDir });

  const storePath = params.runtime.agent.session.resolveStorePath(cfg.session?.store, { agentId });
  const sessionStore = params.runtime.agent.session.loadSessionStore(storePath);
  const now = Date.now();
  const existing = sessionStore[sessionKey] as
    | { sessionId?: string; updatedAt?: number }
    | undefined;
  const sessionId = normalizeOptionalString(existing?.sessionId) ?? randomUUID();
  sessionStore[sessionKey] = { ...existing, sessionId, updatedAt: now };
  await params.runtime.agent.session.saveSessionStore(storePath, sessionStore);

  const sessionFile = params.runtime.agent.session.resolveSessionFilePath(
    sessionId,
    sessionStore[sessionKey],
    { agentId },
  );
  const result = await params.runtime.agent.runEmbeddedPiAgent({
    sessionId,
    sessionKey,
    messageProvider: "google-meet",
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt: buildPrompt({ args: params.args, transcript: params.transcript }),
    thinkLevel: "high",
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    toolsAllow: resolveToolsAllow(params.config.realtime.toolPolicy),
    timeoutMs: params.runtime.agent.resolveAgentTimeoutMs({ cfg }),
    runId: `google-meet:${params.meetingSessionId}:${Date.now()}`,
    lane: "google-meet",
    extraSystemPrompt:
      "You are a behind-the-scenes consultant for a live meeting voice agent. Be accurate, brief, and speakable.",
    agentDir,
  });

  const text = collectVisibleText((result.payloads ?? []) as AgentPayload[]);
  if (!text) {
    const reason = result.meta?.aborted ? "agent run aborted" : "agent returned no speakable text";
    params.logger.warn(`[google-meet] agent consult produced no answer: ${reason}`);
    return { text: "I need a moment to verify that before answering." };
  }
  return { text };
}
