import type {
  TranscriptSessionSummary,
  TranscriptsGetResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { truncateUtf16Safe } from "../utils.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { sanitizeTranscriptSourceLocator } from "./source-locator.js";
import { normalizeExportText } from "./store-artifacts.js";
import type { TranscriptReadEntry } from "./store-read.js";
import type { TranscriptsStore } from "./store.js";

export function projectTranscriptSession(
  entry: TranscriptReadEntry,
  active: boolean,
  providerName?: string,
): TranscriptSessionSummary {
  const { session } = entry;
  const source = sanitizeTranscriptSourceLocator(session.source);
  return {
    selector: entry.selector,
    sessionId: session.sessionId,
    title: session.title === undefined ? undefined : sanitizeTerminalText(session.title),
    providerId: source.providerId,
    providerName,
    // Locator fields are an allowlist, not arbitrary provider metadata.
    source: {
      providerId: source.providerId,
      accountId: source.accountId,
      guildId: source.guildId,
      channelId: source.channelId,
      meetingUrl: source.meetingUrl,
    },
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    active,
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

export async function readTranscriptNotes(
  store: TranscriptsStore,
  session: TranscriptSessionDescriptor,
): Promise<TranscriptsGetResult["summary"]> {
  const stored = await store.readSummary(session);
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
    // Stored Markdown is the canonical CLI rendering; reading never exports files.
    markdown: normalizeExportText(stored.markdown).split("\n").map(sanitizeTerminalText).join("\n"),
  };
}
