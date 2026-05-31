import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationResult,
} from "openclaw/plugin-sdk/image-generation";
import {
  parseOpenAiCompatibleImageResponse,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveClosestSize } from "openclaw/plugin-sdk/media-generation-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import {
  ensureAuthProfileStore,
  isProviderApiKeyConfigured,
  listProfilesForProvider,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  canonicalizeCodexResponsesBaseUrl,
  isOpenAICodexBaseUrl,
  OPENAI_CODEX_RESPONSES_BASE_URL,
} from "./base-url.js";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";
import { resolveConfiguredOpenAIBaseUrl } from "./shared.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL = OPENAI_CODEX_RESPONSES_BASE_URL;
const DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL = "gpt-5.5";
const OPENAI_CODEX_IMAGE_INSTRUCTIONS = "You are an image generation assistant.";
const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-1.5";
const DEFAULT_OPENAI_IMAGE_TIMEOUT_MS = 180_000;
const DEFAULT_AZURE_OPENAI_IMAGE_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_OUTPUT_EXTENSION = "png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const OPENAI_LEGACY_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const OPENAI_MAX_INPUT_IMAGES = 5;
const OPENAI_MAX_IMAGE_RESULTS = 4;
const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_IMAGE_SSE_EVENTS = 512;
const MAX_CODEX_IMAGE_BASE64_CHARS = 64 * 1024 * 1024;
const LOG_VALUE_MAX_CHARS = 256;
const MOCK_OPENAI_PROVIDER_ID = "mock-openai";
const OPENAI_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const OPENAI_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const OPENAI_QUALITIES = ["low", "medium", "high", "auto"] as const;
const OPENAI_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
const log = createSubsystemLogger("image-generation/openai");

const AZURE_HOSTNAME_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
] as const;

const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";

function sanitizeLogValue(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  const cleaned = raw
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gi, "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "unknown";
  }
  return cleaned.length > LOG_VALUE_MAX_CHARS
    ? `${cleaned.slice(0, LOG_VALUE_MAX_CHARS)}...`
    : cleaned;
}

function resolveOpenAIImageTimeoutMs(
  timeoutMs: number | undefined,
  options?: { isAzure?: boolean },
): number {
  return (
    timeoutMs ??
    (options?.isAzure ? DEFAULT_AZURE_OPENAI_IMAGE_TIMEOUT_MS : DEFAULT_OPENAI_IMAGE_TIMEOUT_MS)
  );
}

function resolveOpenAIImageCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return 1;
  }
  return Math.max(1, Math.min(OPENAI_MAX_IMAGE_RESULTS, Math.trunc(count)));
}

function isPublicOpenAIImageBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    const pathName = parsed.pathname.replace(/\/+$/, "");
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "api.openai.com" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      pathName === "/v1"
    );
  } catch {
    return false;
  }
}

function isAzureOpenAIBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return AZURE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function resolveAzureApiVersion(): string {
  return process.env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

function buildAzureImageUrl(
  rawBaseUrl: string,
  model: string,
  action: "generations" | "edits",
): string {
  const cleanBase = rawBaseUrl
    .replace(/\/+$/, "")
    .replace(/\/openai\/v1$/, "")
    .replace(/\/v1$/, "");
  return `${cleanBase}/openai/deployments/${model}/images/${action}?api-version=${resolveAzureApiVersion()}`;
}

function resolveOutputMime(outputFormat?: ImageGenerationOutputFormat): {
  mimeType: string;
  extension: string;
} {
  switch (outputFormat) {
    case "jpeg":
      return { mimeType: "image/jpeg", extension: "jpg" };
    case "webp":
      return { mimeType: "image/webp", extension: "webp" };
    case "png":
    case undefined:
      return { mimeType: DEFAULT_OUTPUT_MIME, extension: DEFAULT_OUTPUT_EXTENSION };
  }
  return { mimeType: DEFAULT_OUTPUT_MIME, extension: DEFAULT_OUTPUT_EXTENSION };
}

type OpenAIImageRequest = Parameters<ImageGenerationProvider["generateImage"]>[0];
type OpenAIImageOptions = NonNullable<OpenAIImageRequest["providerOptions"]>["openai"];

function resolveOpenAIImageOutputCompression(
  req: OpenAIImageRequest,
  openai: OpenAIImageOptions,
): number | undefined {
  if (openai?.outputCompression === undefined) {
    return undefined;
  }
  const outputFormat = req.outputFormat ?? "png";
  return outputFormat === "jpeg" || outputFormat === "webp" ? openai.outputCompression : undefined;
}

function appendOpenAIImageOptions(
  target: Record<string, unknown> | FormData,
  req: Parameters<ImageGenerationProvider["generateImage"]>[0],
): void {
  const openai = req.providerOptions?.openai;
  const background = openai?.background ?? req.background;
  const outputCompression = resolveOpenAIImageOutputCompression(req, openai);
  const entries: Record<string, unknown> = {
    ...(req.quality !== undefined ? { quality: req.quality } : {}),
    ...(req.outputFormat !== undefined ? { output_format: req.outputFormat } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(openai?.moderation !== undefined ? { moderation: openai.moderation } : {}),
    ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
    ...(openai?.user !== undefined ? { user: openai.user } : {}),
  };
  for (const [key, value] of Object.entries(entries)) {
    if (target instanceof FormData) {
      target.set(key, String(value));
    } else {
      target[key] = value;
    }
  }
}

function resolveOpenAIImageRequestModel(
  req: Parameters<ImageGenerationProvider["generateImage"]>[0],
  options?: { allowTransparentDefaultReroute?: boolean },
): string {
  const model = req.model || DEFAULT_OPENAI_IMAGE_MODEL;
  if (
    options?.allowTransparentDefaultReroute === true &&
    model === DEFAULT_OPENAI_IMAGE_MODEL &&
    (req.providerOptions?.openai?.background ?? req.background) === "transparent"
  ) {
    return OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL;
  }
  return model;
}

function resolveNativeOpenAIImageSizesForModel(model: string): readonly string[] {
  switch (model) {
    case "gpt-image-1":
    case "gpt-image-1-mini":
      return OPENAI_LEGACY_IMAGE_SIZES;
    default:
      return OPENAI_SUPPORTED_SIZES;
  }
}

function resolveOpenAIImageRequestSize(params: {
  model: string;
  requestedSize?: string;
  applyNativeLimits: boolean;
}): {
  size: string;
  metadata?: Record<string, string>;
} {
  const requestedSize = params.requestedSize ?? DEFAULT_SIZE;
  if (!params.applyNativeLimits) {
    return { size: requestedSize };
  }
  const supportedSizes = resolveNativeOpenAIImageSizesForModel(params.model);
  const size =
    resolveClosestSize({
      requestedSize,
      supportedSizes,
    }) ?? DEFAULT_SIZE;
  if (size === requestedSize) {
    return { size };
  }
  return {
    size,
    metadata: {
      requestedSize,
      normalizedSize: size,
    },
  };
}

function shouldAllowPrivateImageEndpoint(req: {
  provider: string;
  cfg: OpenClawConfig | undefined;
}) {
  if (req.provider === MOCK_OPENAI_PROVIDER_ID) {
    return true;
  }
  if (isPrivateNetworkOptInEnabled(req.cfg?.browser?.ssrfPolicy)) {
    return true;
  }
  const baseUrl = resolveConfiguredOpenAIBaseUrl(req.cfg);
  if (!baseUrl.startsWith("http://127.0.0.1:") && !baseUrl.startsWith("http://localhost:")) {
    return false;
  }
  return process.env.OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER === "1";
}

function resolveRequestAuthStore(req: {
  authStore?: AuthProfileStore;
  agentDir?: string;
}): AuthProfileStore | undefined {
  if (req.authStore) {
    return req.authStore;
  }
  const agentDir = req.agentDir?.trim();
  if (!agentDir) {
    return undefined;
  }
  return ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
}

function hasDirectOpenAIImageApiKeyAuth(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  if (hasExplicitOpenAIImageApiKeyConfig(params.cfg)) {
    return true;
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return true;
  }
  const store = params.agentDir
    ? ensureAuthProfileStore(params.agentDir, {
        allowKeychainPrompt: false,
      })
    : undefined;
  if (!store) {
    return false;
  }
  const profileIds = listProfilesForProvider(store, "openai");
  if (profileIds.length === 0) {
    return false;
  }
  return profileIds.some((profileId) => store.profiles[profileId]?.type === "api_key");
}

function hasCodexResponseTransportProfileConfigured(req: {
  authStore?: AuthProfileStore;
  agentDir?: string;
}): boolean {
  const store = resolveRequestAuthStore(req);
  if (!store) {
    return false;
  }
  return listProfilesForProvider(store, "openai").some(
    (profileId) =>
      store.profiles[profileId]?.type === "oauth" || store.profiles[profileId]?.type === "token",
  );
}

function resolveOpenAIImageAuthProvider(req: {
  cfg?: OpenClawConfig;
  authStore?: AuthProfileStore;
  agentDir?: string;
}): string {
  const providerConfig = req.cfg?.models?.providers?.openai;
  if (providerConfig?.apiKey !== undefined || providerConfig?.auth === "api-key") {
    return "openai";
  }
  const store = resolveRequestAuthStore(req);
  if (!store) {
    return "openai";
  }
  return "openai";
}

function hasExplicitOpenAIImageApiKeyConfig(cfg: OpenClawConfig | undefined): boolean {
  const providerConfig = cfg?.models?.providers?.openai;
  return providerConfig?.apiKey !== undefined || providerConfig?.auth === "api-key";
}

function hasExplicitDirectOpenAIImageConfig(cfg: OpenClawConfig | undefined): boolean {
  const providerConfig = cfg?.models?.providers?.openai;
  if (!providerConfig) {
    return false;
  }
  return (
    hasExplicitOpenAIImageApiKeyConfig(cfg) ||
    providerConfig.headers !== undefined ||
    providerConfig.authHeader !== undefined ||
    providerConfig.request !== undefined ||
    (providerConfig.api !== undefined && providerConfig.api !== "openai-chatgpt-responses")
  );
}

function hasChatGPTImageRouteConfig(cfg: OpenClawConfig | undefined): boolean {
  const providerConfig = cfg?.models?.providers?.openai;
  return (
    isOpenAICodexBaseUrl(resolveConfiguredOpenAIBaseUrl(cfg)) ||
    providerConfig?.api === "openai-chatgpt-responses"
  );
}

function resolveConfiguredOpenAIImageHeaders(
  cfg: OpenClawConfig | undefined,
): Record<string, string> | undefined {
  const headers = cfg?.models?.providers?.openai?.headers;
  if (!headers) {
    return undefined;
  }
  const stringHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return Object.keys(stringHeaders).length > 0 ? stringHeaders : undefined;
}

function forceOpenAIImageApiKeyAuth(cfg: OpenClawConfig | undefined): OpenClawConfig | undefined {
  if (!hasExplicitOpenAIImageApiKeyConfig(cfg)) {
    return cfg;
  }
  const providerConfig = cfg?.models?.providers?.openai;
  if (!providerConfig) {
    return cfg;
  }
  return {
    ...cfg,
    models: {
      ...cfg?.models,
      providers: {
        ...cfg?.models?.providers,
        openai: {
          ...providerConfig,
          auth: "api-key",
        },
      },
    },
  };
}

async function resolveOpenAIImageAuth(req: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}) {
  return await resolveOptionalApiKeyForProvider({
    provider: resolveOpenAIImageAuthProvider(req),
    cfg: req.cfg,
    agentDir: req.agentDir,
    store: req.authStore,
  });
}

function isCodexSubscriptionAuthMode(mode: unknown): boolean {
  return mode === "oauth" || mode === "token";
}

type OpenAICodexImageGenerationEvent = {
  type?: string;
  item?: {
    type?: string;
    result?: string;
    revised_prompt?: string;
  };
  response?: {
    output?: Array<{
      type?: string;
      result?: string;
      revised_prompt?: string;
    }>;
    usage?: unknown;
    tool_usage?: unknown;
  };
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
};

function inferImageUploadFileName(params: {
  fileName?: string;
  mimeType?: string;
  index: number;
}): string {
  const fileName = params.fileName?.trim();
  if (fileName) {
    return path.basename(fileName);
  }
  const mimeType = params.mimeType?.trim().toLowerCase() || DEFAULT_OUTPUT_MIME;
  const ext = extensionForMime(mimeType)?.slice(1) ?? "png";
  return `image-${params.index + 1}.${ext}`;
}

async function readResponseBodyText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CODEX_IMAGE_SSE_BYTES) {
      throw new Error("OpenAI Codex image generation response exceeded size limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        byteLength += value.byteLength;
        if (byteLength > MAX_CODEX_IMAGE_SSE_BYTES) {
          throw new Error("OpenAI Codex image generation response exceeded size limit");
        }
        chunks.push(decoder.decode(value, { stream: !done }));
      }
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        return chunks.join("");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseCodexImageGenerationEvents(body: string): OpenAICodexImageGenerationEvent[] {
  const events: OpenAICodexImageGenerationEvent[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    let event: OpenAICodexImageGenerationEvent;
    try {
      event = JSON.parse(data) as OpenAICodexImageGenerationEvent;
    } catch {
      // Ignore non-JSON SSE payloads from intermediaries; failed HTTP statuses
      // are handled before this parser runs.
      continue;
    }
    events.push(event);
    if (events.length > MAX_CODEX_IMAGE_SSE_EVENTS) {
      throw new Error("OpenAI Codex image generation response exceeded event limit");
    }
  }
  return events;
}

function decodeCodexImagePayload(payload: string): Buffer {
  if (payload.length > MAX_CODEX_IMAGE_BASE64_CHARS) {
    throw new Error("OpenAI Codex image generation result exceeded size limit");
  }
  return Buffer.from(payload, "base64");
}

function toCodexImage(
  entry: { result?: string; revised_prompt?: string },
  index: number,
  outputFormat?: ImageGenerationOutputFormat,
): ImageGenerationResult["images"][number] | null {
  if (typeof entry.result !== "string" || entry.result.length === 0) {
    return null;
  }
  const output = resolveOutputMime(outputFormat);
  return Object.assign(
    {
      buffer: decodeCodexImagePayload(entry.result),
      mimeType: output.mimeType,
      fileName: `image-${index + 1}.${output.extension}`,
    },
    entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {},
  );
}

function extractCodexImageGenerationResult(params: {
  body: string;
  model: string;
  outputFormat?: ImageGenerationOutputFormat;
}): ImageGenerationResult {
  const events = parseCodexImageGenerationEvents(params.body);
  const failure = events.find(
    (event) => event.type === "response.failed" || event.type === "error",
  );
  if (failure) {
    const message =
      failure.error?.message ??
      failure.message ??
      (failure.error?.code ? `OpenAI Codex image generation failed (${failure.error.code})` : "");
    throw new Error(message || "OpenAI Codex image generation failed");
  }
  const completedResponse = events.find((event) => event.type === "response.completed");
  const outputItemImages = events
    .filter(
      (event) =>
        event.type === "response.output_item.done" &&
        event.item?.type === "image_generation_call" &&
        typeof event.item.result === "string" &&
        event.item.result.length > 0,
    )
    .slice(0, OPENAI_MAX_IMAGE_RESULTS)
    .map((event, index) =>
      event.item ? toCodexImage(event.item, index, params.outputFormat) : null,
    )
    .filter((image): image is NonNullable<typeof image> => image !== null);
  const completedOutputImages = (completedResponse?.response?.output ?? [])
    .filter((entry) => entry.type === "image_generation_call")
    .slice(0, OPENAI_MAX_IMAGE_RESULTS)
    .map((entry, index) => toCodexImage(entry, index, params.outputFormat))
    .filter((image): image is NonNullable<typeof image> => image !== null);
  const images = outputItemImages.length > 0 ? outputItemImages : completedOutputImages;

  return {
    images,
    model: params.model,
    ...(completedResponse?.response
      ? {
          metadata: {
            usage: completedResponse.response.usage,
            toolUsage: completedResponse.response.tool_usage,
          },
        }
      : {}),
  };
}

function createOpenAIImageGenerationProviderBase(params: {
  id: "openai";
  label: string;
  isConfigured: ImageGenerationProvider["isConfigured"];
  generateImage: ImageGenerationProvider["generateImage"];
}): ImageGenerationProvider {
  return {
    id: params.id,
    label: params.label,
    defaultModel: DEFAULT_OPENAI_IMAGE_MODEL,
    models: [...OPENAI_IMAGE_MODELS],
    isConfigured: params.isConfigured,
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: OPENAI_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...OPENAI_SUPPORTED_SIZES],
      },
      output: {
        formats: [...OPENAI_OUTPUT_FORMATS],
        qualities: [...OPENAI_QUALITIES],
        backgrounds: [...OPENAI_BACKGROUNDS],
      },
    },
    generateImage: params.generateImage,
  };
}

