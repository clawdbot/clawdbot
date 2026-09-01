import { detectMime, isZipContainerMime, mimeTypeFromFilePath, normalizeMimeType } from "./mime.js";

export type AttachmentClass =
  | "text"
  | "document"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "binary";
type AttachmentCharset = "utf-16le" | "utf-16be";
export type AttachmentClassification = {
  mime: string | undefined;
  class: AttachmentClass;
  charset?: AttachmentCharset;
};

const TEXT_APPLICATION_MIME = /^application\/(?:json|javascript|xml|yaml|x-yaml)$/;
const DOCUMENT_MIME =
  /^application\/(?:pdf|msword|x-cfb|vnd\.(?:apple\.(?:keynote|numbers|pages)|ms-.+|oasis\.opendocument\..+|openxmlformats-officedocument\..+))$/;
const ARCHIVE_MIME =
  /^application\/(?:gzip|vnd\.rar|x-7z-compressed|x-gzip|x-rar-compressed|x-tar|x-zip-compressed|zip)$/;
const WORDISH_CHAR = /[\p{L}\p{N}]/u;

export function attachmentClassFromMime(mime?: string | null): AttachmentClass {
  const normalized = normalizeMimeType(mime);
  if (!normalized) {
    return "binary";
  }
  if (
    normalized.startsWith("text/") ||
    TEXT_APPLICATION_MIME.test(normalized) ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml")
  ) {
    return "text";
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (DOCUMENT_MIME.test(normalized)) {
    return "document";
  }
  return ARCHIVE_MIME.test(normalized) || isZipContainerMime(normalized) ? "archive" : "binary";
}

function resolveUtf16Charset(buffer: Buffer): AttachmentCharset | undefined {
  if (buffer.length < 2) {
    return undefined;
  }
  const bom = buffer.readUInt16LE(0);
  if (bom === 0xfeff) {
    return "utf-16le";
  }
  if (bom === 0xfffe) {
    return "utf-16be";
  }
  const sampleLength = Math.min(buffer.length, 2048);
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      if (index % 2 === 0) {
        zeroEven += 1;
      } else {
        zeroOdd += 1;
      }
    }
  }
  if ((zeroEven + zeroOdd) / sampleLength <= 0.2) {
    return undefined;
  }
  return zeroOdd >= zeroEven ? "utf-16le" : "utf-16be";
}

function textRatios(text: string, includeWordish: boolean): [printable: number, wordish: number] {
  let printable = 0;
  let wordish = 0;
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const whitespace = code === 9 || code === 10 || code === 13 || code === 32;
    const isControl = !whitespace && (code < 32 || (code >= 0x7f && code <= 0x9f));
    total += 1;
    printable += Number(!isControl);
    wordish += Number(whitespace || (!isControl && includeWordish && WORDISH_CHAR.test(char)));
  }
  return total === 0 ? [0, 0] : [printable / total, wordish / total];
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  // Finish the last sampled UTF-8 sequence without starting a new one outside the window.
  // Its lead is within the final four bytes; completion needs at most three more.
  const tail = sample.subarray(-4);
  const leadIndex = tail.findLastIndex((byte) => (byte & 0xc0) !== 0x80);
  const lead = tail[leadIndex] ?? 0;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 1;
  const end = sample.length + Math.max(0, leadIndex + width - tail.length);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
    return textRatios(text, false)[0] > 0.85;
  } catch {
    const [printable, wordish] = textRatios(new TextDecoder("windows-1252").decode(sample), true);
    return printable > 0.95 && wordish > 0.3;
  }
}

export async function classifyAttachmentBytes(params: {
  buffer: Buffer;
  declaredMime?: string | null;
  /** Ordered fallback hints (e.g. transport Content-Type); bytes arbitrate. */
  additionalMimeHints?: readonly (string | null | undefined)[];
  name?: string | null;
}): Promise<AttachmentClassification> {
  const mime = await detectMime({
    buffer: params.buffer,
    headerMime: params.declaredMime,
    additionalMimeHints: params.additionalMimeHints,
    filePath: params.name ?? undefined,
  });
  const detectedClass = attachmentClassFromMime(mime);
  const hasUtf16Bom =
    params.buffer.length >= 2 &&
    (params.buffer.readUInt16LE(0) === 0xfeff || params.buffer.readUInt16LE(0) === 0xfffe);
  if (
    mime === "application/octet-stream" ||
    mime?.startsWith("application/vnd.") ||
    (detectedClass !== "binary" && !hasUtf16Bom)
  ) {
    const charset = detectedClass === "text" ? resolveUtf16Charset(params.buffer) : undefined;
    // Text resolved by extension can still be BOM-less UTF-16; dropping the
    // detected charset here would decode it downstream as UTF-8 mojibake.
    return charset ? { mime, class: detectedClass, charset } : { mime, class: detectedClass };
  }
  const signature = params.buffer.length >= 4 ? params.buffer.readUInt32BE(0) : 0;
  if (signature === 0x504b0304 || signature === 0x504b0102 || signature === 0x504b0506) {
    return { mime, class: "archive" };
  }
  const charset = resolveUtf16Charset(params.buffer);
  if (!charset && !looksLikeText(params.buffer)) {
    return { mime, class: "binary" };
  }
  const extensionMime = mimeTypeFromFilePath(params.name);
  const firstLine = new TextDecoder(charset ?? "utf-8")
    .decode(params.buffer.subarray(0, Math.min(params.buffer.length, 8192)))
    .split(/\r?\n/, 1)[0];
  const textMime =
    (attachmentClassFromMime(extensionMime) === "text" ? extensionMime : undefined) ??
    (firstLine?.includes(",")
      ? "text/csv"
      : firstLine?.includes("\t")
        ? "text/tab-separated-values"
        : "text/plain");
  return { mime: textMime, class: "text", ...(charset ? { charset } : {}) };
}
