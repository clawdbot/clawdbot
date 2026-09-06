// Filters heartbeat event text before it is added to prompts.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  isHeartbeatAcknowledgementText,
} from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

const MAX_EXEC_EVENT_PROMPT_CHARS = 8_000;
const MAX_SYSTEM_EVENT_PROMPT_CHARS = 8_000;
const MAX_HEARTBEAT_EVENT_PROMPT_CHARS = 16_000;
export const HEARTBEAT_DELIVERY_CONTEXT_KEY_PREFIX = "heartbeat-delivery:";
const STRUCTURED_EXEC_COMPLETION_EVENT_RE =
  /^exec (completed|failed) \(([a-z0-9_-]{1,64}), (code -?\d+|signal [^)]+)\)(?: :: ([\s\S]*))?$/i;

type StructuredExecCompletionEvent = {
  raw: string;
  action: string;
  id: string;
  result: string;
  output: string;
  succeeded: boolean;
};

type HeartbeatEventClass = "exec" | "cron" | "generic";

type EventPromptSpan = {
  eventIndex: number;
  start: number;
  end: number;
  /**
   * Length in the pre-truncation source. Retention decisions compare against
   * this even after later stages clip `end`, so gap attribution survives both
   * truncation stages.
   */
  originalLength: number;
};

type EventPromptText = {
  text: string;
  spans: EventPromptSpan[];
  implicitEventIndexes: number[];
  /** Event content that truncation dropped, keyed by event index. */
  unseenEventSuffixes: Map<number, string>;
};

type UnseenEventRemainder = {
  kind: HeartbeatEventClass;
  eventIndex: number;
  text: string;
};

type HeartbeatEventPromptSection = EventPromptText & {
  kind: HeartbeatEventClass;
  /** Whether the section carries event content the user may need delivered. */
  hasDeliverableContent: boolean;
  /**
   * Framing appended after the event content. It is excluded from truncation
   * budget math so the retained-event selection cannot depend on delivery or
   * response-tool mode.
   */
  suffix: string;
};

export type HeartbeatEventPromptResolution = {
  prompt: string;
  handledEventIndexes: Record<HeartbeatEventClass, number[]>;
  /**
   * Content of handled events that truncation hid from the model. Callers must
   * re-queue these remainders when consuming the originals so partially shown
   * events are never silently dropped.
   */
  unseenRemainders: UnseenEventRemainder[];
};

/**
 * Reserved framing budget so a section's truncation boundary (and therefore
 * which events count as surfaced) is identical across delivery modes.
 */
const MAX_SECTION_SUFFIX_CHARS = 256;

/**
 * An event counts as surfaced only when at least half of its content survives
 * truncation; a bisected fragment must never mark the whole entry handled.
 */
function joinEventPromptLines(lines: readonly (string | null)[]): EventPromptText {
  let text = "";
  const spans: EventPromptSpan[] = [];
  const implicitEventIndexes: number[] = [];
  for (const [eventIndex, line] of lines.entries()) {
    if (!line) {
      implicitEventIndexes.push(eventIndex);
      continue;
    }
    if (text) {
      text += "\n";
    }
    const start = text.length;
    text += line;
    const end = text.length;
    spans.push({ eventIndex, start, end, originalLength: end - start });
  }
  return { text, spans, implicitEventIndexes, unseenEventSuffixes: new Map() };
}

function truncateEventPromptText(value: EventPromptText, maxChars: number): EventPromptText {
  if (value.text.length <= maxChars) {
    return value;
  }
  const text = truncateUtf16Safe(value.text, maxChars);
  const unseenEventSuffixes = new Map(value.unseenEventSuffixes);
  for (const span of value.spans) {
    if (span.end > text.length && span.start < text.length) {
      unseenEventSuffixes.set(
        span.eventIndex,
        (unseenEventSuffixes.get(span.eventIndex) ?? "") + value.text.slice(text.length, span.end),
      );
    } else if (span.start >= text.length) {
      // Wholly dropped events keep their full text unseen; the caller decides
      // whether they count as handled at all.
      unseenEventSuffixes.set(span.eventIndex, value.text.slice(span.start, span.end));
    }
  }
  return {
    text: `${text}\n\n[truncated]`,
    // Spans survive every truncation stage (with clipped ends) so later stages
    // can still attribute hidden ranges to their events; handling is decided
    // per consumer against originalLength, not by dropping metadata here.
    spans: value.spans.map((span) => ({ ...span, end: Math.min(span.end, text.length) })),
    implicitEventIndexes: value.implicitEventIndexes,
    unseenEventSuffixes,
  };
}

