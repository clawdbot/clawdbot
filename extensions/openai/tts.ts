import {
  assertOkOrThrowProviderError,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import {
  captureHttpExchange,
  isDebugProxyGlobalFetchPatchInstalled,
} from "openclaw/plugin-sdk/proxy-capture";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export const OPENAI_TTS_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;

export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "juniper",
  "marin",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];

export function normalizeOpenAITtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function isCustomOpenAIEndpoint(baseUrl?: string): boolean {
  if (baseUrl != null) {
    return normalizeOpenAITtsBaseUrl(baseUrl) !== DEFAULT_OPENAI_BASE_URL;
  }
  return normalizeOpenAITtsBaseUrl(process.env.OPENAI_TTS_BASE_URL) !== DEFAULT_OPENAI_BASE_URL;
}

export function isValidOpenAIModel(model: string, baseUrl?: string): boolean {
  if (isCustomOpenAIEndpoint(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_MODELS.includes(model as (typeof OPENAI_TTS_MODELS)[number]);
}

export function isValidOpenAIVoice(voice: string, baseUrl?: string): voice is OpenAiTtsVoice {
  if (isCustomOpenAIEndpoint(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_VOICES.includes(voice as OpenAiTtsVoice);
}

export function resolveOpenAITtsInstructions(
  model: string,
  instructions?: string,
  baseUrl?: string,
): string | undefined {
  const next = instructions?.trim();
  if (!next) {
    return undefined;
  }
  if (baseUrl !== undefined && isCustomOpenAIEndpoint(baseUrl)) {
    return next;
  }
  return model.includes("gpt-4o-mini-tts") ? next : undefined;
}

export async function openaiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed?: number;
  instructions?: string;
  responseFormat: "mp3" | "opus" | "pcm" | "wav";
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, baseUrl, model, voice, speed, instructions, responseFormat, timeoutMs } =
    params;
  const effectiveInstructions = resolveOpenAITtsInstructions(model, instructions, baseUrl);

  if (!isValidOpenAIModel(model, baseUrl)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice, baseUrl)) {
    throw new Error(`Invalid voice: ${voice}`);
  }

  const requestHeaders = resolveProviderRequestHeaders({
    provider: "openai",
    baseUrl,
    capability: "audio",
    transport: "http",
    defaultHeaders: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  }) ?? {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const requestBody = JSON.stringify({
    model,
    input: text,
    voice,
    response_format: responseFormat,
    ...(speed != null && { speed }),
    ...(effectiveInstructions != null && { instructions: effectiveInstructions }),
  });
  const requestUrl = `${baseUrl}/audio/speech`;
  const debugProxyFetchPatchInstalled = isDebugProxyGlobalFetchPatchInstalled();
  const { response, release } = await fetchWithSsrFGuard({
    url: requestUrl,
    init: {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    capture: false,
    pinDns: debugProxyFetchPatchInstalled ? false : undefined,
    auditContext: "openai-tts",
  });
  try {
    if (!debugProxyFetchPatchInstalled) {
      captureHttpExchange({
        url: requestUrl,
        method: "POST",
        requestHeaders,
        requestBody,
        response,
        transport: "http",
        meta: {
          provider: "openai",
          capability: "tts",
        },
      });
    }

    await assertOkOrThrowProviderError(response, "OpenAI TTS API error");

    return Buffer.from(await response.arrayBuffer());
  } finally {
    await release();
  }
}
