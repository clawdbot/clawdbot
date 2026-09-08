/**
 * transcripts built-in tool.
 *
 * Manages live capture, manual import, summarization, and process-local transcript sessions.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createTranscriptsStore,
  exportTranscriptSummary,
  stopTranscriptCapture,
} from "../../transcripts/capture-operations.js";
import {
  persistTranscriptSummary,
  readTranscriptSummary,
} from "../../transcripts/capture-summary.js";
import {
  activeSessions,
  authorizeTranscriptSource,
  createTranscriptSessionId,
  isTranscriptSelectionCurrent,
  readTranscriptStringParam,
  resolveTranscriptSourceOwnership,
  resolveSourceProvider,
  sourceFromParams,
  startTranscripts,
  type TranscriptsLogger,
  type TranscriptsRuntimeContext,
} from "../../transcripts/capture.js";
import { resolveTranscriptsConfig } from "../../transcripts/config.js";
import { manualTranscriptSourceProvider } from "../../transcripts/manual-source.js";
import { listTranscriptSourceProviders } from "../../transcripts/provider-registry.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptToolCaller,
} from "../../transcripts/provider-types.js";
import { sanitizeTranscriptSourceLocator } from "../../transcripts/source-locator.js";
import {
  transcriptSessionSelector,
  TranscriptsSummaryChangedError,
  type TranscriptsStore,
} from "../../transcripts/store.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { AnyAgentTool } from "./common.js";
import { listPastTranscripts, showPastTranscript } from "./transcripts-tool-read.js";
import {
  toolText,
  transcriptStartToolResult,
  transcriptStopToolResult,
} from "./transcripts-tool-result.js";
import {
  canAccessTranscriptSession,
  resolveTranscriptToolSession,
  transcriptSelectionNoLongerActive,
} from "./transcripts-tool-selection.js";
const STATUS_SELECTOR_LIMIT = 3;
const STATUS_ACTIVE_MAX_ENTRIES = 5;
const STATUS_ACTIVE_MAX_CHARS = 2_000;

const TranscriptsSchema = Type.Object(
  {
    action: Type.String({
      description: "start, stop, status, import, summarize, list, or show.",
    }),
    sessionId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Raw ID for start/import. Legacy stop/summarize/show handle; prefer selector for an exact capture. Cannot be combined with selector.",
      }),
    ),
    selector: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Exact dated capture selector returned by start/import/status. Only for stop/summarize/show; supply this or sessionId, never both. No raw-ID fallback.",
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
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
  const requestedSessionId = readTranscriptStringParam(params.rawParams, "sessionId", {
    trim: true,
  });
  const session: TranscriptSessionDescriptor = {
    sessionId: requestedSessionId ?? createTranscriptSessionId(),
    title: readTranscriptStringParam(params.rawParams, "title", { trim: true }),
    source: sanitizeTranscriptSourceLocator(providerSource),
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
    metadata: {
      ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
      sessionIdOrigin: requestedSessionId ? "supplied" : "generated",
    },
  };
  const transcript = readTranscriptStringParam(params.rawParams, "transcript", {
    required: true,
    trim: false,
  });
  await params.store.writeSession(session);
  const utterances = await provider.importTranscript({
    cfg: params.ctx.config,
    session: { ...session, source: providerSource, metadata: { ...session.metadata } },
    text: transcript,
    speakerLabel: readTranscriptStringParam(params.rawParams, "speakerLabel", { trim: true }),
  });
  for (const utterance of utterances) {
    await params.store.appendUtteranceForSession(session, utterance);
  }
  const persisted = await persistTranscriptSummary({
    config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
    cfg: params.ctx.config,
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
  // Finalization owns notes through export. Older model results must not
  // overwrite it, even while the same capture reservation is still held.
  const canWriteSummary = () =>
    isTranscriptSelectionCurrent(selection, params.store) &&
    (!selection.selectedActive || selection.selectedActive.session === selection.session) &&
    !selection.selectedActive?.stopping &&
    !selection.selectedActive?.finalization;
  if (!canWriteSummary()) {
    return transcriptSelectionNoLongerActive(selection);
  }
  const { session, selector } = selection;
  const sessionId = session.sessionId;
  const summary = await readTranscriptSummary({ ...params, cfg: params.ctx.config, session });
  // Reading yields; a retired capture cannot write into its same-tuple replacement.
  params.ctx.assertCallerActive?.();
  if (!canWriteSummary()) {
    return transcriptSelectionNoLongerActive(selection);
  }
  let intendedPath: string;
  try {
    intendedPath = await params.store.writeSummary(summary, session, selection.historicalRevision);
  } catch (error) {
    if (error instanceof TranscriptsSummaryChangedError) {
      return transcriptSelectionNoLongerActive(selection);
    }
    throw error;
  }
  params.ctx.assertCallerActive?.();
  if (!canWriteSummary()) {
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
  const displayActive = active.toSorted((left, right) =>
    left.selector.localeCompare(right.selector),
  );
  const selectorGroups = [
    {
      state: "pending",
      entries: pendingFinalization.toSorted((left, right) =>
        left.selector.localeCompare(right.selector),
      ),
    },
    { state: "active", entries: displayActive },
  ];
  const selectorLines = selectorGroups
    .flatMap(({ state, entries }) =>
      entries.slice(0, STATUS_SELECTOR_LIMIT).map(({ selector }) => `${state}: ${selector}`),
    )
    .slice(0, STATUS_SELECTOR_LIMIT);
  const omitted = visibleEntries.length - selectorLines.length;
  const selectorText = [
    ...(selectorLines.length ? ["Selectors:", ...selectorLines] : []),
    ...(omitted ? [`${omitted} more; ask a local operator to run openclaw transcripts list.`] : []),
  ];
  const omittedNotice = "Additional active sessions omitted (display limit).";
  const activeLines: string[] = [];
  let remainingChars =
    STATUS_ACTIVE_MAX_CHARS - selectorText.join("\n").length - omittedNotice.length - 2;
  for (const entry of displayActive) {
    if (activeLines.length === STATUS_ACTIVE_MAX_ENTRIES) {
      break;
    }
    const line = JSON.stringify({
      selector: entry.selector,
      providerId: entry.providerId,
      accountId: entry.source.accountId,
      guildId: entry.source.guildId,
      channelId: entry.source.channelId,
      meetingUrl: entry.source.meetingUrl,
      title: entry.title ? truncateUtf16Safe(entry.title, 120) : undefined,
      ...(entry.cleanupPending ? { cleanupPending: true } : {}),
    });
    // Keep complete handles and source context within the shared display budget.
    if (line.length + 1 > remainingChars) {
      continue;
    }
    activeLines.push(line);
    remainingChars -= line.length + 1;
  }
  if (activeLines.length < active.length) {
    activeLines.push(omittedNotice);
  }
  return toolText(
    [
      `Transcripts providers: ${uniqueProviders.length ? uniqueProviders.join(", ") : "none"}`,
      `Active sessions: ${active.length}`,
      ...(pendingFinalization.length
        ? [
            `Ended captures awaiting persistence: ${pendingFinalization.length}; use transcripts stop to retry.`,
          ]
        : []),
      ...activeLines,
      ...selectorText,
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
      "Start, stop, import, summarize, or inspect meeting transcript captures; list past meetings and read their notes.",
    parameters: TranscriptsSchema,
    async execute(_toolCallId, rawParams, signal) {
      const config = resolveTranscriptsConfig(ctx.config?.transcripts);
      if (!config.enabled) {
        throw new Error("transcripts are disabled");
      }
      const params = asOptionalRecord(rawParams) ?? {};
      const action = readTranscriptStringParam(params, "action", { required: true, trim: true });
      if (
        params.selector !== undefined &&
        action !== "stop" &&
        action !== "summarize" &&
        action !== "show"
      ) {
        throw new Error("selector is only supported for stop, summarize, or show.");
      }
      const store = createTranscriptsStore(ctx);
      switch (action) {
        case "list":
          return await listPastTranscripts({ ctx, store, rawParams: params });
        case "show":
          return await showPastTranscript({ ctx, store, rawParams: params });
        case "start":
          return transcriptStartToolResult(
            await startTranscripts({ ctx, store, rawParams: params, abortSignal: signal }),
          );
        case "stop": {
          const selection = await resolveTranscriptToolSession({
            ctx,
            store,
            rawParams: params,
            action: "stop",
          });
          ctx.assertCallerActive?.();
          return transcriptStopToolResult(await stopTranscriptCapture({ ctx, store, selection }));
        }
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
