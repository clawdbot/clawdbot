/**
 * transcripts built-in tool.
 *
 * Manages live capture, manual import, summarization, and process-local transcript sessions.
 */
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type ResolvedTranscriptsAutoStartConfig,
  resolveTranscriptsConfig,
} from "../../transcripts/config.js";
import { manualTranscriptSourceProvider } from "../../transcripts/manual-source.js";
import { listTranscriptSourceProviders } from "../../transcripts/provider-registry.js";
import type { TranscriptSessionDescriptor } from "../../transcripts/provider-types.js";
import { TranscriptsStore, type TranscriptsSessionEntry } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import type { AnyAgentTool } from "./common.js";
import {
  activeSessions,
  createSessionId,
  readStringParam,
  resolveSourceProvider,
  sourceFromParams,
  startTranscripts,
  stopPendingTranscriptCapture,
  toolText,
  type TranscriptsLogger,
  type TranscriptsRuntimeContext,
} from "./transcripts-tool-runtime.js";
const AUTO_START_RETRY_ATTEMPTS = 12;
const AUTO_START_RETRY_MS = 5_000;
const AUTO_START_STOP_TIMEOUT_MS = 5_000;
const AUTO_START_PROVIDER_READY_TIMEOUT_MS = 30_000;

function sameSessionIdentity(
  left: TranscriptSessionDescriptor,
  right: TranscriptSessionDescriptor,
): boolean {
  return left.sessionId === right.sessionId && left.startedAt === right.startedAt;
}

function asParamsRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