function wrapEventPromptText(params: {
  kind: HeartbeatEventClass;
  prefix: string;
  eventText: EventPromptText;
  suffix: string;
  hasDeliverableContent?: boolean;
  /**
   * When set, the suffix is subtracted from the truncation budget (its length
   * is part of the constant section reserve) instead of being appended past the
   * bounded body, so composed batches never exceed the aggregate limit.
   */
  boundSuffix?: boolean;
}): HeartbeatEventPromptSection {
  const offset = params.prefix.length;
  const suffix = params.boundSuffix ? params.suffix : "";
  return {
    kind: params.kind,
    text: `${params.prefix}${params.eventText.text}${suffix}`,
    suffix: params.boundSuffix ? "" : params.suffix,
    spans: params.eventText.spans.map((span) => ({
      ...span,
      start: span.start + offset,
      end: span.end + offset,
    })),
    implicitEventIndexes: params.eventText.implicitEventIndexes,
    unseenEventSuffixes: params.eventText.unseenEventSuffixes,
    hasDeliverableContent: params.hasDeliverableContent ?? params.eventText.text.length > 0,
  };
}

function buildImplicitEventPromptSection(params: {
  kind: HeartbeatEventClass;
  text: string;
  eventCount: number;
  hasDeliverableContent?: boolean;
}): HeartbeatEventPromptSection {
  return {
    kind: params.kind,
    text: params.text,
    suffix: "",
    spans: [],
    implicitEventIndexes: Array.from({ length: params.eventCount }, (_, index) => index),
    unseenEventSuffixes: new Map(),
    hasDeliverableContent: params.hasDeliverableContent ?? false,
  };
}

function parseStructuredExecCompletionEvent(evt: string): StructuredExecCompletionEvent | null {
  const trimmed = evt.trim();
  const match = STRUCTURED_EXEC_COMPLETION_EVENT_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  const action = match[1] ?? "";
  const result = match[3] ?? "";
  return {
    raw: trimmed,
    action,
    id: match[2] ?? "",
    result,
    output: (match[4] ?? "").trim(),
    succeeded: action.toLowerCase() === "completed" && result.toLowerCase() === "code 0",
  };
}

export function isRelayableExecCompletionEvent(evt: string): boolean {
  const parsed = parseStructuredExecCompletionEvent(evt);
  if (!parsed) {
    return isExecCompletionEvent(evt);
  }
  if (parsed.output) {
    return true;
  }
  return !parsed.succeeded;
}

function formatExecEventPromptText(pendingEvents: string[]): EventPromptText & {
  hasMissingOutputFailure: boolean;
} {
  let hasMissingOutputFailure = false;
  const eventText = joinEventPromptLines(
    pendingEvents.map((event) => {
      const parsed = parseStructuredExecCompletionEvent(event);
      if (!parsed) {
        return event.trim() || null;
      }
      if (parsed.output) {
        return parsed.raw;
      }
      if (parsed.succeeded) {
        return null;
      }
      hasMissingOutputFailure = true;
      return `Exec ${parsed.action} (${parsed.id}, ${parsed.result}) without captured stdout/stderr.`;
    }),
  );
  return { ...eventText, hasMissingOutputFailure };
}

