/**
 * Internal runtime event prompt formatting.
 * Sanitizes background task completion events into protected runtime-context
 * blocks or plain prompt text.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { normalizeAgentRunRouteChange } from "./agent-run-terminal-receipt.js";
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
  type RuntimeContextFragment,
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
  modelRouteChange?: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
  replyInstruction: string;
};

type TaskCompletionPromptMode = "plain" | "protected" | "data";

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
  const mediaUrls: string[] = [];
  const attachments: NonNullable<AgentInternalEvent["attachments"]> = [];
  const indexByUrl = new Map<string, number>();
  const trustByUrl = new Map<string, boolean>();
  for (const event of events ?? []) {
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

function sanitizeSingleLineField(value: string, fallback: string, raw = false): string {
  const sanitized = (raw ? value : escapeInternalRuntimeContextDelimiters(value))
    .replace(/\r?\n+/g, " ")
    .trim();
  return sanitized || fallback;
}

function sanitizeMultilineField(value: string): string {
  return escapeInternalRuntimeContextDelimiters(value).replace(/\r\n/g, "\n").trim();
}

function sanitizeMediaDirectiveValue(value: string, raw = false): string | null {
  const sanitized = (raw ? value : escapeInternalRuntimeContextDelimiters(value))
    .replace(/\r?\n/g, " ")
    .replace(/./gs, (char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .trim();
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

function formatGeneratedMediaDirectiveLines(
  event: Pick<AgentTaskCompletionInternalEvent, "mediaUrls" | "attachments">,
  raw = false,
  label = "Generated media:",
): string[] {
  const mediaUrls = Array.from(
    new Set(
      [...(event.mediaUrls ?? []), ...mediaUrlsFromGeneratedAttachments(event.attachments)]
        .map((value) => sanitizeMediaDirectiveValue(value, raw))
        .filter((value): value is string => value !== null),
    ),
  );
  if (mediaUrls.length === 0) {
    return [];
  }
  return [label, ...mediaUrls.map((mediaUrl) => `MEDIA:${mediaUrl}`)];
}

function formatTaskCompletionEvent(
  event: AgentTaskCompletionInternalEvent,
  mode: TaskCompletionPromptMode,
): string {
  const singleLine = (value: string, fallback: string) =>
    sanitizeSingleLineField(value, fallback, mode === "data");
  const sessionKey = singleLine(event.childSessionKey, "unknown");
  const sessionId = singleLine(event.childSessionId ?? "unknown", "unknown");
  const announceType = singleLine(event.announceType, "unknown");
  const taskLabel = singleLine(event.taskLabel, "unnamed task");
  const statusLabel = truncateWithMarker(
    singleLine(event.statusLabel, event.status),
    MAX_TASK_COMPLETION_STATUS_LABEL_CHARS,
    {
      marker: TASK_COMPLETION_STATUS_LABEL_TRUNCATION_MARKER,
      reserve: TASK_COMPLETION_STATUS_LABEL_TRUNCATION_MARKER.length,
      trimEnd: true,
    },
  );
  const result =
    mode === "data"
      ? truncateWithMarker(
          event.result || "(no output)",
          MAX_TASK_COMPLETION_RESULT_ESCAPED_CHARS,
          {
            marker: TASK_COMPLETION_RESULT_TRUNCATION_NOTICE,
            reserve: TASK_COMPLETION_RESULT_TRUNCATION_NOTICE.length,
            trimEnd: true,
          },
        )
      : formatChildResultDataBlock(event.result);
  const modelRouteChange = normalizeAgentRunRouteChange(event.modelRouteChange);
  const attachmentLines = formatGeneratedAttachmentLines(event.attachments);
  const mediaDirectiveLines = formatGeneratedMediaDirectiveLines(event, mode === "data");
  const lines =
    mode !== "plain"
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
  if (modelRouteChange) {
    lines.push("", modelRouteChange);
  }
  if (attachmentLines.length > 0) {
    lines.push("", ...attachmentLines);
  }
  if (mediaDirectiveLines.length > 0) {
    lines.push("", ...mediaDirectiveLines);
  }
  if (event.statsLine?.trim()) {
    lines.push("", mode === "data" ? event.statsLine : sanitizeMultilineField(event.statsLine));
  }
  if (mode !== "data") {
    lines.push(
      "",
      mode === "protected" ? "Action:" : "Instruction:",
      sanitizeMultilineField(event.replyInstruction),
    );
  }
  return lines.join("\n");
}

/** Provenance comes from the producer event; child output and labels remain data. */
export function buildAgentInternalEventContext(
  events?: AgentInternalEvent[],
  legacy = false,
): RuntimeContextFragment[] {
  if (legacy) {
    const text = formatAgentInternalEventsForPrompt(events);
    return text ? [{ kind: "runtime-instruction", text }] : [];
  }
  return (events ?? []).flatMap((event): RuntimeContextFragment[] => [
    {
      kind: "runtime-instruction",
      text: "A background task completed. Keep internal details private and use its result to reply in your normal assistant voice.",
    },
    { kind: "conversation-data", text: formatTaskCompletionEvent(event, "data") },
    { kind: "runtime-instruction", text: event.replyInstruction },
  ]);
}

