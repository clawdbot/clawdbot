import type { stopTranscriptCapture } from "../../transcripts/capture-operations.js";
import { formatTranscriptAccountId, type startTranscripts } from "../../transcripts/capture.js";
import { transcriptSessionSelector } from "../../transcripts/store.js";

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

export function transcriptStartToolResult(result: Awaited<ReturnType<typeof startTranscripts>>) {
  const { session } = result;
  const selector = transcriptSessionSelector(session);
  if (result.status === "ended") {
    return toolText(`Transcripts ended during startup: ${session.sessionId}`, {
      sessionId: session.sessionId,
      selector,
      active: false,
      stoppedAt: session.stoppedAt,
    });
  }
  const accountId = session.source.accountId;
  return toolText(
    `Transcripts started: ${session.sessionId}${accountId ? `\nAccount: ${formatTranscriptAccountId(accountId)}` : ""}`,
    {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      selector,
      providerId: result.providerId,
      ...(accountId ? { accountId } : {}),
    },
  );
}

export function transcriptStopToolResult(
  result: Awaited<ReturnType<typeof stopTranscriptCapture>>,
) {
  if (result.status === "skipped") {
    const { sessionId, selector, reason } = result;
    const text = {
      inactive: `Transcripts session no longer active: ${sessionId}`,
      starting: `Transcripts session start still in progress: ${sessionId}; retry stop after startup settles.`,
      stopping: `Transcripts session stop already in progress: ${sessionId}`,
    }[reason];
    return toolText(text, { sessionId, selector, skipped: true });
  }
  const { status, ...details } = result;
  return toolText(
    `Transcripts ${status}: ${details.sessionId}${details.summaryPath ? `\nSummary: ${details.summaryPath}` : `\nSummary export failed: ${details.summaryExportError}`}`,
    details,
  );
}
