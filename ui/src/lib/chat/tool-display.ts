// Control UI module implements tool display behavior.
import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import {
  defaultTitle,
  formatToolDetailText,
  normalizeToolName,
  resolveToolVerbAndDetailForArgs,
  type ToolDisplaySpec as ToolDisplaySpecBase,
} from "../../../../src/agents/tool-display-common.js";
import type { ToolDetailMode } from "../../../../src/agents/tool-display-exec.js";
import type { ControlUiEmbedSandboxMode } from "../../../../src/gateway/control-ui-contract.js";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";

type ToolDisplaySpec = ToolDisplaySpecBase & {
  icon?: string;
};

type SharedToolDisplaySpec = ToolDisplaySpecBase & {
  emoji?: string;
};

type SharedToolDisplayConfig = {
  version?: number;
  fallback?: SharedToolDisplaySpec;
  tools?: Record<string, SharedToolDisplaySpec>;
};

type ToolDisplay = {
  name: string;
  icon: ChatToolIconName;
  title: string;
  label: string;
  verb?: string;
  detail?: string;
};

export type EmbedSandboxMode = ControlUiEmbedSandboxMode;
type ChatToolIconName = string;

const EMOJI_ICON_MAP: Record<string, ChatToolIconName> = {
  "🧩": "puzzle",
  "🛠️": "wrench",
  "🧰": "wrench",
  "📖": "fileText",
  "✍️": "edit",
  "📝": "penLine",
  "📎": "paperclip",
  "🌐": "globe",
  "📺": "monitor",
  "🧾": "fileText",
  "🔐": "settings",
  "💻": "monitor",
  "🔌": "plug",
  "💬": "messageSquare",
};

function iconForEmoji(emoji?: string): ChatToolIconName {
  if (!emoji) {
    return "puzzle";
  }
  return EMOJI_ICON_MAP[emoji] ?? "puzzle";
}

function convertSpec(spec?: SharedToolDisplaySpec): ToolDisplaySpec {
  return {
    icon: iconForEmoji(spec?.emoji),
    title: spec?.title,
    label: spec?.label,
    detailKeys: spec?.detailKeys,
    actions: spec?.actions,
  };
}

const SHARED_TOOL_DISPLAY_CONFIG = SHARED_TOOL_DISPLAY_JSON as SharedToolDisplayConfig;
const FALLBACK = convertSpec(SHARED_TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" });
const TOOL_MAP: Record<string, ToolDisplaySpec> = Object.fromEntries(
  Object.entries(SHARED_TOOL_DISPLAY_CONFIG.tools ?? {}).map(([key, spec]) => [
    key,
    convertSpec(spec),
  ]),
);

function shortenHomeInString(input: string): string {
  if (!input) {
    return input;
  }

  // Browser-safe home shortening: avoid importing Node-only helpers (keeps Vite builds working in Docker/CI).
  const patterns = [
    { re: /^\/Users\/[^/]+(\/|$)/, replacement: "~$1" }, // macOS
    { re: /^\/home\/[^/]+(\/|$)/, replacement: "~$1" }, // Linux
    { re: /^C:\\Users\\[^\\]+(\\|$)/i, replacement: "~$1" }, // Windows
  ] as const;

  for (const pattern of patterns) {
    if (pattern.re.test(input)) {
      return input.replace(pattern.re, pattern.replacement);
    }
  }

  return input;
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
  detailMode?: ToolDetailMode;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = normalizeLowercaseStringOrEmpty(name);
  const spec = TOOL_MAP[key];
  const icon = spec?.icon ?? FALLBACK.icon ?? "puzzle";
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? title;
  const toolDisplayParts = resolveToolVerbAndDetailForArgs({
    toolKey: key,
    args: params.args,
    meta: params.meta,
    spec,
    fallbackDetailKeys: FALLBACK.detailKeys,
    detailMode: "first",
    toolDetailMode: params.detailMode,
    detailCoerce: { includeFalse: true, includeZero: true },
  });
  const { verb } = toolDisplayParts;
  let { detail } = toolDisplayParts;

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    name,
    icon,
    title,
    label,
    verb,
    detail,
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  return formatToolDetailText(display.detail, { prefixWithWith: true });
}

function isCanvasHttpPath(pathname: string): boolean {
  return (
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`)
  );
}

function isExternalHttpUrl(entry: URL): boolean {
  return entry.protocol === "http:" || entry.protocol === "https:";
}

function sanitizeCanvasEntryUrl(
  rawEntryUrl: string,
  allowExternalEmbedUrls = false,
): string | undefined {
  try {
    const entry = new URL(rawEntryUrl, "http://localhost");
    if (entry.origin !== "http://localhost") {
      if (!allowExternalEmbedUrls || !isExternalHttpUrl(entry)) {
        return undefined;
      }
      return entry.toString();
    }
    if (!isCanvasHttpPath(entry.pathname)) {
      return undefined;
    }
    return `${entry.pathname}${entry.search}${entry.hash}`;
  } catch {
    return undefined;
  }
}

export function resolveCanvasIframeUrl(
  entryUrl: string | undefined,
  canvasPluginSurfaceUrl?: string | null,
  allowExternalEmbedUrls = false,
): string | undefined {
  const rawEntryUrl = entryUrl?.trim();
  if (!rawEntryUrl) {
    return undefined;
  }
  const safeEntryUrl = sanitizeCanvasEntryUrl(rawEntryUrl, allowExternalEmbedUrls);
  if (!safeEntryUrl) {
    return undefined;
  }
  if (!canvasPluginSurfaceUrl?.trim()) {
    return safeEntryUrl;
  }
  try {
    const scopedHostUrl = new URL(canvasPluginSurfaceUrl);
    const scopedPrefix = scopedHostUrl.pathname.replace(/\/+$/, "");
    if (!scopedPrefix.startsWith(CANVAS_CAPABILITY_PATH_PREFIX)) {
      return safeEntryUrl;
    }
    const entry = new URL(safeEntryUrl, scopedHostUrl.origin);
    if (!isCanvasHttpPath(entry.pathname)) {
      return safeEntryUrl;
    }
    entry.protocol = scopedHostUrl.protocol;
    entry.username = scopedHostUrl.username;
    entry.password = scopedHostUrl.password;
    entry.host = scopedHostUrl.host;
    entry.pathname = `${scopedPrefix}${entry.pathname}`;
    return entry.toString();
  } catch {
    return safeEntryUrl;
  }
}

export function resolveEmbedSandbox(
  mode: EmbedSandboxMode | null | undefined,
  ceiling?: "strict" | "scripts",
): string {
  if (ceiling === "strict" || (ceiling === "scripts" && mode === "strict")) {
    return "";
  }
  if (ceiling === "scripts") {
    return "allow-scripts";
  }
  switch (mode) {
    case "strict":
      return "";
    case "trusted":
      return "allow-scripts allow-same-origin";
    default:
      return "allow-scripts";
  }
}
