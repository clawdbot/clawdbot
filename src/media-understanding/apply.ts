// Applies media-understanding outputs to inbound message context, including
// attachment normalization, provider execution, file text extraction, and echoing.
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import pMap from "p-map";
import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
import {
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "../../packages/media-understanding-common/src/format.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { renderFileContextBlock } from "../media/file-context.js";
import { extractFileContentFromSource, normalizeMimeType } from "../media/input-files.js";
import { classifyMediaReferenceSource } from "../media/media-reference.js";
import { runMediaCapability } from "./apply-capability.js";
import {
  decodeTextSample,
  guessDelimitedMime,
  hasSuspiciousBinarySignal,
  looksLikeUtf8Text,
  resolveUtf16Charset,
} from "./attachment-text-sniff.js";
import { resolveAttachmentKind } from "./attachments.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import type { ExtractedFileImage } from "./extracted-file-images.js";
import {
  type FileAttachmentOutcome,
  isSkippedFileOutcome,
  MAX_SKIPPED_FILE_MARKERS,
  renderFileAttachmentOutcome,
  renderSkippedFileOverflowSummary,
  sanitizeMimeType,
} from "./file-attachment-outcomes.js";
import {
  type FileExtractionLimits,
  resolveFileExtractionLimits,
} from "./file-extraction-limits.js";
import { resolveConcurrency } from "./resolve.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
} from "./runner.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  decisions: MediaUnderstandingDecision[];
  extractedFileImages: ExtractedFileImage[];
  appliedImage: boolean;
  appliedAudio: boolean;
  appliedVideo: boolean;
  appliedFile: boolean;
};

const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];
const AUDIO_ONLY_CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["audio"];
const EMPTY_VOICE_NOTE_PLACEHOLDER =
  "[Voice note could not be transcribed because the audio attachment was too small]";
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

function resolveTextMimeFromName(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(name));
  return TEXT_EXT_MIME.get(ext);
}

function buildSyntheticSkippedAudioOutputs(
  decisions: MediaUnderstandingDecision[],
): MediaUnderstandingOutput[] {
  const audioDecision = decisions.find((decision) => decision.capability === "audio");
  if (!audioDecision) {
    return [];
  }
  return audioDecision.attachments.flatMap((attachment) => {
    const hasTooSmallAttempt = attachment.attempts.some((attempt) =>
      attempt.reason?.trim().startsWith("tooSmall"),
    );
    if (!hasTooSmallAttempt) {
      return [];
    }
    return [
      {
        kind: "audio.transcription" as const,
        attachmentIndex: attachment.attachmentIndex,
        text: EMPTY_VOICE_NOTE_PLACEHOLDER,
        provider: "openclaw",
        model: "synthetic-empty-audio",
      },
    ];
  });
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
    mime === "application/x-7z-compressed" ||
    mime === "application/msword" ||
    mime === "application/x-cfb"
  ) {
    return true;
  }
  if (mime.endsWith("+zip")) {
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

type ClassifiedFileAttachment = {
  outcome: FileAttachmentOutcome;
  filename?: string;
  mimeType?: string;
};

// URL attachments may carry signed query credentials; only the pathname
// basename is safe to surface as a model-visible display name.
function attachmentUrlDisplayName(url: string): string | undefined {
  try {
    const base = new URL(url).pathname.split("/").findLast((segment) => segment.length > 0);
    return base || undefined;
  } catch {
    return undefined;
  }
}

async function classifyFileAttachment(params: {
  attachment: MediaAttachment;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  cfg: OpenClawConfig;
  limits: FileExtractionLimits;
  skipAttachmentIndexes?: Set<number>;
}): Promise<ClassifiedFileAttachment> {
  const { attachment, cache, cfg, limits, skipAttachmentIndexes } = params;
  const attachmentFilename =
    attachment.path ?? (attachment.url ? attachmentUrlDisplayName(attachment.url) : undefined);
  if (skipAttachmentIndexes?.has(attachment.index)) {
    return { outcome: { kind: "claimed-elsewhere" } };
  }
  const forcedTextMime = resolveTextMimeFromName(attachmentFilename ?? "");
  const kind = forcedTextMime ? "document" : resolveAttachmentKind(attachment);
  if (!forcedTextMime && (kind === "image" || kind === "video" || kind === "audio")) {
    return { outcome: { kind: "claimed-elsewhere" } };
  }
  if (
    !limits.allowUrl &&
    attachment.url &&
    !attachment.path &&
    !classifyMediaReferenceSource(attachment.url).isMediaStoreUrl
  ) {
    if (shouldLogVerbose()) {
      logVerbose(`media: file attachment skipped (url disabled) index=${attachment.index}`);
    }
    return { outcome: { kind: "url-sources-disabled" }, filename: attachmentFilename };
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
    return { outcome: { kind: "read-failure" }, filename: attachmentFilename };
  }
  const filename = bufferResult?.fileName;
  const nameHint = filename ?? attachmentFilename;
  const forcedTextMimeResolved = forcedTextMime ?? resolveTextMimeFromName(nameHint ?? "");
  const rawMime = bufferResult?.mime ?? attachment.mime;
  const normalizedRawMime = normalizeMimeType(rawMime);
  // Marker mime prefers the sender-declared type; never the name-forced text mime,
  // which would mislabel binary bytes inside a text-named file as a text format.
  // Both candidates pass strict token validation so raw header text never
  // reaches model context; undefined drops the mime from block and marker.
  const binaryMime =
    sanitizeMimeType(normalizeMimeType(attachment.mime)) ?? sanitizeMimeType(normalizedRawMime);
  if (!forcedTextMimeResolved && isBinaryMediaMime(normalizedRawMime)) {
    return {
      outcome: { kind: "unsupported-format", mime: binaryMime },
      filename,
      mimeType: binaryMime,
    };
  }
  if (hasSuspiciousBinarySignal(bufferResult?.buffer)) {
    return {
      outcome: { kind: "unsupported-format", mime: binaryMime },
      filename,
      mimeType: binaryMime,
    };
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
    return { outcome: { kind: "unsupported-format" }, filename };
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
    // Operator-pinned allowlists reject as policy; the default allowlist
    // rejects as a capability gap. The markers differ so the prompt never
    // claims support the active configuration disables.
    const outcome: FileAttachmentOutcome = limits.allowedMimesConfigured
      ? { kind: "policy-rejected", mime: mimeType }
      : { kind: "unsupported-format", mime: mimeType };
    return { outcome, filename, mimeType };
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
      limits: { ...baseLimits, allowedMimes },
      config: cfg,
    });
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`media: file attachment skipped (extract): ${String(err)}`);
    }
    return { outcome: { kind: "read-failure" }, filename, mimeType };
  }
  const text = extracted?.text?.trim() ?? "";
  const extractedImages = extracted?.images ?? [];
  if (text) {
    return { outcome: { kind: "extracted", text, images: extractedImages }, filename, mimeType };
  }
  if (extractedImages.length > 0) {
    return { outcome: { kind: "rendered-to-images", images: extractedImages }, filename, mimeType };
  }
  return { outcome: { kind: "no-extractable-text" }, filename, mimeType };
}

