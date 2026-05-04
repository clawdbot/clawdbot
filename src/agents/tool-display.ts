import { redactToolDetail } from "../logging/redact.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
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
  let { verb, detail } = resolveToolVerbAndDetailForArgs({
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

export function formatToolDetail(display: ToolDisplay): string | undefined {
  const detailRaw = display.detail ? redactToolDetail(display.detail) : undefined;
  return formatToolDetailText(detailRaw);
}

export function formatToolSummary(display: ToolDisplay): string {
  const detail = formatToolDetail(display);
  return detail
    ? `${display.emoji} ${display.label}: ${detail}`
    : `${display.emoji} ${display.label}`;
}