// Build a dynamic prompt for cron events by embedding the actual event content.
// This ensures the model sees the reminder text directly instead of relying on
// "shown in the system messages above" which may not be visible in context.
function buildCronEventPrompt(
  pendingEvents: string[],
  opts?: {
    deliverToUser?: boolean;
    useHeartbeatResponseTool?: boolean;
    standalone?: boolean;
  },
): HeartbeatEventPromptSection {
  const deliverToUser = opts?.deliverToUser ?? true;
  const useHeartbeatResponseTool = opts?.useHeartbeatResponseTool ?? false;
  // Standalone sections carry their own completion directive; composed batches
  // decide silence once for the whole turn.
  const standalone = opts?.standalone ?? true;
  const eventText = joinEventPromptLines(pendingEvents.map((event) => event.trim() || null));
  if (!eventText.text) {
    const completionInstruction = useHeartbeatResponseTool
      ? HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS
      : deliverToUser
        ? `Reply ${SILENT_REPLY_TOKEN}.`
        : `Handle this internally and reply ${SILENT_REPLY_TOKEN} when nothing needs user-facing follow-up.`;
    return buildImplicitEventPromptSection({
      kind: "cron",
      text: `A scheduled cron event was triggered, but no event content was found.${
        standalone ? ` ${completionInstruction}` : ""
      }`,
      eventCount: pendingEvents.length,
    });
  }
  return wrapEventPromptText({
    kind: "cron",
    prefix: "A scheduled reminder has been triggered. The reminder content is:\n\n",
    eventText,
    suffix: standalone
      ? deliverToUser
        ? "\n\nPlease relay this reminder to the user in a helpful and friendly way."
        : "\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested."
      : "",
  });
}

function buildExecEventPrompt(
  pendingEvents: string[],
  opts?: {
    deliverToUser?: boolean;
    useHeartbeatResponseTool?: boolean;
    standalone?: boolean;
  },
): HeartbeatEventPromptSection {
  const deliverToUser = opts?.deliverToUser ?? true;
  const useHeartbeatResponseTool = opts?.useHeartbeatResponseTool ?? false;
  // Standalone sections carry their own completion directive; composed batches
  // decide silence once for the whole turn.
  const standalone = opts?.standalone ?? true;
  const formatted = formatExecEventPromptText(pendingEvents);
  const eventText = truncateEventPromptText(formatted, MAX_EXEC_EVENT_PROMPT_CHARS);
  if (!eventText.text) {
    const completionInstruction = useHeartbeatResponseTool
      ? HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS
      : `Reply ${SILENT_REPLY_TOKEN} only.`;
    return buildImplicitEventPromptSection({
      kind: "exec",
      text: `An async command completion event was triggered, but no command output was found.${
        standalone ? ` ${completionInstruction}` : ""
      } Do not mention, summarize, or reuse output from any earlier run.`,
      eventCount: pendingEvents.length,
    });
  }
  if (!deliverToUser) {
    const text =
      "An async command completion event was triggered, but user delivery is disabled for this run. " +
      (useHeartbeatResponseTool
        ? standalone
          ? `Handle the result internally. ${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS} `
          : ""
        : standalone
          ? `Handle the result internally and reply ${SILENT_REPLY_TOKEN} only. `
          : "") +
      "Do not mention, summarize, or reuse command output.";
    return buildImplicitEventPromptSection({
      kind: "exec",
      text,
      eventCount: pendingEvents.length,
      hasDeliverableContent: true,
    });
  }
  if (formatted.hasMissingOutputFailure) {
    return wrapEventPromptText({
      kind: "exec",
      prefix:
        "An async command you ran earlier completed without captured stdout/stderr. The completion details are:\n\n",
      eventText,
      suffix:
        "\n\nTell the user the command completed without captured output and include the exit status or signal. " +
        "Do not ask the user to provide missing logs, and do not try to retrieve logs from an exec/session id.",
      // Constant suffix reserve keeps composed-batch budgeting (and therefore
      // the retained selection) independent of this mode-dependent instruction.
      boundSuffix: !standalone,
    });
  }
  return wrapEventPromptText({
    kind: "exec",
    prefix:
      "An async command you ran earlier has completed. The command completion details are:\n\n",
    eventText,
    suffix: standalone
      ? "\n\nPlease relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. " +
        "If it failed, explain what went wrong."
      : "",
  });
}

type TruncatedHeartbeatEventPromptSection = {
  text: string;
  handledEventIndexes: number[];
  unseenEventSuffixes: Map<number, string>;
};

