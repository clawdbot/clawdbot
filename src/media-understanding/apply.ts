// Applies media-understanding outputs to inbound message context, including
// attachment normalization, provider execution, file text extraction, and echoing.
import {
  attachmentClassFromMime,
  type AttachmentClassification,
} from "@openclaw/media-core/attachment-classify";
import { mimeTypeFromFilePath, normalizeMimeType } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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
import { extractFileContentFromBuffer } from "../media/input-files.js";
import { classifyMediaReferenceSource } from "../media/media-reference.js";
import { runMediaCapability } from "./apply-capability.js";
import { resolveAttachmentKind } from "./attachments.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import type { ExtractedFileImage } from "./extracted-file-images.js";
import {
  type FileAttachmentOutcome,
  isSkippedFileOutcome,
  renderFileAttachmentOutcome,
  sanitizeMimeType,
} from "./file-attachment-outcomes.js";
import {
  type FileExtractionLimits,
  resolveFileExtractionLimits,
} from "./file-extraction-limits.js";
import {
  MAX_SKIPPED_FILE_MARKERS,
  renderMediaAttachmentDisposition,
  renderSkippedFileOverflowSummary,
} from "./media-attachment-outcomes.js";
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
  enableLocalPathSelfServe?: (
    contexts: MsgContext[],
    stagedPaths?: ReadonlyMap<number, string>,
  ) => void;
};

const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];
const AUDIO_ONLY_CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["audio"];
const EMPTY_VOICE_NOTE_PLACEHOLDER =
  "[Voice note could not be transcribed because the audio attachment was too small]";

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

type ClassifiedFileAttachment = {
  outcome: FileAttachmentOutcome;
  filename?: string;
  mimeType?: string;
};

type AttachmentContextBlock = { text: string; consumesMarkerBudget: boolean };
type LocalPathSelfServeUpgrade = {
  attachmentIndex: number;
  fallback: string;
  render: (path?: string) => string | undefined;
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
  // The staged copy is written under a generated name, so its basename cannot
  // answer a question that names the attachment. Prefer the sender's own name
  // for anything the model reads; classification below deliberately stays on the
  // staged path, because a sender-controlled name must not steer format detection.
  const displayFilename = attachment.fileName ?? attachmentFilename;
  if (skipAttachmentIndexes?.has(attachment.index)) {
    return { outcome: { kind: "claimed-elsewhere" } };
  }
  const extensionMime = mimeTypeFromFilePath(attachmentFilename);
  const forcedTextMime =
    attachmentClassFromMime(extensionMime) === "text" ? extensionMime : undefined;
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
    return { outcome: { kind: "url-sources-disabled" }, filename: displayFilename };
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
    return { outcome: { kind: "read-failure" }, filename: displayFilename };
  }
  const filename = attachment.fileName ?? bufferResult?.fileName;
  const classification: AttachmentClassification = bufferResult.classification;
  // Marker mime prefers the sender-declared type; never the name-forced text mime,
  // which would mislabel binary bytes inside a text-named file as a text format.
  // Both candidates pass strict token validation so raw header text never
  // reaches model context; undefined drops the mime from block and marker.
  const classifiedMime = sanitizeMimeType(classification.mime);
  const binaryMime = sanitizeMimeType(normalizeMimeType(attachment.mime)) ?? classifiedMime;
  // Preserve only the cache's root-approved local read. Rendering still waits
  // for the reply runtime's final filesystem capability (#122411).
  const selfServeLocalPath = bufferResult.localPath;
  if (
    classification.class !== "text" &&
    !(classification.class === "document" && classification.mime === "application/pdf")
  ) {
    // An operator-pinned allowlist that excludes this type is a policy "no";
    // it must win before any self-serve directive can name the file.
    if (
      limits.allowedMimesConfigured &&
      !(classifiedMime && limits.allowedMimes.has(classifiedMime))
    ) {
      return {
        outcome: { kind: "policy-rejected", mime: classifiedMime ?? binaryMime },
        filename,
        mimeType: classifiedMime ?? binaryMime,
      };
    }
    return {
      outcome: {
        kind: "unsupported-format",
        mime: binaryMime,
        ...(selfServeLocalPath ? { localPath: selfServeLocalPath } : {}),
      },
      filename,
      mimeType: binaryMime,
    };
  }
  const mimeType = sanitizeMimeType(classification.mime);
  if (
    classification.class === "text" &&
    attachment.mime &&
    normalizeMimeType(attachment.mime) !== classification.mime
  ) {
    logVerbose(
      `media: MIME override from "${attachment.mime}" to "${classification.mime}" for index=${attachment.index}`,
    );
  }
  if (!mimeType) {
    if (shouldLogVerbose()) {
      logVerbose(`media: file attachment skipped (unknown mime) index=${attachment.index}`);
    }
    return { outcome: { kind: "unsupported-format" }, filename };
  }
  const allowedMimes = new Set(limits.allowedMimes);
  if (!limits.allowedMimesConfigured && classification.class === "text") {
    allowedMimes.add(mimeType);
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
      : {
          kind: "unsupported-format",
          mime: mimeType,
          ...(selfServeLocalPath ? { localPath: selfServeLocalPath } : {}),
        };
    return { outcome, filename, mimeType };
  }
  let extracted: Awaited<ReturnType<typeof extractFileContentFromBuffer>>;
  try {
    const { allowedMimesConfigured: _allowedMimesConfigured, ...baseLimits } = limits;
    extracted = await extractFileContentFromBuffer({
      // Extractor plugins receive owned mutable bytes, never the attachment cache's buffer.
      buffer: Buffer.from(bufferResult.buffer),
      filename: bufferResult.fileName,
      limits: { ...baseLimits, allowedMimes },
      config: cfg,
      classification,
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
  selfServePathsEnabled: boolean;
}) {
  const { attachments, cache, cfg, limits, skipAttachmentIndexes } = params;
  if (!attachments || attachments.length === 0) {
    return { blocks: [], images: [], localPathSelfServeUpgrades: [] };
  }
  const blocks: AttachmentContextBlock[] = [];
  const images: ExtractedFileImage[] = [];
  const localPathSelfServeUpgrades: LocalPathSelfServeUpgrade[] = [];
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
    const blockText = renderFileAttachmentOutcome(outcome, {
      selfServeLocalPath: params.selfServePathsEnabled ? undefined : false,
    });
    if (blockText === null) {
      continue;
    }
    const renderBlock = (content: string) =>
      renderFileContextBlock({
        filename,
        fallbackName: `file-${attachment.index + 1}`,
        mimeType,
        content,
      });
    const text = renderBlock(blockText);
    blocks.push({
      text,
      consumesMarkerBudget: isSkippedFileOutcome(outcome),
    });
    if (outcome.kind === "unsupported-format" && outcome.localPath) {
      const fallback = renderFileAttachmentOutcome(outcome, { selfServeLocalPath: false });
      const selfServe = renderFileAttachmentOutcome(outcome);
      if (fallback && selfServe) {
        localPathSelfServeUpgrades.push({
          attachmentIndex: attachment.index,
          fallback: renderBlock(fallback),
          render: (path) => {
            const rendered = renderFileAttachmentOutcome(
              outcome,
              path ? { selfServeLocalPath: path } : undefined,
            );
            return rendered ? renderBlock(rendered) : undefined;
          },
        });
      }
    }
  }
  return { blocks, images, localPathSelfServeUpgrades };
}

