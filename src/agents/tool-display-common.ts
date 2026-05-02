import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveExecDetail } from "./tool-display-exec.js";
import { asRecord } from "./tool-display-record.js";

type ToolDisplayActionSpec = {
  label?: string;
  detailKeys?: string[];
};

export type ToolDisplaySpec = {
  title?: string;
  label?: string;
  detailKeys?: string[];
  actions?: Record<string, ToolDisplayActionSpec>;
};

type CoerceDisplayValueOptions = {
  includeFalse?: boolean;
  includeZero?: boolean;
  includeNonFinite?: boolean;
  maxStringChars?: number;
  maxArrayEntries?: number;
};

export function normalizeToolName(name?: string): string {
  return (name ?? "tool").trim();
}

export function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, " ").trim();
  if (!cleaned) {
    return "Tool";
  }
  return cleaned
    .split(/\s+/)
    .map((part) =>
      part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

function normalizeVerb(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/_/g, " ");
}

function resolveActionArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const actionRaw = (args as Record<string, unknown>).action;
  if (typeof actionRaw !== "string") {
    return undefined;
  }
  const action = normalizeOptionalString(actionRaw);
  return action || undefined;
}

export function resolveToolVerbAndDetailForArgs(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  spec?: ToolDisplaySpec;
  fallbackDetailKeys?: string[];
  detailMode: "first" | "summary";
  detailCoerce?: CoerceDisplayValueOptions;
  detailMaxEntries?: number;
  detailFormatKey?: (raw: string) => string;
}): { verb?: string; detail?: string } {
  return resolveToolVerbAndDetail({
    toolKey: params.toolKey,
    args: params.args,
    meta: params.meta,
    action: resolveActionArg(params.args),
    spec: params.spec,
    fallbackDetailKeys: params.fallbackDetailKeys,
    detailMode: params.detailMode,
    detailCoerce: params.detailCoerce,
    detailMaxEntries: params.detailMaxEntries,
    detailFormatKey: params.detailFormatKey,
  });
}

function coerceDisplayValue(
  value: unknown,
  opts: CoerceDisplayValueOptions = {},
): string | undefined {
  const maxStringChars = opts.maxStringChars ?? 160;
  const maxArrayEntries = opts.maxArrayEntries ?? 3;

  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstLine = normalizeOptionalString(trimmed.split(/\r?\n/)[0]) ?? "";
    if (!firstLine) {
      return undefined;
    }
    if (firstLine.length > maxStringChars) {
      return `${firstLine.slice(0, Math.max(0, maxStringChars - 3))}…`;
    }
    return firstLine;
  }
  if (typeof value === "boolean") {
    if (!value && !opts.includeFalse) {
      return undefined;
    }
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return opts.includeNonFinite ? String(value) : undefined;
    }
    if (value === 0 && !opts.includeZero) {
      return undefined;
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) => coerceDisplayValue(item, opts))
      .filter((item): item is string => Boolean(item));
    if (values.length === 0) {
      return undefined;
    }
    const preview = values.slice(0, maxArrayEntries).join(", ");
    return values.length > maxArrayEntries ? `${preview}…` : preview;
  }
  return undefined;
}

function lookupValueByPath(args: unknown, path: string): unknown {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  let current: unknown = args;
  for (const segment of path.split(".")) {
    if (!segment) {
      return undefined;
    }
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current = record[segment];
  }
  return current;
}

export function formatDetailKey(raw: string, overrides: Record<string, string> = {}): string {
  const segments = raw.split(".").filter(Boolean);
  const last = segments.at(-1) ?? raw;
  const override = overrides[last];
  if (override) {
    return override;
  }
  const cleaned = last.replace(/_/g, " ").replace(/-/g, " ");
  const spaced = cleaned.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return normalizeLowercaseStringOrEmpty(spaced) || normalizeLowercaseStringOrEmpty(last);
}

function resolvePathArg(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  for (const candidate of [record.path, record.file_path, record.filePath]) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveReadDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path = resolvePathArg(record);
  if (!path) {
    return undefined;
  }

  const offsetRaw =
    typeof record.offset === "number" && Number.isFinite(record.offset)
      ? Math.floor(record.offset)
      : undefined;
  const limitRaw =
    typeof record.limit === "number" && Number.isFinite(record.limit)
      ? Math.floor(record.limit)
      : undefined;

  const offset = offsetRaw !== undefined ? Math.max(1, offsetRaw) : undefined;
  const limit = limitRaw !== undefined ? Math.max(1, limitRaw) : undefined;

  if (offset !== undefined && limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `${unit} ${offset}-${offset + limit - 1} from ${path}`;
  }
  if (offset !== undefined) {
    return `from line ${offset} in ${path}`;
  }
  if (limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `first ${limit} ${unit} of ${path}`;
  }
  return `from ${path}`;
}

