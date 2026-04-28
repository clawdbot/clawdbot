import { formatErrorMessage } from "./error-utils.js";
import { normalizeLowercaseStringOrEmpty } from "./string-utils.js";

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

export function parseQmdQueryJson(stdout: string, stderr: string): QmdQueryResult[] {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  const stdoutIsMarker = trimmedStdout.length > 0 && isQmdNoResultsOutput(trimmedStdout);
  const stderrIsMarker = trimmedStderr.length > 0 && isQmdNoResultsOutput(trimmedStderr);
  if (stdoutIsMarker || (!trimmedStdout && stderrIsMarker)) {
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

function warnQmdQueryParseError(message: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  process.stderr.write(`qmd query returned invalid JSON: ${message}\n`);
}

function isQmdNoResultsOutput(raw: string): boolean {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => normalizeLowercaseStringOrEmpty(line).replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  return lines.some((line) => isQmdNoResultsLine(line));
}

function isQmdNoResultsLine(line: string): boolean {
  if (line === "no results found" || line === "no results found.") {
    return true;
  }
  return /^(?:\[[^\]]+\]\s*)?(?:(?:warn(?:ing)?|info|error|qmd)\s*:\s*)+no results found\.?$/.test(
    line,
  );
}

function summarizeQmdStderr(raw: string): string {
  return raw.length <= 120 ? raw : `${raw.slice(0, 117)}...`;
}

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

function parseQmdLineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractFirstJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
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
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}
