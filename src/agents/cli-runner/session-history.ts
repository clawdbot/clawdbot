/**
 * Loads and renders persisted session history for CLI session reseeding and
 * context-engine synchronization.
 */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptWatermark,
  waitForSessionTranscriptProjection,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-events.js";
import {
  limitAgentHookHistoryMessages,
  MAX_AGENT_HOOK_HISTORY_MESSAGES,
} from "../harness/hook-history.js";
import { buildSessionContext, type SessionTreeEntry } from "../runtime/index.js";
import type { SessionHeader, SessionMessageEntry } from "../sessions/session-manager.js";
import { cliBackendLog } from "./log.js";

/** Maximum transcript size read for CLI session history. */
const MAX_CLI_SESSION_HISTORY_BYTES = 5 * 1024 * 1024;
/** Maximum transcript messages exposed to CLI hook history. */
const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
/** Minimum reseed-history prompt budget for fresh CLI sessions. */
const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;
/** Maximum automatic reseed-history prompt budget derived from context size. */
const MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS = 256 * 1024;
const CLI_SESSION_RESEED_HISTORY_CONTEXT_SHARE = 0.08;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_CLI_SESSION_HISTORY_EVENTS = 10_000;

type CliSessionHistoryParams = {
  sessionTarget: SessionTranscriptRuntimeTarget | undefined;
};
const CLI_SESSION_RESEED_CURRENCY_GUIDANCE =
  "[Recovered history may be stale; verify current and time-sensitive facts before acting.]";

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
  timestamp?: unknown;
};
type RawTranscriptReseedReason =
  | "auth-profile"
  | "auth-epoch"
  | "message-policy"
  | "system-prompt"
  | "cwd"
  | "mcp"
  | "missing-transcript"
  | "orphaned-tool-use"
  | "session-expired";

const RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS = new Set<RawTranscriptReseedReason>([
  "missing-transcript",
  "orphaned-tool-use",
  "message-policy",
  "system-prompt",
  "cwd",
  "mcp",
  "session-expired",
]);

/** Resolves how much prior transcript text may reseed a fresh CLI session. */
export function resolveAutoCliSessionReseedHistoryChars(contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  }
  const contextShareChars = Math.floor(
    contextWindowTokens * CLI_SESSION_RESEED_HISTORY_CONTEXT_SHARE * CHARS_PER_TOKEN_ESTIMATE,
  );
  return Math.max(
    MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    Math.min(MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS, contextShareChars),
  );
}

function coerceHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function formatHistoryTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = timestampMsToIsoString(Date.parse(value));
  return timestamp === value ? timestamp : undefined;
}

function renderHistoryMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as HistoryMessage;
  const role =
    entry.role === "assistant"
      ? "Assistant"
      : entry.role === "user"
        ? "User"
        : entry.role === "compactionSummary"
          ? "Compaction summary"
          : undefined;
  if (!role) {
    return undefined;
  }
  const text =
    entry.role === "compactionSummary" && typeof entry.summary === "string"
      ? entry.summary.trim()
      : coerceHistoryText(entry.content);
  if (!text) {
    return undefined;
  }
  const timestamp = formatHistoryTimestamp(entry.timestamp);
  return `${timestamp ? `[${timestamp}] ` : ""}${role}: ${text}`;
}

