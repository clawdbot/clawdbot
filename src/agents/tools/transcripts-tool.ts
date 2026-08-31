/**
 * transcripts built-in tool.
 *
 * Manages live capture, manual import, summarization, and process-local transcript sessions.
 */
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  type ResolvedTranscriptsAutoStartConfig,
  resolveTranscriptsConfig,
} from "../../transcripts/config.js";
import { manualTranscriptSourceProvider } from "../../transcripts/manual-source.js";
import { listTranscriptSourceProviders } from "../../transcripts/provider-registry.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptToolCaller,
} from "../../transcripts/provider-types.js";
import { sanitizeTranscriptSourceLocator } from "../../transcripts/source-locator.js";
import { TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { AnyAgentTool } from "./common.js";
import {
  activeSessions,
  authorizeTranscriptSource,
  createTranscriptSessionId,
  finalizeTranscriptCapture,
  isTranscriptSessionStarting,
  persistTranscriptSummary,
  readTranscriptStringParam,
  readTranscriptSummary,
  resolveTranscriptSourceOwnership,
  resolveSourceProvider,
  sourceFromParams,
  startTranscripts,
  stopPendingTranscriptCapture,
  toolText,
  type TranscriptsLogger,
  type TranscriptsRuntimeContext,
} from "./transcripts-tool-runtime.js";
import {
  canAccessTranscriptSession,
  isTranscriptSelectionCurrent,
  resolveTranscriptToolSession,
  transcriptSelectionNoLongerActive,
} from "./transcripts-tool-selection.js";
const AUTO_START_RETRY_ATTEMPTS = 12;
const AUTO_START_RETRY_MS = 5_000;
const AUTO_START_STOP_TIMEOUT_MS = 5_000;
const AUTO_START_PROVIDER_READY_TIMEOUT_MS = 30_000;
const STATUS_SELECTOR_LIMIT = 3;

function formatAutoStopDiagnostic(value: unknown): string {
  return JSON.stringify(truncateUtf16Safe(sanitizeTerminalText(formatErrorMessage(value)), 300));
}

const TranscriptsSchema = Type.Object(
  {
    action: Type.String({
      description: "start, stop, status, import, or summarize.",
    }),
    sessionId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Raw ID for start/import. Legacy stop/summarize handle; prefer selector for an exact capture. Cannot be combined with selector.",
      }),
    ),
    selector: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Exact dated capture selector returned by start/import/status. Only for stop/summarize; supply this or sessionId, never both. No raw-ID fallback.",
      }),
    ),
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
  return new TranscriptsStore(path.join(ctx.stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: ctx.stateDir },
  });
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

// Tool stop/import/summarize actions explicitly materialize artifacts, but a
// divergent export must not turn a successful canonical summary write into failure.
async function exportTranscriptSummary(
  store: TranscriptsStore,
  session: TranscriptSessionDescriptor,
  { summary, intendedSummaryPath }: Awaited<ReturnType<typeof persistTranscriptSummary>>,
) {
  try {
    const artifacts = await store.materializeSessionArtifacts(session, "all");
    return { summary, summaryPath: artifacts.summaryPath };
  } catch (error) {
    return { summary, intendedSummaryPath, summaryExportError: String(error) };
  }
}

