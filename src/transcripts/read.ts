import type {
  TranscriptSessionSummary,
  TranscriptsGetResult,
  TranscriptUtterance as ProjectedTranscriptUtterance,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { truncateUtf16Safe } from "../utils.js";
import { isTranscriptSessionActive, readTranscriptCaptureSnapshot } from "./capture.js";
import type { TranscriptSessionDescriptor, TranscriptSourceLocator } from "./provider-types.js";
import { sanitizeTranscriptSourceLocator } from "./source-locator.js";
import { normalizeExportText } from "./store-artifacts.js";
import type { TranscriptReadEntry, TranscriptReadPurpose } from "./store-read.js";
import type { TranscriptsStore } from "./store.js";

/** Only public locator fields cross the Gateway; provider-private keys stay in the archive. */
export function projectTranscriptSource(
  source: TranscriptSourceLocator,
): TranscriptSessionSummary["source"] {
  const safe = sanitizeTranscriptSourceLocator(source);
  const kind = safe.kind;
  return {
    providerId: safe.providerId,
    ...(["live-audio", "live-caption", "posthoc-transcript", "recording-stt"].includes(kind ?? "")
      ? { kind }
      : {}),
    ...(safe.accountId !== undefined ? { accountId: safe.accountId } : {}),
    ...(safe.guildId !== undefined ? { guildId: safe.guildId } : {}),
    ...(safe.channelId !== undefined ? { channelId: safe.channelId } : {}),
    ...(safe.meetingUrl && /^https?:\/\//u.test(safe.meetingUrl)
      ? { meetingUrl: safe.meetingUrl }
      : {}),
    ...(safe.threadTs !== undefined ? { threadTs: safe.threadTs } : {}),
    ...(safe.fileId !== undefined ? { fileId: safe.fileId } : {}),
  };
}

export function projectTranscriptSession(
  entry: TranscriptReadEntry,
  active = isTranscriptSessionActive(entry.session),
  providerName?: string,
  captures = readTranscriptCaptureSnapshot(),
): TranscriptSessionSummary {
  const { session } = entry;
  const source = projectTranscriptSource(session.source);
  const owner = session.metadata?.agentId;
  return {
    selector: entry.selector,
    sessionId: session.sessionId,
    title: session.title === undefined ? undefined : sanitizeTerminalText(session.title),
    providerId: source.providerId,
    providerName,
    source,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    active,
    activeSubscription: captures.some(
      (capture) =>
        capture.state === "armed" &&
        capture.session.sessionId === session.sessionId &&
        capture.session.startedAt === session.startedAt,
    ),
    agentId: typeof owner === "string" ? owner : null,
    updatedAt: entry.updatedAt,
    lastUtteranceAt: entry.lastUtteranceAt,
    utteranceCount: entry.utteranceCount,
    participants: entry.participants.map(sanitizeTerminalText),
    hasSummary: entry.hasSummary,
    summarySource: entry.summarySource,
    overview:
      entry.overview === undefined
        ? undefined
        : truncateUtf16Safe(sanitizeTerminalText(entry.overview), 280),
  };
}

export function projectTranscriptMarkdown(markdown: string): string {
  return normalizeExportText(markdown).split("\n").map(sanitizeTerminalText).join("\n");
}

export async function readTranscriptNotes(
  store: TranscriptsStore,
  session: TranscriptSessionDescriptor,
  purpose: TranscriptReadPurpose = "page",
): Promise<TranscriptsGetResult["summary"]> {
  const stored = store.readNotes(session, purpose);
  if (stored.markdown === undefined) {
    return undefined;
  }
  const summary = stored.summary;
  return {
    generatedAt: summary?.generatedAt ?? "",
    overview: summary?.overview ?? "",
    decisions: summary?.decisions ?? [],
    actionItems: summary?.actionItems ?? [],
    risks: summary?.risks ?? [],
    participants: (summary?.participants ?? []).map(sanitizeTerminalText),
    source: summary?.source,
    model: summary?.model,
    utteranceCount: summary?.utteranceCount ?? 0,
    // Stored Markdown is the canonical CLI rendering; reading never exports files.
    markdown: projectTranscriptMarkdown(stored.markdown),
  };
}

/** Downloads and reader pages share an allowlist; raw provider metadata stays local. */
export function projectTranscriptUtterance(
  utterance: ProjectedTranscriptUtterance,
): ProjectedTranscriptUtterance {
  return {
    sequence: utterance.sequence,
    id: utterance.id,
    startedAt: utterance.startedAt,
    endedAt: utterance.endedAt,
    speakerId: utterance.speakerId,
    speakerLabel:
      utterance.speakerLabel === undefined
        ? undefined
        : sanitizeTerminalText(utterance.speakerLabel),
    text: sanitizeTerminalText(utterance.text),
    final: utterance.final,
  };
}
