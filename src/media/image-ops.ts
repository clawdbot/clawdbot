// Image operation helpers normalize image transforms and adapter calls.
import {
  createRastermill,
  isRastermillUnavailableError,
  RastermillError,
  RastermillUnavailableError,
  readImageProbeFromHeader as readRastermillImageProbeFromHeader,
  readImageMetadataFromHeader as readRastermillImageMetadataFromHeader,
  type ImageProbe,
  type ImageMetadata,
} from "rastermill";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export type { ImageMetadata, ImageProbe };

/** OpenClaw-facing image backend availability error, preserving the failed operation and causes. */
export class ImageProcessorUnavailableError extends Error {
  readonly code = "IMAGE_PROCESSOR_UNAVAILABLE";
  readonly operation: string;
  readonly causes: unknown[];

  constructor(operation: string, message?: string, causes: unknown[] = []) {
    super(message ?? `Image processor unavailable for ${operation}`, {
      cause: causes.find((cause): cause is Error => cause instanceof Error),
    });
    this.name = "ImageProcessorUnavailableError";
    this.operation = operation;
    this.causes = causes;
  }
}

/** JPEG resize request passed through the media-runtime/plugin SDK surface. */
export type ResizeToJpegParams = {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
};

/** PNG resize request passed through the media-runtime/plugin SDK surface. */
export type ResizeToPngParams = {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
};

/** Ordered JPEG quality ladder used when shrinking generated or attached images. */
export const IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;
/** Shared input/output pixel cap for Rastermill-backed image operations. */
export const MAX_IMAGE_INPUT_PIXELS = 25_000_000;

/** Creates a Rastermill processor with OpenClaw temp-dir, pixel-limit, and command trust policy. */
export function createImageProcessor() {
  return createRastermill({
    execution: "auto",
    limits: {
      inputPixels: MAX_IMAGE_INPUT_PIXELS,
      outputPixels: MAX_IMAGE_INPUT_PIXELS,
    },
    temp: {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-img-",
    },
    commandResolver: (command) =>
      resolveSystemBin(command, { trust: command === "powershell" ? "strict" : "standard" }),
  });
}

/** Detects either OpenClaw's wrapper error or Rastermill's native unavailable error. */
export function isImageProcessorUnavailableError(err: unknown): boolean {
  return err instanceof ImageProcessorUnavailableError || isRastermillUnavailableError(err);
}

/** Builds a descending, de-duplicated max-side search grid for iterative image resizing. */
export function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

/** Reads dimensions from image header bytes without invoking a full image decode. */
export function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return readRastermillImageMetadataFromHeader(buffer);
}

/** Reads image probe data from header bytes without invoking a full image decode. */
export function readImageProbeFromHeader(buffer: Buffer): ImageProbe | null {
  return readRastermillImageProbeFromHeader(buffer);
}

function wrapRastermillUnavailable(operation: string, error: unknown): never {
  if (error instanceof RastermillUnavailableError) {
    throw new ImageProcessorUnavailableError(operation, error.message, error.causes);
  }
  throw error;
}

/** Fully probes image dimensions through Rastermill when header-only metadata is insufficient. */
export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  const info = await createImageProcessor().probe(buffer);
  return info ? { width: info.width, height: info.height } : null;
}

/** Normalizes EXIF orientation when possible while leaving bytes unchanged if the backend is unavailable. */
export async function normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
  try {
    const rastermill = createImageProcessor();
    const info = await rastermill.probe(buffer);
    if (!info) {
      return (await rastermill.encode(buffer, { format: "jpeg", autoOrient: true })).data;
    }
    if (!info?.orientation || info.orientation === 1) {
      return buffer;
    }
    return (await rastermill.encode(buffer, { format: "jpeg", autoOrient: true })).data;
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return buffer;
    }
    throw error;
  }
}

/** Resizes or encodes image bytes as JPEG through the shared image processor. */
export async function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
  try {
    return (
      await createImageProcessor().encode(params.buffer, {
        format: "jpeg",
        resize: {
          maxSide: params.maxSide,
          enlarge: params.withoutEnlargement === false,
        },
        quality: params.quality,
      })
    ).data;
  } catch (error) {
    return wrapRastermillUnavailable("resizeToJpeg", error);
  }
}

/** Converts HEIC/HEIF-like image bytes into JPEG through the shared image processor. */
export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  try {
    return (await createImageProcessor().encode(buffer, { format: "jpeg" })).data;
  } catch (error) {
    return wrapRastermillUnavailable("convertHeicToJpeg", error);
  }
}

/** Detects alpha support using a full transparency probe, falling back to trusted header metadata. */
export async function hasAlphaChannel(buffer: Buffer): Promise<boolean> {
  try {
    return (await createImageProcessor().transparency(buffer)).hasAlphaChannel;
  } catch (error) {
    // Some callers only need the header-declared alpha bit; keep that usable when decode fails.
    const headerHasAlpha = readRastermillImageProbeFromHeader(buffer)?.hasAlpha === true;
    if (isRastermillUnavailableError(error)) {
      return headerHasAlpha;
    }
    if (
      error instanceof RastermillError &&
      error.code === "RASTERMILL_UNDECODABLE" &&
      readRastermillImageProbeFromHeader(buffer)
    ) {
      return headerHasAlpha;
    }
    throw error;
  }
}

/** Resizes or encodes image bytes as PNG through the shared image processor. */
export async function resizeToPng(params: ResizeToPngParams): Promise<Buffer> {
  try {
    return (
      await createImageProcessor().encode(params.buffer, {
        format: "png",
        resize: {
          maxSide: params.maxSide,
          enlarge: params.withoutEnlargement === false,
        },
        ...(params.compressionLevel === undefined
          ? {}
          : { compressionLevel: params.compressionLevel }),
      })
    ).data;
  } catch (error) {
    return wrapRastermillUnavailable("resizeToPng", error);
  }
}

/** Optimizes PNG bytes under a target size and returns the chosen search parameters. */
export async function optimizeImageToPng(
  buffer: Buffer,
  maxBytes: number,
  options?: { sides?: readonly number[] },
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  compressionLevel: number;
}> {
  let out;
  try {
    out = await createImageProcessor().encode(buffer, {
      format: "png",
      maxBytes,
      search: options?.sides === undefined ? {} : { maxSide: options.sides },
    });
  } catch (error) {
    wrapRastermillUnavailable("optimizeImageToPng", error);
  }
  return {
    buffer: out.data,
    optimizedSize: out.bytes,
    resizeSide: out.chosen.maxSide ?? out.width,
    compressionLevel: out.chosen.compressionLevel ?? 6,
  };
}
