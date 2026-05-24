import { withTempWorkspace, type TempWorkspace } from "../infra/private-temp-workspace.js";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runExec } from "../process/exec.js";
import { createLazyPromiseLoader } from "../shared/lazy-promise.js";

export type ImageMetadata = {
  width: number;
  height: number;
};

type MediaAttachmentImageOps = {
  getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null>;
  normalizeExifOrientation(buffer: Buffer): Promise<Buffer>;
  resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer>;
  convertHeicToJpeg(buffer: Buffer): Promise<Buffer>;
  hasAlphaChannel(buffer: Buffer): Promise<boolean>;
  resizeToPng(params: ResizeToPngParams): Promise<Buffer>;
};

type MediaAttachmentImageOpsModule = {
  createMediaAttachmentImageOps?: (options: { maxInputPixels: number }) => MediaAttachmentImageOps;
};

type ResizeToJpegParams = {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
};

type ResizeToPngParams = {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
};

type ImageBackend =
  | "sharp"
  | "sips"
  | "windows-native"
  | "imagemagick"
  | "graphicsmagick"
  | "ffmpeg";
type ImageBackendPreference = ImageBackend | "auto";
type ImageOperation =
  | "metadata"
  | "normalizeExifOrientation"
  | "resizeToJpeg"
  | "convertHeicToJpeg"
  | "resizeToPng";

type ExternalImageTool =
  | { backend: "imagemagick"; flavor: "magick" | "convert"; command: string }
  | { backend: "graphicsmagick"; flavor: "gm"; command: string }
  | { backend: "ffmpeg"; flavor: "ffmpeg"; command: string }
  | { backend: "windows-native"; flavor: "powershell"; command: string }
  | { backend: "sips"; flavor: "sips"; command: string };

export const IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;
export const MAX_IMAGE_INPUT_PIXELS = 25_000_000;
const IMAGE_PROCESS_TIMEOUT_MS = 20_000;
const IMAGE_TOOL_MAX_BUFFER = 1024 * 1024;
const MEDIA_UNDERSTANDING_CORE_PLUGIN_ID = "media-understanding-core";
const MEDIA_UNDERSTANDING_CORE_IMAGE_OPS_ARTIFACT = "image-ops.js";

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

export function isImageProcessorUnavailableError(err: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    if (current instanceof ImageProcessorUnavailableError) {
      return true;
    }
    messages.push(current.message);
    current = current.cause;
  }
  const detail = messages.join("\n").toLowerCase();
  return (
    detail.includes("image processor unavailable") ||
    detail.includes("optional dependency sharp is required") ||
    detail.includes("cannot find package 'sharp'") ||
    detail.includes('cannot find package "sharp"') ||
    detail.includes("cannot find module 'sharp'") ||
    detail.includes('cannot find module "sharp"')
  );
}

export function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

function getImageBackendPreference(): ImageBackendPreference {
  const raw = process.env.OPENCLAW_IMAGE_BACKEND?.trim().toLowerCase();
  switch (raw) {
    case "sharp":
    case "sips":
    case "windows-native":
    case "imagemagick":
    case "graphicsmagick":
    case "ffmpeg":
      return raw;
    case "windows":
    case "powershell":
    case "system.drawing":
    case "systemdrawing":
      return "windows-native";
    case "magick":
    case "convert":
      return "imagemagick";
    case "gm":
      return "graphicsmagick";
    default:
      return "auto";
  }
}

function shouldFailClosedOnUnknownMetadata(): boolean {
  return getImageBackendPreference() !== "auto";
}

function imageBackendsForOperation(operation: ImageOperation): ImageBackend[] {
  const preference = getImageBackendPreference();
  if (preference !== "auto") {
    return [preference];
  }

  if (operation === "resizeToPng") {
    if (process.platform === "win32") {
      return ["sharp", "windows-native", "imagemagick", "graphicsmagick"];
    }
    return ["sharp", "imagemagick", "graphicsmagick"];
  }

  if (operation === "normalizeExifOrientation") {
    if (process.platform === "win32") {
      return ["sharp", "imagemagick", "graphicsmagick"];
    }
    return process.platform === "darwin"
      ? ["sharp", "sips", "imagemagick", "graphicsmagick"]
      : ["sharp", "imagemagick", "graphicsmagick"];
  }

  if (process.platform === "win32") {
    if (operation === "convertHeicToJpeg") {
      return ["sharp", "imagemagick", "graphicsmagick", "ffmpeg"];
    }
    return ["sharp", "windows-native", "imagemagick", "graphicsmagick", "ffmpeg"];
  }

  const fallbacks =
    process.platform === "darwin"
      ? (["sips", "imagemagick", "graphicsmagick", "ffmpeg"] as const)
      : (["imagemagick", "graphicsmagick", "ffmpeg"] as const);
  return ["sharp", ...fallbacks];
}

