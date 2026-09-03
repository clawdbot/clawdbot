import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTranscriptsConfig } from "../../transcripts/config.js";
import { manualTranscriptSourceProvider } from "../../transcripts/manual-source.js";
import { getTranscriptSourceProvider } from "../../transcripts/provider-registry.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceLocator,
  TranscriptSourceProvider,
  TranscriptToolAction,
  TranscriptToolCaller,
  TranscriptsStartResult,
} from "../../transcripts/provider-types.js";
import { sanitizeTranscriptSourceLocator } from "../../transcripts/source-locator.js";
import { transcriptSessionSelector } from "../../transcripts/store-artifacts.js";
import type { TranscriptsStore } from "../../transcripts/store.js";
import { persistTranscriptSummary } from "../../transcripts/summary-persistence.js";
import { truncateUtf16Safe } from "../../utils.js";

const ACCOUNT_ID_OUTPUT_MAX_CHARS = 64;

function formatAccountIdForToolText(accountId: string): string {
  return JSON.stringify(truncateUtf16Safe(accountId, ACCOUNT_ID_OUTPUT_MAX_CHARS));
}

export type TranscriptsLogger = {
  warn: (message: string) => void;
};

export type TranscriptsRuntimeContext = {
  agentId?: string;
  caller?: TranscriptToolCaller;
  assertCallerActive?: () => void;
  config?: OpenClawConfig;
  stateDir: string;
  logger: TranscriptsLogger;
};

export type TranscriptsStartCandidate = {
  session?: TranscriptSessionDescriptor;
  discardable?: true;
};

type ActiveTranscriptsSession = {
  session: TranscriptSessionDescriptor;
  providerId: string;
  // Durable timestamps can collide; lifecycle cleanup must match this exact process-owned capture.
  lifecycleToken?: symbol;
  // Keep the capture reserved until provider and durable stop work both finish.
  stopping?: true;
  // Aborted starts stay active until a later stop confirms provider cleanup.
  cleanupPending?: true;
  phase: "starting" | "active" | "terminal" | "failed";
  finalization?: Promise<Awaited<ReturnType<typeof persistTranscriptSummary>>>;
};

// Process-local ownership shared by tool-driven and configured transcript captures.
export const activeSessions = new Map<string, ActiveTranscriptsSession>();

export function isTranscriptSessionActive(
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
): boolean {
  const entry = activeSessions.get(session.sessionId);
  return entry?.session.startedAt === session.startedAt && entry.phase !== "terminal";
}
// Reserve ids across async provider startup so overlapping starts cannot
// replace the only cleanup owner for an existing or still-starting capture.
const startingSessionIds = new Set<string>();

export function isTranscriptSessionStarting(sessionId: string): boolean {
  return startingSessionIds.has(sessionId);
}

// Retain the exact owner on failure so stop can retry persistence without touching
// the provider again. A stop in flight keeps its reservation until it settles.
export function finalizeTranscriptCapture(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  entry: ActiveTranscriptsSession;
}) {
  const { entry } = params;
  entry.phase = "terminal";
  entry.session = {
    ...entry.session,
    stoppedAt: entry.session.stoppedAt ?? new Date().toISOString(),
  };
  entry.finalization ??= (async () => {
    await params.store.writeSession(entry.session);
    return await persistTranscriptSummary({
      config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
      cfg: params.ctx.config,
      store: params.store,
      session: entry.session,
    });
  })()
    .then((result) => {
      if (!entry.stopping && activeSessions.get(entry.session.sessionId) === entry) {
        activeSessions.delete(entry.session.sessionId);
      }
      return result;
    })
    .catch((error: unknown) => {
      delete entry.finalization;
      params.ctx.logger.warn(
        `transcripts finalization failed session=${entry.session.sessionId}; capture ended, use transcripts stop to retry: ${String(error)}`,
      );
      throw error;
    });
  return entry.finalization;
}

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

