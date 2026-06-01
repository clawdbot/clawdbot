import { maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime } from "@openclaw/media-core/mime";
import { readResponseWithLimit } from "@openclaw/media-core/read-response-with-limit";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { fetchProviderDownloadResponse } from "../media-understanding/shared.js";
import type { GeneratedMusicAsset } from "./types.js";

export type GeneratedMusicFileCandidate = {
  url: string;
  mimeType?: string;
  fileName?: string;
};

function normalizeSpecificAudioMimeType(value: unknown): string | undefined {
  const mimeType = normalizeOptionalString(value)?.split(";")[0]?.trim().toLowerCase();
  if (!mimeType || mimeType === "application/octet-stream" || mimeType === "binary/octet-stream") {
    return undefined;
  }
  return mimeType;
}

function pushGeneratedMusicFileCandidate(
  candidates: GeneratedMusicFileCandidate[],
  value: unknown,
): void {
  if (typeof value === "string") {
    const url = normalizeOptionalString(value);
    if (url) {
      candidates.push({ url });
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const url = normalizeOptionalString(value.url);
  if (!url) {
    return;
  }
  candidates.push({
    url,
    ...(normalizeOptionalString(value.content_type)
      ? { mimeType: normalizeOptionalString(value.content_type) }
      : {}),
    ...(normalizeOptionalString(value.file_name)
      ? { fileName: normalizeOptionalString(value.file_name) }
      : {}),
  });
}

export function extractGeneratedMusicFileCandidates(
  payload: unknown,
  keys: readonly string[] = ["audio", "audio_file"],
): GeneratedMusicFileCandidate[] {
  if (!isRecord(payload)) {
    return [];
  }
  const candidates: GeneratedMusicFileCandidate[] = [];
  for (const key of keys) {
    pushGeneratedMusicFileCandidate(candidates, payload[key]);
  }
  return candidates;
}

export function generatedMusicAssetFromBase64(params: {
  base64: string;
  mimeType: string;
  index?: number;
  fileName?: string;
}): GeneratedMusicAsset {
  const ext = extensionForMime(params.mimeType)?.replace(/^\./u, "") || "mp3";
  return {
    buffer: Buffer.from(params.base64, "base64"),
    mimeType: params.mimeType,
    fileName: params.fileName ?? `track-${(params.index ?? 0) + 1}.${ext}`,
  };
}

export async function downloadGeneratedMusicAsset(params: {
  candidate: GeneratedMusicFileCandidate;
  timeoutMs: number;
  fetchFn: typeof fetch;
  provider: string;
  requestFailedMessage: string;
  index?: number;
  maxBytes?: number;
}): Promise<GeneratedMusicAsset> {
  const response = await fetchProviderDownloadResponse({
    url: params.candidate.url,
    init: { method: "GET" },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    provider: params.provider,
    requestFailedMessage: params.requestFailedMessage,
  });
  const mimeType =
    normalizeSpecificAudioMimeType(response.headers.get("content-type")) ??
    normalizeSpecificAudioMimeType(params.candidate.mimeType) ??
    "audio/mpeg";
  const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
  const maxBytes = params.maxBytes ?? maxBytesForKind("audio");
  return {
    buffer: await readResponseWithLimit(response, maxBytes, {
      onOverflow: ({ maxBytes: maxBytesLocal }) =>
        new Error(`${params.provider} generated music download exceeds ${maxBytesLocal} bytes`),
    }),
    mimeType,
    fileName: params.candidate.fileName ?? `track-${(params.index ?? 0) + 1}.${ext}`,
    metadata: {
      url: params.candidate.url,
    },
  };
}
