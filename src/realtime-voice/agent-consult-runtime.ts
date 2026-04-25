import { randomUUID } from "node:crypto";
import type { RunEmbeddedPiAgentParams } from "../agents/pi-embedded-runner/run/params.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeLogger, PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import {
  buildRealtimeVoiceAgentConsultPrompt,
  collectRealtimeVoiceAgentConsultVisibleText,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "./agent-consult-tool.js";

export type RealtimeVoiceAgentConsultRuntime = PluginRuntimeCore["agent"];
export type RealtimeVoiceAgentConsultResult = { text: string };
export {
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-tool.js";

function resolveRealtimeVoiceAgentSandboxSessionKey(agentId: string, sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `agent:${agentId}:${trimmed}`;
}

export async function consultRealtimeVoiceAgent(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
  sessionKey: string;
  messageProvider: string;
  lane: string;
  runIdPrefix: string;
  args: unknown;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  surface: string;
  userLabel: string;
  assistantLabel?: string;
  questionSourceLabel?: string;
  agentId?: string;
  provider?: RunEmbeddedPiAgentParams["provider"];
  model?: RunEmbeddedPiAgentParams["model"];
  thinkLevel?: RunEmbeddedPiAgentParams["thinkLevel"];
  timeoutMs?: number;
  toolsAllow?: string[];
  extraSystemPrompt?: string;
  fallbackText?: string;
}): Promise<RealtimeVoiceAgentConsultResult> {
  const agentId = params.agentId ?? "main";
  const agentDir = params.agentRuntime.resolveAgentDir(params.cfg, agentId);
  const workspaceDir = params.agentRuntime.resolveAgentWorkspaceDir(params.cfg, agentId);
  await params.agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  const storePath = params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, {
    agentId,
  });
  const sessionStore = params.agentRuntime.session.loadSessionStore(storePath);
  const now = Date.now();
  const existing = sessionStore[params.sessionKey] as
    | { sessionId?: string; updatedAt?: number }
    | undefined;
  const sessionId = existing?.sessionId?.trim() || randomUUID();
  sessionStore[params.sessionKey] = { ...existing, sessionId, updatedAt: now };
  await params.agentRuntime.session.saveSessionStore(storePath, sessionStore);

  const sessionFile = params.agentRuntime.session.resolveSessionFilePath(
    sessionId,
    sessionStore[params.sessionKey],
    { agentId },
  );
  const result = await params.agentRuntime.runEmbeddedPiAgent({
    sessionId,
    sessionKey: params.sessionKey,
    sandboxSessionKey: resolveRealtimeVoiceAgentSandboxSessionKey(agentId, params.sessionKey),
    agentId,
    messageProvider: params.messageProvider,
    sessionFile,
    workspaceDir,
    config: params.cfg,
    prompt: buildRealtimeVoiceAgentConsultPrompt({
      args: params.args,
      transcript: params.transcript,
      surface: params.surface,
      userLabel: params.userLabel,
      assistantLabel: params.assistantLabel,
      questionSourceLabel: params.questionSourceLabel,
    }),
    provider: params.provider,
    model: params.model,
    thinkLevel: params.thinkLevel ?? "high",
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    toolsAllow: params.toolsAllow,
    timeoutMs: params.timeoutMs ?? params.agentRuntime.resolveAgentTimeoutMs({ cfg: params.cfg }),
    runId: `${params.runIdPrefix}:${Date.now()}`,
    lane: params.lane,
    extraSystemPrompt:
      params.extraSystemPrompt ??
      "You are a behind-the-scenes consultant for a live voice agent. Be accurate, brief, and speakable.",
    agentDir,
  });

  const text = collectRealtimeVoiceAgentConsultVisibleText(result.payloads ?? []);
  if (!text) {
    const reason = result.meta?.aborted ? "agent run aborted" : "agent returned no speakable text";
    params.logger.warn(`[realtime-voice] agent consult produced no answer: ${reason}`);
    return { text: params.fallbackText ?? "I need a moment to verify that before answering." };
  }
  return { text };
}
