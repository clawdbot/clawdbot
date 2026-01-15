/**
 * Matrix Poll Types (MSC3381)
 *
 * Defines types for Matrix poll events:
 * - m.poll.start - Creates a new poll
 * - m.poll.response - Records a vote
 * - m.poll.end - Closes a poll
 */

import type { PollInput } from "../../../../src/polls.js";

export const M_POLL_START = "m.poll.start";
export const M_POLL_RESPONSE = "m.poll.response";
export const M_POLL_END = "m.poll.end";

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

export type PollKind = "m.poll.disclosed" | "m.poll.undisclosed";

export type TextContent = {
  "m.text"?: string;
  "org.matrix.msc1767.text"?: string;
  body?: string;
};

export type PollAnswer = {
  id: string;
} & TextContent;

export type PollStartContent = {
  "m.poll"?: {
    question: TextContent;
    kind?: PollKind;
    max_selections?: number;
    answers: PollAnswer[];
  };
  "org.matrix.msc3381.poll.start"?: {
    question: TextContent;
    kind?: PollKind;
    max_selections?: number;
    answers: PollAnswer[];
  };
  "m.relates_to"?: {
    rel_type: "m.reference";
    event_id: string;
  };
};

export type PollSummary = {
  eventId: string;
  roomId: string;
  sender: string;
  senderName: string;
  question: string;
  answers: string[];
  kind: PollKind;
  maxSelections: number;
};

export function isPollStartType(eventType: string): boolean {
  return POLL_START_TYPES.includes(eventType);
}

export function getTextContent(text?: TextContent): string {
  if (!text) return "";
  return text["m.text"] ?? text["org.matrix.msc1767.text"] ?? text.body ?? "";
}

export function parsePollStartContent(content: PollStartContent): PollSummary | null {
  const poll = content["m.poll"] ?? content["org.matrix.msc3381.poll.start"];
  if (!poll) return null;

  const question = getTextContent(poll.question);
  if (!question) return null;

  const answers = poll.answers
    .map((answer) => getTextContent(answer))
    .filter((a) => a.trim().length > 0);

  return {
    eventId: "",
    roomId: "",
    sender: "",
    senderName: "",
    question,
    answers,
    kind: poll.kind ?? "m.poll.disclosed",
    maxSelections: poll.max_selections ?? 1,
  };
}

export function formatPollAsText(summary: PollSummary): string {
  const lines = [
    "[Poll]",
    summary.question,
    "",
    ...summary.answers.map((answer, idx) => `${idx + 1}. ${answer}`),
  ];
  return lines.join("\n");
}

function buildTextContent(body: string): TextContent {
  return {
    "m.text": body,
    "org.matrix.msc1767.text": body,
  };
}

export function buildPollStartContent(poll: PollInput): PollStartContent {
  const question = poll.question.trim();
  const answers = poll.options
    .map((option) => option.trim())
    .filter((option) => option.length > 0)
    .map((option, idx) => ({
      id: `answer${idx + 1}`,
      ...buildTextContent(option),
    }));

  const maxSelections = poll.multiple ? Math.max(1, answers.length) : 1;

  return {
    "m.poll": {
      question: buildTextContent(question),
      kind: poll.multiple ? "m.poll.undisclosed" : "m.poll.disclosed",
      max_selections: maxSelections,
      answers,
    },
  };
}