/** Builds a reseed prompt that carries prior OpenClaw transcript context. */
export function buildCliSessionHistoryPrompt(params: {
  messages: unknown[];
  prompt: string;
  maxHistoryChars?: number;
}): string | undefined {
  const maxHistoryChars = params.maxHistoryChars ?? MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  const historyBudget = maxHistoryChars - CLI_SESSION_RESEED_CURRENCY_GUIDANCE.length - "\n".length;
  if (historyBudget <= 0) {
    return undefined;
  }

  // loadCliSessionReseedMessages deliberately places a `compactionSummary`
  // entry first when the session was compacted, so the compacted prior
  // context survives reseed. Pin that summary as a prefix and only
  // tail-truncate the post-summary transcript — a blind tail-slice of the
  // joined history would drop the summary whenever the post-summary tail
  // alone exceeds the cap.
  const firstEntry = params.messages[0];
  const firstIsCompaction =
    Boolean(firstEntry) &&
    typeof firstEntry === "object" &&
    (firstEntry as HistoryMessage).role === "compactionSummary";
  const summaryRendered = firstIsCompaction ? renderHistoryMessage(firstEntry) : undefined;
  const tailMessages = firstIsCompaction ? params.messages.slice(1) : params.messages;

  const tailRaw = tailMessages
    .flatMap((message) => {
      const rendered = renderHistoryMessage(message);
      return rendered ? [rendered] : [];
    })
    .join("\n\n")
    .trim();

  const truncationMarker = "[OpenClaw reseed history truncated; older turns dropped]";
  const renderTruncatedTail = (raw: string, budget: number): string => {
    if (budget <= truncationMarker.length + "\n".length) {
      return sliceUtf16Safe(raw, -budget).trimStart();
    }
    const tailBudget = budget - truncationMarker.length - "\n".length;
    return `${truncationMarker}\n${sliceUtf16Safe(raw, -tailBudget).trimStart()}`;
  };
  const renderTruncatedSummaryWithTail = (renderedSummary: string): string => {
    if (historyBudget <= truncationMarker.length + "\n".length) {
      return tailRaw.length > 0
        ? sliceUtf16Safe(tailRaw, -historyBudget).trimStart()
        : truncateUtf16Safe(renderedSummary, historyBudget).trimEnd();
    }
    const tailBudget =
      tailRaw.length > 0 ? Math.min(tailRaw.length, Math.floor(historyBudget / 2)) : 0;
    const separatorBudget = tailBudget > 0 ? 2 : 1;
    const summaryBudget = Math.max(
      0,
      historyBudget - truncationMarker.length - separatorBudget - tailBudget,
    );
    const summaryTruncated = truncateUtf16Safe(renderedSummary, summaryBudget).trimEnd();
    const tailTruncated = tailBudget > 0 ? sliceUtf16Safe(tailRaw, -tailBudget).trimStart() : "";
    return [truncationMarker, summaryTruncated, tailTruncated].filter(Boolean).join("\n");
  };

  let renderedHistory: string;
  if (summaryRendered) {
    // Reserve the summary from the budget so the post-summary tail cap is
    // the remaining headroom. If the summary alone meets or exceeds the
    // cap, the summary itself must be truncated — pinning a summary that
    // blows past `maxHistoryChars` would defeat the cap that prevents
    // reseeding fresh CLI sessions with unexpectedly huge prompts.
    if (summaryRendered.length >= historyBudget) {
      // Truncate the summary to fit the budget (less the marker line),
      // keeping the head. Still reserve budget for the post-summary tail so
      // recent exact turns survive even when the summary itself is oversize.
      renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
    } else if (tailRaw.length === 0) {
      renderedHistory = summaryRendered;
    } else {
      const summaryBlock = `${summaryRendered}\n\n`;
      const remainingBudget = historyBudget - summaryBlock.length;
      if (tailRaw.length <= remainingBudget) {
        renderedHistory = `${summaryBlock}${tailRaw}`;
      } else if (remainingBudget <= truncationMarker.length + "\n".length) {
        // The summary leaves too little room to announce truncation. Reuse
        // the oversize-summary path so the marker and recent exact turns
        // both retain budget.
        renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
      } else {
        renderedHistory = `${summaryBlock}${renderTruncatedTail(tailRaw, remainingBudget)}`;
      }
    }
  } else {
    // No compaction summary to pin: tail-slice the full rendered history
    // and lead with the marker so it correctly describes what follows
    // (older turns dropped, recent tail retained).
    renderedHistory =
      tailRaw.length > historyBudget ? renderTruncatedTail(tailRaw, historyBudget) : tailRaw;
  }

  if (!renderedHistory) {
    return undefined;
  }

  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    CLI_SESSION_RESEED_CURRENCY_GUIDANCE,
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}

async function loadCliSessionEntries({
  sessionTarget,
}: CliSessionHistoryParams): Promise<SessionTreeEntry[]> {
  if (!sessionTarget) {
    return [];
  }
  await waitForSessionTranscriptProjection(sessionTarget);
  const context = readSessionTranscriptBoundedActiveContextCore(sessionTarget, {
    maxBytes: MAX_CLI_SESSION_HISTORY_BYTES,
    maxEvents: MAX_CLI_SESSION_HISTORY_EVENTS,
  });
  if (context.truncated) {
    cliBackendLog.warn(
      `cli session history truncated to bounded active context: ${sessionTarget.sessionId}`,
    );
  }
  // SAFETY: The canonical accessor returns persisted events on the active branch.
  const entries = context.events as (SessionTreeEntry | SessionHeader)[];
  return entries.filter((entry) => entry.type !== "session");
}

