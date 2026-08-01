// Tracks image attachments that belong to the current reply turn.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent } from "../../llm/types.js";
import { logError } from "../../logger.js";
import { normalizeAttachments } from "../../media-understanding/attachments.normalize.js";
import {
  stripExtractedFileImageMetadata,
  type ExtractedFileImage,
} from "../../media-understanding/extracted-file-images.js";
import { orderSourceIndexedEntries } from "../../media/image-source-indexes.js";
import { normalizeMediaFacts } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { finalizeRuntimePromptImages } from "../../media/runtime-prompt-image-provenance.js";
import type { RuntimePromptImageFactSpace } from "../../media/runtime-prompt-image-provenance.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";

type CurrentImageAttachment = {
  index: number;
  path: string;
  mediaType: string;
  workspaceDir?: string;
};

type OrderedTurnImage = {
  image?: ImageContent;
  imageOrder: PromptImageOrderEntry;
  sourceIndex?: number;
  sequence: number;
};

type OrderedImageSlot = {
  kind: PromptImageOrderEntry;
  sourceIndex?: number;
};

function isGenericMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) {
    return true;
  }
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  return normalized === "application/octet-stream" || normalized === "binary/octet-stream";
}

function resolveNativeImageMediaType(pathValue: unknown, mediaType?: unknown): string | undefined {
  const mediaPath = normalizeOptionalString(pathValue);
  if (!mediaPath) {
    return undefined;
  }
  const normalizedMediaType = normalizeOptionalString(mediaType);
  if (normalizedMediaType?.startsWith("image/")) {
    return normalizedMediaType;
  }
  if (!isGenericMediaType(normalizedMediaType)) {
    return undefined;
  }
  const inferredType = mimeTypeFromFilePath(mediaPath);
  return inferredType?.startsWith("image/") ? inferredType : undefined;
}

function collectCurrentImageAttachments(
  attachments: ReturnType<typeof normalizeAttachments>,
): CurrentImageAttachment[] {
  return attachments.flatMap((attachment) => {
    if (attachment.hydrationSuppressed === true) {
      return [];
    }
    const mediaPath = normalizeOptionalString(attachment.path);
    const mediaType = resolveNativeImageMediaType(attachment.path, attachment.mime);
    if (mediaPath && mediaType) {
      return [
        {
          index: attachment.index,
          path: mediaPath,
          mediaType,
          workspaceDir: attachment.workspaceDir,
        },
      ];
    }
    return [];
  });
}

function collectDescribedImageAttachmentIndexes(ctx: MsgContext): Set<number> {
  return new Set(
    ctx.MediaUnderstanding?.filter((output) => output.kind === "image.description").map(
      (output) => output.attachmentIndex,
    ) ?? [],
  );
}

function createUndescribedImageContext(
  ctx: MsgContext,
  undescribedAttachments: CurrentImageAttachment[],
): MsgContext {
  const media = undescribedAttachments.map((attachment) => ({
    path: attachment.path,
    contentType: attachment.mediaType,
    workspaceDir: attachment.workspaceDir,
  }));
  return {
    ...ctx,
    media,
  };
}

