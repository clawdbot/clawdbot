import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import JSON5 from "json5";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import type { ConfigValidationIssue } from "./types.js";
import { isSecretRef } from "./types.secrets.js";

type ConfigIssuePathSegment = string | number;

type Cursor = { pos: number };

function skipTrivia(raw: string, cursor: Cursor): void {
  while (cursor.pos < raw.length) {
    const char = raw[cursor.pos];
    if (/\s/u.test(char ?? "")) {
      cursor.pos++;
      continue;
    }
    if (char === "/" && raw[cursor.pos + 1] === "/") {
      cursor.pos += 2;
      while (cursor.pos < raw.length && !/[\n\r\u2028\u2029]/u.test(raw[cursor.pos] ?? "")) {
        cursor.pos++;
      }
      continue;
    }
    if (char === "/" && raw[cursor.pos + 1] === "*") {
      const close = raw.indexOf("*/", cursor.pos + 2);
      cursor.pos = close === -1 ? raw.length : close + 2;
      continue;
    }
    return;
  }
}

function scanQuoted(raw: string, cursor: Cursor): void {
  const quote = raw[cursor.pos++];
  while (cursor.pos < raw.length) {
    const char = raw[cursor.pos++];
    if (char === "\\") {
      cursor.pos++;
    } else if (char === quote) {
      return;
    }
  }
}

function consume(raw: string, cursor: Cursor, expected: string): boolean {
  skipTrivia(raw, cursor);
  if (raw[cursor.pos] !== expected) {
    return false;
  }
  cursor.pos++;
  return true;
}