function createImageProcessorUnavailableError(
  operation: ImageOperation,
  causes: unknown[],
): ImageProcessorUnavailableError {
  const backends = imageBackendsForOperation(operation).join(", ");
  const hint =
    process.platform === "win32"
      ? "Install Sharp, ImageMagick, GraphicsMagick, or ffmpeg; Windows native image resizing is tried automatically when available."
      : process.platform === "darwin"
        ? "Install Sharp or a system image tool such as sips, ImageMagick, GraphicsMagick, or ffmpeg."
        : "Install Sharp, ImageMagick, GraphicsMagick, or ffmpeg.";
  return new ImageProcessorUnavailableError(
    operation,
    `Image processor unavailable for ${operation}; tried: ${backends}. ${hint}`,
    causes,
  );
}

function isImageBackendUnavailableCause(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  const detail = messages.join("\n").toLowerCase();
  return (
    detail.includes("optional dependency sharp is required") ||
    detail.includes("cannot find package 'sharp'") ||
    detail.includes('cannot find package "sharp"') ||
    detail.includes("cannot find module 'sharp'") ||
    detail.includes('cannot find module "sharp"') ||
    detail.includes("support for this compression format has not been built in") ||
    detail.includes("is not available") ||
    detail.includes("command not found") ||
    detail.includes("enoent")
  );
}

async function runWithImageBackends<T>(
  operation: ImageOperation,
  fn: (backend: ImageBackend) => Promise<T>,
): Promise<T> {
  const errors: unknown[] = [];
  for (const backend of imageBackendsForOperation(operation)) {
    try {
      return await fn(backend);
    } catch (error) {
      errors.push(error);
      if (!isImageBackendUnavailableCause(error)) {
        throw error;
      }
    }
  }
  throw createImageProcessorUnavailableError(operation, errors);
}

function isMediaAttachmentImageOps(value: unknown): value is MediaAttachmentImageOps {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<Record<keyof MediaAttachmentImageOps, unknown>>;
  return (
    typeof candidate.getImageMetadata === "function" &&
    typeof candidate.normalizeExifOrientation === "function" &&
    typeof candidate.resizeToJpeg === "function" &&
    typeof candidate.convertHeicToJpeg === "function" &&
    typeof candidate.hasAlphaChannel === "function" &&
    typeof candidate.resizeToPng === "function"
  );
}

const mediaAttachmentImageOpsLoader = createLazyPromiseLoader(async () => {
  const { loadBundledPluginPublicArtifactModuleSync } =
    await import("../plugins/public-surface-loader.js");
  const mod = loadBundledPluginPublicArtifactModuleSync<MediaAttachmentImageOpsModule>({
    dirName: MEDIA_UNDERSTANDING_CORE_PLUGIN_ID,
    artifactBasename: MEDIA_UNDERSTANDING_CORE_IMAGE_OPS_ARTIFACT,
  });
  const ops = mod.createMediaAttachmentImageOps?.({
    maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
  });
  if (!isMediaAttachmentImageOps(ops)) {
    throw new Error("Media understanding core did not expose image ops");
  }
  return ops;
});

async function loadMediaAttachmentImageOps(): Promise<MediaAttachmentImageOps> {
  return await mediaAttachmentImageOpsLoader.load();
}

function isPositiveImageDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function buildImageMetadata(width: number, height: number): ImageMetadata | null {
  if (!isPositiveImageDimension(width) || !isPositiveImageDimension(height)) {
    return null;
  }
  return { width, height };
}

function readPngMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 24) {
    return null;
  }
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47 ||
    buffer[4] !== 0x0d ||
    buffer[5] !== 0x0a ||
    buffer[6] !== 0x1a ||
    buffer[7] !== 0x0a ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return buildImageMetadata(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function readPngAlphaChannel(buffer: Buffer): boolean | null {
  if (buffer.length < 29 || readPngMetadata(buffer) === null) {
    return null;
  }

  const colorType = buffer[25];
  if (colorType === 4 || colorType === 6) {
    return true;
  }
  if (colorType !== 0 && colorType !== 2 && colorType !== 3) {
    return null;
  }

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const nextOffset = dataEnd + 4;
    if (dataEnd > buffer.length || nextOffset > buffer.length) {
      return null;
    }
    const chunkType = buffer.toString("ascii", typeStart, typeStart + 4);
    if (chunkType === "tRNS") {
      return chunkLength > 0;
    }
    if (chunkType === "IDAT" || chunkType === "IEND") {
      return false;
    }
    offset = nextOffset;
  }

  return false;
}

function readGifMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 10) {
    return null;
  }
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return null;
  }
  return buildImageMetadata(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function readWebpMetadata(buffer: Buffer): ImageMetadata | null {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8X") {
    if (buffer.length < 30) {
      return null;
    }
    return buildImageMetadata(1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3));
  }
  if (chunkType === "VP8 ") {
    if (buffer.length < 30) {
      return null;
    }
    return buildImageMetadata(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  }
  if (chunkType === "VP8L") {
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      return null;
    }
    const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
    return buildImageMetadata((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

const ISO_BMFF_IMAGE_BRANDS = new Set([
  "avif",
  "avis",
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heif",
  "mif1",
  "msf1",
]);

const ISO_BMFF_CONTAINER_BOXES = new Set([
  "edts",
  "ipco",
  "iprp",
  "mdia",
  "meta",
  "minf",
  "moov",
  "stbl",
  "trak",
]);

function readIsoBmffBoxSize(buffer: Buffer, offset: number, end: number): number | null {
  if (offset + 8 > end) {
    return null;
  }
  const size32 = buffer.readUInt32BE(offset);
  if (size32 === 0) {
    return end - offset;
  }
  if (size32 === 1) {
    if (offset + 16 > end) {
      return null;
    }
    const size64 = buffer.readBigUInt64BE(offset + 8);
    return size64 <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size64) : null;
  }
  return size32;
}

function isIsoBmffImage(buffer: Buffer): boolean {
  if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") {
    return false;
  }
  const ftypSize = readIsoBmffBoxSize(buffer, 0, buffer.length);
  if (!ftypSize || ftypSize < 16 || ftypSize > buffer.length) {
    return false;
  }
  for (let offset = 8; offset + 4 <= ftypSize; offset += 4) {
    if (ISO_BMFF_IMAGE_BRANDS.has(buffer.toString("ascii", offset, offset + 4))) {
      return true;
    }
  }
  return false;
}

function pickLargerImageMetadata(
  current: ImageMetadata | null,
  candidate: ImageMetadata | null,
): ImageMetadata | null {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  const currentPixels = BigInt(current.width) * BigInt(current.height);
  const candidatePixels = BigInt(candidate.width) * BigInt(candidate.height);
  return candidatePixels > currentPixels ? candidate : current;
}

function findIsoBmffIspeMetadata(
  buffer: Buffer,
  start: number,
  end: number,
  depth: number,
): ImageMetadata | null {
  if (depth > 8) {
    return null;
  }
  let offset = start;
  let largest: ImageMetadata | null = null;
  while (offset + 8 <= end) {
    const boxSize = readIsoBmffBoxSize(buffer, offset, end);
    if (!boxSize || boxSize < 8 || offset + boxSize > end) {
      return null;
    }
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const headerSize = buffer.readUInt32BE(offset) === 1 ? 16 : 8;
    const dataStart = offset + headerSize;
    const boxEnd = offset + boxSize;
    if (type === "ispe" && dataStart + 12 <= boxEnd) {
      largest = pickLargerImageMetadata(
        largest,
        buildImageMetadata(buffer.readUInt32BE(dataStart + 4), buffer.readUInt32BE(dataStart + 8)),
      );
    }
    if (ISO_BMFF_CONTAINER_BOXES.has(type)) {
      const childStart = type === "meta" ? dataStart + 4 : dataStart;
      const meta = findIsoBmffIspeMetadata(buffer, childStart, boxEnd, depth + 1);
      largest = pickLargerImageMetadata(largest, meta);
    }
    offset = boxEnd;
  }
  return largest;
}

function readIsoBmffImageMetadata(buffer: Buffer): ImageMetadata | null {
  if (!isIsoBmffImage(buffer)) {
    return null;
  }
  return findIsoBmffIspeMetadata(buffer, 0, buffer.length, 0);
}

function readJpegMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset++;
    }
    if (offset >= buffer.length) {
      return null;
    }

    const marker = buffer[offset];
    offset++;
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= buffer.length) {
      return null;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return null;
    }

    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (segmentLength < 7 || offset + 6 >= buffer.length) {
        return null;
      }
      return buildImageMetadata(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }

    offset += segmentLength;
  }

  return null;
}

export function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return (
    readPngMetadata(buffer) ??
    readGifMetadata(buffer) ??
    readWebpMetadata(buffer) ??
    readIsoBmffImageMetadata(buffer) ??
    readJpegMetadata(buffer)
  );
}

function countImagePixels(meta: ImageMetadata): number | null {
  const pixels = meta.width * meta.height;
  return Number.isSafeInteger(pixels) ? pixels : null;
}

function exceedsImagePixelLimit(meta: ImageMetadata): boolean {
  return meta.width > Math.floor(MAX_IMAGE_INPUT_PIXELS / meta.height);
}

