import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { truncateUtf16Safe } from "../utils.js";
import { persistTranscriptSummary } from "./capture-summary.js";
import { resolveTranscriptsConfig } from "./config.js";
import { manualTranscriptSourceProvider } from "./manual-source.js";
import { getTranscriptSourceProvider } from "./provider-registry.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceLocator,
  TranscriptSourceProvider,
  TranscriptToolAction,
  TranscriptToolCaller,
  TranscriptsStartResult,
} from "./provider-types.js";
import { sanitizeTranscriptSourceLocator } from "./source-locator.js";
import type { TranscriptsStore } from "./store.js";

const ACCOUNT_ID_OUTPUT_MAX_CHARS = 64;

export function formatTranscriptAccountId(accountId: string): string {
  return JSON.stringify(truncateUtf16Safe(accountId, ACCOUNT_ID_OUTPUT_MAX_CHARS));
}

export type TranscriptsLogger = {
  warn: (message: string) => void;
};

export type TranscriptsRuntimeContext = {
  agentId?: string;
  agentChannel?: string;
  agentAccountId?: string;
  caller?: TranscriptToolCaller;
  assertCallerActive?: () => void;
  config?: OpenClawConfig;
  stateDir: string;
  logger: TranscriptsLogger;
};

type ActiveTranscriptsSession = {
  session: TranscriptSessionDescriptor;
  providerId: string;
  // Cleanup belongs to the admitted provider, even after registry replacement.
  provider: Pick<TranscriptSourceProvider, "stop">;
  // Diagnostic request identity, never authority. URLs retain presence only, not invitations.
  configuredSource?: Readonly<
    Pick<TranscriptSourceLocator, "providerId" | "accountId" | "guildId" | "channelId"> & {
      meetingUrl: boolean;
    }
  >;
  // Durable timestamps can collide; lifecycle cleanup must match this exact process-owned capture.
  lifecycleToken?: symbol;
  // Keep the capture reserved until provider and durable stop work both finish.
  stopping?: true;
  // Failed cleanup stays owned and cannot append until a later stop succeeds.
  cleanupPending?: true;
  phase: "starting" | "active" | "terminal" | "failed";
  finalization?: Promise<Awaited<ReturnType<typeof persistTranscriptSummary>>>;
};

// Process-local ownership shared by tool-driven and configured transcript captures.
export const activeSessions = new Map<string, ActiveTranscriptsSession>();

export type TranscriptCaptureSelection = {
  session: TranscriptSessionDescriptor;
  selector: string;
  activeCandidate: ActiveTranscriptsSession | undefined;
  selectedActive: ActiveTranscriptsSession | undefined;
  historicalRevision: string | undefined;
};

export function isTranscriptSelectionCurrent(
  selection: TranscriptCaptureSelection,
  store: TranscriptsStore,
): boolean {
  return (
    activeSessions.get(selection.session.sessionId) === selection.activeCandidate &&
    (selection.selectedActive !== undefined ||
      (selection.historicalRevision !== undefined &&
        store.readSummaryInputRevision(selection.session) === selection.historicalRevision))
  );
}

/** Read-only process facts; a retained stop/cleanup owner does not prove capture is armed. */
export function readTranscriptCaptureSnapshot() {
  return [...activeSessions.values()]
    .filter((entry) => entry.phase !== "terminal" && entry.phase !== "failed")
    .map((entry) => ({
      session: {
        sessionId: entry.session.sessionId,
        startedAt: entry.session.startedAt,
        source: { ...entry.session.source },
      },
      providerId: entry.providerId,
      configuredSource: entry.configuredSource ? { ...entry.configuredSource } : undefined,
      lifecycleToken: entry.lifecycleToken,
      state:
        entry.phase === "active" && !entry.stopping && !entry.cleanupPending
          ? ("armed" as const)
          : ("unknown" as const),
    }));
}

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

const pendingStartRetries = new Set<{
  stateDir: string;
  session: TranscriptSessionDescriptor;
}>();

export function retainTranscriptStartRetry(
  ctx: TranscriptsRuntimeContext,
  retry: NonNullable<TranscriptStartError["retry"]>,
) {
  const owner = { stateDir: ctx.stateDir, session: retry.session };
  pendingStartRetries.add(owner);
  return {
    session: retry.session,
    assertCurrent(store: TranscriptsStore) {
      try {
        if (
          !pendingStartRetries.has(owner) ||
          store.readSummaryInputRevision(retry.session) !== retry.revision
        ) {
          throw new Error("transcript changed or stopped before startup retry");
        }
      } catch (error) {
        throw new TranscriptStartError("id-conflict", error);
      }
    },
    release: () => pendingStartRetries.delete(owner),
  };
}