function readObjectKey(raw: string, cursor: Cursor): string | null {
  skipTrivia(raw, cursor);
  const start = cursor.pos;
  const char = raw[cursor.pos];
  if (char === '"' || char === "'") {
    scanQuoted(raw, cursor);
  } else {
    while (
      cursor.pos < raw.length &&
      !/[\s:]/u.test(raw[cursor.pos] ?? "") &&
      !(raw[cursor.pos] === "/" && /[/*]/u.test(raw[cursor.pos + 1] ?? ""))
    ) {
      cursor.pos++;
    }
  }
  if (cursor.pos === start) {
    return null;
  }
  const token = raw.slice(start, cursor.pos);
  try {
    if (char === '"' || char === "'") {
      const parsed = JSON5.parse(token);
      return typeof parsed === "string" ? parsed : null;
    }
    const parsed = JSON5.parse(`{${token}:null}`) as Record<string, unknown>;
    return Object.keys(parsed)[0] ?? null;
  } catch {
    return null;
  }
}

function skipValue(raw: string, cursor: Cursor): void {
  skipTrivia(raw, cursor);
  const char = raw[cursor.pos];
  if (char === '"' || char === "'") {
    scanQuoted(raw, cursor);
    return;
  }
  if (char === "{") {
    cursor.pos++;
    while (cursor.pos < raw.length) {
      skipTrivia(raw, cursor);
      if (raw[cursor.pos] === "}") {
        cursor.pos++;
        return;
      }
      if (readObjectKey(raw, cursor) === null || !consume(raw, cursor, ":")) {
        return;
      }
      skipValue(raw, cursor);
      skipTrivia(raw, cursor);
      if (raw[cursor.pos] === ",") {
        cursor.pos++;
      }
    }
    return;
  }
  if (char === "[") {
    cursor.pos++;
    while (cursor.pos < raw.length) {
      skipTrivia(raw, cursor);
      if (raw[cursor.pos] === "]") {
        cursor.pos++;
        return;
      }
      skipValue(raw, cursor);
      skipTrivia(raw, cursor);
      if (raw[cursor.pos] === ",") {
        cursor.pos++;
      }
    }
    return;
  }
  while (
    cursor.pos < raw.length &&
    !/[,}\]\s]/u.test(raw[cursor.pos] ?? "") &&
    !(raw[cursor.pos] === "/" && /[/*]/u.test(raw[cursor.pos + 1] ?? ""))
  ) {
    cursor.pos++;
  }
}

function locateValueOffset(
  raw: string,
  cursor: Cursor,
  segments: readonly ConfigIssuePathSegment[],
  depth: number,
): number | undefined {
  const segment = segments[depth];
  const isLeaf = depth === segments.length - 1;
  if (typeof segment === "number") {
    if (!consume(raw, cursor, "[")) {
      return undefined;
    }
    for (let index = 0; cursor.pos < raw.length; index++) {
      skipTrivia(raw, cursor);
      if (raw[cursor.pos] === "]") {
        return undefined;
      }
      if (index === segment) {
        return isLeaf ? cursor.pos : locateValueOffset(raw, cursor, segments, depth + 1);
      }
      skipValue(raw, cursor);
      if (!consume(raw, cursor, ",")) {
        return undefined;
      }
    }
    return undefined;
  }

  if (!consume(raw, cursor, "{")) {
    return undefined;
  }
  let lastMatch: number | undefined;
  while (cursor.pos < raw.length) {
    skipTrivia(raw, cursor);
    if (raw[cursor.pos] === "}") {
      return lastMatch;
    }
    const key = readObjectKey(raw, cursor);
    if (key === null || !consume(raw, cursor, ":")) {
      return undefined;
    }
    skipTrivia(raw, cursor);
    const valueStart = cursor.pos;
    if (key === segment) {
      lastMatch = isLeaf
        ? valueStart
        : locateValueOffset(raw, { pos: valueStart }, segments, depth + 1);
    }
    cursor.pos = valueStart;
    skipValue(raw, cursor);
    skipTrivia(raw, cursor);
    if (raw[cursor.pos] === ",") {
      cursor.pos++;
      continue;
    }
    return lastMatch;
  }
  return lastMatch;
}

function lineAtOffset(raw: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    const char = raw[index];
    if (char === "\r") {
      line++;
      if (raw[index + 1] === "\n") {
        index++;
      }
    } else if (char === "\n" || char === "\u2028" || char === "\u2029") {
      line++;
    }
  }
  return line;
}

function formatConfigIssuePath(segments: readonly ConfigIssuePathSegment[]): string {
  return segments.reduce<string>(
    (result, segment) =>
      typeof segment === "number"
        ? `${result}[${segment}]`
        : result
          ? `${result}.${segment}`
          : segment,
    "",
  );
}

function resolveConfigValueAtPath(
  root: unknown,
  segments: readonly ConfigIssuePathSegment[],
): unknown {
  let current = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyReceivedValue(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    return serialized.length > 160 ? `${truncateUtf16Safe(serialized, 157)}...` : serialized;
  } catch {
    return null;
  }
}

function isPluginOwnedConfigPath(
  pathValue: string,
  pathSegments?: readonly ConfigIssuePathSegment[],
): boolean {
  if (pathSegments) {
    return (
      pathSegments[0] === "channels" ||
      (pathSegments[0] === "plugins" &&
        pathSegments[1] === "entries" &&
        pathSegments[3] === "config")
    );
  }
  return (
    pathValue.startsWith("channels.") || /^plugins\.entries\.[^.]+\.config(?:\.|$)/.test(pathValue)
  );
}

function shouldOmitReceivedValue(
  pathValue: string,
  value: unknown,
  pathSegments?: readonly ConfigIssuePathSegment[],
): boolean {
  return (
    value === undefined ||
    isSecretRef(value) ||
    isSensitiveConfigPath(pathValue) ||
    isPluginOwnedConfigPath(pathValue, pathSegments) ||
    (typeof value === "object" && value !== null) ||
    stringifyReceivedValue(value) === null
  );
}

function appendReceivedValueHint(
  message: string,
  pathValue: string,
  value: unknown,
  pathSegments?: readonly ConfigIssuePathSegment[],
): string {
  if (
    shouldOmitReceivedValue(pathValue, value, pathSegments) ||
    message.toLowerCase().includes("got:") ||
    /\breceived\b/i.test(message)
  ) {
    return message;
  }
  const label = stringifyReceivedValue(value);
  return label ? `${message}, got: ${label}` : message;
}

function resolveConfigIssueLineInRaw(
  raw: string,
  segments: readonly ConfigIssuePathSegment[],
): number | undefined {
  if (segments.length === 0 || raw.trim().length === 0) {
    return undefined;
  }
  const offset = locateValueOffset(raw, { pos: 0 }, segments, 0);
  return offset === undefined ? undefined : lineAtOffset(raw, offset);
}

type AttachConfigIssueDiagnosticsParams = {
  raw: string | null | undefined;
  parsed: unknown;
  effective: unknown;
  configPath?: string | null;
  formatPathForDisplay?: boolean;
  includeReceivedValueHint?: boolean;
};

type ConfigIssueDiagnostics = ConfigValidationIssue & {
  line?: number;
  sourceFile?: string;
};

export function attachConfigIssueDiagnostics(
  issues: readonly ConfigValidationIssue[],
  params: AttachConfigIssueDiagnosticsParams,
): ConfigIssueDiagnostics[] {
  const raw = typeof params.raw === "string" ? params.raw : null;
  const sourceFile =
    typeof params.configPath === "string" && params.configPath.trim()
      ? path.basename(params.configPath)
      : "openclaw.json";
  return issues.map((issue) => {
    const segments = issue.pathSegments;
    if (!segments || segments.length === 0) {
      return issue;
    }
    const literalValue = resolveConfigValueAtPath(params.parsed, segments);
    const effectiveValue = resolveConfigValueAtPath(params.effective, segments);
    const line = raw === null ? undefined : resolveConfigIssueLineInRaw(raw, segments);
    // Validation follows includes, env substitution, and migrations. Only a
    // matching root-file literal is both accurate and safe to echo here.
    const canShowReceivedValue = line !== undefined && Object.is(literalValue, effectiveValue);
    const message =
      params.includeReceivedValueHint && canShowReceivedValue
        ? appendReceivedValueHint(issue.message, issue.path, effectiveValue, segments)
        : issue.message;
    return {
      ...issue,
      path: params.formatPathForDisplay ? formatConfigIssuePath(segments) : issue.path,
      message,
      ...(line === undefined ? {} : { line, sourceFile }),
    };
  });
}
