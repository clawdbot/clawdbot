import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveExecDetail, type ToolDetailMode } from "./tool-display-exec.js";
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

export type ToolSearchCodeDisplayTarget = {
  toolName: string;
  displayToolName?: string;
  displayArgs?: Record<string, unknown>;
  detail?: string;
  bridgeVerb?: "call" | "describe" | "search";
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
  const parts: string[] = [];
  for (const part of cleaned.split(/\s+/)) {
    parts.push(
      part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`,
    );
  }
  return parts.join(" ");
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
  toolDetailMode?: ToolDetailMode;
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
    toolDetailMode: params.toolDetailMode,
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
    const values: string[] = [];
    let displayValueCount = 0;
    for (const item of value) {
      const display = coerceDisplayValue(item, opts);
      if (!display) {
        continue;
      }
      displayValueCount += 1;
      if (values.length < maxArrayEntries) {
        values.push(display);
      }
    }
    if (displayValueCount === 0) {
      return undefined;
    }
    const preview = values.join(", ");
    return displayValueCount > maxArrayEntries ? `${preview}…` : preview;
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
  let last = "";
  for (const segment of raw.split(".")) {
    if (segment) {
      last = segment;
    }
  }
  last ||= raw;
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

  const queries = collectWebSearchQueries(record);
  const count =
    typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0
      ? Math.floor(record.count)
      : typeof record.max_results === "number" &&
          Number.isFinite(record.max_results) &&
          record.max_results > 0
        ? Math.floor(record.max_results)
        : typeof record.num_results === "number" &&
            Number.isFinite(record.num_results) &&
            record.num_results > 0
          ? Math.floor(record.num_results)
          : typeof record.limit === "number" && Number.isFinite(record.limit) && record.limit > 0
            ? Math.floor(record.limit)
            : typeof record.top_k === "number" && Number.isFinite(record.top_k) && record.top_k > 0
              ? Math.floor(record.top_k)
              : undefined;

  if (queries.length === 0) {
    return undefined;
  }

  const displayedQueries = queries.slice(0, 3).map((query) => `"${query}"`);
  const queryText =
    queries.length > displayedQueries.length
      ? `${displayedQueries.join(", ")}…`
      : displayedQueries.join(", ");

  return count !== undefined ? `for ${queryText} (top ${count})` : `for ${queryText}`;
}

function collectWebSearchQueries(record: Record<string, unknown>): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeOptionalString(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    queries.push(normalized);
  };

  add(record.query);
  add(record.q);
  add(record.search);
  add(record.input);

  for (const key of ["search_query", "image_query", "queries"]) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        add(entry);
        continue;
      }
      const entryRecord = asRecord(entry);
      if (!entryRecord) {
        continue;
      }
      add(entryRecord.query);
      add(entryRecord.q);
      add(entryRecord.search);
    }
  }

  return queries;
}

function parseToolSearchCall(code: string): { target: string; args?: string } | undefined {
  const prefixMatch = code.match(/openclaw\.tools\.call\s*\(\s*/s);
  if (!prefixMatch || prefixMatch.index === undefined) {
    return undefined;
  }
  const rest = code.slice(prefixMatch.index + prefixMatch[0].length);
  const targetMatch = rest.match(/^("[^"]{1,240}"|'[^']{1,240}'|[^,)\s]{1,240})/s);
  if (!targetMatch?.[1]) {
    return undefined;
  }
  const afterTarget = rest.slice(targetMatch[0].length);
  const commaIndex = afterTarget.indexOf(",");
  if (commaIndex < 0) {
    return { target: targetMatch[1] };
  }
  const args = afterTarget.slice(commaIndex + 1);
  return { target: targetMatch[1], args };
}

function normalizeToolSearchDisplayToolName(toolName: string | undefined): string | undefined {
  const value = normalizeOptionalString(toolName);
  if (!value) {
    return undefined;
  }
  const catalogIdMatch = value.match(/^(?:openclaw|mcp|client):[^:]+:(.+)$/s);
  return normalizeOptionalString(catalogIdMatch?.[1]) ?? value;
}

function collectToolSearchDescribeBindings(code: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const bindingPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?openclaw\.tools\.describe\s*\(\s*("[^"]{1,240}"|'[^']{1,240}')\s*(?:,|\))/gs;
  for (const match of code.matchAll(bindingPattern)) {
    const variableName = match[1];
    const target = summarizeToolSearchTarget(match[2]);
    if (variableName && target) {
      bindings.set(variableName, target);
    }
  }
  return bindings;
}

function resolveToolSearchCallTarget(
  code: string,
  rawTarget: string | undefined,
): string | undefined {
  const target = normalizeOptionalString(rawTarget);
  if (!target) {
    return undefined;
  }
  const idReference = target.match(/^([A-Za-z_$][\w$]*)\.id\b/s);
  if (idReference?.[1]) {
    const describedTarget = collectToolSearchDescribeBindings(code).get(idReference[1]);
    if (describedTarget) {
      return describedTarget;
    }
  }
  return summarizeToolSearchTarget(target);
}

function summarizeToolSearchTarget(raw: string | undefined): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  const literalMatch = value.match(/^[\s]*["']([^"']{1,160})["'][\s]*$/s);
  if (literalMatch?.[1]) {
    return normalizeOptionalString(literalMatch[1]);
  }
  const idPropertyMatch = value.match(/\.id\b/);
  if (idPropertyMatch) {
    return normalizeOptionalString(value.replace(/\.id\b.*/s, ""));
  }
  const namePropertyMatch = value.match(/name\s*:\s*["']([^"']{1,120})["']/s);
  if (namePropertyMatch?.[1]) {
    return normalizeOptionalString(namePropertyMatch[1]);
  }
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 80 ? compact : undefined;
}

function parseToolSearchCallArgs(raw: string | undefined): Record<string, unknown> | undefined {
  const source = extractObjectLiteralSource(raw);
  if (!source) {
    return undefined;
  }
  const args: Record<string, unknown> = {};
  const propertyPattern =
    /(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|true|false|null|-?\d+(?:\.\d+)?)/g;
  for (const match of source.matchAll(propertyPattern)) {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) {
      continue;
    }
    args[key] = parseSimpleToolSearchArgValue(value);
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

function extractObjectLiteralSource(raw: string | undefined): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  const start = value.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let i = start; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function parseSimpleToolSearchArgValue(raw: string): unknown {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  const quote = raw[0];
  const inner = raw.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return inner;
    }
  }
  return inner.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function summarizeToolSearchCallInput(raw: string | undefined): string | undefined {
  const value = normalizeOptionalString(raw)
    ?.replace(/[);\s]+$/g, "")
    .trim();
  if (!value) {
    return undefined;
  }
  const queryMatch = value.match(/query\s*:\s*["']([^"']{1,80})["']/s);
  if (queryMatch?.[1]) {
    return "query " + queryMatch[1].trim();
  }
  const actionMatch = value.match(/action\s*:\s*["']([^"']{1,80})["']/s);
  if (actionMatch?.[1]) {
    return normalizeOptionalString(actionMatch[1]);
  }
  const commandMatch = value.match(/command\s*:\s*["']([^"'\n]{1,120})["']/s);
  if (commandMatch?.[1]) {
    return normalizeOptionalString(commandMatch[1]);
  }
  const sessionMatch = value.match(/sessionId\s*:\s*["']([^"']{1,80})["']/s);
  if (sessionMatch?.[1]) {
    return "session " + sessionMatch[1].trim();
  }
  const idMatch = value.match(/id\s*:\s*["']([^"']{1,80})["']/s);
  if (idMatch?.[1]) {
    return idMatch[1].trim();
  }
  return undefined;
}

export function resolveToolSearchCodeDisplayTarget(
  args: unknown,
): ToolSearchCodeDisplayTarget | undefined {
  const record = asRecord(args);
  if (!record || typeof record.code !== "string") {
    return undefined;
  }
  const code = record.code;
  const call = parseToolSearchCall(code);
  if (call) {
    const toolName = resolveToolSearchCallTarget(code, call.target);
    if (!toolName) {
      return { toolName: "tool_search_code", detail: "call selected tool", bridgeVerb: "call" };
    }
    return {
      toolName,
      displayToolName: normalizeToolSearchDisplayToolName(toolName),
      displayArgs: parseToolSearchCallArgs(call.args),
      detail: summarizeToolSearchCallInput(call.args),
      bridgeVerb: "call",
    };
  }
  const describeMatch = code.match(/openclaw\.tools\.describe\s*\(\s*([^)]+?)\s*(?:,|\))/s);
  if (describeMatch) {
    const toolName = summarizeToolSearchTarget(describeMatch[1]);
    return toolName
      ? { toolName, detail: "describe via tool search", bridgeVerb: "describe" }
      : { toolName: "tool_search_code", detail: "describe selected tool", bridgeVerb: "describe" };
  }
  const searchMatch = code.match(/openclaw\.tools\.search\s*\(\s*([^)]+?)\s*(?:,|\))/s);
  if (searchMatch) {
    const query = summarizeToolSearchTarget(searchMatch[1]);
    return {
      toolName: "tool_search_code",
      detail: query ? "search " + query : "search tools",
      bridgeVerb: "search",
    };
  }
  return { toolName: "tool_search_code", detail: "run bridge code" };
}

function resolveToolSearchCodeDetail(args: unknown): string | undefined {
  return resolveToolSearchCodeDisplayTarget(args)?.detail;
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

  let suffix = "";
  if (mode) {
    suffix = `mode ${mode}`;
  }
  if (maxChars !== undefined) {
    suffix = suffix ? `${suffix}, max ${maxChars} chars` : `max ${maxChars} chars`;
  }

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

  const maxEntries = opts.maxEntries ?? 8;
  const parts: string[] = [];
  for (let index = 0; index < unique.length && index < maxEntries; index += 1) {
    const entry = unique[index];
    if (entry) {
      parts.push(`${entry.label} ${entry.value}`);
    }
  }
  return parts.join(" · ");
}

function resolveToolVerbAndDetail(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  action?: string;
  spec?: ToolDisplaySpec;
  fallbackDetailKeys?: string[];
  detailMode: "first" | "summary";
  toolDetailMode?: ToolDetailMode;
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
  if (params.toolKey === "exec" || params.toolKey === "bash") {
    detail = resolveExecDetail(params.args, { detailMode: params.toolDetailMode });
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
  if (!detail && params.toolKey === "tool_search_code") {
    detail = resolveToolSearchCodeDetail(params.args);
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
    ? (() => {
        const parts: string[] = [];
        for (const part of detail.split(" · ")) {
          const trimmed = part.trim();
          if (trimmed) {
            parts.push(trimmed);
          }
        }
        return parts.join(", ");
      })()
    : detail;
  if (!normalized) {
    return undefined;
  }
  return opts.prefixWithWith ? `with ${normalized}` : normalized;
}
