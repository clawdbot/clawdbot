import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { readResponseBodySnippet } from "../infra/http-error-body.js";
import { redactToolPayloadText } from "../logging/redact.js";
/**
 * Adapts MiniMax VLM image-understanding requests for agent image inputs.
 */
import {
  postJsonRequest,
  resolveProviderHttpRequestConfigWithOriginTrust,
} from "../media-understanding/shared.js";
import { isRecord } from "../utils.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { readProviderJsonResponse } from "./provider-http-errors.js";
import type { ModelProviderRequestTransportOverrides } from "./provider-request-config.js";
import { resolveProviderTransportSsrFPolicy } from "./provider-transport-fetch.js";

type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

const MINIMAX_VLM_ERROR_BODY_MAX_BYTES = 8 * 1024;
const MINIMAX_VLM_ERROR_BODY_MAX_CHARS = 400;
const DEFAULT_MINIMAX_VLM_TIMEOUT_MS = 60_000;

// Standalone Bearer tokens below the shared redactor's 18-character prose floor are
// still credentials on this authenticated error surface, so mask them regardless of
// length and scheme casing. The lookahead keeps already-hinted tokens
// (`Bearer abc…wxyz`) untouched.
const SHORT_BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[-A-Za-z0-9._~+/=]{1,17}(?![-A-Za-z0-9._~+/=…])/gi;

function redactVlmErrorText(text: string): string {
  return redactToolPayloadText(text).replace(SHORT_BEARER_TOKEN_PATTERN, "$1 ***");
}

export function isMinimaxVlmProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return (
    normalized === "minimax" ||
    normalized === "minimax-cn" ||
    normalized === "minimax-portal" ||
    normalized === "minimax-portal-cn"
  );
}

export function isMinimaxVlmModel(provider: string, modelId: string): boolean {
  return isMinimaxVlmProvider(provider) && modelId.trim() === "MiniMax-VL-01";
}

function isMinimaxCnProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "minimax-cn" || normalized === "minimax-portal-cn";
}

function resolveDefaultApiHost(provider: string | undefined): string {
  return isMinimaxCnProvider(provider) ? "https://api.minimaxi.com" : "https://api.minimax.io";
}

function coerceApiHost(params: {
  apiHost?: string;
  modelBaseUrl?: string;
  provider?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  const defaultHost = resolveDefaultApiHost(params.provider);
  const raw =
    params.apiHost?.trim() ||
    env.MINIMAX_API_HOST?.trim() ||
    params.modelBaseUrl?.trim() ||
    defaultHost;

  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    // Bare hosts are retried with https:// below; malformed absolute URLs fall
    // back to provider defaults instead of sending requests to invalid endpoints.
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    return defaultHost;
  }

  try {
    const url = new URL(`https://${raw}`);
    return url.origin;
  } catch {
    return defaultHost;
  }
}

function pickString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : "";
}

export async function minimaxUnderstandImage(params: {
  apiKey: string;
  prompt: string;
  imageDataUrl: string;
  apiHost?: string;
  modelBaseUrl?: string;
  provider?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Operator-configured private-network policy from the provider request config. */
  allowPrivateNetwork?: boolean;
  /** Resolved model request transport metadata, including proxy and TLS policy. */
  request?: ModelProviderRequestTransportOverrides;
}): Promise<string> {
  const apiKey = normalizeSecretInput(params.apiKey);
  if (!apiKey) {
    throw new Error("MiniMax VLM: apiKey required");
  }
  const prompt = params.prompt.trim();
  if (!prompt) {
    throw new Error("MiniMax VLM: prompt required");
  }
  const imageDataUrl = params.imageDataUrl.trim();
  if (!imageDataUrl) {
    throw new Error("MiniMax VLM: imageDataUrl required");
  }
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(imageDataUrl)) {
    throw new Error("MiniMax VLM: imageDataUrl must be a base64 data:image/(png|jpeg|webp) URL");
  }

  const configuredHost = coerceApiHost({
    apiHost: params.apiHost,
    modelBaseUrl: params.modelBaseUrl,
    provider: params.provider,
  });
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, trustConfiguredBaseUrlOrigin } =
    resolveProviderHttpRequestConfigWithOriginTrust({
      baseUrl: configuredHost,
      defaultBaseUrl: resolveDefaultApiHost(params.provider),
      allowPrivateNetwork: params.allowPrivateNetwork,
      defaultHeaders: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MM-API-Source": "OpenClaw",
      },
      request: params.request,
      provider: params.provider ?? "minimax",
      capability: "image",
      transport: "media-understanding",
    });
  const url = new URL("/v1/coding_plan/vlm", baseUrl).toString();

  const timeoutMs = resolvePositiveTimerTimeoutMs(params.timeoutMs, DEFAULT_MINIMAX_VLM_TIMEOUT_MS);

  const ssrfPolicy = resolveProviderTransportSsrFPolicy({
    baseUrl,
    url,
    allowPrivateNetwork,
    trustConfiguredBaseUrlOrigin,
  });

  const guarded = await postJsonRequest({
    url,
    headers,
    body: {
      prompt,
      image_url: imageDataUrl,
    },
    timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn: fetch,
    allowPrivateNetwork,
    ssrfPolicy,
    dispatcherPolicy,
    auditContext: "minimax-vlm",
  });
  const res = guarded.response;

  try {
    // The Trace-Id header, error body, reason phrase, and base_resp.status_msg are
    // all provider-controlled: an edge or proxy can reflect the request's
    // Authorization credential into any of them. Redact once at ingestion so every
    // error branch below stays safe.
    const traceId = redactVlmErrorText(res.headers.get("Trace-Id") ?? "");
    if (!res.ok) {
      const body = await readResponseBodySnippet(res, {
        maxBytes: MINIMAX_VLM_ERROR_BODY_MAX_BYTES,
        maxChars: MINIMAX_VLM_ERROR_BODY_MAX_CHARS,
      });
      const trace = traceId ? ` Trace-Id: ${traceId}` : "";
      throw new Error(
        `MiniMax VLM request failed (${res.status} ${redactVlmErrorText(res.statusText)}).${trace}${
          body ? ` Body: ${redactVlmErrorText(body)}` : ""
        }`,
      );
    }

    const responseLabel = traceId
      ? `MiniMax VLM response [Trace-Id=${traceId}]`
      : "MiniMax VLM response";
    const json = await readProviderJsonResponse<unknown>(res, responseLabel);
    if (!isRecord(json)) {
      const trace = traceId ? ` Trace-Id: ${traceId}` : "";
      throw new Error(`MiniMax VLM response was not JSON.${trace}`);
    }

    const baseResp = isRecord(json.base_resp) ? (json.base_resp as MinimaxBaseResp) : {};
    const code = typeof baseResp.status_code === "number" ? baseResp.status_code : -1;
    if (code !== 0) {
      const msg = redactVlmErrorText((baseResp.status_msg ?? "").trim());
      const trace = traceId ? ` Trace-Id: ${traceId}` : "";
      throw new Error(`MiniMax VLM API error (${code})${msg ? `: ${msg}` : ""}.${trace}`);
    }

    const content = pickString(json, "content").trim();
    if (!content) {
      const trace = traceId ? ` Trace-Id: ${traceId}` : "";
      throw new Error(`MiniMax VLM returned no content.${trace}`);
    }

    return content;
  } finally {
    await guarded.release();
  }
}
