// Validates and normalizes provider asset attachments for music generation.
import { maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readResponseTextPrefix, readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithTimeout } from "../media-understanding/shared.js";
import { executeProviderOperationWithRetry } from "../provider-runtime/operation-retry.js";
import type { GeneratedMusicAsset } from "./types.js";

const GENERATED_MUSIC_ERROR_BODY_MAX_BYTES = 16 * 1024;

function resolveGeneratedMusicDownloadBodyTimeout(params: {
  provider: string;
  timeoutMs: number;
  deadlineMs: number;
}) {
  return {
    chunkTimeoutMs: params.timeoutMs,
    timeoutMs: Math.max(1, params.deadlineMs - Date.now()),
    onIdleTimeout: ({ chunkTimeoutMs }: { chunkTimeoutMs: number }) =>
      new Error(`${params.provider} generated music download stalled after ${chunkTimeoutMs}ms`),
    onTimeout: () =>
      new Error(
        `${params.provider} generated music download timed out after ${params.timeoutMs}ms`,
      ),
  };
}

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
  const ext = extensionForMime(params.mimeType)?.replace(/^\./u, "") || "mp3";
  return {
    buffer: Buffer.from(params.base64, "base64"),
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
}): Promise<GeneratedMusicAsset> {
  // One wall-clock deadline spans headers, non-2xx error-detail reads, and
  // successful-body reads so a slow drip cannot reset chunk idle forever.
  // Perform bounded status validation inside each retry attempt so transient
  // HTTP statuses (429, 5xx) are retried by executeProviderOperationWithRetry
  // before the download returns.
  const deadlineMs = Date.now() + params.timeoutMs;
  const makeBodyTimeout = () =>
    resolveGeneratedMusicDownloadBodyTimeout({
      provider: params.provider,
      timeoutMs: params.timeoutMs,
      deadlineMs,
    });

  const response = await executeProviderOperationWithRetry({
    provider: params.provider,
    stage: "download",
    operation: async () => {
      const res = await fetchWithTimeout(
        params.candidate.url,
        { method: "GET" },
        Math.max(1, deadlineMs - Date.now()),
        params.fetchFn,
      );
      if (!res.ok) {
        // Retryable statuses skip diagnostic body reads so the shared
        // wall-clock deadline is preserved for the retry attempt. A
        // dripping 5xx body would otherwise consume the full deadline
        // before the retry wrapper could start another attempt.
        if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`${params.requestFailedMessage} (HTTP ${res.status})`);
        }
        // Non-retryable statuses keep a bounded diagnostic read.
        const prefix = await readResponseTextPrefix(
          res,
          GENERATED_MUSIC_ERROR_BODY_MAX_BYTES,
          makeBodyTimeout(),
        );
        const detail = prefix.text.replace(/\s+/g, " ").trim();
        throw new Error(
          `${params.requestFailedMessage} (HTTP ${res.status})` +
            (detail ? `: ${detail.length > 220 ? `${detail.slice(0, 219)}…` : detail}` : ""),
        );
      }
      return res;
    },
  });
  const mimeType =
    normalizeSpecificAudioMimeType(response.headers.get("content-type")) ??
    normalizeSpecificAudioMimeType(params.candidate.mimeType) ??
    "audio/mpeg";
  const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
  const maxBytes = params.maxBytes ?? maxBytesForKind("audio");
  return {
    buffer: await readResponseWithLimit(response, maxBytes, {
      ...makeBodyTimeout(),
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
