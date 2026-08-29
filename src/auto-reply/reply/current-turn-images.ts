// Tracks image attachments that belong to the current reply turn.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MediaImageLayout } from "../../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent } from "../../llm/types.js";
import {
  isImageAttachment,
  normalizeAttachments,
} from "../../media-understanding/attachments.normalize.js";
import {
  stripExtractedFileImageMetadata,
  type ExtractedFileImage,
} from "../../media-understanding/extracted-file-images.js";
import type { MediaAttachment } from "../../media-understanding/types.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import {
  collectDescribedImageAttachmentIndexes,
  hasInboundHistoryMedia,
  resolveAgentTurnAttachments,
} from "./agent-turn-attachments.js";
import { appendRecentHistoryImageContext } from "./history-media.js";

type CurrentImageAttachment = MediaAttachment & { path: string };

type OrderedTurnImage = {
  image?: ImageContent;
  imageOrder: PromptImageOrderEntry;
  sourceIndex?: number;
  sequence: number;
};

export type CurrentTurnImages = {
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  imageSourceIndexes?: Array<number | undefined>;
  unresolvedSourceIndexes?: number[];
  /** Admission-owned slot-to-media identity used by later runtime adapters. */
  mediaImageLayout?: MediaImageLayout;
  /** Provenance for images this turn inherited from room history, appended to the prompt. */
  historyImageNotes?: string;
};

function collectCurrentImageAttachments(ctx: MsgContext): CurrentImageAttachment[] {
  return normalizeAttachments(ctx).flatMap((attachment) => {
    const mediaPath = normalizeOptionalString(attachment.path);
    return mediaPath && isImageAttachment(attachment) ? [{ ...attachment, path: mediaPath }] : [];
  });
}

function appendOrderedImages(params: {
  entries: OrderedTurnImage[];
  images: ImageContent[] | undefined;
  imageOrder?: PromptImageOrderEntry[];
  sourceIndex?: number;
}) {
  const images = params.images ?? [];
  if (!params.imageOrder || params.imageOrder.length === 0) {
    for (const image of images) {
      params.entries.push({
        image,
        imageOrder: "inline",
        sourceIndex: params.sourceIndex,
        sequence: params.entries.length,
      });
    }
    return;
  }

  let inlineIndex = 0;
  for (const imageOrder of params.imageOrder) {
    params.entries.push({
      image: imageOrder === "inline" ? images[inlineIndex++] : undefined,
      imageOrder,
      sourceIndex: params.sourceIndex,
      sequence: params.entries.length,
    });
  }
  while (inlineIndex < images.length) {
    params.entries.push({
      image: images[inlineIndex++],
      imageOrder: "inline",
      sourceIndex: params.sourceIndex,
      sequence: params.entries.length,
    });
  }
}

function resolveMergedTurnImages(entries: OrderedTurnImage[]): {
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  imageSourceIndexes?: Array<number | undefined>;
} {
  if (entries.length === 0) {
    return {};
  }
  const merged = entries.toSorted((left, right) => {
    if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) {
      return left.sourceIndex - right.sourceIndex || left.sequence - right.sequence;
    }
    return left.sequence - right.sequence;
  });
  const images = merged.flatMap((entry) => (entry.image ? [entry.image] : []));
  const result = {
    ...(images.length > 0 ? { images } : {}),
    imageOrder: merged.map((entry) => entry.imageOrder),
  };
  Object.defineProperty(result, "imageSourceIndexes", {
    value: merged.map((entry) => entry.sourceIndex),
  });
  return result;
}

/** Resolves current-turn image attachments that were not already described by media understanding. */
export async function resolveCurrentTurnImages(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  extractedFileImages?: ExtractedFileImage[];
}): Promise<CurrentTurnImages> {
  const entries: OrderedTurnImage[] = [];
  appendOrderedImages({
    entries,
    images: params.images,
    imageOrder: params.imageOrder,
  });
  for (const image of params.extractedFileImages ?? []) {
    appendOrderedImages({
      entries,
      images: [stripExtractedFileImageMetadata(image)],
      sourceIndex: image.attachmentIndex,
    });
  }

  const currentImageAttachments = collectCurrentImageAttachments(params.ctx);
  const describedImageIndexes = collectDescribedImageAttachmentIndexes(params.ctx);
  const undescribedImageAttachments = currentImageAttachments.filter(
    (attachment) => !describedImageIndexes.has(attachment.index),
  );
  // A room that kept media on a gated message answers the turn that finally asks
  // about it. The resolver only reaches those images when this turn resolved none
  // of its own, so asking for them costs nothing when it did.
  const includeRecentHistoryImages = hasInboundHistoryMedia(params.ctx);
  if (undescribedImageAttachments.length === 0 && !includeRecentHistoryImages) {
    return resolveMergedTurnImages(entries);
  }

  try {
    // Only send undescribed current images natively; described images already exist as text context.
    const resolved = await resolveAgentTurnAttachments({
      ctx: params.ctx,
      cfg: params.cfg,
      includeRecentHistoryImages,
      includeAttachmentIndexes: true,
    });
    const images = resolved.attachments.map(
      (attachment): ImageContent => ({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mediaType,
      }),
    );
    const resolvedIndexes = resolved.attachmentIndexes ?? [];
    if (images.length < undescribedImageAttachments.length) {
      logVerbose(
        `agent-runner: native OpenClaw media resolution produced ${images.length}/${undescribedImageAttachments.length} current image attachment(s); retaining resolved images`,
      );
    }
    const imageByResolvedIndex = new Map(
      resolvedIndexes.map((resolvedIndex, imageIndex) => [resolvedIndex, images[imageIndex]]),
    );
    const unresolvedSourceIndexes: number[] = [];
    for (const attachment of undescribedImageAttachments) {
      const image = imageByResolvedIndex.get(attachment.index);
      if (image) {
        appendOrderedImages({
          entries,
          images: [image],
          sourceIndex: attachment.index,
        });
      } else {
        unresolvedSourceIndexes.push(attachment.index);
      }
    }
    // History images carry synthetic source indexes past the current turn's, so
    // they append after it without a second ordering rule.
    const currentSourceIndexes = new Set(
      undescribedImageAttachments.map((attachment) => attachment.index),
    );
    for (const [resolvedIndex, image] of imageByResolvedIndex) {
      if (image && !currentSourceIndexes.has(resolvedIndex)) {
        appendOrderedImages({ entries, images: [image], sourceIndex: resolvedIndex });
      }
    }
    const merged = resolveMergedTurnImages(entries);
    // Without provenance an inherited image reads as this turn's own attachment.
    const historyImageNotes =
      resolved.recentHistoryImages.length > 0
        ? appendRecentHistoryImageContext({
            promptText: "",
            images: resolved.recentHistoryImages,
          })
        : undefined;
    const withHistory = historyImageNotes ? Object.assign(merged, { historyImageNotes }) : merged;
    return unresolvedSourceIndexes.length > 0
      ? Object.assign(withHistory, { unresolvedSourceIndexes })
      : withHistory;
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment image resolution failed, proceeding without native images: ${formatErrorMessage(error)}`,
    );
    const merged = resolveMergedTurnImages(entries);
    return undescribedImageAttachments.length > 0
      ? Object.assign(merged, {
          unresolvedSourceIndexes: undescribedImageAttachments.map(
            (attachment) => attachment.index,
          ),
        })
      : merged;
  }
}
