/**
 * Matrix Poll Types (MSC3381)
 *
 * Defines types for Matrix poll events:
 * - m.poll.start - Creates a new poll
 * - m.poll.response - Records a vote
 * - m.poll.end - Closes a poll
 */

import { normalizePollInput, type PollInput } from "openclaw/plugin-sdk/poll-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const M_POLL_START = "m.poll.start" as const;
export const M_POLL_RESPONSE = "m.poll.response" as const;
export const M_POLL_END = "m.poll.end" as const;

export const ORG_POLL_START = "org.matrix.msc3381.poll.start" as const;
export const ORG_POLL_RESPONSE = "org.matrix.msc3381.poll.response" as const;
export const ORG_POLL_END = "org.matrix.msc3381.poll.end" as const;

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

export type PollParsedAnswer = {
  id: string;
  text: string;
};

export type PollStartSubtype = {
  question: TextContent;
  kind?: PollKind;
  max_selections?: number;
  answers: PollAnswer[];
};

export type LegacyPollStartContent = {
  "m.poll"?: PollStartSubtype;
};

export type PollStartContent = {
  [M_POLL_START]?: PollStartSubtype;
  [ORG_POLL_START]?: PollStartSubtype;
  "m.poll"?: PollStartSubtype;
  "m.text"?: string;
  "org.matrix.msc1767.text"?: string;
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

export type PollResultsSummary = PollSummary & {
  entries: Array<{
    id: string;
    text: string;
    votes: number;
  }>;
  totalVotes: number;
  closed: boolean;
};

export type ParsedPollStart = {
  question: string;
  answers: PollParsedAnswer[];
  kind: PollKind;
  maxSelections: number;
};

export type PollResponseSubtype = {
  answers: string[];
};

export type PollResponseContent = {
  [M_POLL_RESPONSE]?: PollResponseSubtype;
  [ORG_POLL_RESPONSE]?: PollResponseSubtype;
  "m.relates_to": {
    rel_type: "m.reference";
    event_id: string;
  };
};

export function isPollStartType(eventType: string): boolean {
  return (POLL_START_TYPES as readonly string[]).includes(eventType);
}

export function isPollResponseType(eventType: string): boolean {
  return (POLL_RESPONSE_TYPES as readonly string[]).includes(eventType);
}

export function isPollEndType(eventType: string): boolean {
  return (POLL_END_TYPES as readonly string[]).includes(eventType);
}

export function isPollEventType(eventType: string): boolean {
  return (POLL_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function getTextContent(text?: TextContent): string {
  if (!text) {
    return "";
  }
  return text["m.text"] ?? text["org.matrix.msc1767.text"] ?? text.body ?? "";
}

export function parsePollStart(content: PollStartContent): ParsedPollStart | null {
  const poll =
    (content as Record<string, PollStartSubtype | undefined>)[M_POLL_START] ??
    (content as Record<string, PollStartSubtype | undefined>)[ORG_POLL_START] ??
    (content as Record<string, PollStartSubtype | undefined>)["m.poll"];
  if (!poll) {
    return null;
  }

  const question = getTextContent(poll.question).trim();
  if (!question) {
    return null;
  }

  const answers = poll.answers
    .map((answer) => ({
      id: answer.id,
      text: getTextContent(answer).trim(),
    }))
    .filter((answer) => answer.id.trim().length > 0 && answer.text.length > 0);
  if (answers.length === 0) {
    return null;
  }

  const maxSelectionsRaw = poll.max_selections;
  const maxSelections =
    typeof maxSelectionsRaw === "number" && Number.isFinite(maxSelectionsRaw)
      ? Math.floor(maxSelectionsRaw)
      : 1;

  return {
    question,
    answers,
    kind: poll.kind ?? "m.poll.disclosed",
    maxSelections: Math.min(Math.max(maxSelections, 1), answers.length),
  };
}

export function parsePollStartContent(content: PollStartContent): PollSummary | null {
  const parsed = parsePollStart(content);
  if (!parsed) {
    return null;
  }

  return {
    eventId: "",
    roomId: "",
    sender: "",
    senderName: "",
    question: parsed.question,
    answers: parsed.answers.map((answer) => answer.text),
    kind: parsed.kind,
    maxSelections: parsed.maxSelections,
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

export function resolvePollReferenceEventId(content: unknown): string | null {
  if (!content || typeof content !== "object") {
    return null;
  }
  const relates = (content as { "m.relates_to"?: { event_id?: unknown } })["m.relates_to"];
  if (!relates || typeof relates.event_id !== "string") {
    return null;
  }
  const eventId = relates.event_id.trim();
  return eventId.length > 0 ? eventId : null;
}

export function parsePollResponseAnswerIds(content: unknown): string[] | null {
  if (!content || typeof content !== "object") {
    return null;
  }
  const response =
    (content as Record<string, PollResponseSubtype | undefined>)[M_POLL_RESPONSE] ??
    (content as Record<string, PollResponseSubtype | undefined>)[ORG_POLL_RESPONSE];
  if (!response || !Array.isArray(response.answers)) {
    return null;
  }
  return response.answers.filter((answer): answer is string => typeof answer === "string");
}

export function buildPollResultsSummary(params: {
  pollEventId: string;
  roomId: string;
  sender: string;
  senderName: string;
  content: PollStartContent;
  relationEvents: Array<{
    event_id?: string;
    sender?: string;
    type?: string;
    origin_server_ts?: number;
    content?: Record<string, unknown>;
    unsigned?: {
      redacted_because?: unknown;
    };
  }>;
}): PollResultsSummary | null {
  const parsed = parsePollStart(params.content);
  if (!parsed) {
    return null;
  }

  let pollClosedAt = Number.POSITIVE_INFINITY;
  for (const event of params.relationEvents) {
    if (event.unsigned?.redacted_because) {
      continue;
    }
    if (!isPollEndType(typeof event.type === "string" ? event.type : "")) {
      continue;
    }
    if (event.sender !== params.sender) {
      continue;
    }
    const ts =
      typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts)
        ? event.origin_server_ts
        : Number.POSITIVE_INFINITY;
    if (ts < pollClosedAt) {
      pollClosedAt = ts;
    }
  }

  const answerIds = new Set(parsed.answers.map((answer) => answer.id));
  const latestVoteBySender = new Map<
    string,
    {
      ts: number;
      eventId: string;
      answerIds: string[];
    }
  >();

  const orderedRelationEvents = [...params.relationEvents].toSorted((left, right) => {
    const leftTs =
      typeof left.origin_server_ts === "number" && Number.isFinite(left.origin_server_ts)
        ? left.origin_server_ts
        : Number.POSITIVE_INFINITY;
    const rightTs =
      typeof right.origin_server_ts === "number" && Number.isFinite(right.origin_server_ts)
        ? right.origin_server_ts
        : Number.POSITIVE_INFINITY;
    if (leftTs !== rightTs) {
      return leftTs - rightTs;
    }
    return (left.event_id ?? "").localeCompare(right.event_id ?? "");
  });

  for (const event of orderedRelationEvents) {
    if (event.unsigned?.redacted_because) {
      continue;
    }
    if (!isPollResponseType(typeof event.type === "string" ? event.type : "")) {
      continue;
    }
    const senderId = normalizeOptionalString(event.sender) ?? "";
    if (!senderId) {
      continue;
    }
    const eventTs =
      typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts)
        ? event.origin_server_ts
        : Number.POSITIVE_INFINITY;
    if (eventTs > pollClosedAt) {
      continue;
    }
    const rawAnswers = parsePollResponseAnswerIds(event.content) ?? [];
    const normalizedAnswers = Array.from(
      new Set(
        rawAnswers
          .map((answerId) => normalizeOptionalString(answerId) ?? "")
          .filter((answerId) => answerIds.has(answerId))
          .slice(0, parsed.maxSelections),
      ),
    );
    latestVoteBySender.set(senderId, {
      ts: eventTs,
      eventId: typeof event.event_id === "string" ? event.event_id : "",
      answerIds: normalizedAnswers,
    });
  }

  const voteCounts = new Map<string, number>(
    parsed.answers.map((answer): [string, number] => [answer.id, 0]),
  );
  let totalVotes = 0;
  for (const latestVote of latestVoteBySender.values()) {
    if (latestVote.answerIds.length === 0) {
      continue;
    }
    totalVotes += 1;
    for (const answerId of latestVote.answerIds) {
      voteCounts.set(answerId, (voteCounts.get(answerId) ?? 0) + 1);
    }
  }

  return {
    eventId: params.pollEventId,
    roomId: params.roomId,
    sender: params.sender,
    senderName: params.senderName,
    question: parsed.question,
    answers: parsed.answers.map((answer) => answer.text),
    kind: parsed.kind,
    maxSelections: parsed.maxSelections,
    entries: parsed.answers.map((answer) => ({
      id: answer.id,
      text: answer.text,
      votes: voteCounts.get(answer.id) ?? 0,
    })),
    totalVotes,
    closed: Number.isFinite(pollClosedAt),
  };
}

export function formatPollResultsAsText(summary: PollResultsSummary): string {
  const lines = [summary.closed ? "[Poll closed]" : "[Poll]", summary.question, ""];
  const revealResults = summary.kind === "m.poll.disclosed" || summary.closed;
  for (const [index, entry] of summary.entries.entries()) {
    if (!revealResults) {
      lines.push(`${index + 1}. ${entry.text}`);
      continue;
    }
    lines.push(`${index + 1}. ${entry.text} (${entry.votes} vote${entry.votes === 1 ? "" : "s"})`);
  }
  lines.push("");
  if (!revealResults) {
    lines.push("Responses are hidden until the poll closes.");
  } else {
    lines.push(`Total voters: ${summary.totalVotes}`);
  }
  return lines.join("\n");
}

function buildTextContent(body: string): TextContent {
  return {
    "m.text": body,
    "org.matrix.msc1767.text": body,
  };
}

function buildPollFallbackText(question: string, answers: string[]): string {
  if (answers.length === 0) {
    return question;
  }
  return `${question}\n${answers.map((answer, idx) => `${idx + 1}. ${answer}`).join("\n")}`;
}

export function buildPollStartContent(poll: PollInput): PollStartContent {
  const normalized = normalizePollInput(poll);
  const answers = normalized.options.map((option, idx) => ({
    id: `answer${idx + 1}`,
    ...buildTextContent(option),
  }));

  const isMultiple = normalized.maxSelections > 1;
  const fallbackText = buildPollFallbackText(
    normalized.question,
    answers.map((answer) => getTextContent(answer)),
  );

  return {
    [M_POLL_START]: {
      question: buildTextContent(normalized.question),
      kind: isMultiple ? "m.poll.undisclosed" : "m.poll.disclosed",
      max_selections: normalized.maxSelections,
      answers,
    },
    "m.text": fallbackText,
    "org.matrix.msc1767.text": fallbackText,
  };
}

export function buildPollResponseContent(
  pollEventId: string,
  answerIds: string[],
): PollResponseContent {
  return {
    [M_POLL_RESPONSE]: {
      answers: answerIds,
    },
    [ORG_POLL_RESPONSE]: {
      answers: answerIds,
    },
    "m.relates_to": {
      rel_type: "m.reference",
      event_id: pollEventId,
    },
  };
}
