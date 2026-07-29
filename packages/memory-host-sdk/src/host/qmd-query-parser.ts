// Memory Host SDK module implements qmd query parser behavior.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "./error-utils.js";

// Parser for qmd query JSON output, including noisy CLI wrapper output.

/** Normalized qmd query result consumed by memory search. */
export type QmdQueryResult = {
  docid?: string;
  score?: number;
  collection?: string;
  file?: string;
  snippet?: string;
  body?: string;
  startLine?: number;
  endLine?: number;
};

/** Parse qmd stdout/stderr into normalized results, accepting known no-result markers. */
export function parseQmdQueryJson(stdout: string, stderr: string): QmdQueryResult[] {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  const stderrIsMarker = trimmedStderr.length > 0 && isQmdNoResultsOutput(trimmedStderr);
  if (!trimmedStdout && stderrIsMarker) {
    return [];
  }
  if (!trimmedStdout) {
    const context = trimmedStderr ? ` (stderr: ${summarizeQmdStderr(trimmedStderr)})` : "";
    const message = `stdout empty${context}`;
    warnQmdQueryParseError(message);
    throw new Error(`qmd query returned invalid JSON: ${message}`);
  }
  try {
    const parsed = parseQmdQueryResultArray(trimmedStdout);
    if (parsed !== null) {
      return parsed;
    }
    const noisyPayload = extractFirstJsonArray(trimmedStdout);
    if (!noisyPayload) {
      if (isQmdNoResultsOutput(trimmedStdout)) {
        return [];
      }
      throw new Error("qmd query JSON response was not an array");
    }
    const fallback = parseQmdQueryResultArray(noisyPayload);
    if (fallback !== null) {
      return fallback;
    }
    throw new Error("qmd query JSON response was not an array");
  } catch (err) {
    const message = formatErrorMessage(err);
    warnQmdQueryParseError(message);
    throw new Error(`qmd query returned invalid JSON: ${message}`, { cause: err });
  }
}

/** Emit parse warnings outside tests so broken qmd output is visible to operators. */
function warnQmdQueryParseError(message: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  console.warn(`qmd query returned invalid JSON: ${message}`);
}

/** Detect qmd no-result marker output on stdout or stderr. */
function isQmdNoResultsOutput(raw: string): boolean {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => normalizeLowercaseStringOrEmpty(line).replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  return lines.some((line) => isQmdNoResultsLine(line));
}

/** Match qmd no-result lines with optional warning/info prefixes. */
function isQmdNoResultsLine(line: string): boolean {
  if (line === "no results found" || line === "no results found.") {
    return true;
  }
  return /^(?:\[[^\]]+\]\s*)?(?:(?:warn(?:ing)?|info|error|qmd)\s*:\s*)+no results found\.?$/.test(
    line,
  );
}

/** Bound stderr context included in parse errors. */
function summarizeQmdStderr(raw: string): string {
  return raw.length <= 120 ? raw : `${truncateUtf16Safe(raw, 117)}...`;
}

/** Parse and normalize a strict qmd JSON array payload. */
function parseQmdQueryResultArray(raw: string): QmdQueryResult[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.map((item) => {
      if (typeof item !== "object" || item === null) {
        return item as QmdQueryResult;
      }
      const record = item as Record<string, unknown>;
      const docid = typeof record.docid === "string" ? record.docid : undefined;
      const score =
        typeof record.score === "number" && Number.isFinite(record.score)
          ? record.score
          : undefined;
      const collection = typeof record.collection === "string" ? record.collection : undefined;
      const file = typeof record.file === "string" ? record.file : undefined;
      const snippet = typeof record.snippet === "string" ? record.snippet : undefined;
      const body = typeof record.body === "string" ? record.body : undefined;
      return {
        docid,
        score,
        collection,
        file,
        snippet,
        body,
        startLine: parseQmdLineNumber(record.start_line ?? record.startLine),
        endLine: parseQmdLineNumber(record.end_line ?? record.endLine),
      } as QmdQueryResult;
    });
  } catch {
    return null;
  }
}

/** Normalize qmd line numbers, rejecting zero, negative, and non-integer values. */
function parseQmdLineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Extract the first complete, standalone JSON result array from noisy stdout. */
function extractFirstJsonArray(raw: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let atLineStart = true;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }

    if (start < 0) {
      if (char === "\n") {
        atLineStart = true;
        continue;
      }
      if (atLineStart && (char === " " || char === "\t" || char === "\r")) {
        continue;
      }
      // QMD emits result arrays on their own line; log fields can contain arrays too.
      if (!atLineStart || char !== "[") {
        atLineStart = false;
        continue;
      }
      start = i;
      depth = 1;
      atLineStart = false;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char !== "]" || --depth !== 0) {
      continue;
    }

    const candidate = raw.slice(start, i + 1);
    if (parseQmdQueryResultArray(candidate) !== null) {
      return candidate;
    }
    start = -1;
  }
  return null;
}
