// Tracks image attachments that belong to the current reply turn.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent } from "../../llm/types.js";
import { normalizeAttachments } from "../../media-understanding/attachments.normalize.js";
import {
  stripExtractedFileImageMetadata,
  type ExtractedFileImage,
} from "../../media-understanding/extracted-file-images.js";
import { projectMediaFacts } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { MsgContext } from "../templating.js";
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

function isGenericMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) {
    return true;
  }
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  return normalized === "application/octet-stream" || normalized === "binary/octet-stream";
}

/** Resolves image media types from current-turn attachment metadata or filenames. */
function resolveCurrentImageMediaType(pathValue: unknown, mediaType?: unknown): string | undefined {
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

function collectCurrentImageAttachments(ctx: MsgContext): CurrentImageAttachment[] {
  return normalizeAttachments(ctx).flatMap((attachment) => {
    const mediaPath = normalizeOptionalString(attachment.path);
    const mediaType = resolveCurrentImageMediaType(attachment.path, attachment.mime);
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
    ...projectMediaFacts(media),
  };
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
} {
  if (entries.length === 0) {
    return {};
  }
  const merged = entries.toSorted((left, right) => {
    if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) {
      return left.sourceIndex - right.sourceIndex || left.sequence - right.sequence;
    }
    if (left.sourceIndex !== undefined || right.sourceIndex !== undefined) {
      return left.sequence - right.sequence;
    }
    return left.sequence - right.sequence;
  });
  const images = merged.flatMap((entry) => (entry.image ? [entry.image] : []));
  return {
    ...(images.length > 0 ? { images } : {}),
    imageOrder: merged.map((entry) => entry.imageOrder),
  };
}

/** Resolves current-turn image attachments that were not already described by media understanding. */
export async function resolveCurrentTurnImages(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  extractedFileImages?: ExtractedFileImage[];
}): Promise<{
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
}> {
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
  if (currentImageAttachments.length === 0) {
    return resolveMergedTurnImages(entries);
  }
  const describedImageIndexes = collectDescribedImageAttachmentIndexes(params.ctx);
  const undescribedImageAttachments = currentImageAttachments.filter(
    (attachment) => !describedImageIndexes.has(attachment.index),
  );
  if (undescribedImageAttachments.length === 0) {
    return resolveMergedTurnImages(entries);
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
      return resolveMergedTurnImages(entries);
    }
    for (const [index, image] of images.entries()) {
      appendOrderedImages({
        entries,
        images: [image],
        sourceIndex: undescribedImageAttachments[index]?.index,
      });
    }
    return resolveMergedTurnImages(entries);
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment image resolution failed, proceeding without native images: ${formatErrorMessage(error)}`,
    );
    return resolveMergedTurnImages(entries);
  }
}
