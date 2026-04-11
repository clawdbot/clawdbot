import {
  buildImageResizeSideGrid,
  getImageMetadata,
  IMAGE_REDUCE_QUALITY_STEPS,
  resizeToJpeg,
} from "../media/image-ops.js";

export const DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE = 2000;
export const DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

export async function normalizeBrowserScreenshot(
  buffer: Buffer,
  opts?: {
    maxSide?: number;
    maxBytes?: number;
  },
): Promise<{ buffer: Buffer; contentType?: "image/jpeg" }> {
  const maxSide = Math.max(1, Math.round(opts?.maxSide ?? DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE));
  const maxBytes = Math.max(1, Math.round(opts?.maxBytes ?? DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES));

  const meta = await getImageMetadata(buffer);
  const width = meta?.width ?? 0;
  const height = meta?.height ?? 0;
  const maxDim = Math.max(width, height);

  if (buffer.byteLength <= maxBytes && (maxDim === 0 || (width <= maxSide && height <= maxSide))) {
    return { buffer };
  }

  const sideStart = maxDim > 0 ? Math.min(maxSide, maxDim) : maxSide;
  const sideGrid = buildImageResizeSideGrid(maxSide, sideStart);

  let smallest: { buffer: Buffer; size: number } | null = null;

  for (const side of sideGrid) {
    for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
      const out = await resizeToJpeg({
        buffer,
        maxSide: side,
        quality,
        withoutEnlargement: true,
      });

      if (!smallest || out.byteLength < smallest.size) {
        smallest = { buffer: out, size: out.byteLength };
      }

      if (out.byteLength <= maxBytes) {
        return { buffer: out, contentType: "image/jpeg" };
      }
    }
  }

  const best = smallest?.buffer ?? buffer;
  throw new Error(
    `Browser screenshot could not be reduced below ${(maxBytes / (1024 * 1024)).toFixed(0)}MB (got ${(best.byteLength / (1024 * 1024)).toFixed(2)}MB)`,
  );
}
