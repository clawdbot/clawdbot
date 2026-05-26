import type {
  MeetingNotesSessionDescriptor,
  MeetingNotesUtterance,
} from "openclaw/plugin-sdk/meeting-notes";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

export type MeetingNotesSummary = {
  sessionId: string;
  title: string;
  generatedAt: string;
  overview: string;
  transcript: string[];
  decisions: string[];
  actionItems: string[];
  risks: string[];
  utteranceCount: number;
};

const ACTION_PATTERNS =
  /\b(todo|action|follow up|follow-up|assign|owner|next step|ship|fix|send|schedule)\b/i;
const DECISION_PATTERNS = /\b(decided|decision|we will|we'll|agreed|approved|go with|ship it)\b/i;
const RISK_PATTERNS =
  /\b(risk|blocked|blocker|concern|issue|problem|unknown|deadline|privacy|security)\b/i;

function firstSentences(utterances: MeetingNotesUtterance[], limit: number): string {
  const text = normalizeStringEntries(utterances.map((utterance) => utterance.text)).join(" ");
  const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [];
  return normalizeStringEntries(sentences.slice(0, limit)).join(" ");
}

function collectMatches(utterances: MeetingNotesUtterance[], pattern: RegExp): string[] {
  return utterances
    .filter((utterance) => pattern.test(utterance.text))
    .map(formatSpeakerLine)
    .filter(Boolean)
    .slice(0, 12);
}

function formatSpeakerLine(utterance: MeetingNotesUtterance): string {
  const text = utterance.text.trim();
  if (!text) {
    return "";
  }
  const speaker = utterance.speaker?.label?.trim();
  return speaker ? `${speaker}: ${text}` : text;
}

function formatTranscript(utterances: MeetingNotesUtterance[]): string[] {
  return utterances.map(formatSpeakerLine).filter(Boolean);
}

export function summarizeMeetingNotes(params: {
  session: MeetingNotesSessionDescriptor;
  utterances: MeetingNotesUtterance[];
}): MeetingNotesSummary {
  const title = params.session.title?.trim() || "Meeting notes";
  const overview = firstSentences(params.utterances, 4) || "No transcript captured yet.";
  return {
    sessionId: params.session.sessionId,
    title,
    generatedAt: new Date().toISOString(),
    overview,
    transcript: formatTranscript(params.utterances),
    decisions: collectMatches(params.utterances, DECISION_PATTERNS),
    actionItems: collectMatches(params.utterances, ACTION_PATTERNS),
    risks: collectMatches(params.utterances, RISK_PATTERNS),
    utteranceCount: params.utterances.length,
  };
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None captured";
}

export function renderMeetingNotesMarkdown(summary: MeetingNotesSummary): string {
  return [
    `# ${summary.title}`,
    "",
    `Generated: ${summary.generatedAt}`,
    `Session: ${summary.sessionId}`,
    "",
    "## Overview",
    summary.overview,
    "",
    "## Transcript",
    renderList(summary.transcript),
    "",
    "## Decisions",
    renderList(summary.decisions),
    "",
    "## Action Items",
    renderList(summary.actionItems),
    "",
    "## Risks",
    renderList(summary.risks),
    "",
    `Transcript utterances: ${summary.utteranceCount}`,
  ].join("\n");
}
