// Validates and normalizes provider asset attachments for music generation.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readProviderBinaryResponse } from "../agents/provider-http-errors.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchProviderDownloadResponse,
  type ProviderOperationDeadline,
} from "../media-understanding/shared.js";
import type { GeneratedMusicAsset } from "./types.js";

type GeneratedMusicResponseHandle = {
  response: Response;
  release?: () => Promise<void>;
  mimeType?: string;
};

type GeneratedMusicResponseFactory = (params: {
  deadline: ProviderOperationDeadline;
  timeoutMs: () => number;
}) => Promise<GeneratedMusicResponseHandle>;

/**
 * Asset extraction and download helpers for music generation providers.
 *
 * Providers may return audio as URLs, file objects, or base64 payloads; these
 * helpers normalize those shapes into bounded in-memory GeneratedMusicAsset values.
 */
/** Candidate audio file returned by a provider before download. */
export type GeneratedMusicFileCandidate = {
  url: string;
  mimeType?: string;
  fileName?: string;
};

function normalizeSpecificAudioMimeType(value: unknown): string | undefined {
  const mimeType = normalizeOptionalString(value)?.split(";")[0]?.trim().toLowerCase();
  // Generic binary types are less useful than known audio fallbacks for saved track names.
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

/** Extract URL/file candidates from common provider response keys. */
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

/** Convert a base64 provider payload into a generated music asset. */
export function generatedMusicAssetFromBase64(params: {
  base64: string;
  mimeType: string;
  index?: number;
  fileName?: string;
}): GeneratedMusicAsset {
  const canonicalAudio = canonicalizeBase64(params.base64);
  if (!canonicalAudio) {
    throw new Error("Generated music asset contains malformed base64 audio data");
  }
  const ext = extensionForMime(params.mimeType)?.replace(/^\./u, "") || "mp3";
  return {
    buffer: Buffer.from(canonicalAudio, "base64"),
    mimeType: params.mimeType,
    fileName: params.fileName ?? `track-${(params.index ?? 0) + 1}.${ext}`,
  };
}

/** Download a generated music URL with size limits and inferred audio metadata. */
export async function downloadGeneratedMusicAsset(params: {
  candidate: GeneratedMusicFileCandidate;
  timeoutMs: number;
  fetchFn: typeof fetch;
  provider: string;
  requestFailedMessage: string;
  index?: number;
  maxBytes?: number;
  validateBinaryResponse?: boolean;
  includeSourceUrl?: boolean;
  fetchResponse?: GeneratedMusicResponseFactory;
}): Promise<GeneratedMusicAsset> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `${params.provider} generated music download`,
  });
  const timeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: params.timeoutMs,
  });
  const handle = params.fetchResponse
    ? await params.fetchResponse({ deadline, timeoutMs })
    : {
        response: await fetchProviderDownloadResponse({
          url: params.candidate.url,
          init: { method: "GET" },
          deadline,
          fetchFn: params.fetchFn,
          provider: params.provider,
          requestFailedMessage: params.requestFailedMessage,
        }),
      };
  try {
    const mimeType =
      handle.mimeType ??
      normalizeSpecificAudioMimeType(handle.response.headers.get("content-type")) ??
      normalizeSpecificAudioMimeType(params.candidate.mimeType) ??
      "audio/mpeg";
    const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
    const maxBytes = params.maxBytes ?? maxBytesForKind("audio");
    const readOptions = {
      maxBytes,
      timeoutMs,
      onTimeout: ({ timeoutMs: bodyTimeoutMs }: { timeoutMs: number }) =>
        new Error(
          `${params.provider} generated music download timed out after ${deadline.timeoutMs ?? bodyTimeoutMs}ms`,
        ),
      onOverflow: ({ maxBytes: maxBytesLocal }: { maxBytes: number }) =>
        new Error(`${params.provider} generated music download exceeds ${maxBytesLocal} bytes`),
    };
    const buffer = params.validateBinaryResponse
      ? Buffer.from(
          await readProviderBinaryResponse(handle.response, deadline.label, "audio", readOptions),
        )
      : await readResponseWithLimit(handle.response, maxBytes, readOptions);
    return {
      buffer,
      mimeType,
      fileName: params.candidate.fileName ?? `track-${(params.index ?? 0) + 1}.${ext}`,
      ...(params.includeSourceUrl === false ? {} : { metadata: { url: params.candidate.url } }),
    };
  } finally {
    await handle.release?.();
  }
}
