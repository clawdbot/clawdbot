// Terminal Core module implements note behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import { note as clackNote } from "@clack/prompts";
import { splitGraphemes, visibleWidth } from "./ansi.js";
import { stylePromptTitle } from "./prompt-style.js";
import { normalizeLowercaseStringOrEmpty } from "./string.js";

const MIN_NOTE_COLUMNS = 80;
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;
const suppressNotesStorage = new AsyncLocalStorage<boolean>();

function isSuppressedByEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return false;
  }
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function splitLongWord(word: string, maxLen: number): string[] {
  if (maxLen <= 0) {
    return [word];
  }
  // maxLen is a visible-column budget, so accumulate grapheme visible width (CJK/emoji count as 2
  // columns) instead of code-point count; otherwise a wide-char run overflows the line by up to 2x.
  const parts: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const grapheme of splitGraphemes(word)) {
    const width = visibleWidth(grapheme);
    if (current && currentWidth + width > maxLen) {
      parts.push(current);
      current = "";
      currentWidth = 0;
    }
    current += grapheme;
    currentWidth += width;
  }
  if (current) {
    parts.push(current);
  }
  return parts.length > 0 ? parts : [word];
}

function isCopySensitiveToken(word: string): boolean {
  if (!word) {
    return false;
  }
  if (URL_PREFIX_RE.test(word)) {
    return true;
  }
  if (
    word.startsWith("/") ||
    word.startsWith("~/") ||
    word.startsWith("./") ||
    word.startsWith("../")
  ) {
    return true;
  }
  if (WINDOWS_DRIVE_RE.test(word) || word.startsWith("\\\\")) {
    return true;
  }
  if (word.includes("/") || word.includes("\\")) {
    return true;
  }
  // Preserve common file-like tokens (for example administrators_authorized_keys).
  return word.includes("_") && FILE_LIKE_RE.test(word);
}

function pushWrappedWordSegments(params: {
  word: string;
  available: number;
  firstPrefix: string;
  continuationPrefix: string;
  lines: string[];
}) {
  const parts = splitLongWord(params.word, params.available);
  const first = parts.shift() ?? "";
  params.lines.push(params.firstPrefix + first);
  for (const part of parts) {
    params.lines.push(params.continuationPrefix + part);
  }
}

function wrapLine(line: string, maxWidth: number): string[] {
  if (line.trim().length === 0) {
    return [line];
  }
  const match = line.match(/^(\s*)([-*\u2022]\s+)?(.*)$/);
  const indent = match?.[1] ?? "";
  const bullet = match?.[2] ?? "";
  const content = match?.[3] ?? "";
  const firstPrefix = `${indent}${bullet}`;
  const nextPrefix = `${indent}${bullet ? " ".repeat(bullet.length) : ""}`;
  const firstWidth = Math.max(10, maxWidth - visibleWidth(firstPrefix));
  const nextWidth = Math.max(10, maxWidth - visibleWidth(nextPrefix));

  const words = content.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let prefix = firstPrefix;
  let available = firstWidth;

  for (const word of words) {
    if (!current) {
      if (visibleWidth(word) > available) {
        if (isCopySensitiveToken(word)) {
          current = word;
          continue;
        }
        pushWrappedWordSegments({
          word,
          available,
          firstPrefix: prefix,
          continuationPrefix: nextPrefix,
          lines,
        });
        prefix = nextPrefix;
        available = nextWidth;
        continue;
      }
      current = word;
      continue;
    }

    const candidate = `${current} ${word}`;
    if (visibleWidth(candidate) <= available) {
      current = candidate;
      continue;
    }

    lines.push(prefix + current);
    prefix = nextPrefix;
    available = nextWidth;

    if (visibleWidth(word) > available) {
      if (isCopySensitiveToken(word)) {
        current = word;
        continue;
      }
      pushWrappedWordSegments({
        word,
        available,
        firstPrefix: prefix,
        continuationPrefix: prefix,
        lines,
      });
      current = "";
      continue;
    }
    current = word;
  }

  if (current || words.length === 0) {
    lines.push(prefix + current);
  }

  return lines;
}

function coerceNoteMessage(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (message == null) {
    return "";
  }
  if (typeof message === "number" || typeof message === "boolean" || typeof message === "bigint") {
    return String(message);
  }
  if (message instanceof Error) {
    return message.message ? `${message.name}: ${message.message}` : message.name;
  }
  return "";
}

export function wrapNoteMessage(
  message: unknown,
  options: { maxWidth?: number; columns?: number } = {},
): string {
  const text = coerceNoteMessage(message);
  const columns = options.columns ?? resolveNoteColumns(process.stdout.columns);
  const maxWidth = options.maxWidth ?? Math.max(40, Math.min(88, columns - 10));
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, maxWidth))
    .join("\n");
}

export function resolveNoteColumns(columns: number | undefined): number {
  if (!Number.isFinite(columns) || !columns || columns < MIN_NOTE_COLUMNS) {
    return MIN_NOTE_COLUMNS;
  }
  return columns;
}

export function resolveNoteOutputColumns(message: string, columns: number): number {
  const widestLine = message
    .split("\n")
    .reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  return Math.max(columns, widestLine + 6);
}

function createNoteOutput(columns: number): NodeJS.WriteStream {
  if (process.stdout.columns === columns) {
    return process.stdout;
  }
  const output = Object.create(process.stdout) as NodeJS.WriteStream;
  Object.defineProperty(output, "columns", {
    value: columns,
    configurable: true,
  });
  output.write = process.stdout.write.bind(process.stdout);
  return output;
}

export function note(message: unknown, title?: string) {
  if (
    suppressNotesStorage.getStore() === true ||
    isSuppressedByEnv(process.env.OPENCLAW_SUPPRESS_NOTES)
  ) {
    return;
  }
  const columns = resolveNoteColumns(process.stdout.columns);
  const wrappedMessage = wrapNoteMessage(message, { columns });
  clackNote(wrappedMessage, stylePromptTitle(title), {
    output: createNoteOutput(resolveNoteOutputColumns(wrappedMessage, columns)),
  });
}

export function withSuppressedNotes<T>(callback: () => T): T {
  return suppressNotesStorage.run(true, callback);
}
