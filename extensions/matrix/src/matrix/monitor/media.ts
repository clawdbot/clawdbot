// Matrix plugin module implements media behavior.
import { getMatrixRuntime } from "../../runtime.js";
import { MatrixMediaSizeLimitError, isMatrixMediaSizeLimitError } from "../media-errors.js";
import type { EncryptedFile, MatrixClient } from "../sdk.js";

const MATRIX_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

async function fetchMatrixMediaBuffer(params: {
  client: MatrixClient;
  mxcUrl: string;
  maxBytes: number;
}): Promise<{ buffer: Buffer } | null> {
  try {
    const buffer = await params.client.downloadContent(params.mxcUrl, {
      maxBytes: params.maxBytes,
      readIdleTimeoutMs: MATRIX_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
    });
    return { buffer };
  } catch (err) {
    if (isMatrixMediaSizeLimitError(err)) {
      throw err;
    }
    throw new Error(`Matrix media download failed: ${String(err)}`, { cause: err });
  }
}

/**
 * Download and decrypt encrypted media from a Matrix room.
 * Uses the Matrix crypto adapter's decryptMedia helper.
 */
async function fetchEncryptedMediaBuffer(params: {
  client: MatrixClient;
  file: EncryptedFile;
  maxBytes: number;
}): Promise<{ buffer: Buffer } | null> {
  if (!params.client.crypto) {
    throw new Error("Cannot decrypt media: crypto not enabled");
  }

  const decrypted = await params.client.crypto.decryptMedia(params.file, {
    maxBytes: params.maxBytes,
    readIdleTimeoutMs: MATRIX_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
  });

  if (decrypted.byteLength > params.maxBytes) {
    throw new MatrixMediaSizeLimitError();
  }

  return { buffer: decrypted };
}

export async function downloadMatrixMedia(params: {
  client: MatrixClient;
  mxcUrl: string;
  contentType?: string;
  sizeBytes?: number;
  maxBytes: number;
  file?: EncryptedFile;
  originalFilename?: string;
}): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
} | null> {
  let fetched: { buffer: Buffer; headerType?: string } | null;
  if (typeof params.sizeBytes === "number" && params.sizeBytes > params.maxBytes) {
    throw new MatrixMediaSizeLimitError();
  }

  if (params.file) {
    // Encrypted media
    fetched = await fetchEncryptedMediaBuffer({
      client: params.client,
      file: params.file,
      maxBytes: params.maxBytes,
    });
  } else {
    // Unencrypted media
    fetched = await fetchMatrixMediaBuffer({
      client: params.client,
      mxcUrl: params.mxcUrl,
      maxBytes: params.maxBytes,
    });
  }

  if (!fetched) {
    return null;
  }
  const headerType = params.contentType ?? undefined;
  const saved = await getMatrixRuntime().channel.media.saveMediaBuffer(
    fetched.buffer,
    headerType,
    "inbound",
    params.maxBytes,
    params.originalFilename,
  );
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: "[matrix media]",
  };
}
