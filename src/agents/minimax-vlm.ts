import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import { isRecord } from "../utils.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

export function isMinimaxVlmProvider(provider: string): boolean {
  return provider === "minimax" || provider === "minimax-portal";
}

export function isMinimaxVlmModel(provider: string, modelId: string): boolean {
  return isMinimaxVlmProvider(provider) && modelId.trim() === "MiniMax-VL-01";
}

function coerceApiHost(params: {
  apiHost?: string;
  modelBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  const raw =
    params.apiHost?.trim() ||
    env.MINIMAX_API_HOST?.trim() ||
    params.modelBaseUrl?.trim() ||
    "https://api.minimax.io";

  try {
    const url = new URL(raw);
    return url.origin;
  } catch {}

  try {
    const url = new URL(`https://${raw}`);
    return url.origin;
  } catch {
    return "https://api.minimax.io";
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
  timeoutMs?: number;
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

  const host = coerceApiHost({
    apiHost: params.apiHost,
    modelBaseUrl: params.modelBaseUrl,
  });
  const url = new URL("/v1/coding_plan/vlm", host).toString();

  // Ensure env-based proxy dispatcher is active before the outbound fetch call.
  // Without this, HTTP_PROXY/HTTPS_PROXY env vars are silently ignored (#51619).
  ensureGlobalUndiciEnvProxyDispatcher();

  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.floor(params.timeoutMs)
      : 60_000;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "MM-API-Source": "OpenClaw",
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      prompt,
      image_url: imageDataUrl,
    }),
  });

  const traceId = res.headers.get("Trace-Id") ?? "";
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const trace = traceId ? ` Trace-Id: ${traceId}` : "";
    throw new Error(
      `MiniMax VLM request failed (${res.status} ${res.statusText}).${trace}${
        body ? ` Body: ${body.slice(0, 400)}` : ""
      }`,
    );
  }

  const json = (await res.json().catch(() => null)) as unknown;
  if (!isRecord(json)) {
    const trace = traceId ? ` Trace-Id: ${traceId}` : "";
    throw new Error(`MiniMax VLM response was not JSON.${trace}`);
  }

  const baseResp = isRecord(json.base_resp) ? (json.base_resp as MinimaxBaseResp) : {};
  const code = typeof baseResp.status_code === "number" ? baseResp.status_code : -1;
  if (code !== 0) {
    const msg = (baseResp.status_msg ?? "").trim();
    const trace = traceId ? ` Trace-Id: ${traceId}` : "";
    throw new Error(`MiniMax VLM API error (${code})${msg ? `: ${msg}` : ""}.${trace}`);
  }

  const content = pickString(json, "content").trim();
  if (!content) {
    const trace = traceId ? ` Trace-Id: ${traceId}` : "";
    throw new Error(`MiniMax VLM returned no content.${trace}`);
  }

  return content;
}
