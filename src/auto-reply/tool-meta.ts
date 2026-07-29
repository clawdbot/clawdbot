import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveToolDisplay } from "../agents/tool-display.js";
/** Formats compact tool metadata labels for auto-reply progress/status messages. */
import { formatInlineCodeSpan } from "../shared/markdown-code.js";
import { shortenHomeInString } from "../utils.js";

type ToolAggregateOptions = {
  markdown?: boolean;
};

/** Formats one grouped tool-progress label from a tool name and metadata entries. */
export function formatToolAggregate(
  toolName?: string,
  metas?: string[],
  options?: ToolAggregateOptions,
): string {
  const filtered = (metas ?? []).filter(Boolean).map(shortenHomeInString);
  const display = resolveToolDisplay({ name: toolName });
  const normalizedToolName = normalizeLowercaseStringOrEmpty(toolName);
  const compactCommandSummary =
    filtered.length > 0 && (normalizedToolName === "exec" || normalizedToolName === "bash");
  const prefix = compactCommandSummary ? display.emoji : `${display.emoji} ${display.label}`;
  if (!filtered.length) {
    return `${display.emoji} ${display.label}`;
  }

  const rawSegments: string[] = [];
  // Group by directory and brace-collapse filenames to keep progress text short.
  const grouped: Record<string, string[]> = {};
  for (const m of filtered) {
    if (!isPathLike(m)) {
      rawSegments.push(m);
      continue;
    }
    if (m.includes("→")) {
      rawSegments.push(m);
      continue;
    }
    const parts = m.split("/");
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join("/");
      const base = parts.at(-1) ?? m;
      if (!grouped[dir]) {
        grouped[dir] = [];
      }
      grouped[dir].push(base);
    } else {
      if (!grouped["."]) {
        grouped["."] = [];
      }
      grouped["."].push(m);
    }
  }

  const segments = Object.entries(grouped).map(([dir, files]) => {
    const brace = files.length > 1 ? `{${files.join(", ")}}` : files[0];
    if (dir === ".") {
      return brace;
    }
    return `${dir}/${brace}`;
  });

  const allSegments = [...rawSegments, ...segments];
  const meta = allSegments.join("; ");
  const formattedMeta = formatMetaForDisplay(toolName, meta, options?.markdown);
  return compactCommandSummary ? `${prefix} ${formattedMeta}` : `${prefix}: ${formattedMeta}`;
}

function formatMetaForDisplay(
  toolName: string | undefined,
  meta: string,
  markdown?: boolean,
): string {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  if (normalized === "exec" || normalized === "bash") {
    const { flags, body } = splitExecFlags(meta);
    if (flags.length > 0) {
      if (!body) {
        return flags.join(" · ");
      }
      return `${flags.join(" · ")} · ${maybeWrapMarkdown(body, markdown)}`;
    }
  }
  return maybeWrapMarkdown(meta, markdown);
}

function splitExecFlags(meta: string): { flags: string[]; body: string } {
  const parts = meta
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { flags: [], body: "" };
  }
  const flags: string[] = [];
  const bodyParts: string[] = [];
  for (const part of parts) {
    if (part === "elevated" || part === "pty") {
      flags.push(part);
      continue;
    }
    bodyParts.push(part);
  }
  return { flags, body: bodyParts.join(" · ") };
}

function isPathLike(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.includes(" ")) {
    return false;
  }
  if (value.includes("://")) {
    return false;
  }
  if (value.includes("·")) {
    return false;
  }
  if (value.includes("&&") || value.includes("||")) {
    return false;
  }
  return /^~?(\/[^\s]+)+$/.test(value);
}

function maybeWrapMarkdown(value: string, markdown?: boolean): string {
  return markdown ? formatInlineCodeSpan(value) : value;
}
