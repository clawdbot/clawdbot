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
};

type EventPromptText = {
  text: string;
  spans: EventPromptSpan[];
  implicitEventIndexes: number[];
};

type HeartbeatEventPromptSection = EventPromptText & {
  kind: HeartbeatEventClass;
};

export type HeartbeatEventPromptResolution = {
  prompt: string;
  handledEventIndexes: Record<HeartbeatEventClass, number[]>;
};

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
    spans.push({ eventIndex, start, end: text.length });
  }
  return { text, spans, implicitEventIndexes };
}

function truncateEventPromptText(value: EventPromptText, maxChars: number): EventPromptText {
  if (value.text.length <= maxChars) {
    return value;
  }
  const text = truncateUtf16Safe(value.text, maxChars);
  return {
    text: `${text}\n\n[truncated]`,
    spans: value.spans.flatMap((span) => {
      const end = Math.min(span.end, text.length);
      return span.start < end ? [{ ...span, end }] : [];
    }),
    implicitEventIndexes: value.implicitEventIndexes,
  };
}

function wrapEventPromptText(params: {
  kind: HeartbeatEventClass;
  prefix: string;
  eventText: EventPromptText;
  suffix: string;
}): HeartbeatEventPromptSection {
  const offset = params.prefix.length;
  return {
    kind: params.kind,
    text: `${params.prefix}${params.eventText.text}${params.suffix}`,
    spans: params.eventText.spans.map((span) => ({
      ...span,
      start: span.start + offset,
      end: span.end + offset,
    })),
    implicitEventIndexes: params.eventText.implicitEventIndexes,
  };
}

function buildImplicitEventPromptSection(params: {
  kind: HeartbeatEventClass;
  text: string;
  eventCount: number;
}): HeartbeatEventPromptSection {
  return {
    kind: params.kind,
    text: params.text,
    spans: [],
    implicitEventIndexes: Array.from({ length: params.eventCount }, (_, index) => index),
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
  },
): HeartbeatEventPromptSection {
  const deliverToUser = opts?.deliverToUser ?? true;
  const useHeartbeatResponseTool = opts?.useHeartbeatResponseTool ?? false;
  const eventText = joinEventPromptLines(pendingEvents.map((event) => event.trim() || null));
  if (!eventText.text) {
    const completionInstruction = useHeartbeatResponseTool
      ? HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS
      : deliverToUser
        ? `Reply ${SILENT_REPLY_TOKEN}.`
        : `Handle this internally and reply ${SILENT_REPLY_TOKEN} when nothing needs user-facing follow-up.`;
    return buildImplicitEventPromptSection({
      kind: "cron",
      text: `A scheduled cron event was triggered, but no event content was found. ${completionInstruction}`,
      eventCount: pendingEvents.length,
    });
  }
  return wrapEventPromptText({
    kind: "cron",
    prefix: "A scheduled reminder has been triggered. The reminder content is:\n\n",
    eventText,
    suffix: deliverToUser
      ? "\n\nPlease relay this reminder to the user in a helpful and friendly way."
      : "\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested.",
  });
}

function buildExecEventPrompt(
  pendingEvents: string[],
  opts?: { deliverToUser?: boolean; useHeartbeatResponseTool?: boolean },
): HeartbeatEventPromptSection {
  const deliverToUser = opts?.deliverToUser ?? true;
  const useHeartbeatResponseTool = opts?.useHeartbeatResponseTool ?? false;
  const formatted = formatExecEventPromptText(pendingEvents);
  const eventText = truncateEventPromptText(formatted, MAX_EXEC_EVENT_PROMPT_CHARS);
  if (!eventText.text) {
    const completionInstruction = useHeartbeatResponseTool
      ? HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS
      : `Reply ${SILENT_REPLY_TOKEN} only.`;
    return buildImplicitEventPromptSection({
      kind: "exec",
      text: `An async command completion event was triggered, but no command output was found. ${completionInstruction} Do not mention, summarize, or reuse output from any earlier run.`,
      eventCount: pendingEvents.length,
    });
  }
  if (!deliverToUser) {
    const text = useHeartbeatResponseTool
      ? "An async command completion event was triggered, but user delivery is disabled for this run. " +
        `Handle the result internally. ${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS} ` +
        "Do not mention, summarize, or reuse command output."
      : "An async command completion event was triggered, but user delivery is disabled for this run. " +
        `Handle the result internally and reply ${SILENT_REPLY_TOKEN} only. Do not mention, summarize, or reuse command output.`;
    return buildImplicitEventPromptSection({
      kind: "exec",
      text,
      eventCount: pendingEvents.length,
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
    });
  }
  return wrapEventPromptText({
    kind: "exec",
    prefix:
      "An async command you ran earlier has completed. The command completion details are:\n\n",
    eventText,
    suffix:
      "\n\nPlease relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. " +
      "If it failed, explain what went wrong.",
  });
}

