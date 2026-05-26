import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  createRastermill,
  isRastermillUnavailableError,
  RastermillUnavailableError,
  readImageMetadataFromHeader as readRastermillImageMetadataFromHeader,
  readImageProbeFromHeader as readRastermillImageProbeFromHeader,
  type ImageMetadata,
} from "rastermill";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export type { ImageMetadata };

export type ResizeToJpegParams = {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
};

export type ResizeToPngParams = {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
};

export const IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;
export const MAX_IMAGE_INPUT_PIXELS = 25_000_000;
const PHOTON_OWNED_FORMATS = new Set(["png", "gif", "webp", "jpeg"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function createOpenClawRastermill(options: { backend?: "photon" } = {}) {
  return createRastermill({
    ...(options.backend === undefined ? {} : { backend: options.backend }),
    limits: {
      inputPixels: MAX_IMAGE_INPUT_PIXELS,
      outputPixels: MAX_IMAGE_INPUT_PIXELS,
    },
    env: {
      backendVar: "OPENCLAW_IMAGE_BACKEND",
    },
    temp: {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: () => `openclaw-img-${randomUUID()}-`,
    },
    commandResolver: (command) =>
      resolveSystemBin(command, { trust: command === "powershell" ? "strict" : "standard" }),
  });
}

function hasExplicitImageBackendPreference(): boolean {
  const raw = process.env.OPENCLAW_IMAGE_BACKEND?.trim().toLowerCase();
  return raw !== undefined && raw.length > 0 && raw !== "auto";
}

function shouldForcePhotonForInput(buffer: Buffer): boolean {
  if (hasExplicitImageBackendPreference()) {
    return false;
  }
  const format = readRastermillImageProbeFromHeader(buffer)?.format;
  return format !== undefined && PHOTON_OWNED_FORMATS.has(format);
}

function createOpenClawRastermillForInput(buffer: Buffer) {
  return createOpenClawRastermill({
    backend: shouldForcePhotonForInput(buffer) ? "photon" : undefined,
  });
}

export function isImageProcessorUnavailableError(err: unknown): boolean {
  if (err instanceof ImageProcessorUnavailableError || isRastermillUnavailableError(err)) {
    return true;
  }

  const messages: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  const detail = messages.join("\n").toLowerCase();
  return (
    detail.includes("image processor unavailable") ||
    detail.includes("required image processor api") ||
    detail.includes("rastermill_image_processor_unavailable")
  );
}

export function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function buildFfmpegResizeFilter(maxSide: number, withoutEnlargement?: boolean): string {
  const side = clampInteger(maxSide, 1, Number.MAX_SAFE_INTEGER);
  if (withoutEnlargement === false) {
    return `scale=w=${side}:h=${side}:force_original_aspect_ratio=decrease`;
  }
  return `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`;
}

export const testing = {
  buildFfmpegResizeFilter,
};

function wrapRastermillUnavailable(operation: string, error: unknown): never {
  if (error instanceof RastermillUnavailableError) {
    throw new ImageProcessorUnavailableError(operation, error.message, error.causes);
  }
  throw error;
}

function assertImageInputWithinPixelBudget(buffer: Buffer): void {
  const metadata = readRastermillImageMetadataFromHeader(buffer);
  if (!metadata) {
    throw new Error("Unable to determine image dimensions; refusing to process");
  }
  if (metadata.width > Math.floor(MAX_IMAGE_INPUT_PIXELS / metadata.height)) {
    const pixels = Number.isSafeInteger(metadata.width * metadata.height)
      ? ` (${metadata.width * metadata.height} pixels)`
      : "";
    throw new Error(
      `Image dimensions exceed the ${MAX_IMAGE_INPUT_PIXELS.toLocaleString("en-US")} pixel input limit: ${metadata.width}x${metadata.height}${pixels}`,
    );
  }
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const distanceLeft = Math.abs(prediction - left);
  const distanceUp = Math.abs(prediction - up);
  const distanceUpperLeft = Math.abs(prediction - upperLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpperLeft) {
    return left;
  }
  return distanceUp <= distanceUpperLeft ? up : upperLeft;
}

function unfilterPngScanlines(
  inflated: Buffer,
  width: number,
  height: number,
  bytesPerPixel: number,
): Buffer | null {
  const stride = width * bytesPerPixel;
  if (inflated.length !== (stride + 1) * height) {
    return null;
  }
  const out = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[row * (stride + 1)];
    const sourceOffset = row * (stride + 1) + 1;
    const targetOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = inflated[sourceOffset + column] ?? 0;
      const left = column >= bytesPerPixel ? (out[targetOffset + column - bytesPerPixel] ?? 0) : 0;
      const up = row > 0 ? (out[targetOffset + column - stride] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? (out[targetOffset + column - stride - bytesPerPixel] ?? 0)
          : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4:
          value = raw + paethPredictor(left, up, upperLeft);
          break;
        default:
          return null;
      }
      out[targetOffset + column] = value & 0xff;
    }
  }
  return out;
}

