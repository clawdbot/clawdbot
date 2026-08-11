/**
 * User-facing tool display formatter.
 *
 * Builds redacted labels and compact details from tool metadata without affecting execution semantics.
 */
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { redactToolDetail } from "../logging/redact.js";
import { shortenHomeInString } from "../utils.js";
import {
  defaultTitle,
  formatToolDetailText,
  formatDetailKey,
  normalizeToolName,
  resolveToolVerbAndDetailForArgs,
} from "./tool-display-common.js";
import { TOOL_DISPLAY_CONFIG } from "./tool-display-config.js";
import type { ToolDetailMode } from "./tool-display-exec.js";

type ToolDisplay = {
  name: string;
  emoji: string;
  title: string;
  label: string;
  verb?: string;
  detail?: string;
};

const FALLBACK = TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" };
const TOOL_MAP = TOOL_DISPLAY_CONFIG.tools ?? {};
const DETAIL_LABEL_OVERRIDES: Record<string, string> = {
  agentId: "agent",
  sessionKey: "session",
  targetId: "target",
  targetUrl: "url",
  nodeId: "node",
  requestId: "request",
  messageId: "message",
  threadId: "thread",
  channelId: "channel",
  guildId: "guild",
  userId: "user",
  runTimeoutSeconds: "timeout",
  timeoutSeconds: "timeout",
  includeTools: "tools",
  pollQuestion: "poll",
  maxChars: "max chars",
};
const MAX_DETAIL_ENTRIES = 8;

/** Resolves the display model for a tool invocation. */
export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
  detailMode?: ToolDetailMode;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = normalizeLowercaseStringOrEmpty(name);
  const spec = TOOL_MAP[key];
  const emoji = spec?.emoji ?? FALLBACK.emoji ?? "🧩";
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? title;
  const toolDisplayParts = resolveToolVerbAndDetailForArgs({
    toolKey: key,
    args: params.args,
    meta: params.meta,
    spec,
    fallbackDetailKeys: FALLBACK.detailKeys,
    detailMode: "summary",
    toolDetailMode: params.detailMode,
    detailMaxEntries: MAX_DETAIL_ENTRIES,
    detailFormatKey: (raw) => formatDetailKey(raw, DETAIL_LABEL_OVERRIDES),
  });
  const { verb } = toolDisplayParts;
  let { detail } = toolDisplayParts;

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    name,
    emoji,
    title,
    label,
    verb,
    detail,
  };
}

/** Formats and redacts detail text for display. */
export function formatToolDetail(display: ToolDisplay): string | undefined {
  const detailRaw = display.detail ? redactToolDetail(display.detail) : undefined;
  return formatToolDetailText(detailRaw);
}

/** Infers compact display metadata for a tool invocation from its arguments. */
export function inferToolMetaFromArgsCore(
  toolName: string,
  args: unknown,
  options?: { detailMode?: ToolDetailMode },
): string | undefined {
  return formatToolDetail(
    resolveToolDisplay({ name: toolName, args, detailMode: options?.detailMode }),
  );
}

/**
 * Shell-family tools render their command as the whole line instead of
 * "Label: detail". Backends spell the same tool differently — the Claude CLI
 * sends "Bash" where embedded runs send "bash"/"exec" — so every caller must
 * compare the normalized name or the shell line silently loses its detail.
 */
export function isShellToolDisplayName(name: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return normalized === "bash" || normalized === "exec" || normalized === "shell";
}

/** Provider-defined tool names are not enough: namespaced tools can carry executable commands. */
export function isCommandBearingToolCall(name: string | undefined, args?: unknown): boolean {
  if (isShellToolDisplayName(name)) {
    return true;
  }
  const command = asOptionalObjectRecord(args)?.command;
  return typeof command === "string" && normalizeOptionalString(command) !== undefined;
}

/** Builds the compact one-line summary shown in transcripts and logs. */
export function formatToolSummary(display: ToolDisplay): string {
  const detail = formatToolDetail(display);
  if (detail && isShellToolDisplayName(display.name)) {
    return `${display.emoji} ${detail}`;
  }
  return detail
    ? `${display.emoji} ${display.label}: ${detail}`
    : `${display.emoji} ${display.label}`;
}
