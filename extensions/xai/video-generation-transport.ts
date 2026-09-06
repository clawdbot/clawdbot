import { downloadGeneratedVideoAsset } from "openclaw/plugin-sdk/media-generation-runtime";
import {
  assertOkOrThrowHttpError,
  executeProviderOperationWithRetry,
  fetchWithTimeoutGuarded,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import type { GeneratedVideoAsset } from "openclaw/plugin-sdk/video-generation";

export type XaiVideoRequestPolicy = {
  allowPrivateNetwork: boolean;
  dispatcherPolicy?: NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>["dispatcherPolicy"];
};

function resolveXaiVideoFetchTimeoutMs(
  timeoutMs: ProviderOperationTimeoutMs | undefined,
  defaultTimeoutMs: number,
) {
  const resolved = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  return typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0
    ? resolved
    : defaultTimeoutMs;
}

export async function fetchXaiVideoResponse(
  params: {
    url: string;
    init: RequestInit;
    stage: "poll" | "download";
    requestFailedMessage: string;
    auditContext: string;
    timeoutMs?: ProviderOperationTimeoutMs;
    defaultTimeoutMs: number;
    fetchFn: typeof fetch;
  } & XaiVideoRequestPolicy,
) {
  return await executeProviderOperationWithRetry({
    provider: "xai",
    stage: params.stage,
    operation: async () => {
      const result = await fetchWithTimeoutGuarded(
        params.url,
        params.init,
        resolveXaiVideoFetchTimeoutMs(params.timeoutMs, params.defaultTimeoutMs),
        params.fetchFn,
        {
          ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
          ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
          auditContext: params.auditContext,
        },
      );
      try {
        await assertOkOrThrowHttpError(result.response, params.requestFailedMessage);
        return result;
      } catch (error) {
        await result.release();
        throw error;
      }
    },
  });
}

export async function downloadXaiVideo(
  params: {
    url: string;
    timeoutMs?: ProviderOperationTimeoutMs;
    defaultTimeoutMs: number;
    fetchFn: typeof fetch;
    maxBytes: number;
  } & XaiVideoRequestPolicy,
): Promise<GeneratedVideoAsset> {
  return await downloadGeneratedVideoAsset({
    url: params.url,
    timeoutMs: params.timeoutMs ?? params.defaultTimeoutMs,
    defaultTimeoutMs: params.defaultTimeoutMs,
    fetchFn: params.fetchFn,
    provider: "xai",
    label: "xAI generated video download",
    requestFailedMessage: "xAI generated video download failed",
    maxBytes: params.maxBytes,
    validateBinaryResponse: true,
    chunkTimeoutMs: 0,
    fetchResponse: async ({ timeoutMs }) =>
      await fetchXaiVideoResponse({
        url: params.url,
        stage: "download",
        requestFailedMessage: "xAI generated video download failed",
        auditContext: "xai-video-download",
        init: { method: "GET" },
        timeoutMs,
        defaultTimeoutMs: params.defaultTimeoutMs,
        allowPrivateNetwork: params.allowPrivateNetwork,
        dispatcherPolicy: params.dispatcherPolicy,
        fetchFn: params.fetchFn,
      }),
  });
}
