import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";

const NO_ERROR_DETAIL = "no error detail";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redact(value: string): string {
  return redactSensitiveText(value);
}

function addStringDetail(details: string[], label: string, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = redact(value.trim());
  if (trimmed) {
    details.push(label ? `${label}: ${trimmed}` : trimmed);
  }
}

function addScalarDetail(details: string[], label: string, value: unknown) {
  if (typeof value === "string") {
    addStringDetail(details, label, value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    details.push(`${label}: ${String(value)}`);
  }
}

function addStringListDetail(details: string[], label: string, value: unknown) {
  if (!Array.isArray(value)) {
    return;
  }
  const entries = value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = redact(entry.trim());
    return trimmed ? [trimmed] : [];
  });
  if (entries.length) {
    details.push(`${label}: ${entries.join(", ")}`);
  }
}

function safeStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  try {
    const result = JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "object" || nested === null) {
        return nested;
      }
      if (seen.has(nested)) {
        return "[Circular]";
      }
      seen.add(nested);
      return nested;
    });
    return result ? redact(result) : undefined;
  } catch {
    return undefined;
  }
}

function addSlackResponseMetadata(details: string[], value: unknown) {
  if (!isRecord(value)) {
    return;
  }
  addStringListDetail(details, "scopes", value.scopes);
  addStringListDetail(details, "accepted", value.acceptedScopes);
  const messages = value.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      addStringDetail(details, "slack message", message);
    }
  }
  const warnings = value.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings) {
      addStringDetail(details, "slack warning", warning);
    }
  }
}

function addSlackDataDetails(details: string[], value: unknown) {
  if (!isRecord(value)) {
    return;
  }
  addScalarDetail(details, "slack error", value.error);
  addScalarDetail(details, "needed", value.needed);
  addScalarDetail(details, "provided", value.provided);
  addSlackResponseMetadata(details, value.response_metadata);
}

function addRecordDetails(details: string[], value: Record<string, unknown>) {
  addScalarDetail(details, "code", value.code);
  addScalarDetail(details, "status", value.status);
  addScalarDetail(details, "statusCode", value.statusCode);
  addScalarDetail(details, "statusMessage", value.statusMessage);
  addScalarDetail(details, "retryAfter", value.retryAfter);
  addScalarDetail(details, "errno", value.errno);
  addScalarDetail(details, "syscall", value.syscall);
  addScalarDetail(details, "hostname", value.hostname);
  addScalarDetail(details, "type", value.type);
  addStringDetail(details, "statusText", value.statusText);
  addStringDetail(details, "body", value.body);
  addSlackDataDetails(details, value.data);
  if (isRecord(value.response)) {
    addScalarDetail(details, "response status", value.response.status);
    addStringDetail(details, "response statusText", value.response.statusText);
    addSlackDataDetails(details, value.response.data);
  }
}

function collectSlackErrorDetails(error: unknown): string[] {
  const details: string[] = [];
  if (error === undefined || error === null) {
    return details;
  }
  if (typeof error === "string") {
    addStringDetail(details, "", error);
    return details;
  }
  if (error instanceof Error) {
    addStringDetail(details, "", error.message || error.name);
    if (error.cause !== undefined) {
      const cause = formatSlackError(error.cause, "");
      if (cause) {
        details.push(`cause: ${cause}`);
      }
    }
  }
  if (isRecord(error)) {
    addRecordDetails(details, error);
    const fallback = safeStringify(error);
    if (details.length === 0 && fallback && fallback !== "{}") {
      details.push(fallback);
    }
  }
  return details;
}

export function formatSlackError(error: unknown, fallback = NO_ERROR_DETAIL): string {
  const details = collectSlackErrorDetails(error);
  if (details.length > 0) {
    return details.join("; ");
  }
  if (error === undefined || error === null) {
    return fallback;
  }
  if (typeof error === "string" && !error.trim()) {
    return fallback;
  }
  return safeStringify(error) ?? fallback;
}
