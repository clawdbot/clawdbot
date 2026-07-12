// Logbook analysis pipeline: frames -> observations -> revised timeline cards.
// Pure parsing/validation lives here so tests can cover it without the SDK.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { CARD_CATEGORIES } from "./prompts.js";
import { dayKeyFor } from "./store.js";
import type { LogbookCard, LogbookCardDraft, LogbookDistraction } from "./types.js";

/** Cards within this window before a batch are treated as a revisable draft. */
export const CARD_LOOKBACK_MS = 45 * 60 * 1000;
/** Frame gap that splits one analysis window into separate batches. */
const BATCH_MAX_GAP_MS = 2 * 60 * 1000;
/** Upper bound of images sent to the vision model per batch. */
export const MAX_FRAMES_PER_CALL = 16;

type ParsedSegment = { startMs: number; endMs: number; text: string };

/** Parses "HH:MM:SS" (or "H:MM", with optional am/pm) on a local day into epoch ms. */
export function clockToMs(day: string, clock: string): number | null {
  const match = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(clock);
  if (!match) {
    return null;
  }
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  const meridiem = match[4]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) {
    hours += 12;
  }
  if (meridiem === "am" && hours === 12) {
    hours = 0;
  }
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!dayMatch) {
    return null;
  }
  const year = Number(dayMatch[1]);
  const monthIndex = Number(dayMatch[2]) - 1;
  const dayOfMonth = Number(dayMatch[3]);
  const date = new Date(year, monthIndex, dayOfMonth, hours, minutes, seconds);
  // Component construction preserves wall-clock time across DST boundaries;
  // rejecting normalized fields also excludes invalid dates and skipped hours.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== dayOfMonth ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes ||
    date.getSeconds() !== seconds
  ) {
    return null;
  }
  return date.getTime();
}

/** Strips code fences and extracts the outermost JSON array/object from model text. */
export function extractJsonPayload(raw: string): string {
  const cleaned = raw.replaceAll("```json", "").replaceAll("```", "").trim();
  const firstBracket = cleaned.search(/[[{]/);
  if (firstBracket < 0) {
    return cleaned;
  }
  const open = cleaned[firstBracket];
  const close = open === "[" ? "]" : "}";
  const lastClose = cleaned.lastIndexOf(close);
  if (lastClose > firstBracket) {
    return cleaned.slice(firstBracket, lastClose + 1);
  }
  return cleaned;
}

export function parseObservationSegments(params: {
  raw: string;
  day: string;
  startMs: number;
  endMs: number;
}): ParsedSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(params.raw));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { segments?: unknown }).segments)
      ? (parsed as { segments: unknown[] }).segments
      : [];
  const segments: ParsedSegment[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const description = typeof record.description === "string" ? record.description.trim() : "";
    const startMs = typeof record.start === "string" ? clockToMs(params.day, record.start) : null;
    const endMs = typeof record.end === "string" ? clockToMs(params.day, record.end) : null;
    if (!description || startMs === null || endMs === null) {
      continue;
    }
    const clampedStart = Math.max(params.startMs, Math.min(startMs, params.endMs));
    const clampedEnd = Math.max(clampedStart, Math.min(endMs, params.endMs));
    segments.push({ startMs: clampedStart, endMs: clampedEnd, text: description });
  }
  return segments.toSorted((a, b) => a.startMs - b.startMs);
}

type RawCard = {
  startTime?: unknown;
  endTime?: unknown;
  category?: unknown;
  title?: unknown;
  summary?: unknown;
  detailedSummary?: unknown;
  distractions?: unknown;
  appSites?: unknown;
};

type CardParseResult = { ok: true; drafts: LogbookCardDraft[] } | { ok: false; error: string };

function normalizeCategory(value: unknown): string {
  const category = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (CARD_CATEGORIES as readonly string[]).includes(category) ? category : "other";
}

function normalizeDomain(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0];
  return domain && domain.length <= 100 ? domain : undefined;
}

function parseDistractions(day: string, value: unknown): LogbookDistraction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const distractions: LogbookDistraction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const startMs = typeof record.startTime === "string" ? clockToMs(day, record.startTime) : null;
    const endMs = typeof record.endTime === "string" ? clockToMs(day, record.endTime) : null;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (startMs === null || endMs === null || !title || endMs <= startMs) {
      continue;
    }
    distractions.push({ startMs, endMs, title });
  }
  return distractions;
}

