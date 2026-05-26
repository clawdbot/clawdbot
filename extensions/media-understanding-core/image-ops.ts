import { deflateSync, inflateSync } from "node:zlib";
import type { ImageMetadata } from "openclaw/plugin-sdk/media-runtime";

type PhotonModule = typeof import("@silvia-odwyer/photon-node");
type PhotonImage = InstanceType<PhotonModule["PhotonImage"]>;

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

let photonPromise: Promise<PhotonModule> | null = null;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

async function loadPhoton(): Promise<PhotonModule> {
  photonPromise ??= import("@silvia-odwyer/photon-node").then((mod) => {
    if (
      typeof mod.PhotonImage?.new_from_byteslice !== "function" ||
      typeof mod.resize !== "function" ||
      mod.SamplingFilter?.Lanczos3 === undefined
    ) {
      throw new Error("Photon did not expose the required image processor API");
    }
    return mod;
  });
  return await photonPromise;
}

function normalizeMaxInputPixels(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Media attachment image ops require a positive maxInputPixels budget");
  }
  return value;
}

function normalizeMetadata(width: number, height: number): ImageMetadata | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function readPngMetadata(buffer: Buffer): ImageMetadata | null {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return normalizeMetadata(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function readGifMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 10) {
    return null;
  }
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return null;
  }
  return normalizeMetadata(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
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
    return normalizeMetadata(1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3));
  }
  if (chunkType === "VP8 ") {
    return normalizeMetadata(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  }
  if (chunkType === "VP8L") {
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      return null;
    }
    const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
    return normalizeMetadata((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

function readJpegMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      return null;
    }

    const marker = buffer[offset];
    offset += 1;
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
      return normalizeMetadata(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }

    offset += segmentLength;
  }

  return null;
}

function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return (
    readPngMetadata(buffer) ??
    readGifMetadata(buffer) ??
    readWebpMetadata(buffer) ??
    readJpegMetadata(buffer)
  );
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePngRgba(
  pixels: Uint8Array,
  width: number,
  height: number,
  compressionLevel = 6,
): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const source = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0;
    source.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk(
      "IDAT",
      deflateSync(raw, { level: Math.max(0, Math.min(9, Math.round(compressionLevel))) }),
    ),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
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

function decodeGrayscaleAlphaPng(buffer: Buffer): {
  pixels: Uint8Array;
  width: number;
  height: number;
} | null {
  if (buffer.length < 33 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let width = 0;
  let height = 0;
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
      if (
        length !== 13 ||
        data[8] !== 8 ||
        data[9] !== 4 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        return null;
      }
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  const metadata = normalizeMetadata(width, height);
  if (!metadata || idatChunks.length === 0) {
    return null;
  }

  const expectedInflatedLength = (width * 2 + 1) * height;
  const grayAlpha = unfilterPngScanlines(
    inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedInflatedLength }),
    width,
    height,
    2,
  );
  if (!grayAlpha) {
    return null;
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < grayAlpha.length; source += 2, target += 4) {
    const gray = grayAlpha[source] ?? 0;
    pixels[target] = gray;
    pixels[target + 1] = gray;
    pixels[target + 2] = gray;
    pixels[target + 3] = grayAlpha[source + 1] ?? 255;
  }
  return { pixels, width, height };
}

function assertDecodedPixelBudget(image: PhotonImage, maxInputPixels: number): void {
  const width = image.get_width();
  const height = image.get_height();
  if (width > Math.floor(maxInputPixels / height)) {
    throw new Error(
      `Image dimensions exceed the ${maxInputPixels.toLocaleString("en-US")} pixel input limit: ${width}x${height}`,
    );
  }
}

