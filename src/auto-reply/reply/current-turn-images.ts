import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent } from "../../llm/types.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";

type CurrentImageAttachment = {
  index: number;
  path: string;
  mediaType: string;
};

function isGenericMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) {
    return true;
  }
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  return normalized === "application/octet-stream" || normalized === "binary/octet-stream";
}

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
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : normalizeOptionalString(ctx.MediaPath)
        ? [ctx.MediaPath]
        : [];
  if (paths.length === 0) {
    return [];
  }
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;
  const attachments: CurrentImageAttachment[] = [];
  for (const [index, pathValue] of paths.entries()) {
    const mediaPath = normalizeOptionalString(pathValue);
    const mediaType = resolveCurrentImageMediaType(pathValue, types?.[index] ?? ctx.MediaType);
    if (mediaPath && mediaType) {
      attachments.push({ index, path: mediaPath, mediaType });
    }
  }
  return attachments;
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
  const first = undescribedAttachments[0];
  return {
    ...ctx,
    MediaPath: first?.path,
    MediaType: first?.mediaType,
    MediaPaths: undescribedAttachments.map((attachment) => attachment.path),
    MediaTypes: undescribedAttachments.map((attachment) => attachment.mediaType),
  };
}

export async function resolveCurrentTurnImages(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
}): Promise<{
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
}> {
  if (Array.isArray(params.images) && params.images.length > 0) {
    return { images: params.images, imageOrder: params.imageOrder };
  }

  const currentImageAttachments = collectCurrentImageAttachments(params.ctx);
  if (currentImageAttachments.length === 0) {
    return { images: params.images, imageOrder: params.imageOrder };
  }
  const describedImageIndexes = collectDescribedImageAttachmentIndexes(params.ctx);
  const undescribedImageAttachments = currentImageAttachments.filter(
    (attachment) => !describedImageIndexes.has(attachment.index),
  );
  if (undescribedImageAttachments.length === 0) {
    return { images: params.images, imageOrder: params.imageOrder };
  }

  try {
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
      return { images: params.images, imageOrder: params.imageOrder };
    }
    return images.length > 0
      ? { images, imageOrder: images.map(() => "inline" as const) }
      : { images: params.images, imageOrder: params.imageOrder };
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment image resolution failed, proceeding without native images: ${formatErrorMessage(error)}`,
    );
    return { images: params.images, imageOrder: params.imageOrder };
  }
}