function createImagePixelLimitError(meta: ImageMetadata): Error {
  const pixelCount = countImagePixels(meta);
  const detail =
    pixelCount === null
      ? `${meta.width}x${meta.height}`
      : `${meta.width}x${meta.height} (${pixelCount} pixels)`;
  return new Error(
    `Image dimensions exceed the ${MAX_IMAGE_INPUT_PIXELS.toLocaleString("en-US")} pixel input limit: ${detail}`,
  );
}

function validateImagePixelLimit(meta: ImageMetadata): ImageMetadata {
  if (exceedsImagePixelLimit(meta)) {
    throw createImagePixelLimitError(meta);
  }
  return meta;
}

async function readImageMetadataForLimit(buffer: Buffer): Promise<ImageMetadata | null> {
  return readImageMetadataFromHeader(buffer);
}

async function assertImagePixelLimit(buffer: Buffer): Promise<void> {
  const meta = await readImageMetadataForLimit(buffer);
  if (!meta) {
    if (shouldFailClosedOnUnknownMetadata()) {
      throw new Error("Unable to determine image dimensions; refusing to process");
    }
    return;
  }
  validateImagePixelLimit(meta);
}

function assertKnownImagePixelLimitBeforeExternalFallback(buffer: Buffer): void {
  const meta = readImageMetadataFromHeader(buffer);
  if (!meta) {
    throw new Error("Unable to determine image dimensions; refusing to process");
  }
  validateImagePixelLimit(meta);
}

/**
 * Reads EXIF orientation from JPEG buffer.
 * Returns orientation value 1-8, or null if not found/not JPEG.
 *
 * EXIF orientation values:
 * 1 = Normal, 2 = Flip H, 3 = Rotate 180, 4 = Flip V,
 * 5 = Rotate 270 CW + Flip H, 6 = Rotate 90 CW, 7 = Rotate 90 CW + Flip H, 8 = Rotate 270 CW
 */
function readJpegExifOrientation(buffer: Buffer): number | null {
  // Check JPEG magic bytes
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length - 4) {
    // Look for marker
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // Skip padding FF bytes
    if (marker === 0xff) {
      offset++;
      continue;
    }

    // APP1 marker (EXIF)
    if (marker === 0xe1) {
      const exifStart = offset + 4;

      // Check for "Exif\0\0" header
      if (
        buffer.length > exifStart + 6 &&
        buffer.toString("ascii", exifStart, exifStart + 4) === "Exif" &&
        buffer[exifStart + 4] === 0 &&
        buffer[exifStart + 5] === 0
      ) {
        const tiffStart = exifStart + 6;
        if (buffer.length < tiffStart + 8) {
          return null;
        }

        // Check byte order (II = little-endian, MM = big-endian)
        const byteOrder = buffer.toString("ascii", tiffStart, tiffStart + 2);
        const isLittleEndian = byteOrder === "II";

        const readU16 = (pos: number) =>
          isLittleEndian ? buffer.readUInt16LE(pos) : buffer.readUInt16BE(pos);
        const readU32 = (pos: number) =>
          isLittleEndian ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos);

        // Read IFD0 offset
        const ifd0Offset = readU32(tiffStart + 4);
        const ifd0Start = tiffStart + ifd0Offset;
        if (buffer.length < ifd0Start + 2) {
          return null;
        }

        const numEntries = readU16(ifd0Start);
        for (let i = 0; i < numEntries; i++) {
          const entryOffset = ifd0Start + 2 + i * 12;
          if (buffer.length < entryOffset + 12) {
            break;
          }

          const tag = readU16(entryOffset);
          // Orientation tag = 0x0112
          if (tag === 0x0112) {
            const value = readU16(entryOffset + 8);
            return value >= 1 && value <= 8 ? value : null;
          }
        }
      }
      return null;
    }

    // Skip other segments
    if (marker >= 0xe0 && marker <= 0xef) {
      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
      continue;
    }

    // SOF, SOS, or other marker - stop searching
    if (marker === 0xc0 || marker === 0xda) {
      break;
    }

    offset++;
  }

  return null;
}

async function withImageTemp<T>(fn: (workspace: TempWorkspace) => Promise<T>): Promise<T> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-img-" },
    fn,
  );
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveImageTool(backend: Exclude<ImageBackend, "sharp">): ExternalImageTool | null {
  if (backend === "sips") {
    return process.platform === "darwin"
      ? { backend, flavor: "sips", command: "/usr/bin/sips" }
      : null;
  }
  if (backend === "windows-native") {
    const powershell = resolveSystemBin("powershell", { trust: "strict" });
    return powershell && process.platform === "win32"
      ? { backend, flavor: "powershell", command: powershell }
      : null;
  }
  if (backend === "imagemagick") {
    const magick = resolveSystemBin("magick", { trust: "standard" });
    if (magick) {
      return { backend, flavor: "magick", command: magick };
    }
    if (process.platform !== "win32") {
      const convert = resolveSystemBin("convert", { trust: "standard" });
      if (convert) {
        return { backend, flavor: "convert", command: convert };
      }
    }
    return null;
  }
  if (backend === "graphicsmagick") {
    const gm = resolveSystemBin("gm", { trust: "standard" });
    return gm ? { backend, flavor: "gm", command: gm } : null;
  }
  const ffmpeg = resolveSystemBin("ffmpeg", { trust: "standard" });
  return ffmpeg ? { backend, flavor: "ffmpeg", command: ffmpeg } : null;
}

