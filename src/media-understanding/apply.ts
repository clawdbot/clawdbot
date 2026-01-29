import path from "node:path";

import type { MoltbotConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import {
  DEFAULT_INPUT_FILE_MAX_BYTES,
  DEFAULT_INPUT_FILE_MAX_CHARS,
  DEFAULT_INPUT_FILE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_PDF_MAX_PAGES,
  DEFAULT_INPUT_PDF_MAX_PIXELS,
  DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractFileContentFromSource,
  normalizeMimeList,
  normalizeMimeType,
} from "../media/input-files.js";
import {
  extractMediaUserText,
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "./format.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";
import { runWithConcurrency } from "./concurrency.js";
import { resolveConcurrency } from "./resolve.js";
import { resolveAttachmentKind } from "./attachments.js";
import {
  type ActiveMediaModel,
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

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

const XML_ESCAPE_MAP: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Escapes special XML characters in attribute values to prevent injection.
 */
function xmlEscapeAttr(value: string): string {
  return value.replace(/[<>&"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);
}

function resolveFileLimits(cfg: MoltbotConfig) {
  const files = cfg.gateway?.http?.endpoints?.responses?.files;
  return {
    allowUrl: files?.allowUrl ?? true,
    allowedMimes: normalizeMimeList(files?.allowedMimes, DEFAULT_INPUT_FILE_MIMES),
    maxBytes: files?.maxBytes ?? DEFAULT_INPUT_FILE_MAX_BYTES,
    maxChars: files?.maxChars ?? DEFAULT_INPUT_FILE_MAX_CHARS,
    maxRedirects: files?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
    timeoutMs: files?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    pdf: {
      maxPages: files?.pdf?.maxPages ?? DEFAULT_INPUT_PDF_MAX_PAGES,
      maxPixels: files?.pdf?.maxPixels ?? DEFAULT_INPUT_PDF_MAX_PIXELS,
      minTextChars: files?.pdf?.minTextChars ?? DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
    },
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

function resolveUtf16Charset(buffer?: Buffer): "utf-16le" | "utf-16be" | undefined {
  if (!buffer || buffer.length < 2) return undefined;
  const b0 = buffer[0];
  const b1 = buffer[1];
  if (b0 === 0xff && b1 === 0xfe) {
    return "utf-16le";
  }
  if (b0 === 0xfe && b1 === 0xff) {
    return "utf-16be";
  }
  const sampleLen = Math.min(buffer.length, 2048);
  let zeroCount = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    if (buffer[i] === 0) zeroCount += 1;
  }
  if (zeroCount / sampleLen > 0.2) {
    return "utf-16le";
  }
  return undefined;
}

function looksLikeUtf8Text(buffer?: Buffer): boolean {
  if (!buffer || buffer.length === 0) return false;
  const sampleLen = Math.min(buffer.length, 4096);
  let printable = 0;
  let other = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    const byte = buffer[i];
    if (byte === 0) {
      other += 1;
      continue;
    }
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) {
      printable += 1;
    } else {
      other += 1;
    }
  }
  const total = printable + other;
  if (total === 0) return false;
  return printable / total > 0.85;
}

function decodeTextSample(buffer?: Buffer): string {
  if (!buffer || buffer.length === 0) return "";
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
  if (!text) return undefined;
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
  if (!name) return undefined;
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXT_MIME.get(ext);
}

async function extractFileBlocks(params: {
  attachments: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  limits: ReturnType<typeof resolveFileLimits>;
}): Promise<string[]> {
  const { attachments, cache, limits } = params;
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const blocks: string[] = [];
  for (const attachment of attachments) {
    if (!attachment) {
      continue;
    }
    const forcedTextMime = resolveTextMimeFromName(attachment.path ?? attachment.url ?? "");
    const kind = forcedTextMime ? "document" : resolveAttachmentKind(attachment);
    if (!forcedTextMime && (kind === "image" || kind === "video")) {
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
    const utf16Charset = resolveUtf16Charset(bufferResult?.buffer);
    const textSample = decodeTextSample(bufferResult?.buffer);
    const textLike = Boolean(utf16Charset) || looksLikeUtf8Text(bufferResult?.buffer);
    if (!forcedTextMimeResolved && kind === "audio" && !textLike) {
      continue;
    }
    const guessedDelimited = textLike ? guessDelimitedMime(textSample) : undefined;
    const textHint =
      forcedTextMimeResolved ?? guessedDelimited ?? (textLike ? "text/plain" : undefined);
    const rawMime = bufferResult?.mime ?? attachment.mime;
    const mimeType = textHint ?? normalizeMimeType(rawMime);
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
    for (const extra of EXTRA_TEXT_MIMES) {
      allowedMimes.add(extra);
    }
    if (mimeType.startsWith("text/")) {
      allowedMimes.add(mimeType);
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
      extracted = await extractFileContentFromSource({
        source: {
          type: "base64",
          data: bufferResult.buffer.toString("base64"),
          mediaType,
          filename: bufferResult.fileName,
        },
        limits: {
          ...limits,
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
    let blockText = text;
    if (!blockText) {
      if (extracted?.images && extracted.images.length > 0) {
        blockText = "[PDF content rendered to images; images not forwarded to model]";
      } else {
        blockText = "[No extractable text]";
      }
    }
    const safeName = (bufferResult.fileName ?? `file-${attachment.index + 1}`)
      .replace(/[\r\n\t]+/g, " ")
      .trim();
    // Escape XML special characters in attributes to prevent injection
    blocks.push(
      `<file name="${xmlEscapeAttr(safeName)}" mime="${xmlEscapeAttr(mimeType)}">\n${blockText}\n</file>`,
    );
  }
  return blocks;
}

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: MoltbotConfig;
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
  const providerRegistry = buildProviderRegistry(params.providers);
  const cache = createMediaAttachmentCache(attachments);

  try {
    const fileBlocks = await extractFileBlocks({
      attachments,
      cache,
      limits: resolveFileLimits(cfg),
    });

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
      if (!entry) continue;
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
      } else if (originalUserText) {
        ctx.CommandBody = originalUserText;
        ctx.RawBody = originalUserText;
      }
      ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
    }
    if (fileBlocks.length > 0) {
      ctx.Body = appendFileBlocks(ctx.Body, fileBlocks);
    }
    if (outputs.length > 0 || fileBlocks.length > 0) {
      finalizeInboundContext(ctx, {
        forceBodyForAgent: true,
        forceBodyForCommands: outputs.length > 0,
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