async function stopTranscripts(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
  lifecycleToken?: symbol;
}) {
  let selection: Awaited<ReturnType<typeof resolveTranscriptToolSession>>;
  if (params.lifecycleToken) {
    const sessionId = readTranscriptStringParam(params.rawParams, "sessionId", { required: true });
    const active = activeSessions.get(sessionId);
    // Service cleanup is exact lifecycle ownership, not an operator string lookup.
    if (!active || active.lifecycleToken !== params.lifecycleToken) {
      return toolText(`Transcripts session no longer active: ${sessionId}`, {
        sessionId,
        skipped: true,
      });
    }
    selection = {
      session: active.session,
      selector: transcriptSessionSelector(active.session),
      activeCandidate: active,
      selectedActive: active,
    };
  } else {
    selection = await resolveTranscriptToolSession({ ...params, action: "stop" });
    params.ctx.assertCallerActive?.();
  }
  // Authorization may await native policy while the provider retires this owner.
  if (!isTranscriptSelectionCurrent(selection)) {
    return transcriptSelectionNoLongerActive(selection);
  }
  const { session, selector, selectedActive } = selection;
  const sessionId = session.sessionId;
  if (isTranscriptSessionStarting(sessionId)) {
    return toolText(
      `Transcripts session start still in progress: ${sessionId}; retry stop after startup settles.`,
      {
        sessionId,
        selector,
        skipped: true,
      },
    );
  }
  if (selectedActive?.stopping) {
    return toolText(`Transcripts session stop already in progress: ${sessionId}`, {
      sessionId,
      selector,
      skipped: true,
    });
  }
  if (selectedActive) {
    selectedActive.stopping = true;
  }
  let finalized = false;
  try {
    let providerStopError: string | undefined;
    if (selectedActive && selectedActive.phase !== "terminal") {
      const provider = resolveSourceProvider(selectedActive.providerId, params.ctx);
      if (selectedActive.cleanupPending) {
        providerStopError = await stopPendingTranscriptCapture({
          ctx: params.ctx,
          provider,
          session,
          reason: "tool-stop",
        });
        if (providerStopError) {
          throw new Error(`transcripts provider cleanup failed: ${providerStopError}`);
        }
      } else if (provider?.stop) {
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
      if (activeSessions.get(sessionId) !== selectedActive) {
        return transcriptSelectionNoLongerActive(selection);
      }
      if (providerStopError && !selectedActive.session.stoppedAt) {
        selectedActive.session = {
          ...session,
          metadata: {
            ...session.metadata,
            providerStopError,
            providerStopFailedAt: new Date().toISOString(),
          },
        };
      }
    }
    let persisted: Awaited<ReturnType<typeof persistTranscriptSummary>>;
    let stoppedSession: TranscriptSessionDescriptor;
    if (selectedActive) {
      persisted = await finalizeTranscriptCapture({ ...params, entry: selectedActive });
      stoppedSession = selectedActive.session;
      finalized = true;
    } else {
      stoppedSession = { ...session, stoppedAt: session.stoppedAt ?? new Date().toISOString() };
      if (!session.stoppedAt) {
        await params.store.writeSession(stoppedSession);
      }
      persisted = await persistTranscriptSummary({
        config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
        store: params.store,
        session: stoppedSession,
      });
    }
    const { summaryPath, intendedSummaryPath, summary, summaryExportError } =
      await exportTranscriptSummary(params.store, stoppedSession, persisted);
    return toolText(
      `Transcripts stopped: ${sessionId}${summaryPath ? `\nSummary: ${summaryPath}` : `\nSummary export failed: ${summaryExportError}`}`,
      {
        sessionId,
        selector,
        ...(providerStopError ? { providerStopError } : {}),
        ...(summaryExportError ? { summaryExportError } : {}),
        ...(intendedSummaryPath ? { intendedSummaryPath } : {}),
        summary,
        ...(summaryPath ? { summaryPath } : {}),
      },
    );
  } finally {
    if (selectedActive && activeSessions.get(sessionId) === selectedActive) {
      delete selectedActive.stopping;
      if (finalized) {
        activeSessions.delete(sessionId);
      }
    }
  }
}

async function importTranscripts(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
}) {
  const requestedSource = {
    ...sourceFromParams(params.rawParams),
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
  };
  const provider = resolveSourceProvider(requestedSource.providerId, params.ctx);
  if (!provider?.importTranscript) {
    throw new Error(`transcripts provider ${requestedSource.providerId} cannot import transcripts`);
  }
  const resolvedSource = resolveTranscriptSourceOwnership({
    ctx: params.ctx,
    operation: "import",
    provider,
    source: requestedSource,
  });
  const providerSource = resolvedSource.source;
  await authorizeTranscriptSource({
    action: "import",
    ctx: params.ctx,
    provider,
    source: providerSource,
  });
  const session: TranscriptSessionDescriptor = {
    sessionId:
      readTranscriptStringParam(params.rawParams, "sessionId", { trim: true }) ??
      createTranscriptSessionId(),
    title: readTranscriptStringParam(params.rawParams, "title", { trim: true }),
    source: sanitizeTranscriptSourceLocator(providerSource),
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
    metadata: params.ctx.agentId ? { agentId: params.ctx.agentId } : {},
  };
  const transcript = readTranscriptStringParam(params.rawParams, "transcript", {
    required: true,
    trim: false,
  });
  await params.store.writeSession(session);
  const utterances = await provider.importTranscript({
    cfg: params.ctx.config,
    session: { ...session, source: providerSource },
    text: transcript,
    speakerLabel: readTranscriptStringParam(params.rawParams, "speakerLabel", { trim: true }),
  });
  for (const utterance of utterances) {
    await params.store.appendUtteranceForSession(session, utterance);
  }
  const persisted = await persistTranscriptSummary({
    config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
    store: params.store,
    session,
  });
  const { summaryPath, intendedSummaryPath, summary, summaryExportError } =
    await exportTranscriptSummary(params.store, session, persisted);
  return toolText(
    `Transcript imported: ${session.sessionId}${summaryPath ? `\nSummary: ${summaryPath}` : `\nSummary export failed: ${summaryExportError}`}`,
    {
      sessionId: session.sessionId,
      selector: transcriptSessionSelector(session),
      utteranceCount: utterances.length,
      ...(summaryExportError ? { summaryExportError } : {}),
      ...(intendedSummaryPath ? { intendedSummaryPath } : {}),
      summary,
      ...(summaryPath ? { summaryPath } : {}),
    },
  );
}

