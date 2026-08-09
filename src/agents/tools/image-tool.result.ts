import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentToolResult } from "../runtime/index.js";
import { sanitizeToolResultImages } from "../tool-images.js";

export type LoadedImageForTool = {
  buffer: Buffer;
  mimeType: string;
  resolvedImage: string;
  rewrittenFrom?: string;
};

export function buildImageToolReferenceDetails(
  images: readonly LoadedImageForTool[],
): Record<string, unknown> {
  const single = images.length === 1 ? images[0] : undefined;
  if (single) {
    return {
      image: single.resolvedImage,
      ...(single.rewrittenFrom ? { rewrittenFrom: single.rewrittenFrom } : {}),
    };
  }
  return {
    images: images.map((image) => ({
      image: image.resolvedImage,
      ...(image.rewrittenFrom ? { rewrittenFrom: image.rewrittenFrom } : {}),
    })),
  };
}

export async function buildNativeImageToolResult(
  images: readonly LoadedImageForTool[],
  config?: OpenClawConfig,
  skippedImages?: { count: number; budgetBytes: number },
): Promise<AgentToolResult<unknown>> {
  const result: AgentToolResult<unknown> = {
    content: [
      {
        type: "text",
        text:
          `Loaded ${images.length} image${images.length === 1 ? "" : "s"} for direct visual inspection.` +
          (skippedImages
            ? ` Skipped ${skippedImages.count} image${skippedImages.count === 1 ? "" : "s"}: the request byte budget was exhausted.`
            : ""),
      },
      ...images.map((image) => ({
        type: "image" as const,
        data: image.buffer.toString("base64"),
        mimeType: image.mimeType,
      })),
    ],
    details: {
      transport: "native",
      ...buildImageToolReferenceDetails(images),
      ...(skippedImages
        ? { skippedImages: { ...skippedImages, reason: "request_budget_exhausted" } }
        : {}),
      media: { outbound: false },
    },
  };
  return await sanitizeToolResultImages(
    result,
    "image:native",
    resolveImageSanitizationLimits(config),
  );
}
