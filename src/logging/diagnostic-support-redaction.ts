import path from "node:path";
import { isSecretRefShape } from "../config/redact-snapshot.secret-ref.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { isSensitiveUrlQueryParamName } from "../shared/net/redact-sensitive-url.js";
import { redactSensitiveText } from "./redact.js";

const SECRET_SUPPORT_FIELD_RE =
  /(?:authorization|cookie|credential|key|password|passwd|secret|token)/iu;
const PAYLOAD_SUPPORT_FIELD_RE =
  /(?:body|chat|content|detail|error|header|instruction|message|payload|prompt|result|text|tool|transcript)/iu;
const IDENTIFIER_SUPPORT_FIELD_RE =
  /(?:account[-_]?id|chat[-_]?id|conversation[-_]?id|email|message[-_]?id|phone|thread[-_]?id|user[-_]?id|username)/iu;
const PRIVATE_MAP_SUPPORT_FIELD_RE = /^(?:accounts|chats|conversations|messages|threads|users)$/iu;
const CONFIG_PRIVATE_FIELD_RE =
  /(?:allow[-_]?from|allow[-_]?to|deny[-_]?from|deny[-_]?to|blocked[-_]?from|blocked[-_]?users|owner[-_]?id|sender[-_]?id|recipient[-_]?id)/iu;
const SENSITIVE_COMMAND_ARG_RE =
  /^--(?:api[-_]?key|hook[-_]?token|password|password-file|passwd|secret|token)(?:=.*)?$/iu;
