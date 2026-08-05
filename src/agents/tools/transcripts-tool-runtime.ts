import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { manualTranscriptSourceProvider } from "../../transcripts/manual-source.js";
import { getTranscriptSourceProvider } from "../../transcripts/provider-registry.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceLocator,
  TranscriptSourceProvider,
  TranscriptsStartResult,
} from "../../transcripts/provider-types.js";
import { sanitizeTranscriptSourceLocator } from "../../transcripts/source-locator.js";
import type { TranscriptsStore } from "../../transcripts/store.js";

export type TranscriptsLogger = {
  warn: (message: string) => void;
};

export type TranscriptsRuntimeContext = {
  agentId?: string;
  config?: OpenClawConfig;
  stateDir: string;
  logger: TranscriptsLogger;
};

type ActiveTranscriptsSession = {
  session: TranscriptSessionDescriptor;
  providerId: string;
  // Aborted starts stay active until a later stop confirms provider cleanup.
  cleanupPending?: true;
};

// Process-local ownership shared by tool-driven and configured transcript captures.
export const activeSessions = new Map<string, ActiveTranscriptsSession>();
// Reserve ids across async provider startup so overlapping starts cannot
// replace the only cleanup owner for an existing or still-starting capture.
const startingSessionIds = new Set<string>();

function createStartupAbortScope(parent?: AbortSignal): {
  signal?: AbortSignal;
  detach: () => void;
} {
  if (!parent) {
    return { signal: undefined, detach: () => {} };
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) {
    abortFromParent();
  } else {
    parent.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    // Provider startup owns this scoped signal only until start settles.
    // Detaching prevents a later agent-run abort from ending live capture.
    detach: () => parent.removeEventListener("abort", abortFromParent),
  };
}

export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; trim?: boolean },
): string;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: false; trim?: boolean },
): string | undefined;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    if (options.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  const normalized = options.trim === false ? value : value.trim();
  if (!normalized && options.required) {
    throw new Error(`${key} required`);
  }
  return normalized || undefined;
}

export function createSessionId(): string {
  return `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

// Provider routing comes from tool params so manual imports and live providers
// share one persisted source descriptor.
export function sourceFromParams(params: Record<string, unknown>): TranscriptSourceLocator {
  const providerId = readStringParam(params, "providerId", { trim: true }) ?? "manual-transcript";
  return {
    providerId,
    accountId: readStringParam(params, "accountId", { trim: true }),
    guildId: readStringParam(params, "guildId", { trim: true }),
    channelId: readStringParam(params, "channelId", { trim: true }),
    meetingUrl: readStringParam(params, "meetingUrl", { trim: true }),
  };
}

export function resolveSourceProvider(providerId: string, ctx: TranscriptsRuntimeContext) {
  return providerId === manualTranscriptSourceProvider.id
    ? manualTranscriptSourceProvider
    : getTranscriptSourceProvider(providerId, ctx.config);
}

export function toolText(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

export async function stopPendingTranscriptCapture(params: {
  ctx: TranscriptsRuntimeContext;
  provider: TranscriptSourceProvider | undefined;
  session: TranscriptSessionDescriptor;
  reason: string;
}): Promise<string | undefined> {
  if (!params.provider?.stop) {
    return `transcripts provider ${params.session.source.providerId} cannot stop live capture`;
  }
  try {
    const result = await params.provider.stop({
      cfg: params.ctx.config,
      sessionId: params.session.sessionId,
      source: params.session.source,
      reason: params.reason,
    });
    return result.ok ? undefined : result.error;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function startTranscripts(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
  abortSignal?: AbortSignal;
  startupWaitMs?: number;
}) {
  if (params.abortSignal?.aborted) {
    throw new Error("transcripts start aborted");
  }
  const providerSource = {
    ...sourceFromParams(params.rawParams),
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
  };
  const provider = resolveSourceProvider(providerSource.providerId, params.ctx);
  if (!provider?.start) {
    throw new Error(`transcripts provider ${providerSource.providerId} cannot start live capture`);
  }
  const session: TranscriptSessionDescriptor = {
    sessionId: readStringParam(params.rawParams, "sessionId", { trim: true }) ?? createSessionId(),
    title: readStringParam(params.rawParams, "title", { trim: true }),
    source: sanitizeTranscriptSourceLocator(providerSource),
    startedAt: new Date().toISOString(),
    ...(params.ctx.agentId ? { metadata: { agentId: params.ctx.agentId } } : {}),
  };
  if (activeSessions.has(session.sessionId) || startingSessionIds.has(session.sessionId)) {
    throw new Error(`transcripts session already active: ${session.sessionId}`);
  }
  startingSessionIds.add(session.sessionId);
  try {
    await params.store.writeSession(session);
    let startupPending = true;
    const startupAbort = createStartupAbortScope(params.abortSignal);
    let result: TranscriptsStartResult;
    try {
      result = await provider.start({
        cfg: params.ctx.config,
        session: { ...session, source: providerSource },
        abortSignal: startupAbort.signal,
        startupWaitMs: params.startupWaitMs,
        onUtterance: async (utterance) => {
          // Provider callbacks can race abort cleanup; never persist that late startup audio.
          if (startupPending && startupAbort.signal?.aborted) {
            return;
          }
          await params.store.appendUtteranceForSession(session, utterance);
        },
      });
    } finally {
      startupAbort.detach();
    }
    // Provider failures retain cleanup ownership; only a successful result can
    // transfer a live capture to this lifecycle for abort/stop retry handling.
    if (!result.ok) {
      throw new Error(result.error);
    }
    if (startupAbort.signal?.aborted) {
      const cleanupError = await stopPendingTranscriptCapture({
        ctx: params.ctx,
        provider,
        session,
        reason: "service-stop",
      });
      if (cleanupError) {
        activeSessions.set(session.sessionId, {
          session,
          providerId: provider.id,
          cleanupPending: true,
        });
        throw new Error(`transcripts start aborted; provider cleanup failed: ${cleanupError}`);
      }
      throw new Error("transcripts start aborted");
    }
    startupPending = false;
    activeSessions.set(session.sessionId, { session, providerId: provider.id });
    return toolText(`Transcripts started: ${session.sessionId}`, {
      sessionId: session.sessionId,
      providerId: provider.id,
    });
  } finally {
    startingSessionIds.delete(session.sessionId);
  }
}
