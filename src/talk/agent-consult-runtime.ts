// Agent consult runtime starts agent consultation flows from talk sessions.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import {
  forkSessionFromParent,
  resolveParentForkDecision,
} from "../auto-reply/reply/session-fork.js";
import { parseSessionThreadInfoFast } from "../config/sessions/thread-info.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeLogger, PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  buildRealtimeVoiceAgentConsultPrompt,
  collectRealtimeVoiceAgentConsultVisibleText,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "./agent-consult-tool.js";

/**
 * Agent runtime surface used by realtime voice consults.
 */
export type RealtimeVoiceAgentConsultRuntime = PluginRuntimeCore["agent"];

/**
 * Speakable text returned to the realtime voice bridge after an agent consult.
 */
export type RealtimeVoiceAgentConsultResult = { text: string };

/**
 * Controls whether voice consults run in a fresh session or fork context from the requester.
 */
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

/**
 * Overrides consult runtime dependencies for deterministic tests.
 */
export function setRealtimeVoiceAgentConsultDepsForTest(
  deps: Partial<RealtimeVoiceAgentConsultDeps> | null,
): void {
  realtimeVoiceAgentConsultDeps = deps
    ? { ...defaultRealtimeVoiceAgentConsultDeps, ...deps }
    : defaultRealtimeVoiceAgentConsultDeps;
}

function resolveRealtimeVoiceAgentSandboxSessionKey(agentId: string, sessionKey: string): string {
  // Embedded agent runs expect agent-scoped sandbox keys; keep already-scoped keys intact so
  // callers can deliberately share a sandbox with an existing agent session.
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `agent:${agentId}:${trimmed}`;
}

function hasRoutableDeliveryContext(
  context: DeliveryContext | undefined,
): context is DeliveryContext & { channel: string; to: string } {
  return Boolean(context?.channel && context?.to);
}

function resolveDeliverySessionFields(context?: DeliveryContext): Partial<SessionEntry> {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel || !normalized.to) {
    return {};
  }
  return {
    deliveryContext: normalized,
    lastChannel: normalized.channel,
    lastTo: normalized.to,
    lastAccountId: normalized.accountId,
    lastThreadId: normalized.threadId,
  };
}

function resolveRealtimeVoiceAgentDeliveryContext(params: {
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  storePath: string;
  sessionKey: string;
  spawnedBy?: string | null;
}): DeliveryContext | undefined {
  const requesterSessionKey = params.spawnedBy?.trim();
  try {
    // Prefer the live requester session, then its base thread, then the voice consult session.
    // This preserves channel/account/thread routing when a voice bridge delegates back to agent.
    const candidates: string[] = [];
    if (requesterSessionKey) {
      const { baseSessionKey } = parseSessionThreadInfoFast(requesterSessionKey);
      candidates.push(
        ...[requesterSessionKey, baseSessionKey].filter((key): key is string => Boolean(key)),
      );
    }
    candidates.push(params.sessionKey);
    for (const key of candidates) {
      const entry = params.agentRuntime.session.getSessionEntry({
        storePath: params.storePath,
        sessionKey: key,
      });
      const context = deliveryContextFromSession(entry);
      if (hasRoutableDeliveryContext(context)) {
        return context;
      }
    }
  } catch {
    // Best-effort routing enrichment only; consults should still work without it.
  }
  return undefined;
}

async function resolveRealtimeVoiceAgentConsultSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  deliveryContext?: DeliveryContext;
  storePath: string;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
}): Promise<SessionEntry> {
  const now = Date.now();
  const deliveryFields = resolveDeliverySessionFields(params.deliveryContext);
  const requesterSessionKey = params.spawnedBy?.trim();
  const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  const shouldFork =
    params.contextMode === "fork" &&
    requesterSessionKey &&
    (!requesterAgentId || requesterAgentId === params.agentId);
  let forkDecisionWarning: string | undefined;

  const patched = await params.agentRuntime.session.patchSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    fallbackEntry: {
      sessionId: "",
      updatedAt: now,
    },
    update: async (entry) => {
      if (entry.sessionId?.trim()) {
        return { ...deliveryFields, updatedAt: now };
      }
      // Fork only from same-agent requester sessions. Cross-agent parent sessions may carry
      // incompatible provider state, so they get a fresh consult session with spawnedBy linkage.
      if (shouldFork) {
        const parentEntry = params.agentRuntime.session.getSessionEntry({
          storePath: params.storePath,
          sessionKey: requesterSessionKey,
        });
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
              return {
                ...deliveryFields,
                sessionId: fork.sessionId,
                sessionFile: fork.sessionFile,
                spawnedBy: requesterSessionKey,
                forkedFromParent: true,
                updatedAt: now,
              };
            }
          } else {
            forkDecisionWarning = decision.message;
          }
        }
      }
      return {
        ...deliveryFields,
        sessionId: realtimeVoiceAgentConsultDeps.randomUUID(),
        ...(requesterSessionKey ? { spawnedBy: requesterSessionKey } : {}),
        updatedAt: now,
      };
    },
  });
  if (forkDecisionWarning) {
    params.logger.warn(`[talk] ${forkDecisionWarning}`);
  }
  if (patched?.sessionId?.trim()) {
    return patched;
  }
  throw new Error("realtime voice agent consult session could not be initialized");
}

