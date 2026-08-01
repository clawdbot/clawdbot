/**
 * Tool image output sanitizer.
 *
 * Downscales and recompresses oversized base64 image blocks before provider replay.
 */
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { formatByteSize, resolveIntegerOption } from "@openclaw/normalization-core";
import { toErrorObject } from "../infra/errors.js";
import type { ImageContent } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildImageResizeSideGrid,
  getImageMetadata,
  IMAGE_REDUCE_QUALITY_STEPS,
  isImageProcessorUnavailableError,
  MAX_IMAGE_INPUT_PIXELS,
  readImageMetadataFromHeader,
  resizeToJpeg,
  type ImageMetadata,
} from "../media/media-services.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION_PX,
  type ImageSanitizationLimits,
} from "./image-sanitization.js";
import type { AgentToolResult } from "./runtime/index.js";

type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

// Anthropic Messages API rejects oversized images; sanitize here so replayed
// tool outputs do not break later turns or silent channel replies.
const MAX_IMAGE_DIMENSION_PX = DEFAULT_IMAGE_MAX_DIMENSION_PX;
const MAX_IMAGE_BYTES = DEFAULT_IMAGE_MAX_BYTES;
// Hard cap on decoded input bytes before Buffer.from/resizer allocation. A
// conservative limit well below demonstrated OOM thresholds, leaving headroom
// for canonicalization, decode, and image-processing allocations while still
// permitting legitimate tool-output images.
const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
const log = createSubsystemLogger("agents/tool-images");

function isImageTypeBlock(block: unknown): block is Record<string, unknown> & { type: "image" } {
  return (
    Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image"
  );
}

function isImageBlock(block: unknown): block is ImageContentBlock {
  if (!isImageTypeBlock(block)) {
    return false;
  }
  return typeof block.data === "string" && typeof block.mimeType === "string";
}

function isTextBlock(block: unknown): block is TextContentBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as Record<string, unknown>;
  return rec.type === "text" && typeof rec.text === "string";
}

function inferMimeTypeFromBase64(base64: string): string | undefined {
  const trimmed = base64.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("/9j/")) {
    return "image/jpeg";
  }
  if (trimmed.startsWith("iVBOR")) {
    return "image/png";
  }
  if (trimmed.startsWith("R0lGOD")) {
    return "image/gif";
  }
  return undefined;
}

function imageWithinLimits(
  buffer: Buffer,
  metadata: ImageMetadata | null,
  maxDimensionPx: number,
  maxBytes: number,
): metadata is ImageMetadata {
  const width = metadata?.width;
  const height = metadata?.height;
  return (
    typeof width === "number" &&
    typeof height === "number" &&
    width > 0 &&
    height > 0 &&
    buffer.byteLength <= maxBytes &&
    width <= maxDimensionPx &&
    height <= maxDimensionPx &&
    width * height <= MAX_IMAGE_INPUT_PIXELS
  );
}