async function resolveOptionalApiKeyForProvider(
  params: Parameters<typeof resolveApiKeyForProvider>[0],
) {
  try {
    return await resolveApiKeyForProvider(params);
  } catch (error) {
    const provider = params?.provider ?? "";
    const message = error instanceof Error ? error.message : "";
    if (!message.startsWith(`No API key found for provider "${provider}".`)) {
      throw error;
    }
    return null;
  }
}

function logCodexImageAuthSelected(params: {
  req: Parameters<ImageGenerationProvider["generateImage"]>[0];
  authMode?: unknown;
  timeoutMs: number;
}) {
  const model = resolveOpenAIImageRequestModel(params.req, {
    allowTransparentDefaultReroute: true,
  });
  log.info(
    `image auth selected: provider=openai mode=${sanitizeLogValue(
      params.authMode,
    )} transport=codex-responses requestedModel=${sanitizeLogValue(
      model,
    )} responsesModel=${DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL} timeoutMs=${params.timeoutMs}`,
  );
}

async function generateOpenAICodexImage(params: {
  req: Parameters<ImageGenerationProvider["generateImage"]>[0];
  apiKey: string;
}): Promise<ImageGenerationResult> {
  const { req, apiKey } = params;
  const inputImages = req.inputImages ?? [];
  const openAIProviderConfig = req.cfg?.models?.providers?.openai;
  const codexProviderConfig =
    openAIProviderConfig?.api === "openai-chatgpt-responses" ? openAIProviderConfig : undefined;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: canonicalizeCodexResponsesBaseUrl(codexProviderConfig?.baseUrl),
      defaultBaseUrl: DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL,
      defaultHeaders: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      request: sanitizeConfiguredModelProviderRequest(codexProviderConfig?.request),
      provider: "openai",
      api: "openai-chatgpt-responses",
      capability: "image",
      transport: "http",
    });

  const model = resolveOpenAIImageRequestModel(req, {
    allowTransparentDefaultReroute: true,
  });
  const count = resolveOpenAIImageCount(req.count);
  const sizeResolution = resolveOpenAIImageRequestSize({
    model,
    requestedSize: req.size,
    applyNativeLimits: true,
  });
  const size = sizeResolution.size;
  const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs);
  const openai = req.providerOptions?.openai;
  const background = openai?.background ?? req.background;
  const outputCompression = resolveOpenAIImageOutputCompression(req, openai);
  headers.set("Content-Type", "application/json");
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: req.prompt },
    ...inputImages.map((image) => ({
      type: "input_image",
      image_url: toImageDataUrl({ buffer: image.buffer, mimeType: image.mimeType }),
      detail: "auto",
    })),
  ];
  const results: ImageGenerationResult[] = [];
  for (let index = 0; index < count; index += 1) {
    const requestResult = await postJsonRequest({
      url: `${baseUrl}/responses`,
      headers,
      body: {
        model: DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL,
        input: [
          {
            role: "user",
            content,
          },
        ],
        instructions: OPENAI_CODEX_IMAGE_INSTRUCTIONS,
        tools: [
          {
            type: "image_generation",
            model,
            size,
            ...(req.quality !== undefined ? { quality: req.quality } : {}),
            ...(req.outputFormat !== undefined ? { output_format: req.outputFormat } : {}),
            ...(background !== undefined ? { background } : {}),
            ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
          },
        ],
        tool_choice: { type: "image_generation" },
        stream: true,
        store: false,
      },
      timeoutMs,
      fetchFn: fetch,
      allowPrivateNetwork,
      ssrfPolicy: req.ssrfPolicy,
      dispatcherPolicy,
    });
    const { response, release } = requestResult;
    try {
      await assertOkOrThrowHttpError(response, "OpenAI Codex image generation failed");
      results.push(
        extractCodexImageGenerationResult({
          body: await readResponseBodyText(response),
          model,
          outputFormat: req.outputFormat,
        }),
      );
    } finally {
      await release();
    }
  }
  const images = results.flatMap((result) => result.images);
  const output = resolveOutputMime(req.outputFormat);
  return {
    images: images.map((image, index) =>
      Object.assign({}, image, {
        fileName: `image-${index + 1}.${output.extension}`,
      }),
    ),
    model,
    metadata: {
      ...sizeResolution.metadata,
      responses: results.map((result) => result.metadata).filter(Boolean),
    },
  };
}

