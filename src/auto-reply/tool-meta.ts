import { formatToolSummary, resolveToolDisplay } from "../agents/tool-display.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";

type ToolAggregateOptions = {
  markdown?: boolean;
};

export function shortenPath(p: string): string {
  return shortenHomePath(p);
}

export function shortenMeta(meta: string): string {
  if (!meta) return meta;
  const colonIdx = meta.indexOf(":");
  if (colonIdx === -1) return shortenHomeInString(meta);
  const base = meta.slice(0, colonIdx);
  const rest = meta.slice(colonIdx);
  return `${shortenHomeInString(base)}${rest}`;
}

export function formatToolAggregate(
  toolName?: string,
  metas?: string[],
  options?: ToolAggregateOptions,
): string {
  const filtered = (metas ?? []).filter(Boolean).map(shortenMeta);
  const display = resolveToolDisplay({ name: toolName });
  const prefix = `${display.emoji} ${display.label}`;
  if (!filtered.length) return prefix;

  const rawSegments: string[] = [];
  // Group by directory and brace-collapse filenames
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
      if (!grouped[dir]) grouped[dir] = [];
      grouped[dir].push(base);
    } else {
      if (!grouped["."]) grouped["."] = [];
      grouped["."].push(m);
    }
  }

  const segments = Object.entries(grouped).map(([dir, files]) => {
    const brace = files.length > 1 ? `{${files.join(", ")}}` : files[0];
    if (dir === ".") return brace;
    return `${dir}/${brace}`;
  });

  const allSegments = [...rawSegments, ...segments];
  const meta = allSegments.join("; ");
  return `${prefix}: ${formatMetaForDisplay(toolName, meta, options?.markdown)}`;
}

export function formatToolPrefix(toolName?: string, meta?: string) {
  const extra = meta?.trim() ? shortenMeta(meta) : undefined;
  const display = resolveToolDisplay({ name: toolName, meta: extra });
  return formatToolSummary(display);
}

function formatMetaForDisplay(
  toolName: string | undefined,
  meta: string,
  markdown?: boolean,
): string {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (normalized === "exec" || normalized === "bash") {
    const { flags, body } = splitExecFlags(meta);
    if (flags.length > 0) {
      if (!body) return flags.join(" · ");
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
  if (parts.length === 0) return { flags: [], body: "" };
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
  if (!value) return false;
  if (value.includes(" ")) return false;
  if (value.includes("://")) return false;
  if (value.includes("·")) return false;
  if (value.includes("&&") || value.includes("||")) return false;
  return /^~?(\/[^\s]+)+$/.test(value);
}

function maybeWrapMarkdown(value: string, markdown?: boolean): string {
  if (!markdown) return value;
  if (value.includes("`")) return value;
  return `\`${value}\``;
}