const BASIC_AUTH_RE = /\bBasic\s+[A-Za-z0-9+/]+={0,2}/giu;
const COOKIE_HEADER_RE = /\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/giu;
const AWS_ACCESS_KEY_ID_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s:?#]+)(?::([^/@\s?#]+))?@/giu;
const URL_PARAM_RE = /([?&])([^=&\s]+)=([^&#\s]+)/giu;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const MATRIX_USER_ID_RE = /@[A-Za-z0-9._=-]+:[A-Za-z0-9.-]+/gu;
const MATRIX_ROOM_ID_RE = /![A-Za-z0-9._=-]+:[A-Za-z0-9.-]+/gu;
const MATRIX_EVENT_ID_RE = /\$[A-Za-z0-9_-]{16,}/gu;
const HANDLE_RE = /(^|[^\w:/])@[A-Za-z0-9_]{5,}\b(?!\.)/gu;
const LONG_DECIMAL_ID_RE = /\b\d{9,}\b/gu;
const MAX_SUPPORT_STRING_LENGTH = 2000;
const MAX_SUPPORT_SNAPSHOT_DEPTH = 10;
const MAX_SUPPORT_ARRAY_ITEMS = 1000;
const MAX_SUPPORT_OBJECT_ENTRIES = 1000;
const DEFAULT_TRUNCATION_SUFFIX = "...<truncated>";
const TRUNCATED_SUPPORT_FIELD = "<truncated>";

export type SupportRedactionContext = {
  env: NodeJS.ProcessEnv;
  stateDir: string;
};

type RedactSupportStringOptions = {
  maxLength?: number;
  truncationSuffix?: string;
};

type PathRedactionPrefix = {
  prefix: string;
  label: string;
  caseInsensitive: boolean;
};

type SupportObjectEntry = {
  key: string;
  value: unknown;
};

type LimitedSupportArray = {
  count: number;
  items: unknown[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isPrivateSupportField(key: string): boolean {
  return (
    SECRET_SUPPORT_FIELD_RE.test(key) ||
    PAYLOAD_SUPPORT_FIELD_RE.test(key) ||
    IDENTIFIER_SUPPORT_FIELD_RE.test(key)
  );
}

function isPrivateConfigField(key: string): boolean {
  return isPrivateSupportField(key) || CONFIG_PRIVATE_FIELD_RE.test(key);
}

function sanitizeSecretRefForSupport(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = createSupportRecord();
  if (typeof value.source === "string") {
    sanitized.source = value.source;
  }
  if (typeof value.provider === "string") {
    sanitized.provider = value.provider;
  }
  sanitized.id = "<redacted>";
  return sanitized;
}

function privateMapEntryLabel(key: string): string {
  const normalized = key.toLowerCase();
  return normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
}

function createSupportRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function countOwnObjectEntries(record: Record<string, unknown>): number {
  let count = 0;
  for (const key in record) {
    if (hasOwnRecordKey(record, key)) {
      count += 1;
    }
  }
  return count;
}

function limitedSupportObjectEntries(record: Record<string, unknown>): {
  count: number;
  entries: SupportObjectEntry[];
} {
  let count = 0;
  const entries: SupportObjectEntry[] = [];
  for (const key in record) {
    if (!hasOwnRecordKey(record, key)) {
      continue;
    }
    count += 1;
    if (isBlockedObjectKey(key) || entries.length >= MAX_SUPPORT_OBJECT_ENTRIES) {
      continue;
    }
    entries.push({ key, value: record[key] });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { count, entries };
}

function limitedSupportArray(value: unknown[]): LimitedSupportArray {
  return {
    count: value.length,
    items: value.slice(0, MAX_SUPPORT_ARRAY_ITEMS),
  };
}

function addTruncationMetadata(sanitized: Record<string, unknown>, count: number): void {
  if (count > MAX_SUPPORT_OBJECT_ENTRIES) {
    sanitized[TRUNCATED_SUPPORT_FIELD] = {
      truncated: true,
      count,
      limit: MAX_SUPPORT_OBJECT_ENTRIES,
    };
  }
}

function supportArrayResult(items: unknown[], count: number): unknown[] | Record<string, unknown> {
  if (count <= MAX_SUPPORT_ARRAY_ITEMS) {
    return items;
  }
  return {
    items,
    truncated: true,
    count,
    limit: MAX_SUPPORT_ARRAY_ITEMS,
  };
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(value);
}

function normalizePathPrefix(value: string): string {
  return isWindowsAbsolutePath(value) ? path.win32.resolve(value) : path.resolve(value);
}

function addPathPrefix(
  prefixes: Map<string, PathRedactionPrefix>,
  prefix: string,
  label: string,
  caseInsensitive: boolean,
): void {
  if (!prefixes.has(prefix)) {
    prefixes.set(prefix, { prefix, label, caseInsensitive });
  }
}

function addPathPrefixVariants(
  prefixes: Map<string, PathRedactionPrefix>,
  value: string | undefined,
  label: string,
): void {
  if (!value) {
    return;
  }
  const normalized = normalizePathPrefix(value);
  const caseInsensitive = isWindowsAbsolutePath(normalized);
  addPathPrefix(prefixes, normalized, label, caseInsensitive);
  if (isWindowsAbsolutePath(normalized)) {
    addPathPrefix(prefixes, normalized.replaceAll("\\", "/"), label, caseInsensitive);
  }
}

function pathRedactionPrefixes(options: SupportRedactionContext): PathRedactionPrefix[] {
  const prefixes = new Map<string, PathRedactionPrefix>();
  addPathPrefixVariants(prefixes, options.stateDir, "$OPENCLAW_STATE_DIR");
  addPathPrefixVariants(prefixes, options.env.HOME, "~");
  addPathPrefixVariants(prefixes, options.env.USERPROFILE, "~");
  return [...prefixes.values()].toSorted((a, b) => b.prefix.length - a.prefix.length);
}

function pathCandidates(file: string): string[] {
  if (!isWindowsAbsolutePath(file)) {
    return [path.resolve(file)];
  }
  const resolved = path.win32.resolve(file);
  return [resolved, resolved.replaceAll("\\", "/")];
}

function hasPathPrefix(value: string, prefix: PathRedactionPrefix): boolean {
  return prefix.caseInsensitive
    ? value.toLowerCase().startsWith(prefix.prefix.toLowerCase())
    : value.startsWith(prefix.prefix);
}

function matchPathPrefix(file: string, prefix: PathRedactionPrefix): string | undefined {
  if (file.length === prefix.prefix.length && hasPathPrefix(file, prefix)) {
    return "";
  }
  if (!hasPathPrefix(file, prefix)) {
    return undefined;
  }
  const next = file[prefix.prefix.length];
  return next === "/" || next === "\\" ? file.slice(prefix.prefix.length) : undefined;
}

function isSupportAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || isWindowsAbsolutePath(value);
}

export function redactPathForSupport(file: string, options: SupportRedactionContext): string {
  if (file.startsWith("$")) {
    return file;
  }
  const candidates = pathCandidates(file);
  for (const next of candidates) {
    for (const prefix of pathRedactionPrefixes(options)) {
      const suffix = matchPathPrefix(next, prefix);
      if (suffix !== undefined) {
        return `${prefix.label}${suffix}`;
      }
    }
  }
  return redactSensitiveTextForSupport(candidates[0] ?? file);
}

function replaceKnownPathPrefix(value: string, prefix: PathRedactionPrefix): string {
  const search = prefix.caseInsensitive ? prefix.prefix.toLowerCase() : prefix.prefix;
  const haystack = prefix.caseInsensitive ? value.toLowerCase() : value;
  let offset = 0;
  let next = "";
  while (offset < value.length) {
    const index = haystack.indexOf(search, offset);
    if (index === -1) {
      next += value.slice(offset);
      break;
    }
    next += value.slice(offset, index);
    next += prefix.label;
    offset = index + prefix.prefix.length;
  }
  return next;
}

function redactKnownPathPrefixesForSupport(
  value: string,
  redaction: SupportRedactionContext,
): string {
  let next = value;
  for (const prefix of pathRedactionPrefixes(redaction)) {
    next = replaceKnownPathPrefix(next, prefix);
  }
  return next;
}

export function redactTextForSupport(value: string): string {
  let redacted = redactSensitiveTextForSupport(value);
  redacted = redactCommonCredentialTextForSupport(redacted);
  redacted = redactUrlSecretsForSupport(redacted);
  redacted = redactServiceIdentifiersForSupport(redacted);
  redacted = redactContactIdentifiersForSupport(redacted);
  return redactLongIdentifiersForSupport(redacted);
}

function redactSensitiveTextForSupport(value: string): string {
  return redactSensitiveText(value, { mode: "tools" });
}

function redactCommonCredentialTextForSupport(value: string): string {
  return value
    .replace(BASIC_AUTH_RE, "Basic <redacted>")
    .replace(COOKIE_HEADER_RE, "$1: <redacted>")
    .replace(AWS_ACCESS_KEY_ID_RE, "<redacted-aws-key>")
    .replace(JWT_RE, "<redacted-jwt>");
}

function redactUrlSecretsForSupport(value: string): string {
  return value
    .replace(URL_USERINFO_RE, (_match, scheme: string, _username: string, password?: string) =>
      password ? `${scheme}<redacted>:<redacted>@` : `${scheme}<redacted>@`,
    )
    .replace(URL_PARAM_RE, (match, prefix: string, key: string) =>
      isSensitiveUrlQueryParamName(key) ? `${prefix}${key}=<redacted>` : match,
    );
}

function redactContactIdentifiersForSupport(value: string): string {
  return value.replace(EMAIL_RE, "<redacted-email>").replace(HANDLE_RE, "$1<redacted-handle>");
}

function redactServiceIdentifiersForSupport(value: string): string {
  return value
    .replace(MATRIX_USER_ID_RE, "<redacted-matrix-user>")
    .replace(MATRIX_ROOM_ID_RE, "<redacted-matrix-room>")
    .replace(MATRIX_EVENT_ID_RE, "<redacted-matrix-event>");
}

function redactLongIdentifiersForSupport(value: string): string {
  return value.replace(LONG_DECIMAL_ID_RE, "<redacted-id>");
}

export function redactSupportString(
  value: string,
  redaction: SupportRedactionContext,
  options: RedactSupportStringOptions = {},
): string {
  const maxLength = options.maxLength ?? MAX_SUPPORT_STRING_LENGTH;
  const truncationSuffix = options.truncationSuffix ?? DEFAULT_TRUNCATION_SUFFIX;
  const redacted = redactTextForSupport(value);
  const pathRedacted = isSupportAbsolutePath(redacted)
    ? redactPathForSupport(redacted, redaction)
    : redactKnownPathPrefixesForSupport(redacted, redaction);
  if (pathRedacted.length <= maxLength) {
    return pathRedacted;
  }
  return `${pathRedacted.slice(0, maxLength)}${truncationSuffix}`;
}

function sanitizeCommandArguments(args: unknown[], redaction: SupportRedactionContext): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (typeof arg !== "string") {
      return sanitizeSupportSnapshotValue(arg, redaction);
    }
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (SENSITIVE_COMMAND_ARG_RE.test(arg)) {
      const hasInlineValue = arg.includes("=");
      if (!hasInlineValue) {
        redactNext = true;
      }
      return hasInlineValue ? arg.replace(/[=].*/u, "=<redacted>") : arg;
    }
    return redactSupportString(arg, redaction);
  });
}

export function sanitizeSupportSnapshotValue(
  value: unknown,
  redaction: SupportRedactionContext,
  key = "",
  depth = 0,
): unknown {
  if (value == null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return isPrivateSupportField(key) ? "<redacted>" : value;
  }
  if (typeof value === "string") {
    return isPrivateSupportField(key) ? "<redacted>" : redactSupportString(value, redaction);
  }
  if (depth >= MAX_SUPPORT_SNAPSHOT_DEPTH) {
    return "<truncated>";
  }
  if (Array.isArray(value)) {
    const { count, items } = limitedSupportArray(value);
    if (key === "programArguments") {
      return supportArrayResult(sanitizeCommandArguments(items, redaction), count);
    }
    return supportArrayResult(
      items.map((entry) => sanitizeSupportSnapshotValue(entry, redaction, key, depth + 1)),
      count,
    );
  }
  const record = asRecord(value);
  if (!record) {
    return "<unsupported>";
  }
  if (PRIVATE_MAP_SUPPORT_FIELD_RE.test(key)) {
    return { count: countOwnObjectEntries(record) };
  }
  const sanitized = createSupportRecord();
  const { count, entries } = limitedSupportObjectEntries(record);
  for (const { key: entryKey, value: entryValue } of entries) {
    sanitized[entryKey] = isPrivateSupportField(entryKey)
      ? "<redacted>"
      : sanitizeSupportSnapshotValue(entryValue, redaction, entryKey, depth + 1);
  }
  addTruncationMetadata(sanitized, count);
  return sanitized;
}

export function sanitizeSupportConfigValue(
  value: unknown,
  redaction: SupportRedactionContext,
  key = "",
  depth = 0,
): unknown {
  if (value == null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return isPrivateConfigField(key) ? "<redacted>" : value;
  }
  if (typeof value === "string") {
    return isPrivateConfigField(key) ? "<redacted>" : redactSupportString(value, redaction);
  }
  if (depth >= MAX_SUPPORT_SNAPSHOT_DEPTH) {
    return "<truncated>";
  }
  if (Array.isArray(value)) {
    if (isPrivateConfigField(key)) {
      return {
        redacted: true,
        count: value.length,
      };
    }
    const { count, items } = limitedSupportArray(value);
    return supportArrayResult(
      items.map((entry) => sanitizeSupportConfigValue(entry, redaction, key, depth + 1)),
      count,
    );
  }
  const record = asRecord(value);
  if (!record) {
    return "<unsupported>";
  }
  if (isPrivateConfigField(key)) {
    return isSecretRefShape(record) ? sanitizeSecretRefForSupport(record) : "<redacted>";
  }

  const sanitized = createSupportRecord();
  let privateEntryIndex = 0;
  const redactEntryKeys = PRIVATE_MAP_SUPPORT_FIELD_RE.test(key);
  const privateEntryLabel = redactEntryKeys ? privateMapEntryLabel(key) : "";
  const { count, entries } = limitedSupportObjectEntries(record);
  for (const { key: entryKey, value: entryValue } of entries) {
    let outputKey = entryKey;
    if (redactEntryKeys) {
      privateEntryIndex += 1;
      outputKey = `<redacted-${privateEntryLabel}-${privateEntryIndex}>`;
    }
    sanitized[outputKey] = sanitizeSupportConfigValue(entryValue, redaction, entryKey, depth + 1);
  }
  addTruncationMetadata(sanitized, count);
  return sanitized;
}
