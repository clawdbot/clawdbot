import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "./diagnostic-support-redaction.js";

const LOG_STRING_FIELD_RE =
  /^(?:action|channel|code|component|endpoint|event|handshake|kind|level|localAddr|logger|method|model|module|msg|name|outcome|phase|pluginId|provider|reason|remoteAddr|requestId|runId|service|source|status|subsystem|surface|target|time|traceId|type)$/iu;
const LOG_SCALAR_FIELD_RE =
  /^(?:active|attempt|bytes|count|durationMs|enabled|exitCode|intervalMs|jobs|limitBytes|localPort|nextWakeAtMs|pid|port|queueDepth|queued|remotePort|statusCode|waitMs|waiting)$/iu;
const OMITTED_LOG_FIELD_RE =
  /(?:authorization|body|chat|content|cookie|credential|detail|error|header|instruction|message|password|payload|prompt|result|secret|session[-_]?id|session[-_]?key|text|token|tool|transcript|url)/iu;
const UNSAFE_LOG_MESSAGE_RE =
  /(?:\b(?:ai response|assistant said|chat text|message contents|prompt|raw webhook body|tool output|tool result|transcript|user said|webhook body)\b|auto-responding\b.*:\s*["']|partial for\b.*:)/iu;
const MAX_LOG_STRING_LENGTH = 240;
const LOGTAPE_META_FIELD = "_meta";
const LOGTAPE_ARG_FIELD_RE = /^\d+$/u;

const LOGTAPE_META_STRING_FIELDS = new Map([
  ["logLevelName", "level"],
  ["name", "logger"],
]);

function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function createLogRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

export function sanitizeSupportLogRecord(
  line: string,
  redaction: SupportRedactionContext,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      omitted: "unparsed",
      bytes: byteLength(line),
    };
  }

  const source = asRecord(parsed);
  if (!source) {
    return {
      omitted: "non-object",
      bytes: byteLength(line),
    };
  }

  const sanitized = createLogRecord();
  addNamedLogFields(sanitized, source, redaction);
  addLogTapeMetaFields(sanitized, source, redaction);
  addLogTapeArgFields(sanitized, source, redaction);

  return Object.keys(sanitized).length > 0
    ? sanitized
    : {
        omitted: "no-safe-fields",
        bytes: byteLength(line),
      };
}

function addNamedLogFields(
  sanitized: Record<string, unknown>,
  source: Record<string, unknown>,
  redaction: SupportRedactionContext,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === LOGTAPE_META_FIELD || LOGTAPE_ARG_FIELD_RE.test(key)) {
      continue;
    }
    addSafeLogField(sanitized, key, value, redaction);
  }
}

function addLogTapeMetaFields(
  sanitized: Record<string, unknown>,
  source: Record<string, unknown>,
  redaction: SupportRedactionContext,
): void {
  const meta = asRecord(source[LOGTAPE_META_FIELD]);
  if (!meta) {
    return;
  }
  for (const [sourceKey, outputKey] of LOGTAPE_META_STRING_FIELDS) {
    if (sanitized[outputKey] !== undefined) {
      continue;
    }
    const value = meta[sourceKey];
    if (typeof value === "string") {
      if (sourceKey === "name") {
        const record = parseJsonRecord(value);
        if (record) {
          addLogObjectFields(sanitized, record, redaction);
          continue;
        }
      }
      sanitized[outputKey] = sanitizeLogString(value, redaction);
    }
  }
}

function addLogTapeArgFields(
  sanitized: Record<string, unknown>,
  source: Record<string, unknown>,
  redaction: SupportRedactionContext,
): void {
  const args = Object.entries(source)
    .filter(([key]) => LOGTAPE_ARG_FIELD_RE.test(key))
    .toSorted(([left], [right]) => Number(left) - Number(right));

  for (const [, value] of args) {
    const record = typeof value === "string" ? parseJsonRecord(value) : asRecord(value);
    if (record) {
      addLogObjectFields(sanitized, record, redaction);
      continue;
    }

    if (typeof value === "string") {
      addLogTapeMessageField(sanitized, value, redaction);
    }
  }
}

function addLogTapeMessageField(
  sanitized: Record<string, unknown>,
  value: string,
  redaction: SupportRedactionContext,
): void {
  const message = sanitizeLogString(value, redaction);
  if (sanitized.msg === undefined && message && !UNSAFE_LOG_MESSAGE_RE.test(message)) {
    sanitized.msg = message;
    return;
  }
  addOmittedLogMessageMetadata(sanitized, value);
}

function addOmittedLogMessageMetadata(sanitized: Record<string, unknown>, value: string): void {
  sanitized.omitted = "log-message";
  sanitized.omittedLogMessageBytes =
    numericLogMetadata(sanitized.omittedLogMessageBytes) + byteLength(value);
  sanitized.omittedLogMessageCount = numericLogMetadata(sanitized.omittedLogMessageCount) + 1;
}

function numericLogMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function addLogObjectFields(
  sanitized: Record<string, unknown>,
  source: Record<string, unknown>,
  redaction: SupportRedactionContext,
): void {
  for (const [key, value] of Object.entries(source)) {
    addSafeLogField(sanitized, key, value, redaction);
  }
}

function addSafeLogField(
  sanitized: Record<string, unknown>,
  key: string,
  value: unknown,
  redaction: SupportRedactionContext,
): void {
  if (OMITTED_LOG_FIELD_RE.test(key)) {
    return;
  }
  if (isBlockedObjectKey(key)) {
    return;
  }
  if (!isSafeLogField(key, value)) {
    return;
  }
  if (typeof value === "string") {
    const message = sanitizeLogString(value, redaction);
    if (key === "msg" && (!message || UNSAFE_LOG_MESSAGE_RE.test(message))) {
      addOmittedLogMessageMetadata(sanitized, value);
      return;
    }
    sanitized[key] = message;
  } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
    sanitized[key] = value;
  }
}

function sanitizeLogString(value: string, redaction: SupportRedactionContext): string {
  return redactSupportString(value, redaction, {
    maxLength: MAX_LOG_STRING_LENGTH,
    truncationSuffix: "",
  });
}

function isSafeLogField(key: string, value: unknown): boolean {
  if (typeof value === "string") {
    return LOG_STRING_FIELD_RE.test(key);
  }
  return LOG_STRING_FIELD_RE.test(key) || LOG_SCALAR_FIELD_RE.test(key);
}