function resolveWriteDetail(toolKey: string, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path = resolvePathArg(record) ?? normalizeOptionalString(record.url);
  if (!path) {
    return undefined;
  }

  if (toolKey === "attach") {
    return `from ${path}`;
  }

  const destinationPrefix = toolKey === "edit" ? "in" : "to";
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.newText === "string"
        ? record.newText
        : typeof record.new_string === "string"
          ? record.new_string
          : undefined;

  if (content && content.length > 0) {
    return `${destinationPrefix} ${path} (${content.length} chars)`;
  }

  return `${destinationPrefix} ${path}`;
}

function resolveWebSearchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const query = normalizeOptionalString(record.query);
  const count =
    typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0
      ? Math.floor(record.count)
      : undefined;

  if (!query) {
    return undefined;
  }

  return count !== undefined ? `for "${query}" (top ${count})` : `for "${query}"`;
}

function resolveWebFetchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const url = normalizeOptionalString(record.url);
  if (!url) {
    return undefined;
  }

  const mode = normalizeOptionalString(record.extractMode);
  const maxChars =
    typeof record.maxChars === "number" && Number.isFinite(record.maxChars) && record.maxChars > 0
      ? Math.floor(record.maxChars)
      : undefined;

  const suffix = [
    mode ? `mode ${mode}` : undefined,
    maxChars !== undefined ? `max ${maxChars} chars` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");

  return suffix ? `from ${url} (${suffix})` : `from ${url}`;
}

function resolveActionSpec(
  spec: ToolDisplaySpec | undefined,
  action: string | undefined,
): ToolDisplayActionSpec | undefined {
  if (!spec || !action) {
    return undefined;
  }
  return spec.actions?.[action] ?? undefined;
}

function resolveDetailFromKeys(
  args: unknown,
  keys: string[],
  opts: {
    mode: "first" | "summary";
    coerce?: CoerceDisplayValueOptions;
    maxEntries?: number;
    formatKey?: (raw: string) => string;
  },
): string | undefined {
  if (opts.mode === "first") {
    for (const key of keys) {
      const value = lookupValueByPath(args, key);
      const display = coerceDisplayValue(value, opts.coerce);
      if (display) {
        return display;
      }
    }
    return undefined;
  }

  const entries: Array<{ label: string; value: string }> = [];
  for (const key of keys) {
    const value = lookupValueByPath(args, key);
    const display = coerceDisplayValue(value, opts.coerce);
    if (!display) {
      continue;
    }
    entries.push({ label: opts.formatKey ? opts.formatKey(key) : key, value: display });
  }
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return entries[0].value;
  }

  const seen = new Set<string>();
  const unique: Array<{ label: string; value: string }> = [];
  for (const entry of entries) {
    const token = `${entry.label}:${entry.value}`;
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(entry);
  }
  if (unique.length === 0) {
    return undefined;
  }

  return unique
    .slice(0, opts.maxEntries ?? 8)
    .map((entry) => `${entry.label} ${entry.value}`)
    .join(" · ");
}

function resolveToolVerbAndDetail(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  action?: string;
  spec?: ToolDisplaySpec;
  fallbackDetailKeys?: string[];
  detailMode: "first" | "summary";
  detailCoerce?: CoerceDisplayValueOptions;
  detailMaxEntries?: number;
  detailFormatKey?: (raw: string) => string;
}): { verb?: string; detail?: string } {
  const actionSpec = resolveActionSpec(params.spec, params.action);
  const fallbackVerb =
    params.toolKey === "web_search"
      ? "search"
      : params.toolKey === "web_fetch"
        ? "fetch"
        : params.toolKey.replace(/_/g, " ").replace(/\./g, " ");
  const verb = normalizeVerb(actionSpec?.label ?? params.action ?? fallbackVerb);

  let detail: string | undefined;
  if (params.toolKey === "exec") {
    detail = resolveExecDetail(params.args);
  }
  if (!detail && params.toolKey === "read") {
    detail = resolveReadDetail(params.args);
  }
  if (
    !detail &&
    (params.toolKey === "write" || params.toolKey === "edit" || params.toolKey === "attach")
  ) {
    detail = resolveWriteDetail(params.toolKey, params.args);
  }
  if (!detail && params.toolKey === "web_search") {
    detail = resolveWebSearchDetail(params.args);
  }
  if (!detail && params.toolKey === "web_fetch") {
    detail = resolveWebFetchDetail(params.args);
  }

  const detailKeys =
    actionSpec?.detailKeys ?? params.spec?.detailKeys ?? params.fallbackDetailKeys ?? [];
  if (!detail && detailKeys.length > 0) {
    detail = resolveDetailFromKeys(params.args, detailKeys, {
      mode: params.detailMode,
      coerce: params.detailCoerce,
      maxEntries: params.detailMaxEntries,
      formatKey: params.detailFormatKey,
    });
  }
  if (!detail && params.meta) {
    detail = params.meta;
  }
  return { verb, detail };
}

export function formatToolDetailText(
  detail: string | undefined,
  opts: { prefixWithWith?: boolean } = {},
): string | undefined {
  if (!detail) {
    return undefined;
  }
  const normalized = detail.includes(" · ")
    ? detail
        .split(" · ")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join(", ")
    : detail;
  if (!normalized) {
    return undefined;
  }
  return opts.prefixWithWith ? `with ${normalized}` : normalized;
}
