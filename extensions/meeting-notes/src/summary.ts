import type {
  MeetingNotesSessionDescriptor,
  MeetingNotesUtterance,
} from "openclaw/plugin-sdk/meeting-notes";

export type MeetingNotesSummary = {
  sessionId: string;
  title: string;
  generatedAt: string;
  overview: string;
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
  const text = utterances
    .map((utterance) => utterance.text.trim())
    .filter(Boolean)
    .join(" ");
  const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [];
  return sentences
    .slice(0, limit)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join(" ");
}

function collectMatches(utterances: MeetingNotesUtterance[], pattern: RegExp): string[] {
  return utterances
    .filter((utterance) => pattern.test(utterance.text))
    .map((utterance) => {
      const speaker = utterance.speaker?.label ? `${utterance.speaker.label}: ` : "";
      return `${speaker}${utterance.text.trim()}`;
    })
    .filter(Boolean)
    .slice(0, 12);
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
