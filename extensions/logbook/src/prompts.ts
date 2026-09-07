// Logbook prompt builders. Two-stage pipeline (observe frames, then revise
// timeline cards) adapted from the approach popularized by Dayflow (MIT).
import type { LogbookCard, LogbookObservation } from "./types.js";

const CARD_MIN_MINUTES = 10;
const CARD_MAX_MINUTES = 60;
export const CARD_CATEGORIES = [
  "coding",
  "review",
  "writing",
  "research",
  "comms",
  "meetings",
  "design",
  "ops",
  "browsing",
  "media",
  "other",
] as const;

function formatClock(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export const OBSERVATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "description"],
        properties: {
          start: { type: "string", description: "HH:MM:SS within the covered window" },
          end: { type: "string", description: "HH:MM:SS within the covered window" },
          description: { type: "string" },
        },
      },
    },
  },
} as const;

export function buildObservationInstructions(params: {
  frameTimes: number[];
  startMs: number;
  endMs: number;
}): string {
  const start = formatClock(params.startMs);
  const end = formatClock(params.endMs);
  const times = params.frameTimes.map(formatClock).join(", ");
  return [
    `These are ${params.frameTimes.length} screenshots of one computer screen, captured in order between ${start} and ${end} (local time).`,
    `Capture timestamps: ${times}.`,
    "",
    "Write an activity log detailed enough that the user could reconstruct what they did.",
    'For each segment ask: "What EXACTLY did they do? What SPECIFIC things are visible?"',
    "Capture exact app/site names, file names, URLs, page or PR titles, usernames, search queries, and numbers when readable.",
    "",
    'Bad: "Checked email". Good: "Gmail: read \'Budget approval\' from dana@acme.com, replied briefly".',
    'Bad: "Working on code". Good: "VS Code: editing store.ts, fixing a type error in replaceCardsInWindow".',
    "",
    "Return 2-8 segments covering the whole window in order, no gaps, no overlaps.",
    "If the screen barely changes, return one segment describing the sustained activity.",
    "Group by GOAL, not app: debugging across editor, terminal, and browser is one segment.",
    `Timestamps must be HH:MM:SS between ${start} and ${end}.`,
  ].join("\n");
}

export function buildCardsPrompt(params: {
  day: string;
  observations: LogbookObservation[];
  previousCards: LogbookCard[];
  windowStartMs: number;
  windowEndMs: number;
}): string {
  const transcript = params.observations
    .map((obs) => `[${formatClock(obs.startMs)} - ${formatClock(obs.endMs)}] ${obs.text}`)
    .join("\n");
  const previous = JSON.stringify(
    params.previousCards.map((card) => ({
      startTime: formatClock(card.startMs),
      endTime: formatClock(card.endMs),
      category: card.category,
      title: card.title,
      summary: card.summary,
      detailedSummary: card.detail,
      distractions: card.distractions.map((d) => ({
        startTime: formatClock(d.startMs),
        endTime: formatClock(d.endMs),
        title: d.title,
      })),
      appSites: { primary: card.appPrimary ?? "", secondary: card.appSecondary ?? "" },
    })),
    null,
    2,
  );
  return [
    "You are synthesizing a user's screen activity log into timeline cards. Each card is one coherent activity.",
    "",
    "CORE PRINCIPLE:",
    `Each card = one main thing the user did. Time is a constraint (${CARD_MIN_MINUTES}-${CARD_MAX_MINUTES} min per card), not a goal.`,
    "",
    "SPLIT into a new card only when the user's GOAL changes, not just the tool. MERGE when consecutive activities serve the same goal (app switches, debugging across editor + terminal + browser, iterating on the same document). Default to merging: fewer rich cards beat many granular ones.",
    "",
    "DISTRACTIONS: a brief (<5 min) unrelated interruption inside a card. Anything sustained (>10 min) is its own card.",
    "",
    "CONTINUITY: adjacent cards meet cleanly; never introduce gaps or overlaps. Preserve genuine idle gaps from the source data.",
    "",
    `CATEGORY: one of ${CARD_CATEGORIES.join(", ")}.`,
    "",
    'APP SITES: identify the main app or site per card as a canonical lower-case domain (figma.com, docs.google.com, github.com). Use "terminal" for terminals. Omit secondary when unclear. Never invent brands.',
    "",
    "REVISION CONTRACT:",
    "\"Previous cards\" is a draft you are revising and extending with the new observations. Your output must cover the union of the previous cards' time range and the new observations' range; you may restructure freely inside it, but do not drop covered time. The final card may be shorter than the minimum.",
    "",
    `Day: ${params.day}. Window under revision: ${formatClock(params.windowStartMs)} to ${formatClock(params.windowEndMs)}.`,
    "",
    "Previous cards:",
    previous,
    "",
    "New observations:",
    transcript || "(none)",
    "",
    "Return ONLY a raw JSON array, no code fences, in this exact shape:",
    `[
  {
    "startTime": "13:12:00",
    "endTime": "13:41:00",
    "category": "coding",
    "title": "",
    "summary": "",
    "detailedSummary": "",
    "distractions": [{ "startTime": "13:15:00", "endTime": "13:18:00", "title": "" }],
    "appSites": { "primary": "", "secondary": "" }
  }
]`,
  ].join("\n");
}

export function buildCardsCorrectionPrompt(validationError: string): string {
  return [
    "The previous JSON output failed validation:",
    validationError,
    "",
    "Return the FULL corrected JSON array (not a diff). Same coverage, no gaps or overlaps, JSON only.",
  ].join("\n");
}

export function buildStandupPrompt(params: {
  day: string;
  cards: LogbookCard[];
  previousDayCards: LogbookCard[];
}): string {
  const render = (cards: LogbookCard[]) =>
    cards
      .map(
        (card) =>
          `- ${formatClock(card.startMs)}-${formatClock(card.endMs)} [${card.category}] ${card.title}: ${card.summary}`,
      )
      .join("\n") || "(no tracked activity)";
  return [
    `Write a concise daily standup for ${params.day} based on the user's tracked screen activity.`,
    "",
    "Yesterday's timeline:",
    render(params.previousDayCards),
    "",
    "Today's timeline so far:",
    render(params.cards),
    "",
    "Output markdown with exactly three sections: '## Done' (yesterday's concrete accomplishments, merged and deduplicated), '## Today' (in-progress threads worth continuing), '## Blockers' (only if evidence shows something stuck; otherwise write 'None observed').",
    "Keep it under 150 words. No preamble.",
  ].join("\n");
}

export function buildAskPrompt(params: {
  day: string;
  cards: LogbookCard[];
  observations: LogbookObservation[];
  question: string;
}): string {
  const cards = params.cards
    .map(
      (card) =>
        `- ${formatClock(card.startMs)}-${formatClock(card.endMs)} [${card.category}] ${card.title}: ${card.summary} ${card.detail}`,
    )
    .join("\n");
  const observations = params.observations
    .map((obs) => `- ${formatClock(obs.startMs)}-${formatClock(obs.endMs)}: ${obs.text}`)
    .join("\n");
  return [
    `Answer the user's question about their tracked day (${params.day}) using ONLY the evidence below.`,
    "If the evidence does not contain the answer, say so plainly. Reference times like 14:05 when useful.",
    "",
    "Timeline cards:",
    cards || "(none)",
    "",
    "Detailed observations:",
    observations || "(none)",
    "",
    `Question: ${params.question}`,
    "",
    "Answer in 1-4 sentences.",
  ].join("\n");
}