function normalizeOrderedImageSlots(params: {
  images: ImageContent[] | undefined;
  imageOrder?: PromptImageOrderEntry[];
  imageSourceIndexes?: readonly (number | undefined)[];
}): { slots: OrderedImageSlot[]; sourceMappingInvalid: boolean } {
  const images = params.images ?? [];
  const imageOrder = params.imageOrder ?? images.map(() => "inline" as const);
  let slots = imageOrder.map((kind, index) => ({
    kind,
    sourceIndex: params.imageSourceIndexes?.[index],
  }));
  let sourceMappingInvalid = false;
  if (params.imageSourceIndexes && params.imageSourceIndexes.length !== imageOrder.length) {
    logError(
      `Image source slot count ${params.imageSourceIndexes.length} does not match image order count ${imageOrder.length}`,
    );
    sourceMappingInvalid = true;
  }
  const inlineSlotCount = imageOrder.filter((entry) => entry === "inline").length;
  if (inlineSlotCount !== images.length) {
    const mismatchMessage = `Inline image count ${images.length} does not match image order slot count ${inlineSlotCount}`;
    if (images.length === 0) {
      logVerbose(`${mismatchMessage}; leaving fact-owned slots to runner hydration`);
    } else if (params.imageSourceIndexes) {
      logError(mismatchMessage);
    } else {
      logVerbose(mismatchMessage);
    }
    sourceMappingInvalid ||= params.imageSourceIndexes !== undefined;
    let remainingInlineSlots = images.length;
    slots = slots.filter((slot) => {
      if (slot.kind === "offloaded") {
        return true;
      }
      if (remainingInlineSlots === 0) {
        return false;
      }
      remainingInlineSlots -= 1;
      return true;
    });
    slots.push(
      ...Array.from({ length: remainingInlineSlots }, () => ({
        kind: "inline" as const,
        sourceIndex: undefined,
      })),
    );
  }
  return { slots, sourceMappingInvalid };
}

function appendOrderedImages(params: {
  entries: OrderedTurnImage[];
  images: ImageContent[] | undefined;
  slots?: readonly OrderedImageSlot[];
  sourceIndex?: number;
}): void {
  const images = params.images ?? [];
  const slots: readonly OrderedImageSlot[] =
    params.slots ?? images.map(() => ({ kind: "inline" as const }));
  let inlineIndex = 0;
  for (const slot of slots) {
    const mappedSourceIndex = slot.sourceIndex;
    params.entries.push({
      image: slot.kind === "inline" ? images[inlineIndex++] : undefined,
      imageOrder: slot.kind,
      sourceIndex: mappedSourceIndex ?? params.sourceIndex,
      sequence: params.entries.length,
    });
  }
}

function resolveMergedTurnImages(
  entries: OrderedTurnImage[],
  sourceMappingInvalid: boolean,
  imageFactIndexSpace?: RuntimePromptImageFactSpace,
): {
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  imageSourceIndexes?: Array<number | undefined>;
  imageSourceMappingInvalid?: true;
} {
  if (entries.length === 0) {
    return sourceMappingInvalid ? { imageSourceMappingInvalid: true } : {};
  }
  const merged = orderSourceIndexedEntries(entries);
  const images = finalizeRuntimePromptImages(
    merged.flatMap((entry) =>
      entry.image ? [{ image: entry.image, factIndex: entry.sourceIndex ?? null }] : [],
    ),
    imageFactIndexSpace,
  ).images;
  const imageSourceIndexes = merged.map((entry) => entry.sourceIndex);
  return {
    ...(images.length > 0 ? { images } : {}),
    imageOrder: merged.map((entry) => entry.imageOrder),
    ...(imageSourceIndexes.some((index) => index !== undefined) ? { imageSourceIndexes } : {}),
    ...(sourceMappingInvalid ? { imageSourceMappingInvalid: true as const } : {}),
  };
}