const TranscriptsSchema = Type.Object(
  {
    action: Type.String({
      description: "start, stop, status, import, or summarize.",
    }),
    sessionId: Type.Optional(Type.String({ minLength: 1 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
    providerId: Type.Optional(Type.String({ minLength: 1 })),
    accountId: Type.Optional(Type.String({ minLength: 1 })),
    guildId: Type.Optional(Type.String({ minLength: 1 })),
    channelId: Type.Optional(Type.String({ minLength: 1 })),
    meetingUrl: Type.Optional(Type.String({ minLength: 1 })),
    transcript: Type.Optional(Type.String({ minLength: 1 })),
    speakerLabel: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

function createStore(ctx: TranscriptsRuntimeContext): TranscriptsStore {
  return new TranscriptsStore(path.join(ctx.stateDir, "transcripts"));
}

async function waitForPendingAutoStartsToSettle(
  pendingStarts: Set<Promise<void>>,
): Promise<boolean> {
  if (pendingStarts.size === 0) {
    return true;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(pendingStarts).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), AUTO_START_STOP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

// Summaries are persisted beside the session so stop/import/summarize actions
// return both model-readable details and a durable artifact path.
async function summarizeAndPersist(params: {
  config: ReturnType<typeof resolveTranscriptsConfig>;
  store: TranscriptsStore;
  session: TranscriptSessionDescriptor;
  sessionDir?: string;
}) {
  const utterances =
    params.sessionDir !== undefined
      ? await params.store.readUtterancesFromSessionDir(params.sessionDir, {
          maxUtterances: params.config.maxUtterances,
        })
      : await params.store.readUtterancesForSession(params.session, {
          maxUtterances: params.config.maxUtterances,
        });
  const summary = summarizeTranscripts({ session: params.session, utterances });
  const summaryPath =
    params.sessionDir !== undefined
      ? await params.store.writeSummaryToDir(summary, params.sessionDir)
      : await params.store.writeSummary(summary, params.session);
  return { summary, summaryPath };
}

async function stopTranscripts(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
}) {
  const sessionSelector = readStringParam(params.rawParams, "sessionId", {
    required: true,
    trim: true,
  });
  const directActive = activeSessions.get(sessionSelector);
  const resolvedEntry: TranscriptsSessionEntry | undefined = directActive
    ? { session: directActive.session, sessionDir: params.store.sessionDir(directActive.session) }
    : await params.store.readSessionEntry(sessionSelector);
  const resolvedSession = resolvedEntry?.session;
  const activeCandidate =
    resolvedSession !== undefined ? activeSessions.get(resolvedSession.sessionId) : undefined;
  const activeMatchesResolved =
    activeCandidate !== undefined &&
    resolvedSession !== undefined &&
    sameSessionIdentity(activeCandidate.session, resolvedSession);
  const selectedActive = directActive ?? (activeMatchesResolved ? activeCandidate : undefined);
  const session = selectedActive?.session ?? resolvedSession;
  if (!session) {
    throw new Error(`transcripts session not found: ${sessionSelector}`);
  }
  const sessionId = session.sessionId;
  const providerId = selectedActive?.providerId ?? session.source.providerId;
  const provider = resolveSourceProvider(providerId, params.ctx);
  let providerStopError: string | undefined;
  if (selectedActive?.cleanupPending) {
    providerStopError = await stopPendingTranscriptCapture({
      ctx: params.ctx,
      provider,
      session,
      reason: "tool-stop",
    });
    if (providerStopError) {
      throw new Error(`transcripts provider cleanup failed: ${providerStopError}`);
    }
  } else if (selectedActive && provider?.stop) {
    const result = await provider.stop({
      cfg: params.ctx.config,
      sessionId,
      source: session.source,
      reason: "tool-stop",
    });
    if (!result.ok) {
      providerStopError = result.error;
    }
  }
  const stoppedAt = new Date().toISOString();
  if (selectedActive) {
    activeSessions.delete(sessionId);
  }
  const stoppedSession: TranscriptSessionDescriptor = {
    ...session,
    stoppedAt,
    ...(providerStopError
      ? {
          metadata: {
            ...session.metadata,
            providerStopError,
            providerStopFailedAt: stoppedAt,
          },
        }
      : {}),
  };
  if (selectedActive) {
    await params.store.writeSession(stoppedSession);
  } else {
    await params.store.updateStopped(sessionSelector, stoppedAt);
  }
  const { summaryPath, summary } = await summarizeAndPersist({
    config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
    store: params.store,
    session: stoppedSession,
    sessionDir: selectedActive ? undefined : resolvedEntry?.sessionDir,
  });
  return toolText(`Transcripts stopped: ${sessionId}\nSummary: ${summaryPath}`, {
    sessionId,
    ...(providerStopError ? { providerStopError } : {}),
    summary,
    summaryPath,
  });
}

async function importTranscripts(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
}) {
  const source = sourceFromParams(params.rawParams);
  const provider = resolveSourceProvider(source.providerId, params.ctx);
  if (!provider?.importTranscript) {
    throw new Error(`transcripts provider ${source.providerId} cannot import transcripts`);
  }
  const session: TranscriptSessionDescriptor = {
    sessionId: readStringParam(params.rawParams, "sessionId", { trim: true }) ?? createSessionId(),
    title: readStringParam(params.rawParams, "title", { trim: true }),
    source,
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
  };
  const transcript = readStringParam(params.rawParams, "transcript", {
    required: true,
    trim: false,
  });
  await params.store.writeSession(session);
  const utterances = await provider.importTranscript({
    cfg: params.ctx.config,
    session,
    text: transcript,
    speakerLabel: readStringParam(params.rawParams, "speakerLabel", { trim: true }),
  });
  for (const utterance of utterances) {
    await params.store.appendUtteranceForSession(session, utterance);
  }
  const { summaryPath, summary } = await summarizeAndPersist({
    config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
    store: params.store,
    session,
  });
  return toolText(`Transcript imported: ${session.sessionId}\nSummary: ${summaryPath}`, {
    sessionId: session.sessionId,
    utteranceCount: utterances.length,
    summary,
    summaryPath,
  });
}

async function summarizeExisting(params: {
  config: ReturnType<typeof resolveTranscriptsConfig>;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
}) {
  const sessionId = readStringParam(params.rawParams, "sessionId", {
    required: true,
    trim: true,
  });
  const entry = await params.store.readSessionEntry(sessionId);
  if (!entry) {
    throw new Error(`transcripts session not found: ${sessionId}`);
  }
  const { summaryPath, summary } = await summarizeAndPersist({
    config: params.config,
    store: params.store,
    session: entry.session,
    sessionDir: entry.sessionDir,
  });
  return toolText(`Transcripts summarized: ${sessionId}\nSummary: ${summaryPath}`, {
    sessionId,
    summary,
    summaryPath,
  });
}

async function statusTranscripts(ctx: TranscriptsRuntimeContext) {
  const providers = [
    manualTranscriptSourceProvider.id,
    ...listTranscriptSourceProviders(ctx.config).map((provider) => provider.id),
  ];
  const uniqueProviders = uniqueStrings(providers);
  const active = [...activeSessions.values()].map((entry) => ({
    sessionId: entry.session.sessionId,
    providerId: entry.providerId,
    title: entry.session.title,
    source: entry.session.source,
    cleanupPending: entry.cleanupPending === true,
  }));
  return toolText(
    [
      `Transcripts providers: ${uniqueProviders.length ? uniqueProviders.join(", ") : "none"}`,
      `Active sessions: ${active.length}`,
    ].join("\n"),
    { providers: uniqueProviders, active },
  );
}

/** Create the agent-facing transcripts tool. */
export function createTranscriptsTool(options?: {
  config?: OpenClawConfig;
  stateDir?: string;
  logger?: TranscriptsLogger;
}): AnyAgentTool {
  const ctx: TranscriptsRuntimeContext = {
    config: options?.config,
    stateDir: options?.stateDir ?? resolveStateDir(),
    logger: options?.logger ?? console,
  };
  return {
    name: "transcripts",
    label: "Transcripts",
    description:
      "Start/stop/import/summarize/status meeting transcripts: Discord, Google Meet, Slack huddles, others.",
    parameters: TranscriptsSchema,
    async execute(_toolCallId, rawParams, signal) {
      const config = resolveTranscriptsConfig(ctx.config?.transcripts);
      if (!config.enabled) {
        throw new Error("transcripts are disabled");
      }
      const params = asParamsRecord(rawParams);
      const action = readStringParam(params, "action", { required: true, trim: true });
      const store = createStore(ctx);
      switch (action) {
        case "start":
          return await startTranscripts({ ctx, store, rawParams: params, abortSignal: signal });
        case "stop":
          return await stopTranscripts({ ctx, store, rawParams: params });
        case "import":
          return await importTranscripts({ ctx, store, rawParams: params });
        case "summarize":
          return await summarizeExisting({ config, store, rawParams: params });
        case "status":
          return await statusTranscripts(ctx);
        default:
          throw new Error(`unsupported transcripts action: ${action}`);
      }
    },
  };
}

/** Create the process lifecycle service that starts configured transcript captures. */
export function createTranscriptsAutoStartService(ctx: TranscriptsRuntimeContext): {
  start: () => void;
  stop: () => Promise<void>;
} {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const startedSessionIds = new Set<string>();
  const pendingStartControllers = new Set<AbortController>();
  const pendingStarts = new Set<Promise<void>>();

  // Auto-start is retrying and stoppable; each scheduled timer is tracked so a
  // gateway shutdown can cancel retries before stopping any started sessions.
  const schedule = (run: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, delayMs);
    timers.add(timer);
  };

  const startEntry = (
    entry: ResolvedTranscriptsAutoStartConfig,
    attempt: number,
    store: TranscriptsStore,
  ) => {
    if (stopped || startedSessionIds.has(entry.sessionId ?? "")) {
      return;
    }
    const abortController = new AbortController();
    pendingStartControllers.add(abortController);
    const startTask = startTranscripts({
      ctx,
      store,
      abortSignal: abortController.signal,
      startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
      rawParams: {
        action: "start",
        ...entry,
        sessionId: entry.sessionId ?? createSessionId(),
      },
    })
      .then((result) => {
        const sessionId = result.details?.sessionId;
        if (typeof sessionId === "string") {
          startedSessionIds.add(sessionId);
        }
      })
      .catch((err: unknown) => {
        if (stopped) {
          return;
        }
        if (attempt >= AUTO_START_RETRY_ATTEMPTS) {
          ctx.logger.warn(
            `transcripts autoStart failed provider=${entry.providerId}: ${
              err instanceof Error ? err.message : String(err)
            } (check the transcripts.autoStart entry in your config)`,
          );
          return;
        }
        schedule(() => startEntry(entry, attempt + 1, store), AUTO_START_RETRY_MS);
      })
      .finally(() => {
        pendingStartControllers.delete(abortController);
        pendingStarts.delete(startTask);
      });
    pendingStarts.add(startTask);
  };

  return {
    start() {
      const config = resolveTranscriptsConfig(ctx.config?.transcripts);
      if (!config.enabled || config.autoStart.length === 0) {
        return;
      }
      const store = new TranscriptsStore(path.join(ctx.stateDir, "transcripts"));
      for (const entry of config.autoStart) {
        startEntry(
          {
            ...entry,
            sessionId: entry.sessionId ?? createSessionId(),
          },
          1,
          store,
        );
      }
    },
    async stop() {
      stopped = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      for (const controller of pendingStartControllers) {
        controller.abort();
      }
      const pendingStartsSettled = await waitForPendingAutoStartsToSettle(pendingStarts);
      if (!pendingStartsSettled) {
        ctx.logger.warn(
          `transcripts autoStart stop timed out waiting for ${pendingStarts.size} pending start${
            pendingStarts.size === 1 ? "" : "s"
          }`,
        );
      }
      const store = new TranscriptsStore(path.join(ctx.stateDir, "transcripts"));
      for (const sessionId of startedSessionIds) {
        await stopTranscripts({
          ctx,
          store,
          rawParams: { action: "stop", sessionId },
        }).catch((err: unknown) =>
          ctx.logger.warn(
            `transcripts autoStart stop failed session=${sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
      startedSessionIds.clear();
    },
  };
}
