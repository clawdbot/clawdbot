// Agent consult runtime starts agent consultation flows from talk sessions.
import { randomUUID } from "node:crypto";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { forkSessionEntryFromParent } from "../auto-reply/reply/session-fork.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { parseSessionThreadInfoFast } from "../config/sessions/thread-info.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeLogger, PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isModelSelectionLocked, ModelSelectionLockedError } from "../sessions/model-overrides.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
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
type RealtimeVoiceAgentConsultContextMode = "isolated" | "fork";

type RealtimeVoiceAgentConsultDeps = {
  randomUUID: typeof randomUUID;
  forkSessionEntryFromParent: typeof forkSessionEntryFromParent;
};

const defaultRealtimeVoiceAgentConsultDeps: RealtimeVoiceAgentConsultDeps = {
  randomUUID,
  forkSessionEntryFromParent,
};

let realtimeVoiceAgentConsultDeps = defaultRealtimeVoiceAgentConsultDeps;

/**
 * Fails closed when a realtime consult would cross a model-selection lock.
 */
export function assertRealtimeVoiceAgentConsultModelSelectionUnlocked(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  agentId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  storePath?: string;
}): void {
  const candidates = new Map<string, { sessionKey: string; storePath: string }>();
  const remember = (sessionKey: string, fallbackAgentId: string, storePath?: string) => {
    const candidateAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId;
    const candidateStorePath =
      storePath ??
      params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, {
        agentId: candidateAgentId,
      });
    candidates.set(`${candidateStorePath}\u0000${sessionKey}`, {
      sessionKey,
      storePath: candidateStorePath,
    });
  };

  remember(params.sessionKey, params.agentId, params.storePath);
  const requesterSessionKey = params.spawnedBy?.trim();
  if (requesterSessionKey) {
    const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId ?? params.agentId;
    remember(requesterSessionKey, requesterAgentId);
    const { baseSessionKey } = parseSessionThreadInfoFast(requesterSessionKey);
    if (baseSessionKey && baseSessionKey !== requesterSessionKey) {
      remember(baseSessionKey, requesterAgentId);
    }
  }

  for (const { sessionKey, storePath } of candidates.values()) {
    const entry = params.agentRuntime.session.getSessionEntry({
      storePath,
      sessionKey,
      readConsistency: "latest",
    });
    // Realtime consults select a configured provider/model and may run fast-context first.
    // Until they preserve native bindings, a locked transcript must never cross runtimes.
    if (isModelSelectionLocked(entry)) {
      throw new ModelSelectionLockedError();
    }
  }
}

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
  cfg: OpenClawConfig;
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

  let patched: SessionEntry | null = null;
  if (shouldFork) {
    const forked = await realtimeVoiceAgentConsultDeps.forkSessionEntryFromParent({
      storePath: params.storePath,
      parentSessionKey: requesterSessionKey,
      agentId: params.agentId,
      config: params.cfg,
      sessionKey: params.sessionKey,
      fallbackEntry: {
        sessionId: "",
        updatedAt: now,
      },
      skipForkWhen: (entry) => Boolean(entry.sessionId?.trim()),
      skipPatch: () => ({ ...deliveryFields, updatedAt: now }),
      patch: () => ({
        ...deliveryFields,
        spawnedBy: requesterSessionKey,
        updatedAt: now,
      }),
    });
    if (forked.status === "forked" || forked.status === "skipped") {
      if (forked.status === "skipped" && forked.decision?.status === "skip") {
        forkDecisionWarning = forked.decision.message;
      }
      if (forked.sessionEntry.sessionId?.trim()) {
        patched = forked.sessionEntry;
      }
    }
  }

  patched ??= await params.agentRuntime.session.patchSessionEntry({
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
  const storePath = params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, {
    agentId,
  });
  const initialSessionEntry = params.agentRuntime.session.getSessionEntry({
    storePath,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const modelLockParams = {
    cfg: params.cfg,
    agentRuntime: params.agentRuntime,
    agentId,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    storePath,
  };
  assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
  const lifecycleAbortController = new AbortController();
  const sessionWorkAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [params.sessionKey, initialSessionEntry?.sessionId],
    onInterrupt: () =>
      lifecycleAbortController.abort(
        new Error("Realtime voice agent consult interrupted by a session lifecycle change."),
      ),
    assertAllowed: () => {
      const currentEntry = params.agentRuntime.session.getSessionEntry({
        storePath,
        sessionKey: params.sessionKey,
        readConsistency: "latest",
      });
      const changed = initialSessionEntry
        ? !currentEntry || currentEntry.sessionId !== initialSessionEntry.sessionId
        : Boolean(currentEntry);
      if (changed) {
        throw new Error(`Session "${params.sessionKey}" changed while starting work. Retry.`);
      }
      const archivedSessionError = resolveSessionWorkStartError(params.sessionKey, currentEntry);
      if (archivedSessionError) {
        throw new Error(archivedSessionError);
      }
      assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
    },
  });

  try {
    return await sessionWorkAdmission.run(async () => {
      await params.agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

      // The consult session stores normal session metadata so subsequent voice turns can keep
      // routing and, in fork mode, recover useful conversation context from the requester.
      const resolvedDeliveryContext = resolveRealtimeVoiceAgentDeliveryContext({
        agentRuntime: params.agentRuntime,
        storePath,
        sessionKey: params.sessionKey,
        spawnedBy: params.spawnedBy,
      });
      const sessionEntry = await resolveRealtimeVoiceAgentConsultSessionEntry({
        agentId,
        cfg: params.cfg,
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
      assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);

      // Voice consults suppress verbose/reasoning output because the bridge needs a short,
      // speakable answer, not agent-run diagnostics or hidden reasoning artifacts.
      const result = await params.agentRuntime.runEmbeddedAgent({
        sessionId,
        sessionKey: params.sessionKey,
        sessionTarget: {
          agentId,
          sessionId,
          sessionKey: params.sessionKey,
          storePath,
        },
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
        timeoutMs:
          params.timeoutMs ?? params.agentRuntime.resolveAgentTimeoutMs({ cfg: params.cfg }),
        runId: `${params.runIdPrefix}:${Date.now()}`,
        lane: params.lane,
        extraSystemPrompt:
          params.extraSystemPrompt ??
          "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
        agentDir,
        abortSignal: lifecycleAbortController.signal,
      });

      const text = collectRealtimeVoiceAgentConsultVisibleText(result.payloads ?? []);
      if (!text) {
        const reason = result.meta?.aborted
          ? "agent run aborted"
          : "agent returned no speakable text";
        params.logger.warn(`[talk] agent consult produced no answer: ${reason}`);
        return { text: params.fallbackText ?? "I need a moment to verify that before answering." };
      }
      return { text };
    });
  } finally {
    sessionWorkAdmission.release();
  }
}