/** Resolves current-turn image attachments that were not already described by media understanding. */
export async function resolveCurrentTurnImages(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  imageSourceIndexes?: readonly (number | undefined)[];
  sourceMediaCount?: number;
  sourceMappingInvalid?: boolean;
  invalidSourceMappingPolicy?: "hydrate" | "infer-inline";
  extractedFileImages?: ExtractedFileImage[];
  imageFactIndexSpace?: RuntimePromptImageFactSpace;
}): Promise<{
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  imageSourceIndexes?: Array<number | undefined>;
  imageSourceMappingInvalid?: true;
}> {
  const entries: OrderedTurnImage[] = [];
  const initialSlots = normalizeOrderedImageSlots({
    images: params.images,
    imageOrder: params.imageOrder,
    imageSourceIndexes: params.imageSourceIndexes,
  });
  appendOrderedImages({ entries, images: params.images, slots: initialSlots.slots });
  let sourceMappingInvalid =
    initialSlots.sourceMappingInvalid || params.sourceMappingInvalid === true;
  for (const image of params.extractedFileImages ?? []) {
    appendOrderedImages({
      entries,
      images: [stripExtractedFileImageMetadata(image)],
      sourceIndex: image.attachmentIndex,
    });
  }

  const normalizedAttachments = normalizeAttachments(params.ctx);
  const sourceMediaCount = params.sourceMediaCount ?? normalizeMediaFacts(params.ctx.media).length;
  for (const entry of entries) {
    const sourceIndex = entry.sourceIndex;
    if (sourceIndex !== undefined && (sourceIndex < 0 || sourceIndex >= sourceMediaCount)) {
      logError(
        `Image source index ${sourceIndex} does not exist in the current session media space`,
      );
      sourceMappingInvalid = true;
      entry.sourceIndex = undefined;
    }
  }
  const currentImageAttachments = collectCurrentImageAttachments(normalizedAttachments);
  if (currentImageAttachments.length === 0) {
    return resolveMergedTurnImages(entries, sourceMappingInvalid, params.imageFactIndexSpace);
  }
  const describedImageIndexes = collectDescribedImageAttachmentIndexes(params.ctx);
  // The hydrate policy leaves unsourced facts eligible for the native hydration path below.
  const inferInlineOwnership =
    sourceMappingInvalid && params.invalidSourceMappingPolicy === "infer-inline";
  if (inferInlineOwnership) {
    const claimedIndexes = new Set(
      entries.flatMap((entry) => (entry.sourceIndex === undefined ? [] : [entry.sourceIndex])),
    );
    const unclaimedAttachments = currentImageAttachments.filter(
      (attachment) =>
        !claimedIndexes.has(attachment.index) && !describedImageIndexes.has(attachment.index),
    );
    let unclaimedIndex = 0;
    for (const entry of entries) {
      if (!entry.image || entry.sourceIndex !== undefined) {
        continue;
      }
      const attachment = unclaimedAttachments[unclaimedIndex++];
      if (!attachment) {
        break;
      }
      entry.sourceIndex = attachment.index;
    }
  }
  const representedImageIndexes = new Set(
    entries.flatMap((entry) => (entry.sourceIndex === undefined ? [] : [entry.sourceIndex])),
  );
  const undescribedImageAttachments = currentImageAttachments.filter(
    (attachment) =>
      !describedImageIndexes.has(attachment.index) &&
      !representedImageIndexes.has(attachment.index),
  );
  if (undescribedImageAttachments.length === 0) {
    return resolveMergedTurnImages(entries, sourceMappingInvalid, params.imageFactIndexSpace);
  }

  try {
    // Only send undescribed current images natively; described images already exist as text context.
    const resolved = await resolveAgentTurnAttachments({
      ctx: createUndescribedImageContext(params.ctx, undescribedImageAttachments),
      cfg: params.cfg,
      includeRecentHistoryImages: false,
    });
    const images = resolved.attachments.map(
      (attachment): ImageContent => ({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mediaType,
      }),
    );
    if (images.length < undescribedImageAttachments.length) {
      logVerbose(
        `agent-runner: native OpenClaw media resolution produced ${images.length}/${undescribedImageAttachments.length} current image attachment(s); falling back to prompt image refs`,
      );
      return resolveMergedTurnImages(entries, sourceMappingInvalid, params.imageFactIndexSpace);
    }
    for (const [index, image] of images.entries()) {
      appendOrderedImages({
        entries,
        images: [image],
        sourceIndex: undescribedImageAttachments[index]?.index,
      });
    }
    return resolveMergedTurnImages(entries, sourceMappingInvalid, params.imageFactIndexSpace);
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment image resolution failed, proceeding without native images: ${formatErrorMessage(error)}`,
    );
    return resolveMergedTurnImages(entries, sourceMappingInvalid, params.imageFactIndexSpace);
  }
}