function convertToolArgs(
  tool: Extract<ExternalImageTool, { flavor: "magick" | "convert" | "gm" }>,
  args: string[],
): string[] {
  return tool.flavor === "gm" ? ["convert", ...args] : args;
}

async function runPowerShellImageScript(
  scriptName: string,
  script: string,
  args: readonly string[],
): Promise<{ stdout: string }> {
  const tool = resolveImageTool("windows-native");
  if (!tool || tool.flavor !== "powershell") {
    throw new Error("Windows native image backend is not available");
  }
  return await withImageTemp(async (workspace) => {
    const scriptPath = await workspace.write(scriptName, Buffer.from(script, "utf8"));
    return await runExec(
      tool.command,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      {
        timeoutMs: IMAGE_PROCESS_TIMEOUT_MS,
        maxBuffer: IMAGE_TOOL_MAX_BUFFER,
      },
    );
  });
}

const WINDOWS_NATIVE_RESIZE_SCRIPT = `
param(
  [string]$InputPath,
  [string]$OutputPath,
  [int]$MaxSide,
  [int]$Quality,
  [int]$WithoutEnlargement,
  [string]$Format
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile($InputPath)
$bitmap = $null
$graphics = $null
try {
  try {
    if ($source.PropertyIdList -contains 274) {
      $orientation = [BitConverter]::ToUInt16($source.GetPropertyItem(274).Value, 0)
      switch ($orientation) {
        2 { $source.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipX) }
        3 { $source.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
        4 { $source.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipX) }
        5 { $source.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipX) }
        6 { $source.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
        7 { $source.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipX) }
        8 { $source.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
      }
      try { $source.RemovePropertyItem(274) } catch {}
    }
  } catch {}
  $maxDim = [Math]::Max($source.Width, $source.Height)
  if ($maxDim -le 0) { throw 'Invalid image dimensions' }
  $scale = $MaxSide / [double]$maxDim
  if ($WithoutEnlargement -eq 1) {
    $scale = [Math]::Min(1.0, $scale)
  }
  $width = [Math]::Max(1, [int][Math]::Round($source.Width * $scale))
  $height = [Math]::Max(1, [int][Math]::Round($source.Height * $scale))
  $pixelFormat = [System.Drawing.Imaging.PixelFormat]::Format24bppRgb
  if ($Format -eq 'png') {
    $pixelFormat = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  }
  $bitmap = New-Object System.Drawing.Bitmap($width, $height, $pixelFormat)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  if ($Format -eq 'png') {
    $graphics.Clear([System.Drawing.Color]::Transparent)
  } else {
    $graphics.Clear([System.Drawing.Color]::White)
  }
  $graphics.DrawImage($source, 0, 0, $width, $height)
  if ($Format -eq 'png') {
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } else {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' } |
      Select-Object -First 1
    if ($null -eq $codec) { throw 'JPEG encoder not available' }
    $encoder = [System.Drawing.Imaging.Encoder]::Quality
    $encoderParam = New-Object System.Drawing.Imaging.EncoderParameter($encoder, [int64]$Quality)
    $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
    try {
      $encoderParams.Param[0] = $encoderParam
      $bitmap.Save($OutputPath, $codec, $encoderParams)
    } finally {
      $encoderParam.Dispose()
      $encoderParams.Dispose()
    }
  }
} finally {
  if ($null -ne $graphics) { $graphics.Dispose() }
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  $source.Dispose()
}
`;

async function windowsNativeResize(
  params: ResizeToJpegParams | ResizeToPngParams,
  format: "jpeg" | "png",
): Promise<Buffer> {
  return await withImageTemp(async (workspace) => {
    const input = await workspace.write("in.img", params.buffer);
    const outputName = format === "png" ? "out.png" : "out.jpg";
    const output = workspace.path(outputName);
    await runPowerShellImageScript("resize.ps1", WINDOWS_NATIVE_RESIZE_SCRIPT, [
      input,
      output,
      String(clampInteger(params.maxSide, 1, Number.MAX_SAFE_INTEGER)),
      String(clampInteger("quality" in params ? params.quality : 90, 1, 100)),
      params.withoutEnlargement === false ? "0" : "1",
      format === "png" ? "png" : "jpeg",
    ]);
    return await workspace.read(outputName);
  });
}

