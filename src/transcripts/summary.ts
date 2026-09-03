import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";

export type TranscriptsSummary = {
  sessionId: string;
  title: string;
  generatedAt: string;
  overview: string;
  participants: string[];
  source: "model" | "heuristic";
  model?: string;
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

function firstSentences(utterances: TranscriptUtterance[], limit: number): string {
  const text = normalizeStringEntries(utterances.map((utterance) => utterance.text)).join(" ");
  const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [];
  return normalizeStringEntries(sentences.slice(0, limit)).join(" ");
}

function collectMatches(utterances: TranscriptUtterance[], pattern: RegExp): string[] {
  return utterances
    .filter((utterance) => pattern.test(utterance.text))
    .map(formatSpeakerLine)
    .filter(Boolean)
    .slice(0, 12);
}

function sanitizeUtterance(utterance: TranscriptUtterance): TranscriptUtterance {
  const sanitized: TranscriptUtterance = {
    ...utterance,
    text: sanitizeTerminalText(utterance.text),
  };
  if (utterance.speaker) {
    sanitized.speaker = {
      ...utterance.speaker,
      label: sanitizeTerminalText(utterance.speaker.label),
    };
  }
  return sanitized;
}

function formatSpeakerLine(utterance: TranscriptUtterance): string {
  const text = utterance.text.trim();
  if (!text) {
    return "";
  }
  const speaker = utterance.speaker?.label?.trim();
  return speaker ? `${speaker}: ${text}` : text;
}

/** Build a deterministic summary from transcript utterances. */
export function summarizeTranscripts(params: {
  session: TranscriptSessionDescriptor;
  utterances: TranscriptUtterance[];
}): TranscriptsSummary {
  const title = sanitizeTerminalText(params.session.title ?? "").trim() || "Transcripts";
  const utterances = params.utterances.map(sanitizeUtterance);
  const overview = firstSentences(utterances, 4) || "No transcript captured yet.";
  return {
    sessionId: params.session.sessionId,
    title,
    generatedAt: new Date().toISOString(),
    overview,
    participants: normalizeUniqueStringEntries(
      utterances.map((utterance) => utterance.speaker?.label ?? ""),
    ),
    source: "heuristic",
    transcript: utterances.map(formatSpeakerLine).filter(Boolean),
    decisions: collectMatches(utterances, DECISION_PATTERNS),
    actionItems: collectMatches(utterances, ACTION_PATTERNS),
    risks: collectMatches(utterances, RISK_PATTERNS),
    utteranceCount: params.utterances.length,
  };
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None captured";
}

/** Render a transcript summary as markdown for local artifacts. */
export function renderTranscriptsMarkdown(summary: TranscriptsSummary): string {
  return [
    `# ${summary.title}`,
    "",
    `Generated: ${summary.generatedAt}`,
    `Session: ${sanitizeTerminalText(summary.sessionId)}`,
    "",
    "## Overview",
    summary.overview,
    "",
    "## Participants",
    // Persisted summaries from before participant metadata remain renderable.
    renderList(summary.participants ?? []),
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
    // Keep notes ahead of the transcript for bounded readers such as tool show.
    "## Transcript",
    renderList(summary.transcript),
    "",
    `Transcript utterances: ${summary.utteranceCount}`,
  ].join("\n");
}