const SELF_SERVE_CONTEXT_FIELDS = ["Body", "BodyForAgent", "agentText"] as const;

function enableLocalPathSelfServe(
  upgrades: LocalPathSelfServeUpgrade[],
  contexts: MsgContext[],
  stagedPaths?: ReadonlyMap<number, string>,
): void {
  for (const context of contexts) {
    for (const upgrade of upgrades) {
      const stagedPath = stagedPaths?.get(upgrade.attachmentIndex);
      if (stagedPaths && !stagedPath) {
        continue;
      }
      const selfServe = upgrade.render(stagedPath);
      if (!selfServe) {
        continue;
      }
      for (const field of SELF_SERVE_CONTEXT_FIELDS) {
        const value = context[field];
        if (typeof value === "string") {
          context[field] = value.replace(upgrade.fallback, selfServe);
        }
      }
    }
  }
}

function renderMediaAttachmentMarkers(params: {
  attachments: MediaAttachment[];
  decisions: MediaUnderstandingDecision[];
  outputs: MediaUnderstandingOutput[];
  deliveredImageIndexes?: ReadonlySet<number>;
}): AttachmentContextBlock[] {
  const handledIndexes = new Set(params.outputs.map((output) => output.attachmentIndex));
  const decisions = new Map(params.decisions.map((decision) => [decision.capability, decision]));
  return params.attachments.flatMap((attachment) => {
    const capability = resolveAttachmentKind(attachment);
    if (capability !== "image" && capability !== "audio" && capability !== "video") {
      return [];
    }
    // The ACP caller resolved these exact indexes into native turn attachments;
    // a marker would falsely claim non-delivery. Unresolved images keep theirs.
    if (capability === "image" && params.deliveredImageIndexes?.has(attachment.index)) {
      return [];
    }
    const decision = decisions.get(capability);
    if (!decision || handledIndexes.has(attachment.index)) {
      return [];
    }
    const disposition = decision.attachmentDispositions?.[attachment.index];
    // Vision-capable model → the reply runtime hydrates images natively; an
    // absence-of-processing marker would contradict what the model sees.
    // Recorded per-attachment failures stay visible — they are authoritative
    // regardless of native delivery. Partial/failed native hydration remains
    // unexplainable at this frozen-prompt stage (#122101).
    if (
      capability === "image" &&
      decision.nativeVisionActive !== false &&
      disposition?.kind !== "failed"
    ) {
      return [];
    }
    const text = disposition ? renderMediaAttachmentDisposition(capability, disposition) : null;
    return text ? [{ text, consumesMarkerBudget: true }] : [];
  });
}