async function summarizeExisting(params: {
  config: ReturnType<typeof resolveTranscriptsConfig>;
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
}) {
  const selection = await resolveTranscriptToolSession({ ...params, action: "summarize" });
  params.ctx.assertCallerActive?.();
  if (!isTranscriptSelectionCurrent(selection)) {
    return transcriptSelectionNoLongerActive(selection);
  }
  const { session, selector } = selection;
  const sessionId = session.sessionId;
  const summary = await readTranscriptSummary({ ...params, session });
  // Reading yields; a retired capture cannot write into its same-tuple replacement.
  params.ctx.assertCallerActive?.();
  if (!isTranscriptSelectionCurrent(selection)) {
    return transcriptSelectionNoLongerActive(selection);
  }
  const intendedPath = await params.store.writeSummary(summary, session);
  params.ctx.assertCallerActive?.();
  if (!isTranscriptSelectionCurrent(selection)) {
    return transcriptSelectionNoLongerActive(selection);
  }
  const { summaryPath, intendedSummaryPath, summaryExportError } = await exportTranscriptSummary(
    params.store,
    session,
    { summary, intendedSummaryPath: intendedPath },
  );
  return toolText(
    `Transcripts summarized: ${sessionId}${summaryPath ? `\nSummary: ${summaryPath}` : `\nSummary export failed: ${summaryExportError}`}`,
    {
      sessionId,
      selector,
      ...(summaryExportError ? { summaryExportError } : {}),
      ...(intendedSummaryPath ? { intendedSummaryPath } : {}),
      summary,
      ...(summaryPath ? { summaryPath } : {}),
    },
  );
}

async function statusTranscripts(ctx: TranscriptsRuntimeContext) {
  const providers = [
    manualTranscriptSourceProvider.id,
    ...listTranscriptSourceProviders(ctx.config).map((provider) => provider.id),
  ];
  const uniqueProviders = uniqueStrings(providers);
  const visibleEntries = (
    await Promise.all(
      [...activeSessions.values()].map(async (entry) =>
        (await canAccessTranscriptSession(ctx, entry.session, "status")) ? entry : undefined,
      ),
    )
  )
    .filter((entry) => entry !== undefined)
    .filter((entry) => activeSessions.get(entry.session.sessionId) === entry);
  ctx.assertCallerActive?.();
  const pendingFinalization = visibleEntries
    .filter((entry) => entry.phase === "terminal")
    .map((entry) => ({
      selector: transcriptSessionSelector(entry.session),
      sessionId: entry.session.sessionId,
      stoppedAt: entry.session.stoppedAt,
    }));
  const active = visibleEntries
    .filter((entry) => entry.phase !== "terminal")
    .map((entry) => ({
      selector: transcriptSessionSelector(entry.session),
      sessionId: entry.session.sessionId,
      providerId: entry.providerId,
      title: entry.session.title,
      source: entry.session.source,
      cleanupPending: entry.cleanupPending === true,
    }));
  // Three complete canonical selectors keep this model-facing section under 1 KiB.
  // Recovery handles take priority; structured details retain the full authorized list.
  const selectorGroups = [
    { state: "pending", entries: pendingFinalization },
    { state: "active", entries: active },
  ];
  const selectorLines = selectorGroups
    .flatMap(({ state, entries }) =>
      entries
        .toSorted((left, right) => left.selector.localeCompare(right.selector))
        .slice(0, STATUS_SELECTOR_LIMIT)
        .map(({ selector }) => `${state}: ${selector}`),
    )
    .slice(0, STATUS_SELECTOR_LIMIT);
  const omitted = visibleEntries.length - selectorLines.length;
  return toolText(
    [
      `Transcripts providers: ${uniqueProviders.length ? uniqueProviders.join(", ") : "none"}`,
      `Active sessions: ${active.length}`,
      ...(pendingFinalization.length
        ? [
            `Ended captures awaiting persistence: ${pendingFinalization.length}; use transcripts stop to retry.`,
          ]
        : []),
      ...(selectorLines.length ? ["Selectors:", ...selectorLines] : []),
      ...(omitted
        ? [`${omitted} more; ask a local operator to run openclaw transcripts list.`]
        : []),
    ].join("\n"),
    { providers: uniqueProviders, active, pendingFinalization },
  );
}

