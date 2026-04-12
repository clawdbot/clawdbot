import path from "node:path";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { renderFileContextBlock } from "../media/file-context.js";
import {
  extractFileContentFromSource,
  normalizeMimeType,
  resolveInputFileLimits,
} from "../media/input-files.js";
import { wrapExternalContent } from "../security/external-content.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import type { ActiveMediaModel } from "./active-model.types.js";
import { resolveAttachmentKind } from "./attachments.js";
import { runWithConcurrency } from "./concurrency.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import {
  extractMediaUserText,
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "./format.js";
import { resolveConcurrency } from "./resolve.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
  runCapability,
} from "./runner.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  decisions: MediaUnderstandingDecision[];
  appliedImage: boolean;
  appliedAudio: boolean;
  appliedVideo: boolean;
  appliedFile: boolean;
};

const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];
const EXTRA_TEXT_MIMES = [
  "application/xml",
  "text/xml",
  "application/x-yaml",
  "text/yaml",
  "application/yaml",
  "application/javascript",
  "text/javascript",
  "text/tab-separated-values",
];
const TEXT_EXT_MIME = new Map<string, string>([
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".log", "text/plain"],
  [".ini", "text/plain"],
  [".cfg", "text/plain"],
  [".conf", "text/plain"],
  [".env", "text/plain"],
  [".json", "application/json"],
  [".yaml", "text/yaml"],
  [".yml", "text/yaml"],
  [".xml", "application/xml"],
]);

function sanitizeMimeType(value?: string): string | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)/);
  return match?.[1];
}

function resolveFileLimits(cfg: OpenClawConfig) {
  const files = cfg.gateway?.http?.endpoints?.responses?.files;
  const allowedMimesConfigured = Boolean(files?.allowedMimes?.length);
  return {
    ...resolveInputFileLimits(files),
    allowedMimesConfigured,
  };
}

function appendFileBlocks(body: string | undefined, blocks: string[]): string {
  if (!blocks || blocks.length === 0) {
    return body ?? "";
  }
  const base = typeof body === "string" ? body.trim() : "";
  const suffix = blocks.join("\n\n").trim();
  if (!base) {
    return suffix;
  }
  return `${base}\n\n${suffix}`.trim();
}

function wrapUntrustedAttachmentContent(content: string): string {
  return wrapExternalContent(content, {
    source: "unknown",
    includeWarning: false,
  });
}