function truncateHeartbeatEventPromptSection(
  section: HeartbeatEventPromptSection,
  maxChars: number,
): TruncatedHeartbeatEventPromptSection {
  const retainedRanges: Array<{ start: number; end: number }> = [];
  let text = section.text;
  if (section.text.length <= maxChars) {
    retainedRanges.push({ start: 0, end: section.text.length });
  } else {
    const marker = "\n\n[truncated]\n\n";
    const bodyBudget = Math.max(0, maxChars - marker.length);
    const headBudget = Math.ceil(bodyBudget * 0.7);
    const head = truncateUtf16Safe(section.text, headBudget);
    const tailBudget = bodyBudget - headBudget;
    const tail = tailBudget > 0 ? sliceUtf16Safe(section.text, -tailBudget) : "";
    text = `${head}${marker}${tail}`;
    retainedRanges.push({ start: 0, end: head.length });
    if (tail) {
      retainedRanges.push({ start: section.text.length - tail.length, end: section.text.length });
    }
  }
  const handledEventIndexes = new Set(section.implicitEventIndexes);
  const unseenEventSuffixes = new Map(section.unseenEventSuffixes);
  for (const span of section.spans) {
    let retainedChars = 0;
    let unseenGap = "";
    let covered = span.start;
    // Retained ranges are ordered head-then-tail; walk them to collect both the
    // retained length and the gap content truncation hid from this event.
    for (const range of retainedRanges) {
      const overlapStart = Math.max(span.start, range.start);
      const overlapEnd = Math.min(span.end, range.end);
      if (overlapEnd > overlapStart) {
        retainedChars += overlapEnd - overlapStart;
        if (overlapStart > covered) {
          unseenGap += section.text.slice(covered, overlapStart);
        }
        covered = Math.max(covered, overlapEnd);
      }
    }
    if (covered < span.end) {
      unseenGap += section.text.slice(covered, span.end);
    }
    if (unseenGap) {
      // Record every aggregate gap regardless of the retained threshold: exec
      // entries are consumed as a class, so even a mostly hidden span needs its
      // gap re-queued. The aggregate gap sits before any class-cap suffix, so
      // the combined remainder keeps source order.
      unseenEventSuffixes.set(
        span.eventIndex,
        unseenGap + (unseenEventSuffixes.get(span.eventIndex) ?? ""),
      );
    }
    // An event the model saw any part of is surfaced, together with its exact
    // hidden remainder; this keeps oversized entries making bounded progress
    // across successive wakes instead of stalling below a half-retained bar.
    if (retainedChars > 0) {
      handledEventIndexes.add(span.eventIndex);
    }
  }
  return {
    text,
    handledEventIndexes: [...handledEventIndexes].toSorted((left, right) => left - right),
    unseenEventSuffixes,
  };
}