function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))}B`;
  }
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "mega",
    separator: "",
    fractionDigits: (_value, unit) => (unit === "kilo" ? 1 : 2),
  });
}

function fileNameFromPathLike(pathLike: string): string | undefined {
  const value = pathLike.trim();
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const candidate = url.pathname.split("/").findLast(Boolean);
    return candidate && candidate.length > 0 ? candidate : undefined;
  } catch {
    // Not a URL; continue with path-like parsing.
  }

  const normalized = value.replaceAll("\\", "/");
  const candidate = normalized.split("/").findLast(Boolean);
  return candidate && candidate.length > 0 ? candidate : undefined;
}

function inferImageFileName(params: {
  block: ImageContentBlock;
  label?: string;
  mediaPathHint?: string;
}): string | undefined {
  const rec = params.block as unknown as Record<string, unknown>;
  const explicitKeys = ["fileName", "filename", "path", "url"] as const;
  for (const key of explicitKeys) {
    const raw = rec[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      continue;
    }
    const candidate = fileNameFromPathLike(raw);
    if (candidate) {
      return candidate;
    }
  }

  if (typeof rec.name === "string" && rec.name.trim().length > 0) {
    return rec.name.trim();
  }

  if (params.mediaPathHint) {
    const candidate = fileNameFromPathLike(params.mediaPathHint);
    if (candidate) {
      return candidate;
    }
  }

  if (typeof params.label === "string" && params.label.startsWith("read:")) {
    const candidate = fileNameFromPathLike(params.label.slice("read:".length));
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

async function resizeImageBase64IfNeeded(params: {
  base64: string;
  mimeType: string;
  maxDimensionPx: number;
  maxBytes: number;
  label?: string;
  fileName?: string;
}): Promise<{
  base64: string;
  mimeType: string;
  resized: boolean;
  width?: number;
  height?: number;
}> {
  const buf = Buffer.from(params.base64, "base64");
  const headerMeta = readImageMetadataFromHeader(buf);
  if (imageWithinLimits(buf, headerMeta, params.maxDimensionPx, params.maxBytes)) {
    return {
      base64: params.base64,
      mimeType: params.mimeType,
      resized: false,
      width: headerMeta.width,
      height: headerMeta.height,
    };
  }
  const meta = headerMeta ?? (await getImageMetadata(buf));
  const width = meta?.width;
  const height = meta?.height;
  const overBytes = buf.byteLength > params.maxBytes;
  const hasDimensions = typeof width === "number" && typeof height === "number";
  const overDimensions =
    hasDimensions && (width > params.maxDimensionPx || height > params.maxDimensionPx);
  if (imageWithinLimits(buf, meta, params.maxDimensionPx, params.maxBytes)) {
    return {
      base64: params.base64,
      mimeType: params.mimeType,
      resized: false,
      width,
      height,
    };
  }

  const maxDim = hasDimensions ? Math.max(width ?? 0, height ?? 0) : params.maxDimensionPx;
  const sideStart = maxDim > 0 ? Math.min(params.maxDimensionPx, maxDim) : params.maxDimensionPx;
  const sideGrid = buildImageResizeSideGrid(params.maxDimensionPx, sideStart);

  let smallest: { buffer: Buffer; size: number } | null = null;
  let processorUnavailableError: unknown;
  for (const side of sideGrid) {
    for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
      let out: Buffer;
      try {
        out = await resizeToJpeg({
          buffer: buf,
          maxSide: side,
          quality,
          withoutEnlargement: true,
        });
      } catch (err) {
        if (isImageProcessorUnavailableError(err)) {
          processorUnavailableError = err;
          break;
        }
        throw err;
      }
      if (!smallest || out.byteLength < smallest.size) {
        smallest = { buffer: out, size: out.byteLength };
      }
      if (out.byteLength <= params.maxBytes) {
        const sourcePixels =
          typeof width === "number" && typeof height === "number"
            ? `${width}x${height}px`
            : "unknown";
        const sourceWithFile = params.fileName
          ? `${params.fileName} ${sourcePixels}`
          : sourcePixels;
        const byteReductionPct =
          buf.byteLength > 0
            ? Number((((buf.byteLength - out.byteLength) / buf.byteLength) * 100).toFixed(1))
            : 0;
        log.info(
          `Image resized to fit limits: ${sourceWithFile} ${formatBytesShort(buf.byteLength)} -> ${formatBytesShort(out.byteLength)} (-${byteReductionPct}%)`,
          {
            label: params.label,
            fileName: params.fileName,
            sourceMimeType: params.mimeType,
            sourceWidth: width,
            sourceHeight: height,
            sourceBytes: buf.byteLength,
            maxBytes: params.maxBytes,
            maxDimensionPx: params.maxDimensionPx,
            triggerOverBytes: overBytes,
            triggerOverDimensions: overDimensions,
            outputMimeType: "image/jpeg",
            outputBytes: out.byteLength,
            outputQuality: quality,
            outputMaxSide: side,
            byteReductionPct,
          },
        );
        return {
          base64: out.toString("base64"),
          mimeType: "image/jpeg",
          resized: true,
          width,
          height,
        };
      }
    }
    if (processorUnavailableError) {
      break;
    }
  }

  if (processorUnavailableError) {
    throw toErrorObject(processorUnavailableError, "Non-Error thrown");
  }

  const best = smallest?.buffer ?? buf;
  const maxMb = (params.maxBytes / (1024 * 1024)).toFixed(0);
  const gotMb = (best.byteLength / (1024 * 1024)).toFixed(2);
  const sourcePixels =
    typeof width === "number" && typeof height === "number" ? `${width}x${height}px` : "unknown";
  const sourceWithFile = params.fileName ? `${params.fileName} ${sourcePixels}` : sourcePixels;
  log.warn(
    `Image resize failed to fit limits: ${sourceWithFile} best=${formatBytesShort(best.byteLength)} limit=${formatBytesShort(params.maxBytes)}`,
    {
      label: params.label,
      fileName: params.fileName,
      sourceMimeType: params.mimeType,
      sourceWidth: width,
      sourceHeight: height,
      sourceBytes: buf.byteLength,
      maxDimensionPx: params.maxDimensionPx,
      maxBytes: params.maxBytes,
      smallestCandidateBytes: best.byteLength,
      triggerOverBytes: overBytes,
      triggerOverDimensions: overDimensions,
    },
  );
  throw new Error(`Image could not be reduced below ${maxMb}MB (got ${gotMb}MB)`);
}

export async function sanitizeContentBlocksImages(
  blocks: ToolContentBlock[],
  label: string,
  opts: ImageSanitizationLimits = {},
): Promise<ToolContentBlock[]> {
  const maxDimensionPx = resolveIntegerOption(opts.maxDimensionPx, MAX_IMAGE_DIMENSION_PX, {
    min: 1,
  });
  const maxBytes = resolveIntegerOption(opts.maxBytes, MAX_IMAGE_BYTES, { min: 1 });
  const out: ToolContentBlock[] = [];
  for (const block of blocks) {
    if (!isImageBlock(block)) {
      if (isImageTypeBlock(block)) {
        out.push({
          type: "text",
          text: `[${label}] omitted image payload: missing data or mimeType`,
        } satisfies TextContentBlock);
        continue;
      }
      out.push(block);
      continue;
    }

    // Estimate decoded bytes on the raw payload before trim/canonicalize/decode
    // so pathological multi-GB base64 cannot force a transient large allocation.
    // maxBytes is the post-decode resize target; MAX_IMAGE_INPUT_BYTES is a
    // conservative pre-decode ceiling (10 MiB) far below the 25MP/100MB
    // processing headroom, so legitimate tool images still decode and resize.
    if (estimateBase64DecodedBytes(block.data) > MAX_IMAGE_INPUT_BYTES) {
      out.push({
        type: "text",
        text: `[${label}] omitted image payload: image exceeds input size limit (${formatBytesShort(MAX_IMAGE_INPUT_BYTES)})`,
      } satisfies TextContentBlock);
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
    const canonicalData = canonicalizeBase64(data);
    if (!canonicalData) {
      out.push({
        type: "text",
        text: `[${label}] omitted image payload: invalid base64`,
      } satisfies TextContentBlock);
      continue;
    }

    try {
      const inferredMimeType = inferMimeTypeFromBase64(canonicalData);
      const mimeType = inferredMimeType ?? block.mimeType;
      const fileName = inferImageFileName({ block, label });
      const resized = await resizeImageBase64IfNeeded({
        base64: canonicalData,
        mimeType,
        maxDimensionPx,
        maxBytes,
        label,
        fileName,
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
  opts: ImageSanitizationLimits = {},
): Promise<{ images: ImageContent[]; dropped: number }> {
  if (images.length === 0) {
    return { images, dropped: 0 };
  }
  const sanitized = await sanitizeContentBlocksImages(images as ToolContentBlock[], label, opts);
  const next = sanitized.filter(isImageBlock);
  return { images: next, dropped: Math.max(0, images.length - next.length) };
}

export async function sanitizeToolResultImages(
  result: AgentToolResult<unknown>,
  label: string,
  opts: ImageSanitizationLimits = {},
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];
  if (!content.some((block) => isImageTypeBlock(block) || isTextBlock(block))) {
    return result;
  }

  const next = await sanitizeContentBlocksImages(content, label, opts);
  return { ...result, content: next };
}