function assertHeaderPixelBudget(buffer: Buffer, maxInputPixels: number): void {
  const meta = readImageMetadataFromHeader(buffer);
  if (!meta) {
    throw new Error("Unable to determine image dimensions; refusing to process");
  }
  if (meta.width > Math.floor(maxInputPixels / meta.height)) {
    throw new Error(
      `Image dimensions exceed the ${maxInputPixels.toLocaleString("en-US")} pixel input limit: ${meta.width}x${meta.height}`,
    );
  }
}

function readJpegExifOrientation(buffer: Buffer): number | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      return null;
    }
    if (offset + 4 > buffer.length) {
      return null;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      return null;
    }
    if (
      marker === 0xe1 &&
      segmentLength >= 14 &&
      buffer.toString("ascii", offset + 4, offset + 8) === "Exif" &&
      buffer[offset + 8] === 0 &&
      buffer[offset + 9] === 0
    ) {
      return readExifOrientationFromTiff(buffer, offset + 10, offset + 2 + segmentLength);
    }
    offset += 2 + segmentLength;
  }

  return null;
}

function readExifOrientationFromTiff(
  buffer: Buffer,
  tiffStart: number,
  tiffEnd: number,
): number | null {
  if (tiffStart + 8 > tiffEnd) {
    return null;
  }
  const byteOrder = buffer.toString("ascii", tiffStart, tiffStart + 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") {
    return null;
  }
  const readU16 = (offset: number) =>
    littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const readU32 = (offset: number) =>
    littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  if (readU16(tiffStart + 2) !== 42) {
    return null;
  }
  const ifd0Start = tiffStart + readU32(tiffStart + 4);
  if (ifd0Start + 2 > tiffEnd) {
    return null;
  }
  const entries = readU16(ifd0Start);
  for (let index = 0; index < entries; index += 1) {
    const entryOffset = ifd0Start + 2 + index * 12;
    if (entryOffset + 12 > tiffEnd) {
      return null;
    }
    if (readU16(entryOffset) === 0x0112) {
      const orientation = readU16(entryOffset + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : null;
    }
  }
  return null;
}

function transformOrientation(
  rawPixels: Uint8Array,
  width: number,
  height: number,
  orientation: number,
): { pixels: Uint8Array; width: number; height: number } {
  if (orientation === 1) {
    return { pixels: rawPixels, width, height };
  }

  const swapsAxes =
    orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
  const outputWidth = swapsAxes ? height : width;
  const outputHeight = swapsAxes ? width : height;
  const out = new Uint8Array(outputWidth * outputHeight * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let targetX = x;
      let targetY = y;
      switch (orientation) {
        case 2:
          targetX = width - 1 - x;
          break;
        case 3:
          targetX = width - 1 - x;
          targetY = height - 1 - y;
          break;
        case 4:
          targetY = height - 1 - y;
          break;
        case 5:
          targetX = y;
          targetY = x;
          break;
        case 6:
          targetX = height - 1 - y;
          targetY = x;
          break;
        case 7:
          targetX = height - 1 - y;
          targetY = width - 1 - x;
          break;
        case 8:
          targetX = y;
          targetY = width - 1 - x;
          break;
      }

      const sourceOffset = (y * width + x) * 4;
      const targetOffset = (targetY * outputWidth + targetX) * 4;
      out[targetOffset] = rawPixels[sourceOffset] ?? 0;
      out[targetOffset + 1] = rawPixels[sourceOffset + 1] ?? 0;
      out[targetOffset + 2] = rawPixels[sourceOffset + 2] ?? 0;
      out[targetOffset + 3] = rawPixels[sourceOffset + 3] ?? 255;
    }
  }

  return { pixels: out, width: outputWidth, height: outputHeight };
}

function applyExifOrientation(
  photon: PhotonModule,
  image: PhotonImage,
  buffer: Buffer,
): PhotonImage {
  const orientation = readJpegExifOrientation(buffer);
  if (!orientation || orientation === 1) {
    return image;
  }

  const transformed = transformOrientation(
    image.get_raw_pixels(),
    image.get_width(),
    image.get_height(),
    orientation,
  );
  image.free();
  return new photon.PhotonImage(transformed.pixels, transformed.width, transformed.height);
}