/**
 * Runs an embedded agent consult and returns concise speakable text for realtime voice playback.
 */
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
  provider?: RunEmbeddedAgentParams["provider"];
  model?: RunEmbeddedAgentParams["model"];
  thinkLevel?: RunEmbeddedAgentParams["thinkLevel"];
  fastMode?: RunEmbeddedAgentParams["fastMode"];
  timeoutMs?: number;
  toolsAllow?: string[];
  extraSystemPrompt?: string;
  fallbackText?: string;
}): Promise<RealtimeVoiceAgentConsultResult> {
  const agentId = params.agentId ?? "main";
  const agentDir = params.agentRuntime.resolveAgentDir(params.cfg, agentId);
  const workspaceDir = params.agentRuntime.resolveAgentWorkspaceDir(params.cfg, agentId);
  await params.agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  // The consult session stores normal session metadata so subsequent voice turns can keep
  // routing and, in fork mode, recover useful conversation context from the requester.
  const storePath = params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, {
    agentId,
  });
  const resolvedDeliveryContext = resolveRealtimeVoiceAgentDeliveryContext({
    agentRuntime: params.agentRuntime,
    storePath,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
  });
  const sessionEntry = await resolveRealtimeVoiceAgentConsultSessionEntry({
    agentId,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    contextMode: params.contextMode,
    deliveryContext: resolvedDeliveryContext,
    storePath,
    agentRuntime: params.agentRuntime,
    logger: params.logger,
  });
  const consultDeliveryContext =
    resolvedDeliveryContext ?? deliveryContextFromSession(sessionEntry);
  const sessionId = sessionEntry.sessionId;

  const sessionFile = params.agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });
  // Voice consults suppress verbose/reasoning output because the bridge needs a short,
  // speakable answer, not agent-run diagnostics or hidden reasoning artifacts.
  const result = await params.agentRuntime.runEmbeddedAgent({
    sessionId,
    sessionKey: params.sessionKey,
    sandboxSessionKey: resolveRealtimeVoiceAgentSandboxSessionKey(agentId, params.sessionKey),
    agentId,
    spawnedBy: params.spawnedBy,
    messageProvider: consultDeliveryContext?.channel ?? params.messageProvider,
    agentAccountId: consultDeliveryContext?.accountId,
    messageTo: consultDeliveryContext?.to,
    messageThreadId: consultDeliveryContext?.threadId,
    currentChannelId: consultDeliveryContext?.to,
    currentThreadTs:
      consultDeliveryContext?.threadId != null
        ? String(consultDeliveryContext.threadId)
        : undefined,
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
    fastMode: params.fastMode,
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    toolsAllow: params.toolsAllow,
    timeoutMs: params.timeoutMs ?? params.agentRuntime.resolveAgentTimeoutMs({ cfg: params.cfg }),
    runId: `${params.runIdPrefix}:${Date.now()}`,
    lane: params.lane,
    extraSystemPrompt:
      params.extraSystemPrompt ??
      "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
    agentDir,
  });

  const text = collectRealtimeVoiceAgentConsultVisibleText(result.payloads ?? []);
  if (!text) {
    const reason = result.meta?.aborted ? "agent run aborted" : "agent returned no speakable text";
    params.logger.warn(`[talk] agent consult produced no answer: ${reason}`);
    return { text: params.fallbackText ?? "I need a moment to verify that before answering." };
  }
  return { text };
}
