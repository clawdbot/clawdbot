/**
 * Internal runtime event prompt formatting.
 * Sanitizes background task completion events into protected runtime-context
 * blocks or plain prompt text.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import {
  formatGeneratedAttachmentLines,
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "./generated-attachments.js";
import {
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  hasGeneratedMediaCompletionEvent,
  type AgentInternalEventSource,
  type AgentInternalEventStatus,
} from "./internal-event-contract.js";
import {
  escapeInternalRuntimeContextDelimiters,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import { wrapPromptDataBlock } from "./sanitize-for-prompt.js";

type AgentTaskCompletionInternalEvent = {
  type: typeof AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION;
  source: AgentInternalEventSource;
  childSessionKey: string;
  childSessionId?: string;
  announceType: string;
  taskLabel: string;
  status: AgentInternalEventStatus;
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
  replyInstruction: string;
};

type TaskCompletionPromptMode = "plain" | "protected";

const MAX_TASK_COMPLETION_RESULT_ESCAPED_CHARS = 6_000;
const TASK_COMPLETION_RESULT_TRUNCATION_NOTICE = "\n[child result truncated]";
// Status labels embed provider/lifecycle error text ("failed: <cause>",
// "timed out: <cause>"), which is caller-supplied and unbounded. Keep the
// single status line short so a large error cannot crowd out the child result
// or the reply instruction in the parent's prompt.
const MAX_TASK_COMPLETION_STATUS_LABEL_CHARS = 500;
const TASK_COMPLETION_STATUS_LABEL_TRUNCATION_MARKER = "…[truncated]";

/** Internal event variants that can be rendered into agent prompt context. */
export type AgentInternalEvent = AgentTaskCompletionInternalEvent;

/** Collect ordered media descriptors and per-reference trust from internal events. */
export function collectAgentInternalEventMedia(events: AgentInternalEvent[] | undefined): {
  mediaUrls: string[];
  attachments: NonNullable<AgentInternalEvent["attachments"]>;
  trustByUrl: Map<string, boolean>;
} {
  if (!events?.length) {
    return { mediaUrls: [], attachments: [], trustByUrl: new Map() };
  }
  const mediaUrls: string[] = [];
  const attachments: NonNullable<AgentInternalEvent["attachments"]> = [];
  const indexByUrl = new Map<string, number>();
  const trustByUrl = new Map<string, boolean>();
  for (const event of events) {
    const generatedMediaEvent = hasGeneratedMediaCompletionEvent([event]);
    const attachmentByUrl = new Map(
      (event.attachments ?? []).flatMap((attachment) => {
        const reference = normalizeOptionalString(
          attachment.path ?? attachment.url ?? attachment.mediaUrl ?? attachment.filePath,
        );
        return reference ? [[reference, attachment] as const] : [];
      }),
    );
    for (const mediaUrl of [
      ...(Array.isArray(event.mediaUrls) ? event.mediaUrls : []),
      ...mediaUrlsFromGeneratedAttachments(event.attachments),
    ]) {
      const normalized = normalizeOptionalString(mediaUrl);
      if (!normalized) {
        continue;
      }
      const metadata = attachmentByUrl.get(normalized);
      const existingIndex = indexByUrl.get(normalized);
      if (existingIndex !== undefined) {
        trustByUrl.set(normalized, trustByUrl.get(normalized) === true || generatedMediaEvent);
        if (metadata && Object.keys(attachments[existingIndex] ?? {}).length === 0) {
          attachments[existingIndex] = metadata;
        }
        continue;
      }
      indexByUrl.set(normalized, mediaUrls.length);
      trustByUrl.set(normalized, generatedMediaEvent);
      mediaUrls.push(normalized);
      attachments.push(metadata ?? {});
    }
  }
  return { mediaUrls, attachments, trustByUrl };
}

function sanitizeSingleLineField(value: string, fallback: string): string {
  const sanitized = escapeInternalRuntimeContextDelimiters(value)
    .replace(/\r?\n+/g, " ")
    .trim();
  return sanitized || fallback;
}

function sanitizeMultilineField(value: string, fallback: string): string {
  const sanitized = escapeInternalRuntimeContextDelimiters(value).replace(/\r\n/g, "\n").trim();
  return sanitized || fallback;
}

function sanitizeMediaDirectiveValue(value: string): string | null {
  let singleLine = "";
  for (const char of escapeInternalRuntimeContextDelimiters(value).replace(/\r?\n/g, " ")) {
    const code = char.charCodeAt(0);
    singleLine += code < 32 || code === 127 ? " " : char;
  }
  const sanitized = singleLine.trim();
  return sanitized || null;
}