export function buildGeneratedMediaDeliveryContext(
  mediaUrls: string[],
  retry: boolean,
): RuntimeContextFragment[] {
  return [
    {
      kind: "runtime-instruction",
      text: retry
        ? "Deliver only the generated media listed below. Do not resend any other attachment."
        : "Deliver the generated media listed below to the user.",
    },
    {
      kind: "conversation-data",
      text: formatGeneratedMediaDirectiveLines({ mediaUrls, attachments: [] }, true).join("\n"),
    },
  ];
}

/** Format internal runtime events for the protected runtime-context prompt block. */
export function formatAgentInternalEventsForPrompt(events?: AgentInternalEvent[]): string {
  const blocks = (events ?? [])
    .filter((event) => event.type === "task_completion")
    .map((event) => formatTaskCompletionEvent(event, "protected"));
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
  const mediaDirectiveLines = formatGeneratedMediaDirectiveLines(
    { mediaUrls },
    false,
    "Generated media still missing:",
  );
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
    ...mediaDirectiveLines,
    "",
    "Action:",
    "Deliver only the generated media listed above. Do not resend any other attachment.",
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n");
}

/** Format internal runtime events for plain prompts that lack context delimiters. */
function formatAgentInternalEventsForPlainPrompt(events?: AgentInternalEvent[]): string {
  return (events ?? [])
    .filter((event) => event.type === "task_completion")
    .map((event) => formatTaskCompletionEvent(event, "plain"))
    .join("\n\n---\n\n");
}

/** Keep the existing event carrier for runtimes that own their prompt assembly. */
export function prependInternalEventContext(
  body: string,
  events: AgentInternalEvent[] | undefined,
  inputProvenance?: InputProvenance,
): string {
  const rendered = formatAgentInternalEventsForPrompt(events);
  return !rendered || resolveInternalEventPromptBody(body, events, inputProvenance) !== body
    ? body
    : [rendered, body].filter(Boolean).join("\n\n");
}

/** Remove only the canonical duplicate carried by the existing internal-events API. */
export function resolveInternalEventPromptBody(
  body: string,
  events: AgentInternalEvent[] | undefined,
  inputProvenance?: InputProvenance,
  retainProvenance = false,
): string {
  const rendered = formatAgentInternalEventsForPrompt(events);
  if (rendered) {
    for (const carrier of [rendered, annotateInterSessionPromptText(rendered, inputProvenance)]) {
      if (body === carrier || body.startsWith(`${carrier}\n\n`)) {
        return [
          retainProvenance ? carrier.slice(0, -rendered.length).trimEnd() : "",
          body.slice(carrier.length).trimStart(),
        ]
          .filter(Boolean)
          .join("\n\n");
      }
    }
  }
  return body;
}

/** Plain runtimes and transcripts retain the existing visible event representation. */
export function resolveAcpPromptBody(
  body: string,
  events: AgentInternalEvent[] | undefined,
  inputProvenance?: InputProvenance,
): string {
  const rendered = formatAgentInternalEventsForPlainPrompt(events);
  return rendered
    ? [rendered, resolveInternalEventPromptBody(body, events, inputProvenance, true)]
        .filter(Boolean)
        .join("\n\n")
    : body;
}

export function resolveInternalEventTranscriptBody(
  body: string,
  events: AgentInternalEvent[] | undefined,
  inputProvenance?: InputProvenance,
): string {
  return resolveInternalEventPromptBody(body, events, inputProvenance) === body
    ? body
    : resolveAcpPromptBody(body, events, inputProvenance);
}
