/**
 * Matrix Poll Types (MSC3381)
 *
 * Defines types for Matrix poll events:
 * - m.poll.start - Creates a new poll
 * - m.poll.response - Records a vote
 * - m.poll.end - Closes a poll
 */

import type { PollInput } from "../polls.js";

// Event type constants
// Note: These use the stable event types from Matrix spec v1.10+
export const M_POLL_START = "m.poll.start";
export const M_POLL_RESPONSE = "m.poll.response";
export const M_POLL_END = "m.poll.end";

// Unstable prefixes (for older servers)
export const ORG_POLL_START = "org.matrix.msc3381.poll.start";
export const ORG_POLL_RESPONSE = "org.matrix.msc3381.poll.response";
export const ORG_POLL_END = "org.matrix.msc3381.poll.end";

export const POLL_EVENT_TYPES = [
  M_POLL_START,
  M_POLL_RESPONSE,
  M_POLL_END,
  ORG_POLL_START,
  ORG_POLL_RESPONSE,
  ORG_POLL_END,
];

export const POLL_START_TYPES = [M_POLL_START, ORG_POLL_START];
export const POLL_RESPONSE_TYPES = [M_POLL_RESPONSE, ORG_POLL_RESPONSE];
export const POLL_END_TYPES = [M_POLL_END, ORG_POLL_END];

// Poll kind determines if results are shown before the poll ends
export type PollKind = "m.poll.disclosed" | "m.poll.undisclosed";

// Text content wrapper used in extensible events
export type TextContent = {
  "m.text"?: string;
  "org.matrix.msc1767.text"?: string;
  body?: string;
};

// Poll answer structure
export type PollAnswer = {
  id: string;
} & TextContent;

// m.poll.start content structure
export type PollStartContent = {
  "m.poll"?: {
    question: TextContent;
    kind?: PollKind;
    max_selections?: number;
    answers: PollAnswer[];
  };
  // Unstable prefix version
  "org.matrix.msc3381.poll.start"?: {
    question: TextContent;
    kind?: PollKind;
    max_selections?: number;
    answers: PollAnswer[];
  };
  // Fallback text for clients that don't support polls
  "m.text"?: string;
  "org.matrix.msc1767.text"?: string;
  body?: string;
};

// m.poll.response content structure
export type PollResponseContent = {
  "m.relates_to": {
    rel_type: "m.reference";
    event_id: string;
  };
  "m.selections"?: string[];
  "org.matrix.msc3381.poll.response"?: {
    answers: string[];
  };
};

// m.poll.end content structure
export type PollEndContent = {
  "m.relates_to": {
    rel_type: "m.reference";
    event_id: string;
  };
  "m.poll.end"?: Record<string, unknown>;
  "org.matrix.msc3381.poll.end"?: Record<string, unknown>;
  "m.text"?: string;
  "org.matrix.msc1767.text"?: string;
};

// Simplified poll representation for the agent
export type MatrixPollSummary = {
  eventId: string;
  roomId: string;
  sender: string;
  senderName?: string;
  question: string;
  options: Array<{ id: string; text: string }>;
  maxSelections: number;
  kind: PollKind;
  timestamp?: number;
  ended?: boolean;
};

// Helper to extract text from TextContent
export function extractText(content: TextContent | undefined): string {
  if (!content) return "";
  return (
    content["m.text"] ??
    content["org.matrix.msc1767.text"] ??
    content.body ??
    ""
  );
}

// Helper to check if an event type is a poll start
export function isPollStartType(type: string): boolean {
  return POLL_START_TYPES.includes(type);
}

// Helper to check if an event type is a poll response
export function isPollResponseType(type: string): boolean {
  return POLL_RESPONSE_TYPES.includes(type);
}

// Helper to check if an event type is a poll end
export function isPollEndType(type: string): boolean {
  return POLL_END_TYPES.includes(type);
}

// Helper to check if an event type is any poll event
export function isPollEventType(type: string): boolean {
  return POLL_EVENT_TYPES.includes(type);
}

// Parse poll start content (handles both stable and unstable prefixes)
export function parsePollStartContent(
  content: PollStartContent,
): MatrixPollSummary | null {
  const poll = content["m.poll"] ?? content["org.matrix.msc3381.poll.start"];
  if (!poll) return null;

  const question = extractText(poll.question);
  if (!question) return null;

  const options = (poll.answers ?? []).map((answer) => ({
    id: answer.id,
    text: extractText(answer),
  }));

  if (options.length < 2) return null;

  return {
    eventId: "",
    roomId: "",
    sender: "",
    question,
    options,
    maxSelections: poll.max_selections ?? 1,
    kind: poll.kind ?? "m.poll.disclosed",
  };
}

// Build poll start content from PollInput
export function buildPollStartContent(poll: PollInput): PollStartContent {
  const answers: PollAnswer[] = poll.options.map((option, index) => ({
    id: `answer-${index}`,
    "m.text": option,
  }));

  const maxSelections = poll.maxSelections ?? 1;

  return {
    "m.poll": {
      question: { "m.text": poll.question },
      kind: "m.poll.disclosed",
      max_selections: maxSelections,
      answers,
    },
    // Fallback text for clients that don't support polls
    "m.text": `Poll: ${poll.question}\n${poll.options
      .map((o, i) => `${i + 1}. ${o}`)
      .join("\n")}`,
  };
}

// Build poll end content
export function buildPollEndContent(pollEventId: string): PollEndContent {
  return {
    "m.relates_to": {
      rel_type: "m.reference",
      event_id: pollEventId,
    },
    "m.poll.end": {},
    "m.text": "The poll has ended.",
  };
}

// Format a poll for display as text
export function formatPollAsText(poll: MatrixPollSummary): string {
  const lines = [
    `📊 Poll: "${poll.question}"`,
    "",
    ...poll.options.map((opt, i) => `${i + 1}. ${opt.text}`),
  ];

  if (poll.maxSelections > 1) {
    lines.push("", `(Select up to ${poll.maxSelections} options)`);
  }

  return lines.join("\n");
}