async function runConvertTool(
  tool: Extract<ExternalImageTool, { flavor: "magick" | "convert" | "gm" }>,
  args: string[],
): Promise<void> {
  await runExec(tool.command, convertToolArgs(tool, args), {
    timeoutMs: IMAGE_PROCESS_TIMEOUT_MS,
    maxBuffer: IMAGE_TOOL_MAX_BUFFER,
  });
}

function buildResizeGeometry(maxSide: number, withoutEnlargement?: boolean): string {
  const side = clampInteger(maxSide, 1, Number.MAX_SAFE_INTEGER);
  return `${side}x${side}${withoutEnlargement === false ? "" : ">"}`;
}

function buildFfmpegResizeFilter(maxSide: number, withoutEnlargement?: boolean): string {
  const side = clampInteger(maxSide, 1, Number.MAX_SAFE_INTEGER);
  if (withoutEnlargement === false) {
    return `scale=w=${side}:h=${side}:force_original_aspect_ratio=decrease`;
  }
  return `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`;
}

async function externalResizeToJpeg(
  backend: Exclude<ImageBackend, "sharp">,
  params: ResizeToJpegParams,
): Promise<Buffer> {
  const tool = resolveImageTool(backend);
  if (!tool) {
    throw new Error(`Image backend ${backend} is not available`);
  }
  if (tool.flavor === "sips") {
    const normalized = await normalizeExifOrientationSips(params.buffer);
    if (params.withoutEnlargement !== false) {
      const meta = await getImageMetadata(normalized);
      if (meta) {
        const maxDim = Math.max(meta.width, meta.height);
        if (maxDim > 0 && maxDim <= params.maxSide) {
          return await sipsResizeToJpeg({
            buffer: normalized,
            maxSide: maxDim,
            quality: params.quality,
          });
        }
      }
    }
    return await sipsResizeToJpeg({
      buffer: normalized,
      maxSide: params.maxSide,
      quality: params.quality,
    });
  }
  if (tool.flavor === "powershell") {
    return await windowsNativeResize(params, "jpeg");
  }

  return await withImageTemp(async (workspace) => {
    const input = await workspace.write("in.img", params.buffer);
    const output = workspace.path("out.jpg");
    if (tool.flavor === "ffmpeg") {
      const side = clampInteger(params.maxSide, 1, Number.MAX_SAFE_INTEGER);
      const qv = clampInteger(31 - params.quality * 0.29, 2, 31);
      await runExec(
        tool.command,
        [
          "-y",
          "-i",
          input,
          "-vf",
          buildFfmpegResizeFilter(side, params.withoutEnlargement),
          "-frames:v",
          "1",
          "-q:v",
          String(qv),
          output,
        ],
        { timeoutMs: IMAGE_PROCESS_TIMEOUT_MS, maxBuffer: IMAGE_TOOL_MAX_BUFFER },
      );
      return await workspace.read("out.jpg");
    }

    await runConvertTool(tool, [
      input,
      "-auto-orient",
      "-resize",
      buildResizeGeometry(params.maxSide, params.withoutEnlargement),
      "-quality",
      String(clampInteger(params.quality, 1, 100)),
      output,
    ]);
    return await workspace.read("out.jpg");
  });
}

async function externalConvertToJpeg(
  backend: Exclude<ImageBackend, "sharp">,
  buffer: Buffer,
): Promise<Buffer> {
  const tool = resolveImageTool(backend);
  if (!tool) {
    throw new Error(`Image backend ${backend} is not available`);
  }
  if (tool.flavor === "sips") {
    return await sipsConvertToJpeg(buffer);
  }
  if (tool.flavor === "powershell") {
    throw new Error("Windows native image backend does not convert HEIC to JPEG");
  }
  return await withImageTemp(async (workspace) => {
    const input = await workspace.write("in.img", buffer);
    const output = workspace.path("out.jpg");
    if (tool.flavor === "ffmpeg") {
      await runExec(tool.command, ["-y", "-i", input, "-frames:v", "1", "-q:v", "3", output], {
        timeoutMs: IMAGE_PROCESS_TIMEOUT_MS,
        maxBuffer: IMAGE_TOOL_MAX_BUFFER,
      });
    } else {
      await runConvertTool(tool, [input, "-auto-orient", "-quality", "90", output]);
    }
    return await workspace.read("out.jpg");
  });
}

async function externalNormalizeExifOrientation(
  backend: Exclude<ImageBackend, "sharp" | "ffmpeg">,
  buffer: Buffer,
): Promise<Buffer> {
  if (backend === "sips") {
    return await normalizeExifOrientationSips(buffer);
  }
  const tool = resolveImageTool(backend);
  if (!tool || tool.flavor === "ffmpeg" || tool.flavor === "sips" || tool.flavor === "powershell") {
    throw new Error(`Image backend ${backend} is not available`);
  }
  if (!readJpegExifOrientation(buffer)) {
    return buffer;
  }
  return await withImageTemp(async (workspace) => {
    const input = await workspace.write("in.jpg", buffer);
    const output = workspace.path("out.jpg");
    await runConvertTool(tool, [input, "-auto-orient", output]);
    return await workspace.read("out.jpg");
  });
}

