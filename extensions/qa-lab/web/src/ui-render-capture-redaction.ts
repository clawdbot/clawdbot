import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const NON_SECRET_CAPTURE_TOKEN_FIELDS = new Set([
  "completiontokens",
  "inputtokens",
  "maxcompletiontokens",
  "maxtokens",
  "outputtokens",
  "prompttokens",
  "reasoningtokens",
  "totaltokens",
]);

export function isSensitiveCaptureField(label: string): boolean {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const tokenMarker =
    !NON_SECRET_CAPTURE_TOKEN_FIELDS.has(normalized) &&
    normalized !== "tokenizer" &&
    normalized.includes("token");
  return (
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("apikey") ||
    normalized.includes("accesskey") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("session") ||
    tokenMarker
  );
}

export function redactCaptureScalar(value: string, label?: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (label && isSensitiveCaptureField(label)) {
    if (/^bearer\s+/i.test(trimmed)) {
      return "Bearer [redacted]";
    }
    return "[redacted]";
  }
  if (trimmed.length > 400) {
    return `${sliceUtf16Safe(trimmed, 0, 280)}\n…\n${sliceUtf16Safe(trimmed, -80)}`;
  }
  return trimmed;
}

export function redactCaptureValue(value: unknown, label?: string): unknown {
  if (typeof value === "string") {
    return redactCaptureScalar(value, label);
  }
  if (label && isSensitiveCaptureField(label)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCaptureValue(entry, label));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactCaptureValue(entry, key);
  }
  return out;
}

function readCaptureQuotedSpan(
  value: string,
  start: number,
): { closed: boolean; end: number; raw: string; text: string } {
  const quote = value[start];
  let text = "";
  let index = start + 1;
  while (index < value.length) {
    const char = value[index];
    if (char === "\\") {
      text += value.slice(index, Math.min(index + 2, value.length));
      index += 2;
      continue;
    }
    if (char === quote) {
      return {
        closed: true,
        end: index + 1,
        raw: value.slice(start, index + 1),
        text,
      };
    }
    text += char;
    index += 1;
  }
  return {
    closed: false,
    end: value.length,
    raw: value.slice(start),
    text,
  };
}

function skipCaptureInlineWhitespace(value: string, start: number): number {
  let index = start;
  while (/\s/.test(value[index] ?? "")) {
    index += 1;
  }
  return index;
}

function consumeCaptureJsonishValue(value: string, start: number): number {
  const opener = value[start];
  if (opener === '"' || opener === "'") {
    return readCaptureQuotedSpan(value, start).end;
  }
  if (opener === "{" || opener === "[") {
    const stack = [opener === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < value.length && stack.length > 0) {
      const char = value[index];
      if (char === '"' || char === "'") {
        index = readCaptureQuotedSpan(value, index).end;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === stack.at(-1)) {
        stack.pop();
      }
      index += 1;
    }
    return index;
  }
  let index = start;
  while (index < value.length && !/[,\n\r}\]]/.test(value[index] ?? "")) {
    index += 1;
  }
  return index;
}

function redactCaptureJsonishSecretFields(value: string): string {
  let redacted = "";
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char !== '"' && char !== "'") {
      redacted += char;
      index += 1;
      continue;
    }
    const key = readCaptureQuotedSpan(value, index);
    const colonIndex = skipCaptureInlineWhitespace(value, key.end);
    if (!key.closed || value[colonIndex] !== ":" || !isSensitiveCaptureField(key.text)) {
      redacted += key.raw;
      index = key.end;
      continue;
    }
    const valueStart = skipCaptureInlineWhitespace(value, colonIndex + 1);
    const valueEnd = consumeCaptureJsonishValue(value, valueStart);
    const valueQuote =
      value[valueStart] === "'" || value[valueStart] === '"' ? value[valueStart] : '"';
    redacted += `${key.raw}${value.slice(key.end, valueStart)}${valueQuote}[redacted]${valueQuote}`;
    index = valueEnd;
  }
  return redacted;
}

export function redactCaptureInlineSecretPairs(value: string): string {
  return redactCaptureJsonishSecretFields(value).replace(
    /\b([A-Za-z][A-Za-z0-9_-]{0,64})=([^&\s"',}\]]+)/gu,
    (match: string, key: string) => (isSensitiveCaptureField(key) ? `${key}=[redacted]` : match),
  );
}

export function redactCapturePayloadPreview(payload: string): string {
  return redactCaptureScalar(redactCaptureInlineSecretPairs(payload));
}

export function formatCaptureFieldValue(value: unknown, label?: string): string {
  const redacted = redactCaptureValue(value, label);
  if (typeof redacted === "string") {
    return redacted;
  }
  if (redacted == null) {
    return "";
  }
  if (Array.isArray(redacted)) {
    return redacted
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .filter(Boolean)
      .join(", ");
  }
  return JSON.stringify(redacted, null, 2);
}