/** Checks whether the canonical session has persisted transcript events. */
export async function hasCliSessionTranscript({
  sessionTarget,
}: CliSessionHistoryParams): Promise<boolean> {
  return (
    sessionTarget !== undefined && readSessionTranscriptWatermark(sessionTarget).maxSeq !== null
  );
}

/** Loads reset-aware active transcript messages for CLI lifecycle hook context. */
export async function loadCliSessionHistoryMessages({
  sessionTarget,
}: CliSessionHistoryParams): Promise<unknown[]> {
  if (!sessionTarget) {
    return [];
  }
  await waitForSessionTranscriptProjection(sessionTarget);
  // Hooks retain history across compactions; only reset closes their history window.
  const page = readSessionTranscriptBoundedMessageTailPage(sessionTarget, {
    maxBytes: MAX_CLI_SESSION_HISTORY_BYTES,
    maxMessages: MAX_CLI_SESSION_HISTORY_MESSAGES,
    offset: 0,
  });
  if (page.events.length < page.scannedMessages) {
    cliBackendLog.warn(
      `cli session history truncated to bounded message tail: ${sessionTarget.sessionId}`,
    );
  }
  // SAFETY: The message-position projection only selects canonical message events.
  return page.events.map(({ event }) => (event as SessionMessageEntry).message);
}

/** Loads canonical replay messages for context-engine updates. */
export async function loadCliSessionContextEngineMessages(
  params: CliSessionHistoryParams,
): Promise<unknown[]> {
  const entries = await loadCliSessionEntries(params);
  const messages = buildSessionContext(entries).messages;
  const boundary = entries.findLast(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  if (boundary?.type === "compaction" && messages[0]?.role === "compactionSummary") {
    // Context engines also receive the persisted compaction metadata, not just rendered summary text.
    return [
      {
        ...messages[0],
        timestamp: boundary.timestamp,
        firstKeptEntryId: boundary.firstKeptEntryId,
        ...(boundary.details !== undefined ? { details: boundary.details } : {}),
        ...("tokensAfter" in boundary ? { tokensAfter: boundary.tokensAfter } : {}),
      },
      ...messages.slice(1),
    ];
  }
  return messages;
}

/** Loads compacted/raw transcript messages eligible for CLI session reseeding. */
export async function loadCliSessionReseedMessages(
  params: CliSessionHistoryParams & {
    allowRawTranscriptReseed?: boolean;
    rawTranscriptReseedReason?: RawTranscriptReseedReason;
  },
): Promise<unknown[]> {
  const entries = await loadCliSessionEntries(params);
  // Persistence timestamps, rather than provider timestamps, describe recovered history.
  const reseedEntries: SessionTreeEntry[] = [];
  for (const entry of entries) {
    reseedEntries.push(
      entry.type === "message"
        ? { ...entry, message: { ...entry.message, timestamp: Date.parse(entry.timestamp) } }
        : entry,
    );
  }
  const historyMessages = [];
  for (const message of buildSessionContext(reseedEntries).messages) {
    historyMessages.push({ ...message, timestamp: timestampMsToIsoString(message.timestamp) });
  }
  const summary = historyMessages[0];
  const hasSummary = summary?.role === "compactionSummary" && summary.summary.trim().length > 0;
  if (
    !hasSummary &&
    (params.allowRawTranscriptReseed !== true ||
      !params.rawTranscriptReseedReason ||
      !RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS.has(params.rawTranscriptReseedReason))
  ) {
    return [];
  }
  const history = historyMessages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  return hasSummary
    ? [
        { ...summary, summary: summary.summary.trim() },
        ...limitAgentHookHistoryMessages(history, MAX_CLI_SESSION_HISTORY_MESSAGES - 1),
      ]
    : limitAgentHookHistoryMessages(history, MAX_CLI_SESSION_HISTORY_MESSAGES);
}