function formatChildResultDataBlock(value: string): string {
  // The event retains the authoritative full result; only model-visible
  // projections share this escaped-output budget.
  return (
    wrapPromptDataBlock({
      label: "Child result",
      text: value,
      maxEscapedChars: MAX_TASK_COMPLETION_RESULT_ESCAPED_CHARS,
      truncationMarker: TASK_COMPLETION_RESULT_TRUNCATION_NOTICE,
    }) || "Child result: (no output)"
  );
}

function formatGeneratedMediaDirectiveLines(event: AgentTaskCompletionInternalEvent): string[] {
  const mediaUrls = Array.from(
    new Set(
      [...(event.mediaUrls ?? []), ...mediaUrlsFromGeneratedAttachments(event.attachments)]
        .map(sanitizeMediaDirectiveValue)
        .filter((value): value is string => value !== null),
    ),
  );
  if (mediaUrls.length === 0) {
    return [];
  }
  return ["Generated media:", ...mediaUrls.map((mediaUrl) => `MEDIA:${mediaUrl}`)];
}

function formatTaskCompletionEvent(
  event: AgentTaskCompletionInternalEvent,
  mode: TaskCompletionPromptMode,
): string {
  const sessionKey = sanitizeSingleLineField(event.childSessionKey, "unknown");
  const sessionId = sanitizeSingleLineField(event.childSessionId ?? "unknown", "unknown");
  const announceType = sanitizeSingleLineField(event.announceType, "unknown");
  const taskLabel = sanitizeSingleLineField(event.taskLabel, "unnamed task");
  const statusLabel = truncateWithMarker(
    sanitizeSingleLineField(event.statusLabel, event.status),
    MAX_TASK_COMPLETION_STATUS_LABEL_CHARS,
    {
      marker: TASK_COMPLETION_STATUS_LABEL_TRUNCATION_MARKER,
      reserve: TASK_COMPLETION_STATUS_LABEL_TRUNCATION_MARKER.length,
      trimEnd: true,
    },
  );
  const result = formatChildResultDataBlock(event.result);
  const attachmentLines = formatGeneratedAttachmentLines(event.attachments);
  const mediaDirectiveLines = formatGeneratedMediaDirectiveLines(event);
  const lines =
    mode === "protected"
      ? ["[Internal task completion event]"]
      : [
          "A background task completed. Use this result to reply to the user in your normal assistant voice.",
          "",
        ];
  lines.push(
    `source: ${event.source}`,
    `session_key: ${sessionKey}`,
    `session_id: ${sessionId}`,
    `type: ${announceType}`,
    `task: ${taskLabel}`,
    `status: ${statusLabel}`,
    "",
    result,
  );
  if (attachmentLines.length > 0) {
    lines.push("", ...attachmentLines);
  }
  if (mediaDirectiveLines.length > 0) {
    lines.push("", ...mediaDirectiveLines);
  }
  if (event.statsLine?.trim()) {
    lines.push("", sanitizeMultilineField(event.statsLine, ""));
  }
  lines.push(
    "",
    mode === "protected" ? "Action:" : "Instruction:",
    sanitizeMultilineField(event.replyInstruction, ""),
  );
  return lines.join("\n");
}

/** Format internal runtime events for the protected runtime-context prompt block. */
export function formatAgentInternalEventsForPrompt(events?: AgentInternalEvent[]): string {
  if (!events || events.length === 0) {
    return "";
  }
  const blocks = events
    .map((event) => {
      if (event.type === "task_completion") {
        return formatTaskCompletionEvent(event, "protected");
      }
      return "";
    })
    .filter((value) => value.trim().length > 0);
  if (blocks.length === 0) {
    return "";
  }
  return [
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "OpenClaw runtime context (internal):",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    blocks.join("\n\n---\n\n"),
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n");
}

/** Build a protected follow-up that can retry only media proven missing from a partial send. */
export function formatGeneratedMediaDeliveryRetryForPrompt(mediaUrls: string[]): string {
  const mediaDirectiveLines = Array.from(
    new Set(
      mediaUrls.map(sanitizeMediaDirectiveValue).filter((value): value is string => value !== null),
    ),
  ).map((mediaUrl) => `MEDIA:${mediaUrl}`);
  if (mediaDirectiveLines.length === 0) {
    return "";
  }
  return [
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "OpenClaw runtime context (internal):",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    "[Generated media delivery retry]",
    "A previous agent turn delivered only part of this generated-media result.",
    "",
    "Generated media still missing:",
    ...mediaDirectiveLines,
    "",
    "Action:",
    "Deliver only the generated media listed above. Do not resend any other attachment.",
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n");
}

/** Format internal runtime events for plain prompts that lack context delimiters. */
export function formatAgentInternalEventsForPlainPrompt(events?: AgentInternalEvent[]): string {
  if (!events || events.length === 0) {
    return "";
  }
  return events
    .map((event) => {
      if (event.type === "task_completion") {
        return formatTaskCompletionEvent(event, "plain");
      }
      return "";
    })
    .filter((value) => value.trim().length > 0)
    .join("\n\n---\n\n");
}
