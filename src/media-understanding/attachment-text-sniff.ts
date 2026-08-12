// Byte-level text detection for inbound attachments: charset resolution,
// legacy-codepage heuristics, archive signatures, and delimiter guessing.
import { expectDefined } from "@openclaw/normalization-core";

export function resolveUtf16Charset(buffer?: Buffer): "utf-16le" | "utf-16be" | undefined {
  // Some chat attachments arrive as UTF-16 without a reliable MIME charset; the
  // BOM and zero-byte distribution are enough to select a safe decoder.
  if (!buffer || buffer.length < 2) {
    return undefined;
  }
  const b0 = buffer[0];
  const b1 = buffer[1];
  if (b0 === 0xff && b1 === 0xfe) {
    return "utf-16le";
  }
  if (b0 === 0xfe && b1 === 0xff) {
    return "utf-16be";
  }
  const sampleLen = Math.min(buffer.length, 2048);
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    if (buffer[i] !== 0) {
      continue;
    }
    if (i % 2 === 0) {
      zeroEven += 1;
    } else {
      zeroOdd += 1;
    }
  }
  const zeroCount = zeroEven + zeroOdd;
  if (zeroCount / sampleLen > 0.2) {
    return zeroOdd >= zeroEven ? "utf-16le" : "utf-16be";
  }
  return undefined;
}

const WORDISH_CHAR = /[\p{L}\p{N}]/u;
const CP1252_MAP: Array<string | undefined> = [
  "\u20ac",
  undefined,
  "\u201a",
  "\u0192",
  "\u201e",
  "\u2026",
  "\u2020",
  "\u2021",
  "\u02c6",
  "\u2030",
  "\u0160",
  "\u2039",
  "\u0152",
  undefined,
  "\u017d",
  undefined,
  undefined,
  "\u2018",
  "\u2019",
  "\u201c",
  "\u201d",
  "\u2022",
  "\u2013",
  "\u2014",
  "\u02dc",
  "\u2122",
  "\u0161",
  "\u203a",
  "\u0153",
  undefined,
  "\u017e",
  "\u0178",
];

function decodeLegacyText(buffer: Buffer): string {
  let output = "";
  for (const byte of buffer) {
    if (byte >= 0x80 && byte <= 0x9f) {
      const mapped = CP1252_MAP[byte - 0x80];
      output += mapped ?? String.fromCharCode(byte);
      continue;
    }
    output += String.fromCharCode(byte);
  }
  return output;
}

function getTextStats(text: string): { printableRatio: number; wordishRatio: number } {
  if (!text) {
    return { printableRatio: 0, wordishRatio: 0 };
  }
  let printable = 0;
  let control = 0;
  let wordish = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      printable += 1;
      wordish += 1;
      continue;
    }
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
      control += 1;
      continue;
    }
    printable += 1;
    if (WORDISH_CHAR.test(char)) {
      wordish += 1;
    }
  }
  const total = printable + control;
  if (total === 0) {
    return { printableRatio: 0, wordishRatio: 0 };
  }
  return { printableRatio: printable / total, wordishRatio: wordish / total };
}

function isMostlyPrintable(text: string): boolean {
  return getTextStats(text).printableRatio > 0.85;
}

function looksLikeLegacyTextBytes(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  const text = decodeLegacyText(buffer);
  const { printableRatio, wordishRatio } = getTextStats(text);
  return printableRatio > 0.95 && wordishRatio > 0.3;
}

export function looksLikeUtf8Text(buffer?: Buffer): boolean {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return isMostlyPrintable(text);
  } catch {
    return looksLikeLegacyTextBytes(sample);
  }
}

export function hasSuspiciousBinarySignal(buffer?: Buffer): boolean {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length < 4 || sample[0] !== 0x50 || sample[1] !== 0x4b) {
    return false;
  }
  const signature =
    (expectDefined(sample[2], "sample entry at 2") << 8) |
    expectDefined(sample[3], "sample entry at 3");
  // Cover the ZIP local-header, central-directory, and empty-archive markers
  // so archive payloads cannot slip past text coercion when MIME detection is weak.
  return signature === 0x0304 || signature === 0x0102 || signature === 0x0506;
}

export function decodeTextSample(buffer?: Buffer): string {
  if (!buffer || buffer.length === 0) {
    return "";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  const utf16Charset = resolveUtf16Charset(sample);
  if (utf16Charset === "utf-16be") {
    const swapped = Buffer.alloc(sample.length);
    for (let i = 0; i + 1 < sample.length; i += 2) {
      swapped[i] = expectDefined(sample[i + 1], "UTF-16BE low byte");
      swapped[i + 1] = expectDefined(sample[i], "UTF-16BE high byte");
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  if (utf16Charset === "utf-16le") {
    return new TextDecoder("utf-16le").decode(sample);
  }
  return new TextDecoder("utf-8").decode(sample);
}

export function guessDelimitedMime(text: string): string | undefined {
  if (!text) {
    return undefined;
  }
  const line = text.split(/\r?\n/)[0] ?? "";
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  if (commas > 0) {
    return "text/csv";
  }
  if (tabs > 0) {
    return "text/tab-separated-values";
  }
  return undefined;
}
