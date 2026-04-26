import type { ImageMetadata } from "openclaw/plugin-sdk/media-runtime";
import type sharpImport from "sharp";

type SharpFactory = typeof sharpImport;

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

type MediaUnderstandingImageOpsOptions = {
  maxInputPixels: number;
};

const SHARP_MODULE = "sharp";

let sharpFactoryPromise: Promise<SharpFactory> | null = null;

function normalizeSharpFactory(mod: unknown): SharpFactory {
  const candidates = [
    (mod as { default?: unknown }).default,
    ((mod as { default?: { default?: unknown } }).default ?? {})?.default,
    mod,
  ];
  const sharp = candidates.find(
    (candidate): candidate is SharpFactory => typeof candidate === "function",
  );
  if (!sharp) {
    throw new Error("Optional dependency sharp did not expose an image processor");
  }
  return sharp;
}

async function loadSharp(maxInputPixels: number): Promise<SharpFactory> {
  if (!sharpFactoryPromise) {
    sharpFactoryPromise = import(SHARP_MODULE)
      .then((mod) => {
        const sharp = normalizeSharpFactory(mod);
        return ((buffer, options) =>
          sharp(buffer, {
            ...options,
            failOnError: false,
            limitInputPixels: maxInputPixels,
          })) as SharpFactory;
      })
      .catch((err) => {
        sharpFactoryPromise = null;
        throw new Error("Optional dependency sharp is required for image attachment processing", {
          cause: err,
        });
      });
  }
  return await sharpFactoryPromise;
}

function normalizeMaxInputPixels(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Media attachment image ops require a positive maxInputPixels budget");
  }
  return value;
}

function normalizeMetadata(meta: { width?: number; height?: number }): ImageMetadata | null {
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export function createMediaAttachmentImageOps(options: MediaUnderstandingImageOpsOptions) {
  const maxInputPixels = normalizeMaxInputPixels(options.maxInputPixels);
  return {
    async getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
      const sharp = await loadSharp(maxInputPixels);
      return normalizeMetadata(await sharp(buffer).metadata());
    },

    async normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
      const sharp = await loadSharp(maxInputPixels);
      return await sharp(buffer).rotate().toBuffer();
    },

    async resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
      const sharp = await loadSharp(maxInputPixels);
      return await sharp(params.buffer)
        .rotate()
        .resize({
          width: params.maxSide,
          height: params.maxSide,
          fit: "inside",
          withoutEnlargement: params.withoutEnlargement !== false,
        })
        .jpeg({ quality: params.quality, mozjpeg: true })
        .toBuffer();
    },

    async convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
      const sharp = await loadSharp(maxInputPixels);
      return await sharp(buffer).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    },

    async hasAlphaChannel(buffer: Buffer): Promise<boolean> {
      const sharp = await loadSharp(maxInputPixels);
      const meta = await sharp(buffer).metadata();
      return meta.hasAlpha || meta.channels === 4;
    },

    async resizeToPng(params: ResizeToPngParams): Promise<Buffer> {
      const sharp = await loadSharp(maxInputPixels);
      const compressionLevel = params.compressionLevel ?? 6;
      return await sharp(params.buffer)
        .rotate()
        .resize({
          width: params.maxSide,
          height: params.maxSide,
          fit: "inside",
          withoutEnlargement: params.withoutEnlargement !== false,
        })
        .png({ compressionLevel })
        .toBuffer();
    },
  };
}
