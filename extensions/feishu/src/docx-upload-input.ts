import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import {
  canonicalizeBase64,
  estimateBase64DecodedBytes,
  extensionForMime,
} from "openclaw/plugin-sdk/media-runtime";
import { getFeishuRuntime } from "./runtime.js";

type DocxUploadInput = {
  url?: string;
  filePath?: string;
  image?: string;
  maxBytes: number;
  localRoots?: readonly string[];
  fileName?: string;
  remoteReadTimeoutMs?: number;
};

function decodeBase64Image(params: {
  payload: string;
  maxBytes: number;
  invalidMessage: string;
  oversizedLabel: string;
}): Buffer {
  const estimatedBytes = estimateBase64DecodedBytes(params.payload);
  if (estimatedBytes > params.maxBytes) {
    throw new Error(
      `${params.oversizedLabel} exceeds limit: estimated ${estimatedBytes} bytes > ${params.maxBytes} bytes`,
    );
  }
  const canonical = canonicalizeBase64(params.payload);
  if (!canonical) {
    throw new Error(params.invalidMessage);
  }
  return Buffer.from(canonical, "base64");
}

function resolveDataUriImage(image: string, maxBytes: number, fileName?: string) {
  const commaIndex = image.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid data URI: missing comma separator.");
  }
  const metadata = image.slice("data:".length, commaIndex).split(";");
  const encoding = metadata.slice(1).map((value) => value.trim().toLowerCase());
  if (!encoding.includes("base64")) {
    throw new Error(
      "Invalid data URI: missing ';base64' marker. Expected format: data:image/png;base64,<base64data>",
    );
  }
  const buffer = decodeBase64Image({
    payload: image.slice(commaIndex + 1),
    maxBytes,
    invalidMessage: "Invalid data URI: base64 payload is malformed.",
    oversizedLabel: "Image data URI",
  });
  const mime = metadata[0]?.trim();
  const extension = extensionForMime(mime)?.slice(1) ?? "png";
  return { buffer, fileName: fileName ?? `image.${extension}` };
}

async function resolveLocalUpload(
  filePath: string,
  maxBytes: number,
  localRoots: readonly string[] | undefined,
  fileName: string | undefined,
) {
  const loaded = await getFeishuRuntime().media.loadWebMedia(resolve(filePath), {
    maxBytes,
    optimizeImages: false,
    localRoots,
  });
  return { buffer: loaded.buffer, fileName: fileName ?? basename(filePath) };
}

function resolveImageLocalPath(image: string): string | undefined {
  const candidate = image.startsWith("~") ? `${homedir()}${image.slice(1)}` : image;
  const unambiguousPath =
    image.startsWith("~") || image.startsWith("./") || image.startsWith("../");
  const absolutePath = isAbsolute(image);

  if (unambiguousPath || (absolutePath && existsSync(candidate))) {
    return candidate;
  }
  if (absolutePath) {
    throw new Error(
      `File not found: "${candidate}". If you intended to pass image binary data, use a data URI instead: data:image/jpeg;base64,...`,
    );
  }
  return undefined;
}

async function resolveRemoteUpload(input: DocxUploadInput & { url: string }) {
  const fetched = await getFeishuRuntime().channel.media.readRemoteMediaBuffer({
    url: input.url,
    maxBytes: input.maxBytes,
    ...(input.remoteReadTimeoutMs !== undefined
      ? {
          responseHeaderTimeoutMs: input.remoteReadTimeoutMs,
          readIdleTimeoutMs: input.remoteReadTimeoutMs,
        }
      : {}),
  });
  const urlPath = new URL(input.url).pathname;
  const urlFileName = urlPath.split("/").pop() || "upload.bin";
  return {
    buffer: fetched.buffer,
    fileName: input.fileName ?? fetched.fileName ?? urlFileName,
  };
}

export async function resolveDocxUploadInput(
  input: DocxUploadInput,
): Promise<{ buffer: Buffer; fileName: string }> {
  const sources = [
    input.url && "url",
    input.filePath && "file_path",
    input.image && "image",
  ].filter((source): source is string => Boolean(source));
  if (sources.length !== 1) {
    throw new Error(
      sources.length === 0
        ? "Either url, file_path, or image (base64/data URI) must be provided"
        : `Provide only one upload source; got: ${sources.join(", ")}`,
    );
  }

  if (input.url) {
    return await resolveRemoteUpload({ ...input, url: input.url });
  }
  if (input.filePath) {
    return await resolveLocalUpload(
      input.filePath,
      input.maxBytes,
      input.localRoots,
      input.fileName,
    );
  }

  const image = input.image;
  if (!image) {
    throw new Error("Image input must not be empty");
  }
  if (image.startsWith("data:")) {
    return resolveDataUriImage(image, input.maxBytes, input.fileName);
  }
  const localPath = resolveImageLocalPath(image);
  if (localPath) {
    return await resolveLocalUpload(localPath, input.maxBytes, input.localRoots, input.fileName);
  }

  const buffer = decodeBase64Image({
    payload: image,
    maxBytes: input.maxBytes,
    invalidMessage:
      "Invalid base64: image input is malformed. Use a data URI (data:image/png;base64,...) or a local file path instead.",
    oversizedLabel: "Base64 image",
  });
  return { buffer, fileName: input.fileName ?? "image.png" };
}