export function readTranscriptStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; trim?: boolean },
): string;
export function readTranscriptStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: false; trim?: boolean },
): string | undefined;
export function readTranscriptStringParam(
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

export function createTranscriptSessionId(): string {
  return `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

// Provider routing comes from tool params so manual imports and live providers
// share one persisted source descriptor.
export function sourceFromParams(params: Record<string, unknown>): TranscriptSourceLocator {
  const providerId =
    readTranscriptStringParam(params, "providerId", { trim: true }) ?? "manual-transcript";
  return {
    providerId,
    accountId: readTranscriptStringParam(params, "accountId", { trim: true }),
    guildId: readTranscriptStringParam(params, "guildId", { trim: true }),
    channelId: readTranscriptStringParam(params, "channelId", { trim: true }),
    meetingUrl: readTranscriptStringParam(params, "meetingUrl", { trim: true }),
  };
}

export function resolveSourceProvider(providerId: string, config?: OpenClawConfig) {
  return providerId === manualTranscriptSourceProvider.id
    ? manualTranscriptSourceProvider
    : getTranscriptSourceProvider(providerId, config);
}

function bindSourceToTurnAccount(params: {
  ctx: TranscriptsRuntimeContext;
  operation: "import" | "start";
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
}): TranscriptSourceLocator {
  const ownership = params.provider.accessControl;
  if (!ownership) {
    return params.source;
  }
  if (params.ctx.caller?.kind === "operator") {
    return params.source;
  }
  const ownerChannel = ownership.channelId.trim().toLowerCase();
  if (!ownerChannel) {
    throw new Error(
      `transcripts provider ${params.provider.id} has an invalid account owner channel`,
    );
  }
  const channel = params.ctx.caller?.channel?.trim().toLowerCase();
  const accountId = params.ctx.caller?.accountId?.trim();
  if (!channel) {
    return params.source;
  }
  if (channel !== ownerChannel) {
    throw new Error(
      `transcripts provider ${params.provider.id} can only ${params.operation} from ${ownerChannel} or a channel-less local tool`,
    );
  }
  if (!accountId) {
    throw new Error(
      `transcripts provider ${params.provider.id} requires trusted account context from ${channel}`,
    );
  }
  // Same-channel capture stays on the trusted inbound account; model input
  // cannot redirect or later control another configured channel account.
  return { ...params.source, accountId };
}

export async function authorizeTranscriptSource(params: {
  action: TranscriptToolAction;
  ctx: TranscriptsRuntimeContext;
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
}): Promise<void> {
  params.ctx.assertCallerActive?.();
  const ownership = params.provider.accessControl;
  if (!ownership) {
    return;
  }
  const caller = params.ctx.caller;
  if (!caller) {
    throw new Error("transcripts caller authorization is unavailable");
  }
  const authorization = await ownership.authorize({
    action: params.action,
    caller,
    cfg: params.ctx.config,
    source: params.source,
  });
  params.ctx.assertCallerActive?.();
  if (!authorization.ok) {
    throw new Error(authorization.error);
  }
}

export function resolveTranscriptSourceOwnership(params: {
  ctx: TranscriptsRuntimeContext;
  operation: "import" | "start";
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
  configuredLifecycle?: boolean;
}): TranscriptSourceLocator {
  const boundSource = bindSourceToTurnAccount(params);
  const ownership = params.provider.accessControl;
  const trustedAccountId =
    ownership && params.ctx.caller?.kind === "channel"
      ? params.ctx.caller.accountId?.trim()
      : undefined;
  const sourceForResolution = trustedAccountId
    ? { ...boundSource, accountId: trustedAccountId }
    : boundSource;
  const accountResolution = ownership?.resolveAccountId({
    cfg: params.ctx.config,
    source: sourceForResolution,
  });
  if (accountResolution && !accountResolution.ok) {
    throw new Error(accountResolution.error);
  }
  const resolvedAccountId = accountResolution
    ? accountResolution.value?.trim()
    : sourceForResolution.accountId?.trim();
  if (trustedAccountId && resolvedAccountId !== trustedAccountId) {
    throw new Error(
      `transcripts provider ${params.provider.id} could not use trusted account ${formatAccountIdForToolText(trustedAccountId)}`,
    );
  }
  const providerSource = ownership
    ? { ...sourceForResolution, accountId: resolvedAccountId }
    : sourceForResolution;
  if (params.configuredLifecycle && ownership && !providerSource.accountId?.trim()) {
    throw new Error(
      `transcripts provider ${params.provider.id} could not resolve an account for configured auto-start`,
    );
  }
  return providerSource;
}

export function toolText(text: string, details?: Record<string, unknown> & { selector?: string }) {
  return {
    content: [
      {
        type: "text" as const,
        text: details?.selector ? `${text}\nSelector: ${details.selector}` : text,
      },
    ],
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
  configuredLifecycle?: true;
  lifecycleToken?: symbol;
  candidate?: TranscriptsStartCandidate;
  onCaptureEnded?: () => void;
}) {
  if (params.abortSignal?.aborted) {
    throw new Error("transcripts start aborted");
  }
  const requestedSource = {
    ...sourceFromParams(params.rawParams),
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
  };
  const provider = resolveSourceProvider(requestedSource.providerId, params.ctx.config);
  if (!provider?.start) {
    throw new Error(`transcripts provider ${requestedSource.providerId} cannot start live capture`);
  }
  const providerSource = resolveTranscriptSourceOwnership({
    ctx: params.ctx,
    operation: "start",
    provider,
    source: requestedSource,
    configuredLifecycle: params.configuredLifecycle,
  });
  if (!params.configuredLifecycle) {
    await authorizeTranscriptSource({
      action: "start",
      ctx: params.ctx,
      provider,
      source: providerSource,
    });
  }
  const previousSession = params.candidate?.session;
  const session: TranscriptSessionDescriptor = {
    sessionId:
      previousSession?.sessionId ??
      readTranscriptStringParam(params.rawParams, "sessionId", { trim: true }) ??
      createTranscriptSessionId(),
    title:
      readTranscriptStringParam(params.rawParams, "title", { trim: true }) ??
      previousSession?.title,
    source: sanitizeTranscriptSourceLocator(providerSource),
    startedAt: previousSession?.startedAt ?? new Date().toISOString(),
    metadata: {
      ...previousSession?.metadata,
      ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
    },
  };
  if (activeSessions.has(session.sessionId) || startingSessionIds.has(session.sessionId)) {
    throw new Error(`transcripts session already active: ${session.sessionId}`);
  }
  startingSessionIds.add(session.sessionId);
  const entry: ActiveTranscriptsSession = {
    session,
    providerId: provider.id,
    phase: "starting",
    lifecycleToken: params.lifecycleToken,
  };
  const startupAbort = createStartupAbortScope(params.abortSignal);
  try {
    const inserted = await params.store.writeSession(session);
    if (params.candidate) {
      params.candidate.session = session;
      if (inserted) {
        params.candidate.discardable = true;
      }
    }
    let result: TranscriptsStartResult;
    try {
      result = await provider.start({
        cfg: params.ctx.config,
        session: { ...session, source: { ...providerSource }, metadata: { ...session.metadata } },
        abortSignal: startupAbort.signal,
        startupWaitMs: params.startupWaitMs,
        onUtterance: async (utterance) => {
          // Abort, retirement, and id reuse fence this callback before any durable append.
          if (
            entry.phase === "terminal" ||
            entry.phase === "failed" ||
            entry.cleanupPending ||
            (entry.phase === "starting"
              ? startupAbort.signal?.aborted
              : activeSessions.get(session.sessionId) !== entry)
          ) {
            return;
          }
          await params.store.appendUtteranceForSession(session, utterance);
        },
        onStatus: async (status) => {
          // Payload ids/source are descriptive, never authority over another capture.
          if (status.active || entry.phase === "failed" || entry.phase === "terminal") {
            return;
          }
          if (entry.phase !== "starting" && activeSessions.get(session.sessionId) !== entry) {
            return;
          }
          entry.phase = "terminal";
          entry.session = { ...session, stoppedAt: new Date().toISOString() };
          // Awaiting start here would deadlock providers that notify inline.
          if (activeSessions.get(session.sessionId) === entry) {
            try {
              await finalizeTranscriptCapture({ ...params, entry });
            } finally {
              if (!entry.stopping) {
                params.onCaptureEnded?.();
              }
            }
          }
        },
      });
    } catch (error) {
      entry.phase = "failed";
      throw error;
    }
    // Provider failures retain cleanup ownership; only a successful result can
    // transfer a live capture to this lifecycle for abort/stop retry handling.
    if (!result.ok) {
      entry.phase = "failed";
      throw new Error(result.error);
    }
    // Accepted capture is a real meeting even when it ends without any speech.
    if (params.candidate) {
      delete params.candidate.discardable;
    }
    activeSessions.set(session.sessionId, entry);
    if (!session.title) {
      const title = truncateUtf16Safe(result.session.title?.trim() ?? "", 120);
      if (title) {
        session.title = title;
        entry.session = { ...entry.session, title };
        await params.store.writeSession(entry.session);
      }
    }
    if (startupAbort.signal?.aborted) {
      entry.cleanupPending = true;
      const cleanupError =
        entry.phase === "terminal"
          ? undefined
          : await stopPendingTranscriptCapture({
              ctx: params.ctx,
              provider,
              session,
              reason: "service-stop",
            });
      if (cleanupError) {
        throw new Error(`transcripts start aborted; provider cleanup failed: ${cleanupError}`);
      }
      await finalizeTranscriptCapture({ ...params, entry });
      throw new Error("transcripts start aborted");
    }
    if (entry.phase === "terminal") {
      await finalizeTranscriptCapture({ ...params, entry });
      return toolText(`Transcripts ended during startup: ${session.sessionId}`, {
        sessionId: session.sessionId,
        selector: transcriptSessionSelector(session),
        active: false,
        stoppedAt: entry.session.stoppedAt,
      });
    }
    entry.phase = "active";
    const effectiveAccount = session.source.accountId;
    return toolText(
      `Transcripts started: ${session.sessionId}${effectiveAccount ? `\nAccount: ${formatAccountIdForToolText(effectiveAccount)}` : ""}`,
      {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        selector: transcriptSessionSelector(session),
        providerId: provider.id,
        ...(effectiveAccount ? { accountId: effectiveAccount } : {}),
      },
    );
  } catch (error) {
    if (
      entry.phase === "starting" &&
      !entry.cleanupPending &&
      activeSessions.get(session.sessionId) === entry
    ) {
      entry.cleanupPending = true;
      const cleanupError = await stopPendingTranscriptCapture({
        ctx: params.ctx,
        provider,
        session,
        reason: "startup-failed",
      });
      if (cleanupError) {
        throw new Error(
          `transcripts start failed session=${session.sessionId}; provider cleanup failed: ${cleanupError}`,
          { cause: error },
        );
      }
      await finalizeTranscriptCapture({ ...params, entry });
    }
    // Retain one tuple through retries and preserve the stop time of reopened history.
    if (entry.phase === "failed" && params.candidate) {
      const stopped = {
        ...(previousSession ?? session),
        stoppedAt: previousSession?.stoppedAt ?? new Date().toISOString(),
      };
      await params.store.writeSession(stopped);
      params.candidate.session = stopped;
    }
    throw error;
  } finally {
    startupAbort.detach();
    startingSessionIds.delete(session.sessionId);
  }
}