async function externalResizeToPng(
  backend: Exclude<ImageBackend, "sharp" | "sips" | "ffmpeg">,
  params: ResizeToPngParams,
): Promise<Buffer> {
  const tool = resolveImageTool(backend);
  if (!tool || tool.flavor === "ffmpeg" || tool.flavor === "sips") {
    throw new Error(`Image backend ${backend} is not available`);
  }
  if (tool.flavor === "powershell") {
    return await windowsNativeResize(params, "png");
  }
  return await withImageTemp(async (workspace) => {
    const input = await workspace.write("in.img", params.buffer);
    const output = workspace.path("out.png");
    const args = [
      input,
      "-auto-orient",
      "-resize",
      buildResizeGeometry(params.maxSide, params.withoutEnlargement),
    ];
    const compressionLevel = params.compressionLevel;
    if (compressionLevel !== undefined && tool.flavor !== "gm") {
      args.push("-define", `png:compression-level=${clampInteger(compressionLevel, 0, 9)}`);
    }
    args.push(output);
    await runConvertTool(tool, args);
    return await workspace.read("out.png");
  });
}

async function sipsResizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
}): Promise<Buffer> {
  return await withImageTemp(async (workspace) => {
    const input = await workspace.write("in.img", params.buffer);
    const output = workspace.path("out.jpg");
    await runExec(
      "/usr/bin/sips",
      [
        "-Z",
        String(Math.max(1, Math.round(params.maxSide))),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(Math.max(1, Math.min(100, Math.round(params.quality)))),
        input,
        "--out",
        output,
      ],
      { timeoutMs: IMAGE_PROCESS_TIMEOUT_MS, maxBuffer: IMAGE_TOOL_MAX_BUFFER },
    );
    return await workspace.read("out.jpg");
  });
}

async function sipsConvertToJpeg(buffer: Buffer): Promise<Buffer> {
  return await withImageTemp(async (workspace) => {
    const input = await workspace.write("in.heic", buffer);
    const output = workspace.path("out.jpg");
    await runExec("/usr/bin/sips", ["-s", "format", "jpeg", input, "--out", output], {
      timeoutMs: IMAGE_PROCESS_TIMEOUT_MS,
      maxBuffer: IMAGE_TOOL_MAX_BUFFER,
    });
    return await workspace.read("out.jpg");
  });
}

export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  const metadataForLimit = await readImageMetadataForLimit(buffer).catch(() => null);
  if (metadataForLimit) {
    try {
      return validateImagePixelLimit(metadataForLimit);
    } catch {
      return null;
    }
  }

  const preference = getImageBackendPreference();
  if (preference !== "auto" && preference !== "sharp") {
    return null;
  }

  return await (async () => {
    const meta = await (await loadMediaAttachmentImageOps()).getImageMetadata(buffer);
    return meta ? validateImagePixelLimit(meta) : null;
  })().catch(() => null);
}

/**
 * Applies rotation/flip to image buffer using sips based on EXIF orientation.
 */
async function sipsApplyOrientation(buffer: Buffer, orientation: number): Promise<Buffer> {
  // Map EXIF orientation to sips operations
  // sips -r rotates clockwise, -f flips (horizontal/vertical)
  const ops: string[] = [];
  switch (orientation) {
    case 2: // Flip horizontal
      ops.push("-f", "horizontal");
      break;
    case 3: // Rotate 180
      ops.push("-r", "180");
      break;
    case 4: // Flip vertical
      ops.push("-f", "vertical");
      break;
    case 5: // Rotate 270 CW + flip horizontal
      ops.push("-r", "270", "-f", "horizontal");
      break;
    case 6: // Rotate 90 CW
      ops.push("-r", "90");
      break;
    case 7: // Rotate 90 CW + flip horizontal
      ops.push("-r", "90", "-f", "horizontal");
      break;
    case 8: // Rotate 270 CW
      ops.push("-r", "270");
      break;
    default:
      // Orientation 1 or unknown - no change needed
      return buffer;
  }

  return await withImageTemp(async (workspace) => {
    const input = await workspace.write("in.jpg", buffer);
    const output = workspace.path("out.jpg");
    await runExec("/usr/bin/sips", [...ops, input, "--out", output], {
      timeoutMs: IMAGE_PROCESS_TIMEOUT_MS,
      maxBuffer: IMAGE_TOOL_MAX_BUFFER,
    });
    return await workspace.read("out.jpg");
  });
}