function resolveUtf16Charset(buffer?: Buffer): "utf-16le" | "utf-16be" | undefined {
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

function looksLikeUtf8Text(buffer?: Buffer): boolean {
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

function decodeTextSample(buffer?: Buffer): string {
  if (!buffer || buffer.length === 0) {
    return "";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  const utf16Charset = resolveUtf16Charset(sample);
  if (utf16Charset === "utf-16be") {
    const swapped = Buffer.alloc(sample.length);
    for (let i = 0; i + 1 < sample.length; i += 2) {
      swapped[i] = sample[i + 1];
      swapped[i + 1] = sample[i];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  if (utf16Charset === "utf-16le") {
    return new TextDecoder("utf-16le").decode(sample);
  }
  return new TextDecoder("utf-8").decode(sample);
}

function guessDelimitedMime(text: string): string | undefined {
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

function resolveTextMimeFromName(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(name));
  return TEXT_EXT_MIME.get(ext);
}

function isBinaryMediaMime(mime?: string): boolean {
  if (!mime) {
    return false;
  }
  if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")) {
    return true;
  }
  if (mime === "application/octet-stream") {
    return true;
  }
  if (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime === "application/gzip" ||
    mime === "application/x-gzip" ||
    mime === "application/x-rar-compressed" ||
    mime === "application/x-7z-compressed"
  ) {
    return true;
  }
  if (mime.startsWith("application/vnd.")) {
    // Keep vendor +json/+xml payloads eligible for text extraction while
    // treating the common binary vendor family (Office, archives, etc.) as binary.
    if (mime.endsWith("+json") || mime.endsWith("+xml")) {
      return false;
    }
    return true;
  }
  return false;
}

async function extractFileBlocks(params: {
  attachments: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  limits: ReturnType<typeof resolveFileLimits>;
  skipAttachmentIndexes?: Set<number>;
}): Promise<string[]> {
  const { attachments, cache, limits, skipAttachmentIndexes } = params;
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const blocks: string[] = [];
  for (const attachment of attachments) {
    if (!attachment) {
      continue;
    }
    if (skipAttachmentIndexes?.has(attachment.index)) {
      continue;
    }
    const forcedTextMime = resolveTextMimeFromName(attachment.path ?? attachment.url ?? "");
    const kind = forcedTextMime ? "document" : resolveAttachmentKind(attachment);
    if (!forcedTextMime && (kind === "image" || kind === "video" || kind === "audio")) {
      continue;
    }
    if (!limits.allowUrl && attachment.url && !attachment.path) {
      if (shouldLogVerbose()) {
        logVerbose(`media: file attachment skipped (url disabled) index=${attachment.index}`);
      }
      continue;
    }
    let bufferResult: Awaited<ReturnType<typeof cache.getBuffer>>;
    try {
      bufferResult = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: limits.maxBytes,
        timeoutMs: limits.timeoutMs,
      });
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(`media: file attachment skipped (buffer): ${String(err)}`);
      }
      continue;
    }
    const nameHint = bufferResult?.fileName ?? attachment.path ?? attachment.url;
    const forcedTextMimeResolved = forcedTextMime ?? resolveTextMimeFromName(nameHint ?? "");
    const rawMime = bufferResult?.mime ?? attachment.mime;
    const normalizedRawMime = normalizeMimeType(rawMime);
    if (!forcedTextMimeResolved && isBinaryMediaMime(normalizedRawMime)) {
      continue;
    }
    const utf16Charset = resolveUtf16Charset(bufferResult?.buffer);
    const textSample = decodeTextSample(bufferResult?.buffer);
    // Do not coerce real PDFs into text/plain via printable-byte heuristics.
    // PDFs have a dedicated extraction path in extractFileContentFromSource.
    const allowTextHeuristic = normalizedRawMime !== "application/pdf";
    const textLike =
      allowTextHeuristic && (Boolean(utf16Charset) || looksLikeUtf8Text(bufferResult?.buffer));
    const guessedDelimited = textLike ? guessDelimitedMime(textSample) : undefined;
    const textHint =
      forcedTextMimeResolved ?? guessedDelimited ?? (textLike ? "text/plain" : undefined);
    const mimeType = sanitizeMimeType(textHint ?? normalizeMimeType(rawMime));
    // Log when MIME type is overridden from non-text to text for auditability
    if (textHint && rawMime && !rawMime.startsWith("text/")) {
      logVerbose(
        `media: MIME override from "${rawMime}" to "${textHint}" for index=${attachment.index}`,
      );
    }
    if (!mimeType) {
      if (shouldLogVerbose()) {
        logVerbose(`media: file attachment skipped (unknown mime) index=${attachment.index}`);
      }
      continue;
    }
    const allowedMimes = new Set(limits.allowedMimes);
    if (!limits.allowedMimesConfigured) {
      for (const extra of EXTRA_TEXT_MIMES) {
        allowedMimes.add(extra);
      }
      if (mimeType.startsWith("text/")) {
        allowedMimes.add(mimeType);
      }
    }
    if (!allowedMimes.has(mimeType)) {
      if (shouldLogVerbose()) {
        logVerbose(
          `media: file attachment skipped (unsupported mime ${mimeType}) index=${attachment.index}`,
        );
      }
      continue;
    }
    let extracted: Awaited<ReturnType<typeof extractFileContentFromSource>>;
    try {
      const mediaType = utf16Charset ? `${mimeType}; charset=${utf16Charset}` : mimeType;
      const { allowedMimesConfigured: _allowedMimesConfigured, ...baseLimits } = limits;
      extracted = await extractFileContentFromSource({
        source: {
          type: "base64",
          data: bufferResult.buffer.toString("base64"),
          mediaType,
          filename: bufferResult.fileName,
        },
        limits: {
          ...baseLimits,
          allowedMimes,
        },
      });
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(`media: file attachment skipped (extract): ${String(err)}`);
      }
      continue;
    }
    const text = extracted?.text?.trim() ?? "";
    let blockText = text ? wrapUntrustedAttachmentContent(text) : "";
    if (!blockText) {
      if (extracted?.images && extracted.images.length > 0) {
        blockText = "[PDF content rendered to images; images not forwarded to model]";
      } else {
        blockText = "[No extractable text]";
      }
    }
    blocks.push(
      renderFileContextBlock({
        filename: bufferResult.fileName,
        fallbackName: `file-${attachment.index + 1}`,
        mimeType,
        content: blockText,
      }),
    );
  }
  return blocks;
}

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<ApplyMediaUnderstandingResult> {
  const { ctx, cfg } = params;
  const commandCandidates = [ctx.CommandBody, ctx.RawBody, ctx.Body];
  const originalUserText =
    commandCandidates
      .map((value) => extractMediaUserText(value))
      .find((value) => value && value.trim()) ?? undefined;

  const attachments = normalizeMediaAttachments(ctx);
  const providerRegistry = buildProviderRegistry(params.providers, cfg);
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: resolveMediaAttachmentLocalRoots({ cfg, ctx }),
  });

  try {
    const tasks = CAPABILITY_ORDER.map((capability) => async () => {
      const config = cfg.tools?.media?.[capability];
      return await runCapability({
        capability,
        cfg,
        ctx,
        attachments: cache,
        media: attachments,
        agentDir: params.agentDir,
        providerRegistry,
        config,
        activeModel: params.activeModel,
      });
    });

    const results = await runWithConcurrency(tasks, resolveConcurrency(cfg));
    const outputs: MediaUnderstandingOutput[] = [];
    const decisions: MediaUnderstandingDecision[] = [];
    for (const entry of results) {
      if (!entry) {
        continue;
      }
      for (const output of entry.outputs) {
        outputs.push(output);
      }
      decisions.push(entry.decision);
    }

    if (decisions.length > 0) {
      ctx.MediaUnderstandingDecisions = [...(ctx.MediaUnderstandingDecisions ?? []), ...decisions];
    }

    if (outputs.length > 0) {
      ctx.Body = formatMediaUnderstandingBody({ body: ctx.Body, outputs });
      const audioOutputs = outputs.filter((output) => output.kind === "audio.transcription");
      if (audioOutputs.length > 0) {
        const transcript = formatAudioTranscripts(audioOutputs);
        ctx.Transcript = transcript;
        if (originalUserText) {
          ctx.CommandBody = originalUserText;
          ctx.RawBody = originalUserText;
        } else {
          ctx.CommandBody = transcript;
          ctx.RawBody = transcript;
        }
        // Echo transcript back to chat before agent processing, if configured.
        const audioCfg = cfg.tools?.media?.audio;
        if (audioCfg?.echoTranscript && transcript) {
          await sendTranscriptEcho({
            ctx,
            cfg,
            transcript,
            format: audioCfg.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
          });
        }
      } else if (originalUserText) {
        ctx.CommandBody = originalUserText;
        ctx.RawBody = originalUserText;
      }
      ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
    }
    const audioAttachmentIndexes = new Set(
      outputs
        .filter((output) => output.kind === "audio.transcription")
        .map((output) => output.attachmentIndex),
    );
    const fileBlocks = await extractFileBlocks({
      attachments,
      cache,
      limits: resolveFileLimits(cfg),
      skipAttachmentIndexes: audioAttachmentIndexes.size > 0 ? audioAttachmentIndexes : undefined,
    });
    if (fileBlocks.length > 0) {
      ctx.Body = appendFileBlocks(ctx.Body, fileBlocks);
    }
    if (outputs.length > 0 || fileBlocks.length > 0) {
      finalizeInboundContext(ctx, {
        forceBodyForAgent: true,
        forceBodyForCommands: outputs.length > 0 || fileBlocks.length > 0,
      });
    }

    return {
      outputs,
      decisions,
      appliedImage: outputs.some((output) => output.kind === "image.description"),
      appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
      appliedVideo: outputs.some((output) => output.kind === "video.description"),
      appliedFile: fileBlocks.length > 0,
    };
  } finally {
    await cache.cleanup();
  }
}
