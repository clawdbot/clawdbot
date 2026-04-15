import {
  captureHttpExchange,
  isDebugProxyGlobalFetchPatchInstalled,
} from "openclaw/plugin-sdk/proxy-capture";
import {
  asObject,
  readResponseTextLimited,
  trimToUndefined,
  truncateErrorDetail,
} from "openclaw/plugin-sdk/speech";

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
): string | undefined {
  const next = instructions?.trim();
  return next && model.includes("gpt-4o-mini-tts") ? next : undefined;
}

function formatOpenAiErrorPayload(payload: unknown): string | undefined {
  const root = asObject(payload);
  const subject = asObject(root?.error) ?? root;
  if (!subject) {
    return undefined;
  }
  const message =
    trimToUndefined(subject.message) ??
    trimToUndefined(subject.detail) ??
    trimToUndefined(root?.message);
  const type = trimToUndefined(subject.type);
  const code = trimToUndefined(subject.code);
  const metadata = [type ? `type=${type}` : undefined, code ? `code=${code}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  if (message && metadata) {
    return `${truncateErrorDetail(message)} [${metadata}]`;
  }
  if (message) {
    return truncateErrorDetail(message);
  }
  if (metadata) {
    return `[${metadata}]`;
  }
  return undefined;
}

async function extractOpenAiErrorDetail(response: Response): Promise<string | undefined> {
  const rawBody = trimToUndefined(await readResponseTextLimited(response));
  if (!rawBody) {
    return undefined;
  }
  try {
    return formatOpenAiErrorPayload(JSON.parse(rawBody)) ?? truncateErrorDetail(rawBody);
  } catch {
    return truncateErrorDetail(rawBody);
  }
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
  const effectiveInstructions = resolveOpenAITtsInstructions(model, instructions);

  if (!isValidOpenAIModel(model, baseUrl)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice, baseUrl)) {
    throw new Error(`Invalid voice: ${voice}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestHeaders = {
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
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
    });
    if (!isDebugProxyGlobalFetchPatchInstalled()) {
      captureHttpExchange({
        url: `${baseUrl}/audio/speech`,
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

    if (!response.ok) {
      const detail = await extractOpenAiErrorDetail(response);
      const requestId =
        trimToUndefined(response.headers.get("x-request-id")) ??
        trimToUndefined(response.headers.get("request-id"));
      throw new Error(
        `OpenAI TTS API error (${response.status})` +
          (detail ? `: ${detail}` : "") +
          (requestId ? ` [request_id=${requestId}]` : ""),
      );
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
