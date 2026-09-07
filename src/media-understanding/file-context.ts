// One file-classification/extraction owner serves live input and retained model context.
import {
  attachmentClassFromMime,
  type AttachmentClassification,
} from "@openclaw/media-core/attachment-classify";
import { mimeTypeFromFilePath, normalizeMimeType } from "@openclaw/media-core/mime";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { renderFileContextBlock } from "../media/file-context.js";
import { extractFileContentFromBuffer } from "../media/input-files.js";
import type { MediaFact } from "../media/media-facts.js";
import { classifyMediaReferenceSource } from "../media/media-reference.js";
import { resolveAttachmentKind } from "./attachments.js";
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
  applyAttachmentMarkerBudget,
  type AttachmentContextBlock,
} from "./media-attachment-outcomes.js";
import {
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
} from "./runner.attachments.js";
import type { MediaAttachment } from "./types.js";

type ClassifiedFileAttachment = {
  outcome: FileAttachmentOutcome;
  filename?: string;
  mimeType?: string;
};

export type LocalPathSelfServeUpgrade = {
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
  assertCurrent?: () => void;
}): Promise<ClassifiedFileAttachment> {
  const { attachment, cache, cfg, limits, skipAttachmentIndexes } = params;
  params.assertCurrent?.();
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
  params.assertCurrent?.();
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
      // Text decoding is read-only; PDF extractor plugins still receive owned mutable bytes.
      buffer:
        mimeType === "application/pdf" ? Buffer.from(bufferResult.buffer) : bufferResult.buffer,
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
  params.assertCurrent?.();
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

export async function extractFileContext(params: {
  attachments: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  cfg: OpenClawConfig;
  limits: FileExtractionLimits;
  skipAttachmentIndexes?: Set<number>;
  assertCurrent?: () => void;
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
      assertCurrent: params.assertCurrent,
    }).finally(() => cache.releaseBuffer(attachment.index));
    params.assertCurrent?.();
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

/** Prepares retained document context under the same admission policy as live attachments. */
export async function prepareFileContextFromMedia(params: {
  media: readonly MediaFact[];
  config: OpenClawConfig;
  workspaceDir: string;
  channelId?: string;
  accountId?: string;
  maxChars: number;
  assertCurrent: () => void;
}) {
  return await renderInboundDocumentContext({
    ctx: {
      media: [...params.media],
      Provider: params.channelId,
      AccountId: params.accountId,
    },
    cfg: params.config,
    workspaceDir: params.workspaceDir,
    maxChars: params.maxChars,
    assertCurrent: params.assertCurrent,
  });
}

export type InboundDocumentContext = { text: string; images: ExtractedFileImage[] };

/** Keep prompt expansion separate from inbound state so rejected steers can dispatch normally. */
export async function renderInboundDocumentContext(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  maxChars?: number;
  assertCurrent?: () => void;
}): Promise<InboundDocumentContext> {
  params.assertCurrent?.();
  const { ctx, cfg } = params;
  const limits = resolveFileExtractionLimits(cfg);
  const attachments = normalizeMediaAttachments(ctx);
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
    const context = await extractFileContext({
      attachments,
      cache,
      cfg,
      limits:
        params.maxChars === undefined
          ? limits
          : { ...limits, maxChars: Math.min(limits.maxChars, params.maxChars) },
      selfServePathsEnabled: false,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
    return {
      text: applyAttachmentMarkerBudget(context.blocks).join("\n\n"),
      images: context.images,
    };
  } finally {
    await cache.cleanup();
  }
}