export function parseCardsJson(params: {
  raw: string;
  day: string;
  windowStartMs: number;
  windowEndMs: number;
}): CardParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(params.raw));
  } catch (err) {
    return { ok: false, error: `Output is not valid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Output must be a JSON array of cards." };
  }
  const drafts: LogbookCardDraft[] = [];
  const problems: string[] = [];
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      problems.push(`Card ${index}: not an object.`);
      return;
    }
    const raw = entry as RawCard;
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    const startMs = typeof raw.startTime === "string" ? clockToMs(params.day, raw.startTime) : null;
    const endMs = typeof raw.endTime === "string" ? clockToMs(params.day, raw.endTime) : null;
    if (startMs === null || endMs === null) {
      problems.push(`Card ${index}: startTime/endTime must be HH:MM:SS local time.`);
      return;
    }
    if (endMs <= startMs) {
      problems.push(`Card ${index}: endTime must be after startTime.`);
      return;
    }
    if (!title || !summary) {
      problems.push(`Card ${index}: title and summary are required.`);
      return;
    }
    const appSites =
      raw.appSites && typeof raw.appSites === "object"
        ? (raw.appSites as Record<string, unknown>)
        : {};
    drafts.push({
      day: params.day,
      startMs,
      endMs,
      title,
      summary,
      detail: typeof raw.detailedSummary === "string" ? raw.detailedSummary.trim() : "",
      category: normalizeCategory(raw.category),
      appPrimary: normalizeDomain(appSites.primary),
      appSecondary: normalizeDomain(appSites.secondary),
      distractions: parseDistractions(params.day, raw.distractions),
      keyframeId: undefined,
    });
  });
  if (problems.length > 0) {
    return { ok: false, error: problems.join("\n") };
  }
  if (drafts.length === 0) {
    return { ok: false, error: "Output contained no valid cards." };
  }
  const sorted = drafts.toSorted((a, b) => a.startMs - b.startMs);
  const normalized: LogbookCardDraft[] = [];
  for (const current of sorted) {
    const previous = normalized.at(-1);
    if (!previous) {
      normalized.push(current);
      continue;
    }
    const overlapMs = previous.endMs - current.startMs;
    if (overlapMs > 60 * 1000) {
      return {
        ok: false,
        error: `Cards ${normalized.length - 1} and ${normalized.length} overlap by ${Math.round(overlapMs / 60000)} minutes; adjacent cards must meet cleanly.`,
      };
    }
    if (overlapMs > 0) {
      // Trim sub-minute overlaps instead of round-tripping to the model again.
      normalized.push({ ...current, startMs: previous.endMs });
    } else {
      normalized.push(current);
    }
  }
  return { ok: true, drafts: normalized };
}

/** Sub-minute slack so minute-rounded model times do not fail coverage checks. */
const COVERAGE_TOLERANCE_MS = 2 * 60 * 1000;

function formatClockForError(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Validates that drafts cover every required span before the destructive
 * window replacement. Without this, a syntactically valid but partial model
 * output would silently erase previously synthesized cards.
 */
export function validateCardCoverage(params: {
  drafts: Array<{ startMs: number; endMs: number }>;
  requiredSpans: Array<{ startMs: number; endMs: number }>;
  windowStartMs: number;
  windowEndMs: number;
  toleranceMs?: number;
}): { ok: true } | { ok: false; error: string } {
  const tolerance = params.toleranceMs ?? COVERAGE_TOLERANCE_MS;
  const problems: string[] = [];
  for (const draft of params.drafts) {
    if (
      draft.startMs < params.windowStartMs - tolerance ||
      draft.endMs > params.windowEndMs + tolerance
    ) {
      problems.push(
        `Card ${formatClockForError(draft.startMs)}-${formatClockForError(draft.endMs)} lies outside the revision window ${formatClockForError(params.windowStartMs)}-${formatClockForError(params.windowEndMs)}.`,
      );
    }
  }
  const covered = params.drafts
    .map((draft) => ({ startMs: draft.startMs, endMs: draft.endMs }))
    .toSorted((a, b) => a.startMs - b.startMs);
  for (const span of params.requiredSpans) {
    let cursor = span.startMs;
    for (const interval of covered) {
      if (interval.endMs <= cursor) {
        continue;
      }
      if (interval.startMs > cursor + tolerance) {
        break;
      }
      cursor = Math.max(cursor, interval.endMs);
      if (cursor >= span.endMs - tolerance) {
        break;
      }
    }
    if (cursor < span.endMs - tolerance) {
      problems.push(
        `Time ${formatClockForError(Math.max(cursor, span.startMs))}-${formatClockForError(span.endMs)} from the previous timeline is not covered; do not drop existing cards or observed time.`,
      );
    }
  }
  if (problems.length > 0) {
    return { ok: false, error: problems.join("\n") };
  }
  return { ok: true };
}

/** Union of the revision window: previous draft cards plus the new batch range. */
export function revisionWindow(params: {
  batchStartMs: number;
  batchEndMs: number;
  previousCards: LogbookCard[];
}): { startMs: number; endMs: number } {
  let startMs = params.batchStartMs;
  let endMs = params.batchEndMs;
  for (const card of params.previousCards) {
    startMs = Math.min(startMs, card.startMs);
    endMs = Math.max(endMs, card.endMs);
  }
  return { startMs, endMs };
}

/** Groups pending frames into one batch window, splitting on large gaps. */
export function selectBatchFrames(params: {
  frames: Array<{ id: number; capturedAtMs: number }>;
  /** Close an in-progress window immediately instead of waiting for elapse. */
  force?: boolean;
  windowMs: number;
  nowMs: number;
}): { frameIds: number[]; startMs: number; endMs: number } | null {
  if (params.frames.length === 0) {
    return null;
  }
  const first = expectDefined(params.frames[0], "first pending Logbook frame");
  const firstDay = dayKeyFor(first.capturedAtMs);
  const nextDayStart = new Date(first.capturedAtMs);
  nextDayStart.setHours(24, 0, 0, 0);
  const windowEnd = Math.min(first.capturedAtMs + params.windowMs, nextDayStart.getTime());
  const selected: Array<{ id: number; capturedAtMs: number }> = [];
  let previousTs = first.capturedAtMs;
  let endedEarly = false;
  for (const frame of params.frames) {
    if (frame.capturedAtMs >= windowEnd) {
      endedEarly = dayKeyFor(frame.capturedAtMs) !== firstDay;
      break;
    }
    if (selected.length > 0 && frame.capturedAtMs - previousTs > BATCH_MAX_GAP_MS) {
      endedEarly = true;
      break;
    }
    // Batches never span local midnight: every downstream clock (observations,
    // cards, day keys) is parsed against the batch's single day.
    if (selected.length > 0 && dayKeyFor(frame.capturedAtMs) !== firstDay) {
      endedEarly = true;
      break;
    }
    selected.push(frame);
    previousTs = frame.capturedAtMs;
  }
  if (selected.length === 0) {
    return null;
  }
  const last = expectDefined(selected.at(-1), "last selected Logbook frame");
  // Only close a batch once its window has elapsed (or a gap/midnight ended
  // it), so a window in progress keeps accumulating frames; `force` closes an
  // in-progress window immediately (analyze now).
  const windowElapsed = params.nowMs >= windowEnd;
  if (!windowElapsed && !endedEarly && !params.force) {
    return null;
  }
  // A normally elapsed window ends at its boundary so consecutive batches meet
  // cleanly; ending at the last frame would leak one capture interval per
  // batch as a permanent timeline gap. Early or forced closures must not claim
  // time past the last observed frame (idle gap, next day, or the future).
  const endMs = windowElapsed && !endedEarly ? windowEnd : last.capturedAtMs + 1;
  return {
    frameIds: selected.map((frame) => frame.id),
    startMs: first.capturedAtMs,
    endMs,
  };
}

/** Evenly samples frames so a batch stays within the per-call image budget. */
export function sampleFrames<T>(frames: T[], max: number): T[] {
  if (max <= 0) {
    return [];
  }
  if (frames.length <= max) {
    return frames;
  }
  if (max === 1) {
    return [expectDefined(frames[0], "first Logbook frame sample")];
  }
  const sampled: T[] = [];
  const step = (frames.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) {
    sampled.push(expectDefined(frames[Math.round(i * step)], "sampled Logbook frame"));
  }
  return [...new Set(sampled)];
}

/** Picks the frame closest to a card's midpoint as its keyframe. */
export function pickKeyframeId(
  card: { startMs: number; endMs: number },
  frames: Array<{ id: number; capturedAtMs: number }>,
): number | undefined {
  if (frames.length === 0) {
    return undefined;
  }
  const midpoint = card.startMs + (card.endMs - card.startMs) / 2;
  let best = expectDefined(frames[0], "first Logbook keyframe candidate");
  for (const frame of frames) {
    if (Math.abs(frame.capturedAtMs - midpoint) < Math.abs(best.capturedAtMs - midpoint)) {
      best = frame;
    }
  }
  return best.id;
}
