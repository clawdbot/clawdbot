/**
 * JSON parsing helpers that preserve integer literals larger than
 * Number.MAX_SAFE_INTEGER as strings before JSON.parse can round them.
 */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_SAFE_INTEGER_ABS_STR = String(Number.MAX_SAFE_INTEGER);

function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function parseJsonNumberToken(
  input: string,
  start: number,
): { token: string; end: number; isInteger: boolean } | null {
  let idx = start;
  if (input[idx] === "-") {
    idx += 1;
  }
  if (idx >= input.length) {
    return null;
  }

  if (input[idx] === "0") {
    idx += 1;
  } else if (isAsciiDigit(input[idx]) && input[idx] !== "0") {
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  } else {
    return null;
  }

  let isInteger = true;
  if (input[idx] === ".") {
    isInteger = false;
    idx += 1;
    if (!isAsciiDigit(input[idx])) {
      return null;
    }
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  }

  if (input[idx] === "e" || input[idx] === "E") {
    isInteger = false;
    idx += 1;
    if (input[idx] === "+" || input[idx] === "-") {
      idx += 1;
    }
    if (!isAsciiDigit(input[idx])) {
      return null;
    }
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  }

  return {
    token: input.slice(start, idx),
    end: idx,
    isInteger,
  };
}

function isUnsafeIntegerLiteral(token: string): boolean {
  const digits = token[0] === "-" ? token.slice(1) : token;
  if (digits.length < MAX_SAFE_INTEGER_ABS_STR.length) {
    return false;
  }
  if (digits.length > MAX_SAFE_INTEGER_ABS_STR.length) {
    return true;
  }
  return digits > MAX_SAFE_INTEGER_ABS_STR;
}

/**
 * Quotes integer literals above Number.MAX_SAFE_INTEGER before JSON.parse.
 *
 * The optional `tag` is prefixed inside the quotes around each converted
 * literal. Every real caller of this function wants the plain digit string
 * back and leaves `tag` at its default `""`. A caller that instead compares
 * two independently-serialized payloads needs `tag` non-empty: without it, a
 * quoted unsafe integer is byte-identical to a genuine JSON string holding
 * the same digits, so a real number-to-string argument change would compare
 * equal to the unchanged number. A control character a caller can't type
 * makes that collision impossible.
 */
export function quoteUnsafeIntegerLiterals(input: string, tag = ""): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let idx = 0;

  while (idx < input.length) {
    const ch = input[idx] ?? "";
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      idx += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      idx += 1;
      continue;
    }

    if (ch === "-" || isAsciiDigit(ch)) {
      const parsed = parseJsonNumberToken(input, idx);
      if (parsed) {
        if (parsed.isInteger && isUnsafeIntegerLiteral(parsed.token)) {
          out += `"${tag}${parsed.token}"`;
        } else {
          out += parsed.token;
        }
        idx = parsed.end;
        continue;
      }
    }

    out += ch;
    idx += 1;
  }

  return out;
}

/** Parses JSON while preserving unsafe integer literals as strings. */
export function parseJsonPreservingUnsafeIntegers(input: string): unknown {
  return JSON.parse(quoteUnsafeIntegerLiterals(input)) as unknown;
}

/** Parses or accepts an object while preserving unsafe integer literals in string input. */
export function parseJsonObjectPreservingUnsafeIntegers(
  value: unknown,
): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asNullableRecord(parseJsonPreservingUnsafeIntegers(value));
    } catch {
      return null;
    }
  }
  return asNullableRecord(value);
}
