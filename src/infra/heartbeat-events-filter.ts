import { HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS } from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const MAX_EXEC_EVENT_PROMPT_CHARS = 8_000;
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

function formatExecEventPromptText(pendingEvents: string[]): {
  text: string;
  hasMissingOutputFailure: boolean;
} {
  let hasMissingOutputFailure = false;
  const lines = pendingEvents.flatMap((event) => {
    const parsed = parseStructuredExecCompletionEvent(event);
    if (!parsed) {
      const trimmed = event.trim();
      return trimmed ? [trimmed] : [];
    }
    if (parsed.output) {
      return [parsed.raw];
    }
    if (parsed.succeeded) {
      return [];
    }
    hasMissingOutputFailure = true;
    return [
      `Exec ${parsed.action} (${parsed.id}, ${parsed.result}) without captured stdout/stderr.`,
    ];
  });
  return { text: lines.join("\n").trim(), hasMissingOutputFailure };
}

// Build a dynamic prompt for cron events by embedding the actual event content.
// This ensures the model sees the reminder text directly instead of relying on
// "shown in the system messages above" which may not be visible in context.
export function buildCronEventPrompt(
  pendingEvents: string[],
  opts?: {
    deliverToUser?: boolean;
    useHeartbeatResponseTool?: boolean;
  },
): string {
  const deliverToUser = opts?.deliverToUser ?? true;
  const useHeartbeatResponseTool = opts?.useHeartbeatResponseTool ?? false;
  const eventText = pendingEvents.join("\n").trim();
  if (!eventText) {
    if (useHeartbeatResponseTool) {
      return (
        "A scheduled cron event was triggered, but no event content was found. " +
        HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS
      );
    }
    if (!deliverToUser) {
      return (
        "A scheduled cron event was triggered, but no event content was found. " +
        "Handle this internally and reply HEARTBEAT_OK when nothing needs user-facing follow-up."
      );
    }
    return (
      "A scheduled cron event was triggered, but no event content was found. " +
      "Reply HEARTBEAT_OK."
    );
  }
  if (!deliverToUser) {
    return (
      "A scheduled reminder has been triggered. The reminder content is:\n\n" +
      eventText +
      "\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested."
    );
  }
  return (
    "A scheduled reminder has been triggered. The reminder content is:\n\n" +
    eventText +
    "\n\nPlease relay this reminder to the user in a helpful and friendly way."
  );
}

export function buildExecEventPrompt(
  pendingEvents: string[],
  opts?: { deliverToUser?: boolean; useHeartbeatResponseTool?: boolean },
): string {
  const deliverToUser = opts?.deliverToUser ?? true;
  const useHeartbeatResponseTool = opts?.useHeartbeatResponseTool ?? false;
  const { text: rawEventText, hasMissingOutputFailure } = formatExecEventPromptText(pendingEvents);
  const eventText =
    rawEventText.length > MAX_EXEC_EVENT_PROMPT_CHARS
      ? `${rawEventText.slice(0, MAX_EXEC_EVENT_PROMPT_CHARS)}\n\n[truncated]`
      : rawEventText;
  if (!eventText) {
    if (useHeartbeatResponseTool) {
      return (
        "An async command completion event was triggered, but no command output was found. " +
        `${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS} Do not mention, summarize, or reuse output from any earlier run.`
      );
    }
    return (
      "An async command completion event was triggered, but no command output was found. " +
      "Reply HEARTBEAT_OK only. Do not mention, summarize, or reuse output from any earlier run."
    );
  }
  if (!deliverToUser) {
    if (useHeartbeatResponseTool) {
      return (
        "An async command completion event was triggered, but user delivery is disabled for this run. " +
        `Handle the result internally. ${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS} ` +
        "Do not mention, summarize, or reuse command output."
      );
    }
    return (
      "An async command completion event was triggered, but user delivery is disabled for this run. " +
      "Handle the result internally and reply HEARTBEAT_OK only. Do not mention, summarize, or reuse command output."
    );
  }
  if (hasMissingOutputFailure) {
    return (
      "An async command you ran earlier completed without captured stdout/stderr. The completion details are:\n\n" +
      eventText +
      "\n\n" +
      "Tell the user the command completed without captured output and include the exit status or signal. " +
      "Do not ask the user to provide missing logs, and do not try to retrieve logs from an exec/session id."
    );
  }
  return (
    "An async command you ran earlier has completed. The command completion details are:\n\n" +
    eventText +
    "\n\n" +
    "Please relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. " +
    "If it failed, explain what went wrong."
  );
}

const HEARTBEAT_OK_PREFIX = normalizeLowercaseStringOrEmpty(HEARTBEAT_TOKEN);

// Detect heartbeat-specific noise so cron reminders don't trigger on non-reminder events.
function isHeartbeatAckEvent(evt: string): boolean {
  const trimmed = evt.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (!lower.startsWith(HEARTBEAT_OK_PREFIX)) {
    return false;
  }
  const suffix = lower.slice(HEARTBEAT_OK_PREFIX.length);
  if (suffix.length === 0) {
    return true;
  }
  return !/[a-z0-9_]/.test(suffix[0]);
}

function isHeartbeatNoiseEvent(evt: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(evt);
  if (!lower) {
    return false;
  }
  return (
    isHeartbeatAckEvent(lower) ||
    lower.includes("heartbeat poll") ||
    lower.includes("heartbeat wake")
  );
}

export function isExecCompletionEvent(evt: string): boolean {
  const trimmed = evt.trimStart();
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  return (
    /^exec finished(?::|\s*\()/.test(normalized) ||
    STRUCTURED_EXEC_COMPLETION_EVENT_RE.test(trimmed)
  );
}

// Returns true when a system event should be treated as real cron reminder content.
export function isCronSystemEvent(evt: string) {
  if (!evt.trim()) {
    return false;
  }
  return !isHeartbeatNoiseEvent(evt) && !isExecCompletionEvent(evt);
}