/** Create the agent-facing transcripts tool. */
export function createTranscriptsTool(options?: {
  agentId?: string;
  agentChannel?: string;
  agentAccountId?: string;
  caller?: TranscriptToolCaller;
  assertCallerActive?: () => void;
  config?: OpenClawConfig;
  stateDir?: string;
  logger?: TranscriptsLogger;
}): AnyAgentTool {
  const ctx: TranscriptsRuntimeContext = {
    config: options?.config,
    stateDir: options?.stateDir ?? resolveStateDir(),
    logger: options?.logger ?? console,
    ...(options?.agentId ? { agentId: options.agentId } : {}),
    ...(options?.agentChannel ? { agentChannel: options.agentChannel } : {}),
    ...(options?.agentAccountId ? { agentAccountId: options.agentAccountId } : {}),
    ...(options?.caller ? { caller: options.caller } : {}),
    ...(options?.assertCallerActive ? { assertCallerActive: options.assertCallerActive } : {}),
  };
  return {
    name: "transcripts",
    label: "Transcripts",
    description:
      "Start, stop, import, summarize, or inspect meeting transcript captures and historical notes.",
    parameters: TranscriptsSchema,
    async execute(_toolCallId, rawParams, signal) {
      const config = resolveTranscriptsConfig(ctx.config?.transcripts);
      if (!config.enabled) {
        throw new Error("transcripts are disabled");
      }
      const params = asOptionalRecord(rawParams) ?? {};
      const action = readTranscriptStringParam(params, "action", { required: true, trim: true });
      if (params.selector !== undefined && action !== "stop" && action !== "summarize") {
        throw new Error("selector is only supported for stop or summarize.");
      }
      const store = createStore(ctx);
      switch (action) {
        case "start":
          return await startTranscripts({ ctx, store, rawParams: params, abortSignal: signal });
        case "stop":
          return await stopTranscripts({ ctx, store, rawParams: params });
        case "import":
          return await importTranscripts({ ctx, store, rawParams: params });
        case "summarize":
          return await summarizeExisting({ config, ctx, store, rawParams: params });
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
  const startedSessions = new Map<string, symbol>();
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
    if (stopped || startedSessions.has(entry.sessionId ?? "")) {
      return;
    }
    const abortController = new AbortController();
    const lifecycleToken = Symbol(entry.sessionId);
    pendingStartControllers.add(abortController);
    const startTask = startTranscripts({
      ctx,
      store,
      abortSignal: abortController.signal,
      startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
      configuredLifecycle: true,
      lifecycleToken,
      rawParams: {
        action: "start",
        ...entry,
        sessionId: entry.sessionId ?? createTranscriptSessionId(),
      },
    })
      .then((result) => {
        const sessionId = result.details?.sessionId;
        if (typeof sessionId === "string") {
          startedSessions.set(sessionId, lifecycleToken);
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
      const store = createStore(ctx);
      for (const entry of config.autoStart) {
        startEntry(
          {
            ...entry,
            sessionId: entry.sessionId ?? createTranscriptSessionId(),
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
      const store = createStore(ctx);
      for (const [sessionId, lifecycleToken] of startedSessions) {
        const warnings: string[] = [];
        try {
          const { details } = await stopTranscripts({
            ctx,
            store,
            rawParams: { action: "stop", sessionId },
            // Bypass authorization only while the exact capture created by this
            // service is still active; a reused id may belong to another owner.
            lifecycleToken,
          });
          // Fulfillment can include partial success; only diagnostics belong in logs,
          // never the tool content or summary. Skipped captures have no warnings.
          if (typeof details.summaryExportError === "string") {
            warnings.push(
              `summary saved; export failed intendedSummaryPath=${formatAutoStopDiagnostic(details.intendedSummaryPath)}: ${formatAutoStopDiagnostic(details.summaryExportError)}. Correct the export destination, then run openclaw transcripts path <session> or openclaw transcripts show <session>.`,
            );
          }
          if (typeof details.providerStopError === "string") {
            warnings.push(
              `provider stop failed: ${formatAutoStopDiagnostic(details.providerStopError)}. Check the provider capture status and connection.`,
            );
          }
        } catch (error) {
          warnings.push(`stop failed: ${formatAutoStopDiagnostic(error)}`);
        }
        for (const warning of warnings) {
          ctx.logger.warn(
            `transcripts autoStart session=${formatAutoStopDiagnostic(sessionId)}: ${warning}`,
          );
        }
      }
      startedSessions.clear();
    },
  };
}
