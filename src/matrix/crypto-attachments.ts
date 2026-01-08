import {
  Attachment,
  EncryptedAttachment,
  initAsync,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import type { EncryptedFile } from "matrix-js-sdk/lib/@types/media.js";

type MediaEncryptionInfo = Omit<EncryptedFile, "url">;

let wasmReady: Promise<void> | null = null;

async function ensureCryptoWasmReady(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initAsync();
  }
  await wasmReady;
}

function parseMediaEncryptionInfo(infoJson: string): MediaEncryptionInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(infoJson);
  } catch {
    throw new Error("Matrix media encryption info is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Matrix media encryption info is missing");
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.iv !== "string" ||
    typeof value.v !== "string" ||
    typeof value.key !== "object" ||
    value.key === null ||
    typeof value.hashes !== "object" ||
    value.hashes === null
  ) {
    throw new Error("Matrix media encryption info is incomplete");
  }
  return value as MediaEncryptionInfo;
}

export async function encryptMatrixAttachment(
  buffer: Uint8Array,
): Promise<{ encrypted: Uint8Array; info: MediaEncryptionInfo }> {
  await ensureCryptoWasmReady();
  const encrypted = Attachment.encrypt(buffer);
  const infoJson = encrypted.mediaEncryptionInfo;
  if (!infoJson) {
    throw new Error("Matrix media encryption info missing");
  }
  return {
    encrypted: encrypted.encryptedData,
    info: parseMediaEncryptionInfo(infoJson),
  };
}

export async function decryptMatrixAttachment(params: {
  encrypted: Uint8Array;
  file: EncryptedFile;
}): Promise<Uint8Array> {
  await ensureCryptoWasmReady();
  const { url: _url, ...info } = params.file;
  const attachment = new EncryptedAttachment(
    params.encrypted,
    JSON.stringify(info),
  );
  return Attachment.decrypt(attachment);
}
