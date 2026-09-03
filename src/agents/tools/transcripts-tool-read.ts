import type { TranscriptSessionSummary } from "../../../packages/gateway-protocol/src/schema/transcripts.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { projectTranscriptSession, readTranscriptNotes } from "../../transcripts/read.js";
import type { TranscriptsStore } from "../../transcripts/store.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  isTranscriptSessionActive,
  resolveSourceProvider,
  toolText,
  type TranscriptsRuntimeContext,
} from "./transcripts-tool-runtime.js";
import {
  canAccessTranscriptSession,
  isTranscriptSelectionCurrent,
  resolveTranscriptToolSession,
  transcriptSelectionNoLongerActive,
} from "./transcripts-tool-selection.js";

const TRANSCRIPTS_SHOW_MAX_CHARS = 12_000;
const TRANSCRIPTS_LIST_MAX_CHARS = 4_000;
type ReadParams = {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
};

export async function listPastTranscripts({ ctx, store, rawParams }: ReadParams) {
  const limit = rawParams.limit ?? 20;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("limit must be an integer from 1 to 50.");
  }
  const sessions: Omit<TranscriptSessionSummary, "overview">[] = [];
  // Page before authorization, but limit after it: hidden meetings must not crowd
  // accessible captures out of the result. No per-meeting database queries.
  for (let offset = 0; sessions.length < limit; offset += 200) {
    const entries = store.listReadEntries({ limit: 200, offset });
    for (const entry of entries) {
      if (!(await canAccessTranscriptSession(ctx, entry.session, "list"))) {
        continue;
      }
      const { overview: _overview, ...session } = projectTranscriptSession(
        entry,
        isTranscriptSessionActive(entry.session),
        resolveSourceProvider(entry.session.source.providerId, ctx.config)?.name,
      );
      sessions.push(session);
      if (sessions.length === limit) {
        break;
      }
    }
    if (entries.length < 200) {
      break;
    }
  }
  ctx.assertCallerActive?.();
  const lines: string[] = [];
  for (const session of sessions) {
    const title = truncateUtf16Safe(
      sanitizeTerminalText(session.title || session.providerName || session.providerId),
      80,
    );
    const participants = truncateUtf16Safe(session.participants.join(", "), 100);
    const date = session.startedAt.slice(0, 16).replace("T", " ");
    const line = `${date}  ${title}  (${session.utteranceCount} utterances, ${participants || "no speakers"})  selector: ${session.selector}`;
    if ([...lines, line].join("\n").length > TRANSCRIPTS_LIST_MAX_CHARS - 100) {
      lines.push("More meetings in details.sessions; use a smaller limit for a shorter list.");
      break;
    }
    lines.push(line);
  }
  return toolText(lines.join("\n") || "No accessible meeting transcripts found.", { sessions });
}

export async function showPastTranscript(params: ReadParams) {
  const { ctx, store } = params;
  const selection = await resolveTranscriptToolSession({ ...params, action: "show" });
  const entry = store.listReadEntries({ limit: 1, session: selection.session })[0];
  if (!entry) {
    throw new Error(`transcripts session not found: ${selection.selector}`);
  }
  const notes = await readTranscriptNotes(store, selection.session);
  ctx.assertCallerActive?.();
  if (!isTranscriptSelectionCurrent(selection, store)) {
    return transcriptSelectionNoLongerActive(selection);
  }
  const session = projectTranscriptSession(
    { ...entry, session: selection.session },
    isTranscriptSessionActive(selection.session),
  );
  const {
    selector,
    sessionId,
    title,
    startedAt,
    stoppedAt,
    utteranceCount,
    participants,
    summarySource,
    active,
  } = session;
  const marker = `\n[truncated; run openclaw transcripts show ${selector} for the full notes]`;
  const markdown = notes?.markdown;
  const text =
    markdown === undefined
      ? `No summary exists yet for this meeting.${active ? " Capture is active." : ""}`
      : markdown.length > TRANSCRIPTS_SHOW_MAX_CHARS
        ? truncateUtf16Safe(markdown, TRANSCRIPTS_SHOW_MAX_CHARS - marker.length) + marker
        : markdown;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      text,
      selector,
      sessionId,
      title,
      startedAt,
      stoppedAt,
      utteranceCount,
      participants: notes?.participants.length ? notes.participants : participants,
      summarySource,
      ...(markdown === undefined ? { active } : {}),
    },
  };
}
