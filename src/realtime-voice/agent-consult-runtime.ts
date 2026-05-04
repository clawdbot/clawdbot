import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunEmbeddedPiAgentParams } from "../agents/pi-embedded-runner/run/params.js";
import {
  forkSessionFromParent,
  resolveParentForkDecision,
} from "../auto-reply/reply/session-fork.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeLogger, PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  buildRealtimeVoiceAgentConsultPrompt,
  collectRealtimeVoiceAgentConsultVisibleText,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "./agent-consult-tool.js";

export type RealtimeVoiceAgentConsultRuntime = PluginRuntimeCore["agent"];
export type RealtimeVoiceAgentConsultResult = { text: string };
export type RealtimeVoiceAgentConsultContextMode = "isolated" | "fork";
export {
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-tool.js";

type RealtimeVoiceAgentConsultDeps = {
  randomUUID: typeof randomUUID;
  resolveParentForkDecision: typeof resolveParentForkDecision;
  forkSessionFromParent: typeof forkSessionFromParent;
};

const defaultRealtimeVoiceAgentConsultDeps: RealtimeVoiceAgentConsultDeps = {
  randomUUID,
  resolveParentForkDecision,
  forkSessionFromParent,
};

let realtimeVoiceAgentConsultDeps = defaultRealtimeVoiceAgentConsultDeps;

export function __setRealtimeVoiceAgentConsultDepsForTest(
  deps: Partial<RealtimeVoiceAgentConsultDeps> | null,
): void {
  realtimeVoiceAgentConsultDeps = deps
    ? { ...defaultRealtimeVoiceAgentConsultDeps, ...deps }
    : defaultRealtimeVoiceAgentConsultDeps;
}

function resolveRealtimeVoiceAgentSandboxSessionKey(agentId: string, sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `agent:${agentId}:${trimmed}`;
}

async function resolveRealtimeVoiceAgentConsultSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  storePath: string;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
}): Promise<SessionEntry> {
  const now = Date.now();
  return await params.agentRuntime.session.updateSessionStore(params.storePath, async (store) => {
    const existing = store[params.sessionKey] as SessionEntry | undefined;
    if (existing?.sessionId?.trim()) {
      const next: SessionEntry = { ...existing, updatedAt: now };
      store[params.sessionKey] = next;
      return next;
    }

    const requesterSessionKey = params.spawnedBy?.trim();
    const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
    const shouldFork =
      params.contextMode === "fork" &&
      requesterSessionKey &&
      (!requesterAgentId || requesterAgentId === params.agentId);

    if (shouldFork) {
      const parentEntry = store[requesterSessionKey] as SessionEntry | undefined;
      if (parentEntry?.sessionId?.trim()) {
        const decision = await realtimeVoiceAgentConsultDeps.resolveParentForkDecision({
          parentEntry,
          storePath: params.storePath,
        });
        if (decision.status === "fork") {
          const fork = await realtimeVoiceAgentConsultDeps.forkSessionFromParent({
            parentEntry,
            agentId: params.agentId,
            sessionsDir: path.dirname(params.storePath),
          });
          if (fork) {
            const next: SessionEntry = {
              ...existing,
              sessionId: fork.sessionId,
              sessionFile: fork.sessionFile,
              spawnedBy: requesterSessionKey,
              forkedFromParent: true,
              updatedAt: now,
            };
            store[params.sessionKey] = next;
            return next;
          }
        } else {
          params.logger.warn(`[realtime-voice] ${decision.message}`);
        }
      }
    }

    const next: SessionEntry = {
      ...existing,
      sessionId: realtimeVoiceAgentConsultDeps.randomUUID(),
      ...(requesterSessionKey ? { spawnedBy: requesterSessionKey } : {}),
      updatedAt: now,
    };
    store[params.sessionKey] = next;
    return next;
  });
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
  spawnedBy?: string | null;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
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
  const sessionEntry = await resolveRealtimeVoiceAgentConsultSessionEntry({
    agentId,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    contextMode: params.contextMode,
    storePath,
    agentRuntime: params.agentRuntime,
    logger: params.logger,
  });
  const sessionId = sessionEntry.sessionId;

  const sessionFile = params.agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });
  const result = await params.agentRuntime.runEmbeddedPiAgent({
    sessionId,
    sessionKey: params.sessionKey,
    sandboxSessionKey: resolveRealtimeVoiceAgentSandboxSessionKey(agentId, params.sessionKey),
    agentId,
    spawnedBy: params.spawnedBy,
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