/** Compose every event class inspected by one heartbeat into a single model turn. */
export function resolveHeartbeatEventPrompt(params: {
  execEvents?: readonly string[];
  cronEvents?: readonly string[];
  genericEvents?: readonly string[];
  deliverToUser?: boolean;
  useHeartbeatResponseTool?: boolean;
}): HeartbeatEventPromptResolution {
  const deliverToUser = params.deliverToUser ?? true;
  const useHeartbeatResponseTool = params.useHeartbeatResponseTool ?? false;
  const opts = { deliverToUser, useHeartbeatResponseTool };
  const hasExecEvents = (params.execEvents?.length ?? 0) > 0;
  const hasCronEvents = (params.cronEvents?.length ?? 0) > 0;
  const hasGenericEvents = (params.genericEvents?.length ?? 0) > 0;
  // The completion policy is decided once for a composed batch, so no section
  // carries its own silence or relay directive in that mode.
  const composedBatch = [hasExecEvents, hasCronEvents, hasGenericEvents].filter(Boolean).length > 1;
  const sectionOpts = composedBatch ? { ...opts, standalone: false } : opts;
  const sections: HeartbeatEventPromptSection[] = [];
  if (hasExecEvents) {
    sections.push(buildExecEventPrompt([...(params.execEvents ?? [])], sectionOpts));
  }
  if (hasCronEvents) {
    sections.push(buildCronEventPrompt([...(params.cronEvents ?? [])], sectionOpts));
  }
  if (hasGenericEvents) {
    sections.push(buildSystemEventPrompt([...(params.genericEvents ?? [])], sectionOpts));
  }
  if (sections.length === 0) {
    sections.push(buildSystemEventPrompt([], opts));
  }
  const handledEventIndexes: HeartbeatEventPromptResolution["handledEventIndexes"] = {
    exec: [],
    cron: [],
    generic: [],
  };
  const unseenRemainders: UnseenEventRemainder[] = [];
  // One collector per section: exec entries are additionally consumed as a
  // class via allEventIndexes below, so their remainders must be gathered from
  // every handled index exactly once.
  const collectRemainders = (
    section: HeartbeatEventPromptSection,
    truncated: TruncatedHeartbeatEventPromptSection,
  ) => {
    for (const index of truncated.handledEventIndexes) {
      const unseen = truncated.unseenEventSuffixes.get(index);
      if (unseen) {
        unseenRemainders.push({ kind: section.kind, eventIndex: index, text: unseen });
      }
    }
  };
  if (sections.length === 1) {
    const section = sections[0];
    if (!section) {
      return { prompt: "", handledEventIndexes, unseenRemainders: [] };
    }
    // Reserve a constant framing budget so the truncation boundary never
    // depends on the mode-dependent suffix the model actually receives.
    const truncated = truncateHeartbeatEventPromptSection(
      section,
      MAX_HEARTBEAT_EVENT_PROMPT_CHARS - MAX_SECTION_SUFFIX_CHARS,
    );
    if (hasExecEvents) {
      handledEventIndexes.exec = allEventIndexes(params.execEvents);
    } else {
      handledEventIndexes[section.kind] = truncated.handledEventIndexes;
    }
    collectRemainders(section, {
      ...truncated,
      handledEventIndexes: hasExecEvents
        ? allEventIndexes(params.execEvents)
        : truncated.handledEventIndexes,
    });
    return { prompt: truncated.text + section.suffix, handledEventIndexes, unseenRemainders };
  }
  const batchCompletionInstruction = useHeartbeatResponseTool
    ? HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS
    : deliverToUser
      ? sections.some((section) => section.hasDeliverableContent)
        ? "Handle every event above. Relay the reminders and command results that need the user's attention, and reply " +
          `${SILENT_REPLY_TOKEN} only if nothing needs user-facing follow-up.`
        : `Reply ${SILENT_REPLY_TOKEN} only after handling the events above.`
      : `Handle every event above internally. Do not relay anything to the user unless explicitly requested, and reply ${SILENT_REPLY_TOKEN} when done.`;
  const header =
    "Multiple heartbeat events were triggered. Assess each event and handle every event shown below.";
  const separator = "\n\n";
  // Reserve the longest possible completion instruction so the per-section
  // budget (and therefore the retained-event selection) is identical across
  // relay, internal-only, and response-tool modes.
  const sectionBudget = Math.max(
    1,
    Math.floor(
      (MAX_HEARTBEAT_EVENT_PROMPT_CHARS -
        header.length -
        MAX_BATCH_COMPLETION_INSTRUCTION_CHARS -
        separator.length * (sections.length + 1)) /
        sections.length,
    ),
  );
  const truncatedSections = sections.map((section) => {
    const truncated = truncateHeartbeatEventPromptSection(section, sectionBudget);
    const effectiveHandled =
      section.kind === "exec" && hasExecEvents
        ? allEventIndexes(params.execEvents)
        : truncated.handledEventIndexes;
    handledEventIndexes[section.kind] = effectiveHandled;
    collectRemainders(section, { ...truncated, handledEventIndexes: effectiveHandled });
    return truncated.text + section.suffix;
  });
  return {
    prompt: [header, ...truncatedSections, batchCompletionInstruction].join(separator),
    handledEventIndexes,
    unseenRemainders,
  };
}

const MAX_BATCH_COMPLETION_INSTRUCTION_CHARS = Math.max(
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS.length,
  `Handle every event above. Relay the reminders and command results that need the user's attention, and reply ${SILENT_REPLY_TOKEN} only if nothing needs user-facing follow-up.`
    .length,
  `Reply ${SILENT_REPLY_TOKEN} only after handling the events above.`.length,
  `Handle every event above internally. Do not relay anything to the user unless explicitly requested, and reply ${SILENT_REPLY_TOKEN} when done.`
    .length,
);