type TruncatedHeartbeatEventPromptSection = {
  text: string;
  handledEventIndexes: number[];
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
  for (const span of section.spans) {
    if (retainedRanges.some((range) => span.start < range.end && span.end > range.start)) {
      handledEventIndexes.add(span.eventIndex);
    }
  }
  return {
    text,
    handledEventIndexes: [...handledEventIndexes].toSorted((left, right) => left - right),
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
  const opts = {
    deliverToUser: params.deliverToUser,
    useHeartbeatResponseTool: params.useHeartbeatResponseTool,
  };
  const sections: HeartbeatEventPromptSection[] = [];
  if (params.execEvents?.length) {
    sections.push(buildExecEventPrompt([...params.execEvents], opts));
  }
  if (params.cronEvents?.length) {
    sections.push(buildCronEventPrompt([...params.cronEvents], opts));
  }
  if (params.genericEvents?.length) {
    sections.push(buildSystemEventPrompt([...params.genericEvents], opts));
  }
  if (sections.length === 0) {
    sections.push(buildSystemEventPrompt([], opts));
  }
  const handledEventIndexes: HeartbeatEventPromptResolution["handledEventIndexes"] = {
    exec: [],
    cron: [],
    generic: [],
  };
  if (sections.length === 1) {
    const section = sections[0];
    if (!section) {
      return { prompt: "", handledEventIndexes };
    }
    const truncated = truncateHeartbeatEventPromptSection(
      section,
      MAX_HEARTBEAT_EVENT_PROMPT_CHARS,
    );
    handledEventIndexes[section.kind] = truncated.handledEventIndexes;
    return { prompt: truncated.text, handledEventIndexes };
  }
  const header =
    "Multiple heartbeat events were triggered. Assess each event and handle every event shown below.";
  const separator = "\n\n";
  const sectionBudget = Math.max(
    1,
    Math.floor(
      (MAX_HEARTBEAT_EVENT_PROMPT_CHARS - header.length - separator.length * sections.length) /
        sections.length,
    ),
  );
  const truncatedSections = sections.map((section) => {
    const truncated = truncateHeartbeatEventPromptSection(section, sectionBudget);
    handledEventIndexes[section.kind] = truncated.handledEventIndexes;
    return truncated.text;
  });
  return {
    prompt: [header, ...truncatedSections].join(separator),
    handledEventIndexes,
  };
}

/** Build a heartbeat prompt for system events that are not owned by exec or cron. */
function buildSystemEventPrompt(
  pendingEvents: string[],
  opts?: { deliverToUser?: boolean; useHeartbeatResponseTool?: boolean },
): HeartbeatEventPromptSection {
  const deliverToUser = opts?.deliverToUser ?? true;
  const useHeartbeatResponseTool = opts?.useHeartbeatResponseTool ?? false;
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
      text: `A system event was triggered, but no event content was found. ${completionInstruction}`,
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
    suffix: deliverToUser
      ? "\n\nAssess whether this event needs user-facing follow-up. If it does, explain it helpfully; otherwise " +
        completionInstruction +
        "."
      : "\n\nHandle this event internally. Do not relay it to the user unless explicitly requested. " +
        completionInstruction +
        ".",
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