function targetSize(
  image: PhotonImage,
  maxSide: number,
  withoutEnlargement: boolean,
): { width: number; height: number } {
  const width = image.get_width();
  const height = image.get_height();
  const maxDimension = Math.max(width, height);
  if (maxDimension <= 0) {
    throw new Error("Invalid image dimensions");
  }
  const requestedScale = maxSide / maxDimension;
  const scale = withoutEnlargement ? Math.min(1, requestedScale) : requestedScale;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function resizeImage(
  photon: PhotonModule,
  image: PhotonImage,
  params: ResizeToJpegParams | ResizeToPngParams,
): PhotonImage {
  const size = targetSize(image, params.maxSide, params.withoutEnlargement !== false);
  if (size.width === image.get_width() && size.height === image.get_height()) {
    return image;
  }
  const resized = photon.resize(image, size.width, size.height, photon.SamplingFilter.Lanczos3);
  image.free();
  return resized;
}

async function loadOrientedPhotonImage(
  buffer: Buffer,
  maxInputPixels: number,
): Promise<{ photon: PhotonModule; image: PhotonImage }> {
  assertHeaderPixelBudget(buffer, maxInputPixels);
  const photon = await loadPhoton();
  let decoded: PhotonImage;
  try {
    decoded = photon.PhotonImage.new_from_byteslice(buffer);
  } catch (err) {
    const grayscaleAlpha = decodeGrayscaleAlphaPng(buffer);
    if (!grayscaleAlpha) {
      throw err;
    }
    decoded = new photon.PhotonImage(
      grayscaleAlpha.pixels,
      grayscaleAlpha.width,
      grayscaleAlpha.height,
    );
  }
  assertDecodedPixelBudget(decoded, maxInputPixels);
  return { photon, image: applyExifOrientation(photon, decoded, buffer) };
}

export function createMediaAttachmentImageOps(options: MediaUnderstandingImageOpsOptions) {
  const maxInputPixels = normalizeMaxInputPixels(options.maxInputPixels);
  return {
    async getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
      const { image } = await loadOrientedPhotonImage(buffer, maxInputPixels);
      try {
        return normalizeMetadata(image.get_width(), image.get_height());
      } finally {
        image.free();
      }
    },

    async normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
      const orientation = readJpegExifOrientation(buffer);
      if (!orientation || orientation === 1) {
        return buffer;
      }

      const { image } = await loadOrientedPhotonImage(buffer, maxInputPixels);
      try {
        return Buffer.from(image.get_bytes_jpeg(90));
      } finally {
        image.free();
      }
    },

    async resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
      const { photon, image } = await loadOrientedPhotonImage(params.buffer, maxInputPixels);
      const resized = resizeImage(photon, image, params);
      try {
        return Buffer.from(resized.get_bytes_jpeg(params.quality));
      } finally {
        resized.free();
      }
    },

    async convertHeicToJpeg(_buffer: Buffer): Promise<Buffer> {
      throw new Error("Photon does not support HEIC/AVIF conversion");
    },

    async hasAlphaChannel(buffer: Buffer): Promise<boolean> {
      const { image } = await loadOrientedPhotonImage(buffer, maxInputPixels);
      try {
        const pixels = image.get_raw_pixels();
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if ((pixels[offset] ?? 255) < 255) {
            return true;
          }
        }
        return false;
      } finally {
        image.free();
      }
    },

    async resizeToPng(params: ResizeToPngParams): Promise<Buffer> {
      const { photon, image } = await loadOrientedPhotonImage(params.buffer, maxInputPixels);
      const resized = resizeImage(photon, image, params);
      try {
        return encodePngRgba(
          resized.get_raw_pixels(),
          resized.get_width(),
          resized.get_height(),
          params.compressionLevel,
        );
      } finally {
        resized.free();
      }
    },
  };
}