/**
 * Exec completion entries are consumed as a class whenever their section is
 * present: rendering truncation bounds what the model sees, but ordinary reply
 * admission never drains exec completions, so per-entry retention would strand
 * truncated entries with no future owner.
 */
function allEventIndexes(events: readonly string[] | undefined): number[] {
  return Array.from({ length: events?.length ?? 0 }, (_, index) => index);
}

/** Build a heartbeat prompt for system events that are not owned by exec or cron. */
function buildSystemEventPrompt(
  pendingEvents: string[],
  opts?: {
    deliverToUser?: boolean;
    useHeartbeatResponseTool?: boolean;
    standalone?: boolean;
  },
): HeartbeatEventPromptSection {
  const deliverToUser = opts?.deliverToUser ?? true;
  const useHeartbeatResponseTool = opts?.useHeartbeatResponseTool ?? false;
  // Standalone sections carry their own completion directive; composed batches
  // decide silence once for the whole turn.
  const standalone = opts?.standalone ?? true;
  const eventText = truncateEventPromptText(
    joinEventPromptLines(pendingEvents.map(compactSystemEvent)),
    MAX_SYSTEM_EVENT_PROMPT_CHARS,
  );
  if (!eventText.text) {
    const completionInstruction = useHeartbeatResponseTool
      ? HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS
      : `Reply ${SILENT_REPLY_TOKEN} only.`;
    return buildImplicitEventPromptSection({
      kind: "generic",
      text: `A system event was triggered, but no event content was found.${
        standalone ? ` ${completionInstruction}` : ""
      }`,
      eventCount: pendingEvents.length,
    });
  }
  const completionInstruction = useHeartbeatResponseTool
    ? HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS
    : `reply ${SILENT_REPLY_TOKEN} when nothing needs user-facing follow-up`;
  return wrapEventPromptText({
    kind: "generic",
    prefix: "A system event was triggered. The event details are:\n\n",
    eventText,
    suffix: standalone
      ? deliverToUser
        ? "\n\nAssess whether this event needs user-facing follow-up. If it does, explain it helpfully; otherwise " +
          completionInstruction +
          "."
        : "\n\nHandle this event internally. Do not relay it to the user unless explicitly requested. " +
          completionInstruction +
          "."
      : "",
  });
}

const HEARTBEAT_OK_PREFIX = normalizeLowercaseStringOrEmpty(HEARTBEAT_TOKEN);

export function isHeartbeatNoiseEvent(evt: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(evt);
  if (!lower) {
    return false;
  }
  return (
    isHeartbeatAcknowledgementText(evt, 0) ||
    (lower.startsWith(HEARTBEAT_OK_PREFIX) &&
      !/[a-z0-9_]/.test(lower.charAt(HEARTBEAT_OK_PREFIX.length))) ||
    lower.includes("heartbeat poll") ||
    lower.includes("heartbeat wake")
  );
}

export function compactSystemEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.includes("reason periodic")) {
    return null;
  }
  if (lower.startsWith("read heartbeat.md")) {
    return null;
  }
  if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) {
    return null;
  }
  if (trimmed.startsWith("Node:")) {
    return trimmed.replace(/ · last input [^·]+/i, "").trim();
  }
  return trimmed;
}

export function isExecCompletionEvent(evt: string): boolean {
  const trimmed = evt.trimStart();
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  return (
    /^exec finished(?::|\s*\()/.test(normalized) ||
    STRUCTURED_EXEC_COMPLETION_EVENT_RE.test(trimmed)
  );
}

export function isHeartbeatDeliveryAwarenessEvent(event: { contextKey?: string | null }): boolean {
  return event.contextKey?.startsWith(HEARTBEAT_DELIVERY_CONTEXT_KEY_PREFIX) ?? false;
}

// Returns true when a system event should be treated as real cron reminder content.
export function isCronSystemEvent(evt: string) {
  if (!evt.trim()) {
    return false;
  }
  return !isHeartbeatNoiseEvent(evt) && !isExecCompletionEvent(evt);
}