function decodedPngHasTransparentPixel(buffer: Buffer): boolean | null {
  if (buffer.length < 33 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let transparency: Buffer | null = null;
  const idatChunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      return null;
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (length !== 13 || data[10] !== 0 || data[11] !== 0) {
        return null;
      }
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  const bytesPerPixel =
    colorType === 6
      ? 4
      : colorType === 4
        ? 2
        : colorType === 2
          ? 3
          : colorType === 0 || colorType === 3
            ? 1
            : null;
  if (
    width <= 0 ||
    height <= 0 ||
    bitDepth !== 8 ||
    interlace !== 0 ||
    bytesPerPixel === null ||
    idatChunks.length === 0
  ) {
    return null;
  }
  if (colorType === 0 || colorType === 2) {
    return transparency !== null && transparency.length > 0;
  }

  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks), {
    maxOutputLength: (stride + 1) * height,
  });
  const pixels = unfilterPngScanlines(inflated, width, height, bytesPerPixel);
  if (!pixels) {
    return null;
  }
  if (colorType === 3) {
    if (!transparency) {
      return false;
    }
    for (const paletteIndex of pixels) {
      if ((transparency[paletteIndex] ?? 255) < 255) {
        return true;
      }
    }
    return false;
  }

  const alphaOffset = colorType === 6 ? 3 : 1;
  for (let offset = alphaOffset; offset < pixels.length; offset += bytesPerPixel) {
    if ((pixels[offset] ?? 255) < 255) {
      return true;
    }
  }
  return false;
}

export function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return readRastermillImageMetadataFromHeader(buffer);
}

export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  const info = await createOpenClawRastermill().probe(buffer);
  return info ? { width: info.width, height: info.height } : null;
}

export async function normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
  try {
    assertImageInputWithinPixelBudget(buffer);
    const rastermill = createOpenClawRastermillForInput(buffer);
    const info = await rastermill.probe(buffer);
    if (!info?.orientation || info.orientation === 1) {
      return buffer;
    }
    return (await rastermill.encode(buffer, { format: "jpeg", autoOrient: true })).data;
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return buffer;
    }
    return wrapRastermillUnavailable("normalizeExifOrientation", error);
  }
}

export async function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
  try {
    return (
      await createOpenClawRastermillForInput(params.buffer).encode(params.buffer, {
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

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  try {
    return (await createOpenClawRastermill().encode(buffer, { format: "jpeg" })).data;
  } catch (error) {
    return wrapRastermillUnavailable("convertHeicToJpeg", error);
  }
}

export async function hasAlphaChannel(buffer: Buffer): Promise<boolean> {
  try {
    assertImageInputWithinPixelBudget(buffer);
    const rastermill = createOpenClawRastermillForInput(buffer);
    const info = await rastermill.probe(buffer);
    if (!info) {
      return false;
    }
    if (info.hasAlpha !== null) {
      return info.hasAlpha;
    }
    try {
      const png = await rastermill.encode(buffer, {
        format: "png",
        autoOrient: false,
      });
      return decodedPngHasTransparentPixel(png.data) ?? false;
    } catch {
      return false;
    }
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return false;
    }
    throw error;
  }
}

export async function resizeToPng(params: ResizeToPngParams): Promise<Buffer> {
  try {
    return (
      await createOpenClawRastermillForInput(params.buffer).encode(params.buffer, {
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
  try {
    const out = await createOpenClawRastermillForInput(buffer).encodeWithinBytes(buffer, {
      format: "png",
      maxBytes,
      search: options?.sides === undefined ? {} : { maxSide: options.sides },
    });
    return {
      buffer: out.data,
      optimizedSize: out.bytes,
      resizeSide: out.chosen.maxSide ?? out.width,
      compressionLevel: out.chosen.compressionLevel ?? 6,
    };
  } catch (error) {
    return wrapRastermillUnavailable("optimizeImageToPng", error);
  }
}