function applyAttachmentMarkerBudget(blocks: AttachmentContextBlock[]): string[] {
  const rendered: string[] = [];
  let markers = 0;
  let overflow = 0;
  for (const block of blocks) {
    if (block.consumesMarkerBudget && markers >= MAX_SKIPPED_FILE_MARKERS) {
      overflow += 1;
      continue;
    }
    markers += Number(block.consumesMarkerBudget);
    rendered.push(block.text);
  }
  return overflow > 0 ? [...rendered, renderSkippedFileOverflowSummary(overflow)] : rendered;
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
  /** Render local paths immediately only when the caller owns the final tool surface. */
  selfServeLocalPaths?: boolean;
  /** Attachment indexes the caller (ACP) has already resolved into native turn attachments. */
  deliveredImageIndexes?: ReadonlySet<number>;
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
    const audioAttachmentIndexes = new Set<number>();
    for (const entry of results) {
      decisions.push(entry.decision);
      if (entry.decision.capability !== "audio") {
        for (const output of entry.outputs) {
          outputs.push(output);
        }
        continue;
      }
      const audioOutputsByAttachmentIndex = new Map<number, MediaUnderstandingOutput>();
      for (const output of entry.outputs) {
        audioOutputsByAttachmentIndex.set(output.attachmentIndex, output);
        audioAttachmentIndexes.add(output.attachmentIndex);
      }
      // Capability results retain image/audio/video order. Project audio in the
      // runner's selected order so placeholders honor attachments.prefer and
      // stay before video even when every audio attachment was too small.
      for (const attachment of entry.decision.attachments) {
        const output = audioOutputsByAttachmentIndex.get(attachment.attachmentIndex);
        if (output) {
          outputs.push(output);
        } else if (
          attachment.attempts.some((attempt) => attempt.reason?.trim().startsWith("tooSmall"))
        ) {
          outputs.push({
            kind: "audio.transcription",
            attachmentIndex: attachment.attachmentIndex,
            text: EMPTY_VOICE_NOTE_PLACEHOLDER,
            provider: "openclaw",
            model: "synthetic-empty-audio",
          });
        }
      }
    }

    if (decisions.length > 0) {
      ctx.MediaUnderstandingDecisions = [...(ctx.MediaUnderstandingDecisions ?? []), ...decisions];
    }

    if (outputs.length > 0) {
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
    const fileContext =
      params.processingMode === "audio-only"
        ? { blocks: [], images: [], localPathSelfServeUpgrades: [] }
        : await extractFileContext({
            attachments,
            cache,
            cfg,
            limits: resolveFileExtractionLimits(cfg),
            skipAttachmentIndexes:
              audioAttachmentIndexes.size > 0 ? audioAttachmentIndexes : undefined,
            // Placement is the caller's fact. Absent an authoritative host-readable
            // placement, suppress — a wrong path is worse than the plain marker (#122411).
            selfServePathsEnabled: params.selfServeLocalPaths === true,
          });
    // Only processed capabilities have decisions, so audio-only runs cannot
    // add markers for image/video inputs still owned by the native harness.
    const mediaMarkers = renderMediaAttachmentMarkers({
      attachments,
      decisions,
      outputs,
      deliveredImageIndexes: params.deliveredImageIndexes,
    });
    const contextBlocks = applyAttachmentMarkerBudget([...fileContext.blocks, ...mediaMarkers]);
    if (outputs.length > 0 || contextBlocks.length > 0) {
      const enrich = (body?: string) =>
        appendFileBlocks(formatMediaUnderstandingBody({ body, outputs }), contextBlocks);
      // Channels may carry preflight transcripts only in prepared agent text.
      // Enrich that base before changing the separate transport envelope.
      ctx.agentText = enrich(ctx.agentText ?? ctx.BodyForAgent ?? ctx.Body);
      ctx.Body = enrich(ctx.Body);
      finalizeInboundContext(ctx, { forceBodyForCommands: true });
    }

    return {
      outputs,
      decisions,
      extractedFileImages: fileContext.images,
      appliedImage: outputs.some((output) => output.kind === "image.description"),
      appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
      appliedVideo: outputs.some((output) => output.kind === "video.description"),
      appliedFile: fileContext.blocks.length > 0,
      ...(fileContext.localPathSelfServeUpgrades.length > 0
        ? {
            enableLocalPathSelfServe: (
              contexts: MsgContext[],
              stagedPaths?: ReadonlyMap<number, string>,
            ) =>
              enableLocalPathSelfServe(
                fileContext.localPathSelfServeUpgrades,
                contexts,
                stagedPaths,
              ),
          }
        : {}),
    };
  } finally {
    await cache.cleanup();
  }
}