/**
 * Normalizes EXIF orientation in an image buffer.
 * Returns the buffer with correct pixel orientation (rotated if needed).
 * Falls back to original buffer if normalization fails.
 */
export async function normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
  await assertImagePixelLimit(buffer);

  for (const backend of imageBackendsForOperation("normalizeExifOrientation")) {
    try {
      if (backend === "sharp") {
        const ops = await loadMediaAttachmentImageOps();
        return await ops.normalizeExifOrientation(buffer);
      }
      if (backend !== "ffmpeg") {
        assertKnownImagePixelLimitBeforeExternalFallback(buffer);
        return await externalNormalizeExifOrientation(backend, buffer);
      }
    } catch {
      // Orientation normalization is best-effort; resizing still handles raw buffers.
    }
  }

  return buffer;
}

export async function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
  await assertImagePixelLimit(params.buffer);
  return await runWithImageBackends("resizeToJpeg", async (backend) => {
    if (backend === "sharp") {
      return await (await loadMediaAttachmentImageOps()).resizeToJpeg(params);
    }
    assertKnownImagePixelLimitBeforeExternalFallback(params.buffer);
    return await externalResizeToJpeg(backend, params);
  });
}

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  await assertImagePixelLimit(buffer);
  return await runWithImageBackends("convertHeicToJpeg", async (backend) => {
    if (backend === "sharp") {
      return await (await loadMediaAttachmentImageOps()).convertHeicToJpeg(buffer);
    }
    assertKnownImagePixelLimitBeforeExternalFallback(buffer);
    return await externalConvertToJpeg(backend, buffer);
  });
}

/**
 * Checks if an image has an alpha channel (transparency).
 * Returns true if the image has alpha, false otherwise.
 */
export async function hasAlphaChannel(buffer: Buffer): Promise<boolean> {
  await assertImagePixelLimit(buffer);

  const pngAlphaChannel = readPngAlphaChannel(buffer);
  if (pngAlphaChannel !== null) {
    return pngAlphaChannel;
  }

  try {
    const ops = await loadMediaAttachmentImageOps();
    return await ops.hasAlphaChannel(buffer);
  } catch {
    return false;
  }
}

/**
 * Resizes an image to PNG format, preserving alpha channel (transparency).
 * Falls back to the media attachments plugin only (no sips fallback for PNG with alpha).
 */
export async function resizeToPng(params: ResizeToPngParams): Promise<Buffer> {
  await assertImagePixelLimit(params.buffer);
  return await runWithImageBackends("resizeToPng", async (backend) => {
    if (backend === "sharp") {
      return await (await loadMediaAttachmentImageOps()).resizeToPng(params);
    }
    if (backend === "windows-native" || backend === "imagemagick" || backend === "graphicsmagick") {
      assertKnownImagePixelLimitBeforeExternalFallback(params.buffer);
      return await externalResizeToPng(backend, params);
    }
    throw new Error(`Image backend ${backend} is not available for PNG resizing`);
  });
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
  // Try a grid of sizes/compression levels until under the limit.
  // PNG uses compression levels 0-9 (higher = smaller but slower).
  const sides = options?.sides?.length ? [...options.sides] : [2048, 1536, 1280, 1024, 800];
  const compressionLevels = [6, 7, 8, 9];
  let smallest: {
    buffer: Buffer;
    size: number;
    resizeSide: number;
    compressionLevel: number;
  } | null = null;
  let firstResizeError: unknown;

  for (const side of sides) {
    for (const compressionLevel of compressionLevels) {
      try {
        const out = await resizeToPng({
          buffer,
          maxSide: side,
          compressionLevel,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size, resizeSide: side, compressionLevel };
        }
        if (size <= maxBytes) {
          return {
            buffer: out,
            optimizedSize: size,
            resizeSide: side,
            compressionLevel,
          };
        }
      } catch (err) {
        firstResizeError ??= err;
        // Continue trying other size/compression combinations.
      }
    }
  }

  if (smallest) {
    return {
      buffer: smallest.buffer,
      optimizedSize: smallest.size,
      resizeSide: smallest.resizeSide,
      compressionLevel: smallest.compressionLevel,
    };
  }

  if (firstResizeError) {
    throw firstResizeError;
  }

  throw new Error("Failed to optimize PNG image");
}

/**
 * Internal sips-only EXIF normalization (no sharp fallback).
 * Used by resizeToJpeg to normalize before sips resize.
 */
async function normalizeExifOrientationSips(buffer: Buffer): Promise<Buffer> {
  try {
    const orientation = readJpegExifOrientation(buffer);
    if (!orientation || orientation === 1) {
      return buffer;
    }
    return await sipsApplyOrientation(buffer, orientation);
  } catch {
    return buffer;
  }
}
