import { resolveTranscriptsConfig } from "../../transcripts/config.js";
import type { TranscriptSessionDescriptor } from "../../transcripts/provider-types.js";
import { transcriptSessionSelector, type TranscriptsStore } from "../../transcripts/store.js";
import { persistTranscriptSummary } from "../../transcripts/summary-persistence.js";
import {
  activeSessions,
  finalizeTranscriptCapture,
  isTranscriptSessionStarting,
  readTranscriptStringParam,
  resolveSourceProvider,
  stopPendingTranscriptCapture,
  toolText,
  type TranscriptsRuntimeContext,
} from "./transcripts-tool-runtime.js";
import {
  isTranscriptSelectionCurrent,
  resolveTranscriptToolSession,
  transcriptSelectionNoLongerActive,
} from "./transcripts-tool-selection.js";

// Tool stop/import/summarize actions explicitly materialize artifacts, but a
// divergent export must not turn a successful canonical summary write into failure.
export async function exportTranscriptSummary(
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

export async function stopTranscripts(params: {
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
      historicalRevision: undefined,
    };
  } else {
    selection = await resolveTranscriptToolSession({ ...params, action: "stop" });
    params.ctx.assertCallerActive?.();
  }
  // Authorization may await native policy while the provider retires this owner.
  if (!isTranscriptSelectionCurrent(selection, params.store)) {
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
      const provider = resolveSourceProvider(selectedActive.providerId, params.ctx.config);
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
        cfg: params.ctx.config,
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