export function buildOpenAIImageGenerationProvider(): ImageGenerationProvider {
  return createOpenAIImageGenerationProviderBase({
    id: "openai",
    label: "OpenAI",
    isConfigured: ({ cfg, agentDir }) => {
      const configuredBaseUrl = resolveConfiguredOpenAIBaseUrl(cfg);
      const hasPublicOpenAIBaseUrl = isPublicOpenAIImageBaseUrl(configuredBaseUrl);
      const hasChatGPTRouteConfig = hasChatGPTImageRouteConfig(cfg);
      if (
        isProviderApiKeyConfigured({
          provider: "openai",
          agentDir,
        })
      ) {
        return (
          hasPublicOpenAIBaseUrl ||
          hasDirectOpenAIImageApiKeyAuth({ cfg, agentDir }) ||
          (hasChatGPTRouteConfig && hasCodexResponseTransportProfileConfigured({ agentDir }))
        );
      }
      if (!hasPublicOpenAIBaseUrl && !hasChatGPTRouteConfig) {
        return false;
      }
      return hasCodexResponseTransportProfileConfigured({ agentDir });
    },
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const rawBaseUrl = resolveConfiguredOpenAIBaseUrl(req.cfg);
      const publicOpenAIBaseUrl = isPublicOpenAIImageBaseUrl(rawBaseUrl);
      const chatGPTBaseUrl = isOpenAICodexBaseUrl(rawBaseUrl);
      const codexResponsesConfigured =
        req.cfg?.models?.providers?.openai?.api === "openai-chatgpt-responses";
      const explicitOpenAIApiKeyConfig = hasExplicitOpenAIImageApiKeyConfig(req.cfg);
      const explicitDirectOpenAIConfig =
        !chatGPTBaseUrl && !codexResponsesConfigured && hasExplicitDirectOpenAIImageConfig(req.cfg);
      const useCodexResponseTransportRoute =
        (publicOpenAIBaseUrl || chatGPTBaseUrl || codexResponsesConfigured) &&
        !explicitDirectOpenAIConfig &&
        hasCodexResponseTransportProfileConfigured(req);
      let preResolvedImageAuth:
        | NonNullable<Awaited<ReturnType<typeof resolveApiKeyForProvider>>>
        | null
        | undefined;
      if (explicitOpenAIApiKeyConfig) {
        const directAuth = await resolveOptionalApiKeyForProvider({
          provider: "openai",
          cfg: forceOpenAIImageApiKeyAuth(req.cfg),
          agentDir: req.agentDir,
          store: req.authStore,
          credentialPrecedence: "env-first",
        });
        preResolvedImageAuth =
          directAuth?.apiKey && (directAuth.mode === undefined || directAuth.mode === "api-key")
            ? directAuth
            : null;
      }
      if (useCodexResponseTransportRoute) {
        const codexAuth = await resolveOpenAIImageAuth(req);
        if (!codexAuth?.apiKey) {
          throw new Error("OpenAI Codex OAuth missing");
        }
        if (codexAuth.mode === "api-key") {
          preResolvedImageAuth = codexAuth;
        } else {
          const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs);
          logCodexImageAuthSelected({ req, authMode: codexAuth.mode, timeoutMs });
          return generateOpenAICodexImage({ req, apiKey: codexAuth.apiKey });
        }
      }

      let imageAuth:
        | NonNullable<Awaited<ReturnType<typeof resolveApiKeyForProvider>>>
        | null
        | undefined =
        preResolvedImageAuth !== undefined
          ? preResolvedImageAuth
          : await resolveOptionalApiKeyForProvider({
              provider: "openai",
              cfg: req.cfg,
              agentDir: req.agentDir,
              store: req.authStore,
            });
      if (
        !explicitDirectOpenAIConfig &&
        imageAuth?.apiKey &&
        isCodexSubscriptionAuthMode(imageAuth.mode)
      ) {
        if (publicOpenAIBaseUrl) {
          const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs);
          logCodexImageAuthSelected({ req, authMode: imageAuth.mode, timeoutMs });
          return generateOpenAICodexImage({ req, apiKey: imageAuth.apiKey });
        }
        imageAuth = undefined;
      }
      if (!imageAuth?.apiKey) {
        if (!publicOpenAIBaseUrl) {
          throw new Error("OpenAI API key missing");
        }
        throw new Error("OpenAI API key or Codex OAuth missing");
      }
      const isAzure = isAzureOpenAIBaseUrl(rawBaseUrl);
      const openAIProviderConfig = req.cfg?.models?.providers?.openai;

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: rawBaseUrl,
          defaultBaseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
          allowPrivateNetwork: shouldAllowPrivateImageEndpoint(req),
          headers: resolveConfiguredOpenAIImageHeaders(req.cfg),
          request: sanitizeConfiguredModelProviderRequest(openAIProviderConfig?.request),
          api: openAIProviderConfig?.api,
          defaultHeaders: isAzure
            ? { "api-key": imageAuth.apiKey }
            : { Authorization: `Bearer ${imageAuth.apiKey}` },
          provider: "openai",
          capability: "image",
          transport: "http",
        });

      const model = resolveOpenAIImageRequestModel(req, {
        allowTransparentDefaultReroute: publicOpenAIBaseUrl,
      });
      const count = resolveOpenAIImageCount(req.count);
      const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs, { isAzure });
      const sizeResolution = resolveOpenAIImageRequestSize({
        model,
        requestedSize: req.size,
        applyNativeLimits: publicOpenAIBaseUrl || isAzure,
      });
      const size = sizeResolution.size;
      const url = isAzure
        ? buildAzureImageUrl(rawBaseUrl, model, isEdit ? "edits" : "generations")
        : `${baseUrl}/images/${isEdit ? "edits" : "generations"}`;
      const requestResult = isEdit
        ? await (() => {
            const form = new FormData();
            if (!isAzure) {
              form.set("model", model);
            }
            form.set("prompt", req.prompt);
            form.set("n", String(count));
            form.set("size", size);
            appendOpenAIImageOptions(form, req);
            for (const [index, image] of inputImages.entries()) {
              const mimeType = image.mimeType?.trim() || DEFAULT_OUTPUT_MIME;
              form.append(
                "image[]",
                new Blob([new Uint8Array(image.buffer)], { type: mimeType }),
                inferImageUploadFileName({
                  fileName: image.fileName,
                  mimeType,
                  index,
                }),
              );
            }

            const multipartHeaders = new Headers(headers);
            multipartHeaders.delete("Content-Type");
            return postMultipartRequest({
              url,
              headers: multipartHeaders,
              body: form,
              timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              ssrfPolicy: req.ssrfPolicy,
              dispatcherPolicy,
            });
          })()
        : await (() => {
            const jsonHeaders = new Headers(headers);
            jsonHeaders.set("Content-Type", "application/json");
            const body: Record<string, unknown> = {
              prompt: req.prompt,
              n: count,
              size,
            };
            if (!isAzure) {
              body.model = model;
            }
            appendOpenAIImageOptions(body, req);
            return postJsonRequest({
              url,
              headers: jsonHeaders,
              body,
              timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              ssrfPolicy: req.ssrfPolicy,
              dispatcherPolicy,
            });
          })();
      const { response, release } = requestResult;
      try {
        await assertOkOrThrowHttpError(
          response,
          isEdit ? "OpenAI image edit failed" : "OpenAI image generation failed",
        );

        const data = await response.json();
        const output = resolveOutputMime(req.outputFormat);
        const images = parseOpenAiCompatibleImageResponse(data, {
          defaultMimeType: output.mimeType,
          malformedResponseError: isEdit
            ? "OpenAI image edit response malformed"
            : "OpenAI image generation response malformed",
        }).map((image, index) =>
          Object.assign(image, {
            fileName: `image-${index + 1}.${output.extension}`,
          }),
        );
        if (images.length === 0) {
          throw new Error(
            isEdit
              ? "OpenAI image edit response missing image data"
              : "OpenAI image generation response missing image data",
          );
        }

        return {
          images,
          model,
          ...(sizeResolution.metadata ? { metadata: sizeResolution.metadata } : {}),
        };
      } finally {
        await release();
      }
    },
  });
}