async function extractFileContext(params: {
  attachments: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  cfg: OpenClawConfig;
  limits: FileExtractionLimits;
  skipAttachmentIndexes?: Set<number>;
}) {
  const { attachments, cache, cfg, limits, skipAttachmentIndexes } = params;
  if (!attachments || attachments.length === 0) {
    return { blocks: [], images: [] };
  }
  const blocks: string[] = [];
  const images: ExtractedFileImage[] = [];
  let skippedMarkers = 0;
  let skippedOverflow = 0;
  for (const attachment of attachments) {
    if (!attachment) {
      continue;
    }
    const { outcome, filename, mimeType } = await classifyFileAttachment({
      attachment,
      cache,
      cfg,
      limits,
      skipAttachmentIndexes,
    });
    if (outcome.kind === "extracted" || outcome.kind === "rendered-to-images") {
      images.push(
        ...outcome.images.map((image) => ({
          ...image,
          attachmentIndex: attachment.index,
        })),
      );
    }
    const blockText = renderFileAttachmentOutcome(outcome);
    if (blockText === null) {
      continue;
    }
    if (isSkippedFileOutcome(outcome)) {
      if (skippedMarkers >= MAX_SKIPPED_FILE_MARKERS) {
        skippedOverflow += 1;
        continue;
      }
      skippedMarkers += 1;
    }
    blocks.push(
      renderFileContextBlock({
        filename,
        fallbackName: `file-${attachment.index + 1}`,
        mimeType,
        content: blockText,
      }),
    );
  }
  if (skippedOverflow > 0) {
    blocks.push(renderSkippedFileOverflowSummary(skippedOverflow));
  }
  return { blocks, images };
}

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
  /** Preserve native-harness ownership of image, video, and file inputs while applying STT. */
  processingMode?: "audio-only";
}): Promise<ApplyMediaUnderstandingResult> {
  const { ctx, cfg } = params;
  const commandCandidates = [ctx.CommandBody, ctx.RawBody, ctx.Body];
  const originalUserText =
    commandCandidates
      .map((value) => normalizeOptionalString(value))
      .find((value) => value && value.trim()) ?? undefined;

  const attachments = normalizeMediaAttachments(ctx);
  const providerRegistry = buildProviderRegistry(params.providers, cfg);
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: resolveMediaAttachmentLocalRoots({
      cfg,
      ctx,
      workspaceDir: params.workspaceDir,
    }),
    ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
    workspaceDir: params.workspaceDir,
  });

  try {
    const results = await pMap(
      params.processingMode === "audio-only" ? AUDIO_ONLY_CAPABILITY_ORDER : CAPABILITY_ORDER,
      async (capability) =>
        await runMediaCapability({
          capability,
          cfg,
          ctx,
          attachments: cache,
          media: attachments,
          agentId: params.agentId,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          providerRegistry,
          config: cfg.tools?.media?.[capability],
          activeModel: params.activeModel,
        }),
      { concurrency: resolveConcurrency(cfg), stopOnError: false },
    );
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

    const audioOutputAttachmentIndexes = new Set(
      outputs
        .filter((output) => output.kind === "audio.transcription")
        .map((output) => output.attachmentIndex),
    );
    const syntheticSkippedAudioOutputs = buildSyntheticSkippedAudioOutputs(decisions).filter(
      (output) => !audioOutputAttachmentIndexes.has(output.attachmentIndex),
    );

    // Merge synthetic placeholders into the audio slice while preserving the
    // selected audio attachment order from `runCapability()` / `attachments.prefer`.
    // When audio produced no real outputs, insert the synthetic slice at the
    // audio capability slot (before video) instead of appending at the end.
    if (syntheticSkippedAudioOutputs.length > 0) {
      const audioDecision = decisions.find((decision) => decision.capability === "audio");
      const audioAttachmentOrder =
        audioDecision?.attachments.map((attachment) => attachment.attachmentIndex) ?? [];
      const audioOutputsByAttachmentIndex = new Map<number, MediaUnderstandingOutput>();
      for (const output of outputs) {
        if (output.kind === "audio.transcription") {
          audioOutputsByAttachmentIndex.set(output.attachmentIndex, output);
        }
      }
      for (const output of syntheticSkippedAudioOutputs) {
        audioOutputsByAttachmentIndex.set(output.attachmentIndex, output);
      }
      const mergedAudio = audioAttachmentOrder
        .map((attachmentIndex) => audioOutputsByAttachmentIndex.get(attachmentIndex))
        .filter((output): output is MediaUnderstandingOutput => Boolean(output));

      const firstAudioIdx = outputs.findIndex((o) => o.kind === "audio.transcription");
      if (firstAudioIdx >= 0) {
        const before = outputs.slice(0, firstAudioIdx);
        const afterLastAudio = outputs.slice(
          outputs.reduce(
            (last, o, i) => (o.kind === "audio.transcription" ? i : last),
            firstAudioIdx,
          ) + 1,
        );
        outputs.length = 0;
        outputs.push(...before, ...mergedAudio, ...afterLastAudio);
      } else {
        const firstVideoIdx = outputs.findIndex((o) => o.kind === "video.description");
        const audioInsertIdx = firstVideoIdx >= 0 ? firstVideoIdx : outputs.length;
        outputs.splice(audioInsertIdx, 0, ...mergedAudio);
      }
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
    // Only skip file extraction for attachments that have a real (non-synthetic)
    // audio transcription. Synthetic placeholders should not prevent file extraction
    // for tiny audio-MIME files that could be recovered as text via forcedTextMime.
    const syntheticAudioIndexes = new Set(
      syntheticSkippedAudioOutputs.map((o) => o.attachmentIndex),
    );
    const audioAttachmentIndexes = new Set(
      outputs
        .filter(
          (output) =>
            output.kind === "audio.transcription" &&
            !syntheticAudioIndexes.has(output.attachmentIndex),
        )
        .map((output) => output.attachmentIndex),
    );
    const fileContext =
      params.processingMode === "audio-only"
        ? { blocks: [], images: [] }
        : await extractFileContext({
            attachments,
            cache,
            cfg,
            limits: resolveFileExtractionLimits(cfg),
            skipAttachmentIndexes:
              audioAttachmentIndexes.size > 0 ? audioAttachmentIndexes : undefined,
          });
    if (fileContext.blocks.length > 0) {
      ctx.Body = appendFileBlocks(ctx.Body, fileContext.blocks);
    }
    if (outputs.length > 0 || fileContext.blocks.length > 0) {
      finalizeInboundContext(ctx, {
        forceBodyForAgent: true,
        forceBodyForCommands: outputs.length > 0 || fileContext.blocks.length > 0,
      });
    }

    return {
      outputs,
      decisions,
      extractedFileImages: fileContext.images,
      appliedImage: outputs.some((output) => output.kind === "image.description"),
      appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
      appliedVideo: outputs.some((output) => output.kind === "video.description"),
      appliedFile: fileContext.blocks.length > 0,
    };
  } finally {
    await cache.cleanup();
  }
}
