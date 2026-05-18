import type { ImageContent } from "@earendil-works/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";

function countCurrentImageAttachmentCandidates(ctx: MsgContext): number {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : normalizeOptionalString(ctx.MediaPath)
        ? [ctx.MediaPath]
        : [];
  if (paths.length === 0) {
    return 0;
  }
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;
  let count = 0;
  for (const [index, pathValue] of paths.entries()) {
    const mediaPath = normalizeOptionalString(pathValue);
    const mediaType = normalizeOptionalString(types?.[index] ?? ctx.MediaType);
    if (mediaPath && mediaType?.startsWith("image/")) {
      count++;
    }
  }
  return count;
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

  const currentImageCandidateCount = countCurrentImageAttachmentCandidates(params.ctx);
  if (currentImageCandidateCount === 0) {
    return { images: params.images, imageOrder: params.imageOrder };
  }

  try {
    const resolved = await resolveAgentTurnAttachments({
      ctx: params.ctx,
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
    if (images.length < currentImageCandidateCount) {
      logVerbose(
        `agent-runner: native PI media resolution produced ${images.length}/${currentImageCandidateCount} current image attachment(s); falling back to prompt image refs`,
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
