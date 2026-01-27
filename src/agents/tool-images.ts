import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getImageMetadata, resizeToJpeg } from "../media/image-ops.js";

type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

// Anthropic Messages API limitations (observed in Moltbot sessions):
// - Images over ~2000px per side can fail in multi-image requests.
// - Images over 5MB are rejected by the API.
//
// To keep sessions resilient (and avoid "silent" WhatsApp non-replies), we auto-downscale
// and recompress base64 image blocks when they exceed these limits.
const MAX_IMAGE_DIMENSION_PX = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const log = createSubsystemLogger("agents/tool-images");

function isImageBlock(block: unknown): block is ImageContentBlock {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  return rec.type === "image" && typeof rec.data === "string" && typeof rec.mimeType === "string";
}

function isTextBlock(block: unknown): block is TextContentBlock {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  return rec.type === "text" && typeof rec.text === "string";
}

function inferMimeTypeFromBase64(base64: string): string | undefined {
  const trimmed = base64.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/9j/")) return "image/jpeg";
  if (trimmed.startsWith("iVBOR")) return "image/png";
  if (trimmed.startsWith("R0lGOD")) return "image/gif";
  return undefined;
}

async function resizeImageBase64IfNeeded(params: {
  base64: string;
  mimeType: string;
  maxDimensionPx: number;
  maxBytes: number;
  label?: string;
}): Promise<{
  base64: string;
  mimeType: string;
  resized: boolean;
  width?: number;
  height?: number;
}> {
  const buf = Buffer.from(params.base64, "base64");
  const meta = await getImageMetadata(buf);
  const width = meta?.width;
  const height = meta?.height;
  const overBytes = buf.byteLength > params.maxBytes;
  const hasDimensions = typeof width === "number" && typeof height === "number";
  if (
    hasDimensions &&
    !overBytes &&
    width <= params.maxDimensionPx &&
    height <= params.maxDimensionPx
  ) {
    return {
      base64: params.base64,
      mimeType: params.mimeType,
      resized: false,
      width,
      height,
    };
  }
  if (
    hasDimensions &&
    (width > params.maxDimensionPx || height > params.maxDimensionPx || overBytes)
  ) {
    log.warn("Image exceeds limits; resizing", {
      label: params.label,
      width,
      height,
      maxDimensionPx: params.maxDimensionPx,
      maxBytes: params.maxBytes,
    });
  }

  const qualities = [85, 75, 65, 55, 45, 35];
  const maxDim = hasDimensions ? Math.max(width ?? 0, height ?? 0) : params.maxDimensionPx;
  const sideStart = maxDim > 0 ? Math.min(params.maxDimensionPx, maxDim) : params.maxDimensionPx;
  const sideGrid = [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((v) => Math.min(params.maxDimensionPx, v))
    .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i)
    .sort((a, b) => b - a);

  let smallest: { buffer: Buffer; size: number } | null = null;
  for (const side of sideGrid) {
    for (const quality of qualities) {
      const out = await resizeToJpeg({
        buffer: buf,
        maxSide: side,
        quality,
        withoutEnlargement: true,
      });
      if (!smallest || out.byteLength < smallest.size) {
        smallest = { buffer: out, size: out.byteLength };
      }
      if (out.byteLength <= params.maxBytes) {
        log.info("Image resized", {
          label: params.label,
          width,
          height,
          maxDimensionPx: params.maxDimensionPx,
          maxBytes: params.maxBytes,
          originalBytes: buf.byteLength,
          resizedBytes: out.byteLength,
          quality,
          side,
        });
        return {
          base64: out.toString("base64"),
          mimeType: "image/jpeg",
          resized: true,
          width,
          height,
        };
      }
    }
  }

  const best = smallest?.buffer ?? buf;
  const maxMb = (params.maxBytes / (1024 * 1024)).toFixed(0);
  const gotMb = (best.byteLength / (1024 * 1024)).toFixed(2);
  throw new Error(`Image could not be reduced below ${maxMb}MB (got ${gotMb}MB)`);
}

export async function sanitizeContentBlocksImages(
  blocks: ToolContentBlock[],
  label: string,
  opts: { maxDimensionPx?: number; maxBytes?: number } = {},
): Promise<ToolContentBlock[]> {
  const maxDimensionPx = Math.max(opts.maxDimensionPx ?? MAX_IMAGE_DIMENSION_PX, 1);
  const maxBytes = Math.max(opts.maxBytes ?? MAX_IMAGE_BYTES, 1);
  const out: ToolContentBlock[] = [];

  for (const block of blocks) {
    if (!isImageBlock(block)) {
      out.push(block);
      continue;
    }

    const data = block.data.trim();
    if (!data) {
      out.push({
        type: "text",
        text: `[${label}] omitted empty image payload`,
      } satisfies TextContentBlock);
      continue;
    }

    try {
      const inferredMimeType = inferMimeTypeFromBase64(data);
      const mimeType = inferredMimeType ?? block.mimeType;
      const resized = await resizeImageBase64IfNeeded({
        base64: data,
        mimeType,
        maxDimensionPx,
        maxBytes,
        label,
      });
      out.push({
        ...block,
        data: resized.base64,
        mimeType: resized.resized ? resized.mimeType : mimeType,
      });
    } catch (err) {
      out.push({
        type: "text",
        text: `[${label}] omitted image payload: ${String(err)}`,
      } satisfies TextContentBlock);
    }
  }

  return out;
}

export async function sanitizeImageBlocks(
  images: ImageContent[],
  label: string,
  opts: { maxDimensionPx?: number; maxBytes?: number } = {},
): Promise<{ images: ImageContent[]; dropped: number }> {
  if (images.length === 0) return { images, dropped: 0 };
  const sanitized = await sanitizeContentBlocksImages(images as ToolContentBlock[], label, opts);
  const next = sanitized.filter(isImageBlock) as ImageContent[];
  return { images: next, dropped: Math.max(0, images.length - next.length) };
}

export async function sanitizeToolResultImages(
  result: AgentToolResult<unknown>,
  label: string,
  opts: { maxDimensionPx?: number; maxBytes?: number } = {},
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];
  if (!content.some((b) => isImageBlock(b) || isTextBlock(b))) return result;

  const next = await sanitizeContentBlocksImages(content, label, opts);
  return { ...result, content: next };
}