export function revokeTranscriptStartRetries(
  ctx: TranscriptsRuntimeContext,
  session: TranscriptSessionDescriptor,
) {
  // Repeated historical stop preserves stoppedAt and summary inputs. Revoke
  // pending process authority explicitly instead of rewriting that history.
  for (const owner of pendingStartRetries) {
    if (
      owner.stateDir === ctx.stateDir &&
      owner.session.sessionId === session.sessionId &&
      owner.session.startedAt === session.startedAt
    ) {
      pendingStartRetries.delete(owner);
    }
  }
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

export function resolveSourceProvider(providerId: string, ctx: TranscriptsRuntimeContext) {
  return providerId === manualTranscriptSourceProvider.id
    ? manualTranscriptSourceProvider
    : getTranscriptSourceProvider(providerId, ctx.config);
}

function bindSourceToTurnAccount(params: {
  ctx: TranscriptsRuntimeContext;
  operation: "import" | "start";
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
}): {
  source: TranscriptSourceLocator;
} {
  const ownership = params.provider.accessControl;
  if (!ownership) {
    return { source: params.source };
  }
  if (params.ctx.caller?.kind === "operator") {
    return { source: params.source };
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
    return { source: params.source };
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
  return {
    source: { ...params.source, accountId },
  };
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
}): {
  source: TranscriptSourceLocator;
} {
  const boundSource = bindSourceToTurnAccount(params);
  const ownership = params.provider.accessControl;
  const trustedAccountId =
    ownership && params.ctx.caller?.kind === "channel"
      ? params.ctx.caller.accountId?.trim()
      : undefined;
  const sourceForResolution = trustedAccountId
    ? { ...boundSource.source, accountId: trustedAccountId }
    : boundSource.source;
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
      `transcripts provider ${params.provider.id} could not use trusted account ${formatTranscriptAccountId(trustedAccountId)}`,
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
  const channel = ownership?.channelId;
  if (
    params.configuredLifecycle &&
    !params.ctx.agentId &&
    params.ctx.config &&
    channel &&
    providerSource.channelId
  ) {
    providerSource.agentId = resolveAgentRoute({
      cfg: params.ctx.config,
      channel,
      accountId: providerSource.accountId,
      guildId: providerSource.guildId,
      peer: { kind: "channel", id: providerSource.channelId },
    }).agentId;
  }
  return { source: providerSource };
}

export async function stopTranscriptProviderCapture(params: {
  ctx: TranscriptsRuntimeContext;
  entry: ActiveTranscriptsSession;
  reason: string;
}): Promise<string | undefined> {
  const { entry } = params;
  let error: string | undefined;
  try {
    if (!entry.provider.stop) {
      error = `transcripts provider ${entry.providerId} cannot stop live capture`;
    } else {
      const result = await entry.provider.stop({
        cfg: params.ctx.config,
        sessionId: entry.session.sessionId,
        source: entry.session.source,
        reason: params.reason,
      });
      error = result.ok ? undefined : result.error;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  // Successful stops may drain final utterances. Fence only after failure, and
  // never turn an authoritative terminal notification back into pending cleanup.
  if (
    error !== undefined &&
    activeSessions.get(entry.session.sessionId) === entry &&
    entry.phase !== "terminal"
  ) {
    entry.cleanupPending = true;
  }
  return error;
}

export async function startTranscripts(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
  abortSignal?: AbortSignal;
  startupWaitMs?: number;
  configuredLifecycle?: true;
  lifecycleToken?: symbol;
  existingSession?: TranscriptSessionDescriptor;
  /** Configured capture retains the original choice before supplying its selected ID. */
  sessionIdOrigin?: "generated" | "supplied";
  onCaptureEnded?: () => void;
}) {
  if (params.abortSignal?.aborted) {
    throw new Error("transcripts start aborted");
  }
  const requestedSource = {
    ...sourceFromParams(params.rawParams),
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
  };
  // Capture omissions before account resolution or provider handoff can replace them.
  const configuredSource = params.configuredLifecycle
    ? {
        providerId: requestedSource.providerId,
        accountId: requestedSource.accountId,
        guildId: requestedSource.guildId,
        channelId: requestedSource.channelId,
        meetingUrl: Boolean(requestedSource.meetingUrl),
      }
    : undefined;
  const provider = resolveSourceProvider(requestedSource.providerId, params.ctx);
  if (!provider?.start) {
    throw new Error(`transcripts provider ${requestedSource.providerId} cannot start live capture`);
  }
  const resolvedSource = resolveTranscriptSourceOwnership({
    ctx: params.ctx,
    operation: "start",
    provider,
    source: requestedSource,
    configuredLifecycle: params.configuredLifecycle,
  });
  const providerSource = resolvedSource.source;
  const agentId = params.ctx.agentId ?? providerSource.agentId;
  if (
    params.existingSession &&
    agentId !== undefined &&
    (params.existingSession.metadata?.agentId ?? "main") !== agentId
  ) {
    throw new TranscriptStartError(
      "id-conflict",
      new Error("transcripts capture belongs to a different agent; start a new capture"),
    );
  }
  if (!params.configuredLifecycle) {
    await authorizeTranscriptSource({
      action: "start",
      ctx: params.ctx,
      provider,
      source: providerSource,
    });
  }
  const requestedSessionId = readTranscriptStringParam(params.rawParams, "sessionId", {
    trim: true,
  });
  const session: TranscriptSessionDescriptor = {
    sessionId:
      params.existingSession?.sessionId ?? requestedSessionId ?? createTranscriptSessionId(),
    title: params.existingSession
      ? params.existingSession.title
      : readTranscriptStringParam(params.rawParams, "title", { trim: true }),
    source: params.existingSession?.source ?? sanitizeTranscriptSourceLocator(providerSource),
    startedAt: params.existingSession?.startedAt ?? new Date().toISOString(),
    metadata: params.existingSession
      ? params.existingSession.metadata
      : {
          ...(agentId ? { agentId } : {}),
          sessionIdOrigin:
            params.sessionIdOrigin ?? (requestedSessionId ? "supplied" : "generated"),
        },
  };
  if (activeSessions.has(session.sessionId) || startingSessionIds.has(session.sessionId)) {
    throw new TranscriptStartError(
      "id-conflict",
      new Error(`transcripts session already active: ${session.sessionId}`),
    );
  }
  startingSessionIds.add(session.sessionId);
  const entry: ActiveTranscriptsSession = {
    session,
    providerId: provider.id,
    provider,
    phase: "starting",
    configuredSource,
    lifecycleToken: params.lifecycleToken,
  };
  let admitted = false;
  let retry: TranscriptStartError["retry"];
  const startupAbort = createStartupAbortScope(params.abortSignal);
  try {
    await params.store.writeSession(session);
    admitted = true;
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
      if (!result.ok) {
        throw new Error(result.error);
      }
    } catch (error) {
      entry.phase = "failed";
      throw error;
    }
    // Provider failures retain cleanup ownership; only a successful result can
    // transfer a live capture to this lifecycle for abort/stop retry handling.
    activeSessions.set(session.sessionId, entry);
    // Retries and reopens retain the admitted title, including its absence.
    if (!params.existingSession && !session.title) {
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
          : await stopTranscriptProviderCapture({
              ctx: params.ctx,
              entry,
              reason: "service-stop",
            });
      if (cleanupError !== undefined) {
        throw new Error(`transcripts start aborted; provider cleanup failed: ${cleanupError}`);
      }
      await finalizeTranscriptCapture({ ...params, entry });
      throw new Error("transcripts start aborted");
    }
    if (entry.phase === "terminal") {
      await finalizeTranscriptCapture({ ...params, entry });
      return { status: "ended" as const, session: entry.session };
    }
    entry.phase = "active";
    return { status: "active" as const, session, providerId: provider.id };
  } catch (error) {
    let failure = error;
    try {
      if (
        entry.phase === "starting" &&
        !entry.cleanupPending &&
        activeSessions.get(session.sessionId) === entry
      ) {
        entry.cleanupPending = true;
        const cleanupError = await stopTranscriptProviderCapture({
          ctx: params.ctx,
          entry,
          reason: "startup-failed",
        });
        if (cleanupError !== undefined) {
          throw new Error(
            `transcripts start failed session=${session.sessionId}; provider cleanup failed: ${cleanupError}`,
            { cause: error },
          );
        }
        await finalizeTranscriptCapture({ ...params, entry });
      }
      // Failed reopening must not erase the durable stop time: the next bounded
      // attempt still needs to find this same meeting, not create an empty sibling.
      if (entry.phase === "failed") {
        const restored = params.existingSession ?? {
          ...session,
          stoppedAt: new Date().toISOString(),
        };
        await params.store.writeSession(restored);
        // Authority describes the durable tuple after restoration, including its
        // original stop time. A failed restoration or revision read grants none.
        const revision = params.store.readSummaryInputRevision(restored);
        if (revision !== undefined) {
          retry = { session: restored, revision };
        }
      }
    } catch (cleanupError) {
      failure = cleanupError;
      retry = undefined;
    }
    // Cleanup and restoration failures remain terminal admissions, never authority
    // to start another provider behind retained cleanup or an unrestored tuple.
    throw admitted ? new TranscriptStartError("admitted-start-failed", failure, retry) : failure;
  } finally {
    startupAbort.detach();
    startingSessionIds.delete(session.sessionId);
  }
}

export class TranscriptStartError extends Error {
  constructor(
    readonly code: "id-conflict" | "admitted-start-failed",
    cause: unknown,
    // Only failed provider startup retains an admission that its owning service may retry.
    readonly retry?: { session: TranscriptSessionDescriptor; revision: string },
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TranscriptStartError";
  }
}
