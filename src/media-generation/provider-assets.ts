// Downloads generated video assets under provider-owned transport policies.
import { maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readProviderBinaryResponse } from "../agents/provider-http-errors.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchProviderDownloadResponse,
  type ProviderOperationDeadline,
  type ProviderOperationTimeoutMs,
} from "../media-understanding/shared.js";
import type { GeneratedVideoAsset } from "../video-generation/types.js";

type GeneratedVideoResponseHandle = {
  response: Response;
  release?: () => Promise<void>;
};

type GeneratedVideoResponseFactory = (params: {
  deadline: ProviderOperationDeadline;
  timeoutMs: () => number;
}) => Promise<GeneratedVideoResponseHandle>;

/** Download a generated video URL with size limits and inferred video metadata. */
export async function downloadGeneratedVideoAsset(params: {
  url: string;
  timeoutMs: ProviderOperationTimeoutMs;
  defaultTimeoutMs: number;
  fetchFn: typeof fetch;
  provider: string;
  label: string;
  requestFailedMessage: string;
  index?: number;
  maxBytes?: number;
  validateBinaryResponse?: boolean;
  metadata?: Record<string, unknown>;
  fetchResponse?: GeneratedVideoResponseFactory;
}): Promise<GeneratedVideoAsset> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: params.label,
  });
  const timeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: deadline.timeoutMs ?? params.defaultTimeoutMs,
  });
  const handle = params.fetchResponse
    ? await params.fetchResponse({ deadline, timeoutMs })
    : {
        response: await fetchProviderDownloadResponse({
          url: params.url,
          init: { method: "GET" },
          deadline,
          fetchFn: params.fetchFn,
          provider: params.provider,
          requestFailedMessage: params.requestFailedMessage,
        }),
      };
  try {
    const mimeType =
      normalizeOptionalString(handle.response.headers.get("content-type")) ?? "video/mp4";
    const maxBytes = params.maxBytes ?? maxBytesForKind("video");
    const readOptions = {
      maxBytes,
      timeoutMs,
      onTimeout: ({ timeoutMs: bodyTimeoutMs }: { timeoutMs: number }) =>
        new Error(`${params.label} timed out after ${deadline.timeoutMs ?? bodyTimeoutMs}ms`),
      onOverflow: ({ maxBytes: maxBytesLocal }: { maxBytes: number }) =>
        new Error(`${params.label} exceeds ${maxBytesLocal} bytes`),
    };
    const buffer = params.validateBinaryResponse
      ? await readProviderBinaryResponse(handle.response, params.label, "video", readOptions)
      : await readResponseWithLimit(handle.response, maxBytes, readOptions);
    const ext = extensionForMime(mimeType)?.replace(/^\./u, "") ?? "mp4";
    return {
      buffer,
      mimeType,
      fileName: `video-${(params.index ?? 0) + 1}.${ext}`,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
  } finally {
    await handle.release?.();
  }
}
