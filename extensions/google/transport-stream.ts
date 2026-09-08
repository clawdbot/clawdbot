// Google plugin module implements transport stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  getEnvApiKey,
  resolveProviderContext,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderCallStreamOptions,
  type ProviderContext,
  type ProviderModel,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type VideoContent,
} from "openclaw/plugin-sdk/llm";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderHttpError,
  providerOperationRetryConfig,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildGuardedModelFetch,
  consumeGoogleGenerateContentStream,
  projectGoogleMessages,
  requiresGoogleToolCallId,
  convertGoogleTools,
  type GoogleStreamChunk as GoogleSseChunk,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  mergeTransportHeaders,
  notifyProviderHttpResponse,
  sanitizeTransportPayloadText,
  stripSystemPromptCacheBoundary,
  transformTransportMessages,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseGeminiAuth } from "./gemini-auth.js";
import { stripGoogleProviderPrefix } from "./model-id.js";
import { isGoogleNativeVideoModelId } from "./provider-models.js";
import { isOfficialGoogleAiStudioBaseUrl, normalizeGoogleApiBaseUrl } from "./provider-policy.js";
import {
  isGoogleGemini25ThinkingBudgetModel,
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  resolveGoogleGemini3ThinkingLevel,
  stripInvalidGoogleThinkingBudget,
  type GoogleThinkingInputLevel,
  type GoogleThinkingLevel,
} from "./thinking-api.js";
import {
  isGoogleVertexCredentialsMarker,
  resolveGoogleVertexAuthorizedUserHeaders,
} from "./vertex-adc.js";

type CanonicalGoogleTransportApi = "google-generative-ai" | "google-vertex";
type GoogleTransportApi = CanonicalGoogleTransportApi | "openclaw-google-generative-ai-transport";

type GoogleTransportModel = ProviderModel<GoogleTransportApi> & {
  headers?: Record<string, string>;
  provider: string;
};

type GoogleTransportOptions = SimpleStreamOptions &
  ProviderCallStreamOptions & {
    cachedContent?: string;
    toolChoice?:
      | "auto"
      | "none"
      | "any"
      | "required"
      | {
          type: "function";
          function: {
            name: string;
          };
        };
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
      level?: GoogleThinkingLevel;
    };
  };

type GoogleGenerateContentRequest = {
  cachedContent?: string;
  contents: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
};

const GOOGLE_NATIVE_VIDEO_MIME: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
]);
const GOOGLE_VIDEO_SLOT_OMISSION = "(video omitted: native video slot unavailable)";
const GOOGLE_VIDEO_MIME_OMISSION = "(video omitted: unsupported Google video MIME type)";
const GOOGLE_REQUEST_BYTES_EXCLUSIVE = 20_000_000;
type GoogleVideoSlots = Map<Record<string, unknown>, VideoContent>;

const GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS = 45_000;
const GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_ENV = "OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS";
const GOOGLE_SSE_EVENT_BOUNDARY_RE = /(?:\r\n|\r(?!\n)|\n){2}/u;
// Compare Google-owned publisher resources without changing outbound request paths.
const GOOGLE_VERTEX_MODEL_RESOURCE_PREFIX =
  /^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google\/models\//u;

type MutableAssistantOutput = AssistantMessage & { api: CanonicalGoogleTransportApi };

const GOOGLE_VERTEX_DEFAULT_API_VERSION = "v1";

let toolCallCounter = 0;
function requiresToolCallThoughtSignature(modelId: string): boolean {
  return isGoogleGemini3ProModel(modelId) || isGoogleGemini3FlashModel(modelId);
}

function normalizeGoogleTransportRouteApi(
  api: string | undefined,
): CanonicalGoogleTransportApi | undefined {
  switch (api) {
    case "google-generative-ai":
    case "openclaw-google-generative-ai-transport":
      return "google-generative-ai";
    case "google-vertex":
      return "google-vertex";
    default:
      return undefined;
  }
}

function normalizeGoogleTransportModelRoute(model: GoogleTransportModel): GoogleTransportModel {
  const api = normalizeGoogleTransportRouteApi(model.api);
  return api && api !== model.api ? Object.assign({}, model, { api }) : model;
}

function canonicalGoogleModel(model: GoogleTransportModel): Model<GoogleTransportApi> {
  return {
    ...model,
    input: model.input.filter((type) => type !== "video"),
  } as Model<GoogleTransportApi>;
}

function supportsGoogleNativeVideo(model: GoogleTransportModel): boolean {
  return (
    model.provider === "google" &&
    normalizeGoogleTransportRouteApi(model.api) === "google-generative-ai" &&
    isOfficialGoogleAiStudioBaseUrl(model.baseUrl) &&
    isGoogleNativeVideoModelId(model.id) &&
    model.input.includes("video")
  );
}

function normalizeGoogleTransportMessageRoutes(messages: Context["messages"]): Context["messages"] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") {
      return msg;
    }
    const api = normalizeGoogleTransportRouteApi(msg.api);
    return api && api !== msg.api ? Object.assign({}, msg, { api }) : msg;
  });
}

function mapToolChoice(
  choice: GoogleTransportOptions["toolChoice"],
): { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] } | undefined {
  if (!choice) {
    return undefined;
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { mode: "ANY", allowedFunctionNames: [choice.function.name] };
  }
  switch (choice) {
    case "none":
      return { mode: "NONE" };
    case "any":
    case "required":
      return { mode: "ANY" };
    default:
      return { mode: "AUTO" };
  }
}

function mapStopReasonString(reason: string): "stop" | "length" | "error" {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    default:
      return "error";
  }
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function resolveGoogleModelPath(modelId: string): string {
  if (modelId.startsWith("models/") || modelId.startsWith("tunedModels/")) {
    return modelId;
  }
  return `models/${stripGoogleProviderPrefix(modelId)}`;
}

function buildGoogleGenerativeAiRequestUrl(model: GoogleTransportModel): string {
  const baseUrl = normalizeGoogleApiBaseUrl(model.baseUrl);
  return `${baseUrl}/${resolveGoogleModelPath(model.id)}:streamGenerateContent?alt=sse`;
}

function resolveGoogleVertexProject(options: GoogleTransportOptions | undefined): string {
  const project =
    normalizeOptionalString((options as { project?: unknown } | undefined)?.project) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalString(process.env.GCLOUD_PROJECT);
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
    );
  }
  return project;
}

function resolveGoogleVertexLocation(options: GoogleTransportOptions | undefined): string {
  const location =
    normalizeOptionalString((options as { location?: unknown } | undefined)?.location) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_LOCATION);
  if (!location) {
    throw new Error(
      "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.",
    );
  }
  return location;
}

function resolveGoogleVertexBaseOrigin(model: GoogleTransportModel, location: string): string {
  const configured = normalizeOptionalString(model.baseUrl);
  if (configured && !configured.includes("{location}")) {
    try {
      const url = new URL(configured);
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/u, "");
    } catch {
      return configured.replace(/\/+$/u, "");
    }
  }
  if (location === "global") {
    return "https://aiplatform.googleapis.com";
  }
  // Multi-region locations (eu, us) use the dedicated .rep.googleapis.com host
  // with the location embedded in the host, matching @google/genai SDK behavior.
  // A regional prefix (eu-aiplatform.googleapis.com) returns an HTML 404.
  if (location === "eu" || location === "us") {
    return `https://aiplatform.${location}.rep.googleapis.com`;
  }
  return `https://${location}-aiplatform.googleapis.com`;
}

function buildGoogleVertexRequestUrl(
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): string {
  const project = encodeURIComponent(resolveGoogleVertexProject(options));
  const location = encodeURIComponent(resolveGoogleVertexLocation(options));
  // Mirror resolveGoogleModelPath: strip the google/ provider prefix so a
  // provider-qualified id does not become an invalid models/google%2F... path.
  const modelId = encodeURIComponent(stripGoogleProviderPrefix(model.id));
  const origin = resolveGoogleVertexBaseOrigin(model, decodeURIComponent(location));
  return `${origin}/${GOOGLE_VERTEX_DEFAULT_API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`;
}

function resolveThinkingLevel(level: ThinkingLevel, modelId: string): GoogleThinkingLevel {
  const resolved = resolveGoogleGemini3ThinkingLevel({ modelId, thinkingLevel: level });
  if (resolved) {
    return resolved;
  }
  throw new Error("Unsupported thinking level");
}

function resolveExplicitThinkingLevel(
  level: GoogleThinkingLevel,
  modelId: string,
): GoogleThinkingLevel {
  return (
    resolveGoogleGemini3ThinkingLevel({
      modelId,
      thinkingLevel: level.toLowerCase() as GoogleThinkingInputLevel,
    }) ?? level
  );
}

function getDisabledThinkingConfig(modelId: string): Record<string, unknown> | undefined {
  const thinkingLevel = resolveGoogleGemini3ThinkingLevel({ modelId, thinkingLevel: "off" });
  if (thinkingLevel) {
    return { thinkingLevel };
  }
  return normalizeGoogleThinkingConfig(modelId, { thinkingBudget: 0 });
}

function getGoogleThinkingBudget(
  modelId: string,
  effort: ThinkingLevel,
  customBudgets?: GoogleTransportOptions["thinkingBudgets"],
): number | undefined {
  const normalizedEffort = effort === "xhigh" || effort === "max" ? "high" : effort;
  if (customBudgets?.[normalizedEffort] !== undefined) {
    return customBudgets[normalizedEffort];
  }
  if (modelId.includes("2.5-pro")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[normalizedEffort];
  }
  if (modelId.includes("2.5-flash-lite")) {
    return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[normalizedEffort];
  }
  if (modelId.includes("2.5-flash")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[normalizedEffort];
  }
  return undefined;
}

function isAdaptiveReasoningLevel(value: unknown): value is "adaptive" {
  return value === "adaptive";
}

function resolveGoogleThinkingConfig(
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): Record<string, unknown> | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  if (options?.thinking) {
    if (!options.thinking.enabled) {
      return getDisabledThinkingConfig(model.id);
    }
    const config: Record<string, unknown> = { includeThoughts: true };
    if (options.thinking.level) {
      config.thinkingLevel = resolveExplicitThinkingLevel(options.thinking.level, model.id);
    } else if (typeof options.thinking.budgetTokens === "number") {
      const thinkingLevel = resolveGoogleGemini3ThinkingLevel({
        modelId: model.id,
        thinkingBudget: options.thinking.budgetTokens,
      });
      if (thinkingLevel) {
        config.thinkingLevel = thinkingLevel;
      } else {
        config.thinkingBudget = options.thinking.budgetTokens;
      }
    }
    return normalizeGoogleThinkingConfig(model.id, config);
  }
  if (!options?.reasoning || options.reasoning === "off") {
    return getDisabledThinkingConfig(model.id);
  }
  if (isAdaptiveReasoningLevel(options.reasoning)) {
    if (isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id)) {
      return { includeThoughts: true };
    }
    if (isGoogleGemini25ThinkingBudgetModel(model.id)) {
      return normalizeGoogleThinkingConfig(model.id, {
        includeThoughts: true,
        thinkingBudget: -1,
      });
    }
  }
  if (isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id)) {
    return {
      includeThoughts: true,
      thinkingLevel: resolveThinkingLevel(options.reasoning, model.id),
    };
  }
  const budget = getGoogleThinkingBudget(model.id, options.reasoning, options.thinkingBudgets);
  return normalizeGoogleThinkingConfig(model.id, {
    includeThoughts: true,
    ...(typeof budget === "number" ? { thinkingBudget: budget } : {}),
  });
}

function normalizeGoogleThinkingConfig(
  modelId: string,
  thinkingConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  stripInvalidGoogleThinkingBudget({ thinkingConfig, modelId });
  return Object.keys(thinkingConfig).length > 0 ? thinkingConfig : undefined;
}

function convertGoogleMessages(
  model: GoogleTransportModel,
  context: Context | ProviderContext,
  videoSlots?: GoogleVideoSlots,
) {
  const routeModel = normalizeGoogleTransportModelRoute(model);
  return projectGoogleMessages({
    model: routeModel,
    messages: transformTransportMessages(
      normalizeGoogleTransportMessageRoutes(context.messages as Context["messages"]),
      canonicalGoogleModel(routeModel),
      (id) => (requiresGoogleToolCallId(model.id) ? normalizeToolCallId(id) : id),
      { preserveCrossModelToolCallThoughtSignature: requiresToolCallThoughtSignature(model.id) },
    ) as ProviderContext["messages"],
    replay: "managed",
    requiresToolCallSignature: requiresToolCallThoughtSignature(model.id),
    videoPart: (video) => {
      const placeholder = { text: GOOGLE_VIDEO_SLOT_OMISSION };
      videoSlots?.set(placeholder, video);
      return placeholder;
    },
  });
}

export function buildGoogleGenerativeAiParams(
  model: GoogleTransportModel,
  context: Context | ProviderContext,
  options?: GoogleTransportOptions,
  videoSlots?: GoogleVideoSlots,
): GoogleGenerateContentRequest {
  const generationConfig: Record<string, unknown> = {};
  if (typeof options?.temperature === "number") {
    generationConfig.temperature = options.temperature;
  }
  if (typeof options?.maxTokens === "number") {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    generationConfig.stopSequences = options.stop;
  }
  const thinkingConfig = resolveGoogleThinkingConfig(model, options);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const params: GoogleGenerateContentRequest = {
    contents: convertGoogleMessages(model, context, videoSlots),
  };
  const cachedContent =
    typeof options?.cachedContent === "string" ? options.cachedContent.trim() : "";
  if (cachedContent) {
    params.cachedContent = cachedContent;
  }
  if (Object.keys(generationConfig).length > 0) {
    params.generationConfig = generationConfig;
  }
  if (!cachedContent && context.systemPrompt) {
    params.systemInstruction = {
      parts: [
        {
          text: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
        },
      ],
    };
  }
  if (!cachedContent && context.tools?.length) {
    params.tools = convertGoogleTools(context.tools);
    const toolChoice = mapToolChoice(options?.toolChoice);
    if (toolChoice) {
      params.toolConfig = {
        functionCallingConfig: toolChoice,
      };
    }
  }
  return params;
}

function replaceGooglePartWithText(part: Record<string, unknown>, text: string): void {
  Object.keys(part).forEach((key) => Reflect.deleteProperty(part, key));
  part.text = text;
}

function materializeGoogleVideoSlots(
  request: GoogleGenerateContentRequest,
  slots: GoogleVideoSlots,
): Record<string, unknown>[] {
  const trusted: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const video = slots.get(value);
    if (video) {
      if (!GOOGLE_NATIVE_VIDEO_MIME.has(video.mimeType)) {
        replaceGooglePartWithText(value, GOOGLE_VIDEO_MIME_OMISSION);
        return;
      }
      Object.keys(value).forEach((key) => Reflect.deleteProperty(value, key));
      value.inlineData = { mimeType: video.mimeType, data: video.data };
      trusted.push(value);
      return;
    }
    const inlineData = isRecord(value.inlineData) ? value.inlineData : undefined;
    if (normalizeLowercaseStringOrEmpty(inlineData?.mimeType).startsWith("video/")) {
      replaceGooglePartWithText(value, GOOGLE_VIDEO_SLOT_OMISSION);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(request);
  return trusted;
}

function serializeGoogleRequest(
  request: GoogleGenerateContentRequest,
  videoSlots: Record<string, unknown>[],
): string {
  let body = JSON.stringify(request);
  for (const slot of videoSlots.toReversed()) {
    if (Buffer.byteLength(body, "utf8") < GOOGLE_REQUEST_BYTES_EXCLUSIVE) {
      break;
    }
    replaceGooglePartWithText(slot, GOOGLE_VIDEO_SLOT_OMISSION);
    body = JSON.stringify(request);
  }
  if (Buffer.byteLength(body, "utf8") >= GOOGLE_REQUEST_BYTES_EXCLUSIVE) {
    throw new Error(
      `Google request body must be smaller than ${GOOGLE_REQUEST_BYTES_EXCLUSIVE} bytes`,
    );
  }
  return body;
}

function buildGoogleHeaders(
  model: GoogleTransportModel,
  apiKey: string | undefined,
  optionHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const authHeaders = apiKey ? parseGeminiAuth(apiKey).headers : undefined;
  return (
    resolveProviderRequestHeaders({
      provider: model.provider,
      api: normalizeGoogleTransportRouteApi(model.api),
      baseUrl: model.baseUrl,
      capability: "llm",
      transport: "stream",
      defaultHeaders: mergeTransportHeaders(
        {
          "Content-Type": "application/json",
          accept: "text/event-stream",
        },
        authHeaders,
        model.headers,
      ),
      callerHeaders: optionHeaders,
      precedence: "caller-wins",
    }) ?? {
      "Content-Type": "application/json",
      accept: "text/event-stream",
    }
  );
}

function isGoogleOauthApiKey(apiKey: string | undefined): boolean {
  return Boolean(
    apiKey?.trimStart().startsWith("{") && parseGeminiAuth(apiKey).headers.Authorization,
  );
}

function hasGoogleAuthHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => {
    const normalized = name.trim().toLowerCase();
    return normalized === "authorization" || normalized === "x-goog-api-key";
  });
}

function collectGoogleTransportApiKeys(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
  options: GoogleTransportOptions | undefined;
  primaryApiKey: string | undefined;
}): string[] {
  if (
    params.kind !== "google-generative-ai" ||
    !isOfficialGoogleAiStudioBaseUrl(params.model.baseUrl) ||
    isGoogleOauthApiKey(params.primaryApiKey) ||
    hasGoogleAuthHeader(params.model.headers) ||
    hasGoogleAuthHeader(params.options?.headers)
  ) {
    return [];
  }
  return collectProviderApiKeysForExecution({
    provider: params.model.provider,
    primaryApiKey: params.primaryApiKey,
  });
}

async function buildGoogleVertexHeaders(
  model: GoogleTransportModel,
  apiKey: string | undefined,
  optionHeaders: Record<string, string> | undefined,
  fetchImpl?: typeof fetch,
): Promise<Record<string, string>> {
  const authHeaders = isGoogleVertexCredentialsMarker(apiKey)
    ? await resolveGoogleVertexAuthorizedUserHeaders(fetchImpl)
    : { "x-goog-api-key": apiKey };
  return (
    mergeTransportHeaders(
      {
        "Content-Type": "application/json",
        accept: "text/event-stream",
      },
      authHeaders,
      model.headers,
      optionHeaders,
    ) ?? {
      "Content-Type": "application/json",
      accept: "text/event-stream",
    }
  );
}

function buildGoogleTransportRequestUrl(
  kind: CanonicalGoogleTransportApi,
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): string {
  return kind === "google-vertex"
    ? buildGoogleVertexRequestUrl(model, options)
    : buildGoogleGenerativeAiRequestUrl(model);
}

function resolveGoogleGemini3FirstResponseRetryMs(env = process.env): number {
  const raw = env[GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_ENV];
  if (raw === undefined || raw.trim() === "") {
    return GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS;
  }
  return parseStrictNonNegativeInteger(raw) ?? GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS;
}

function shouldRetryGoogleGemini3FirstResponse(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
}): boolean {
  if (params.kind !== "google-generative-ai") {
    return false;
  }
  if (!isOfficialGoogleAiStudioBaseUrl(params.model.baseUrl)) {
    return false;
  }
  return isGoogleGemini3ProModel(params.model.id) || isGoogleGemini3FlashModel(params.model.id);
}

function resolveGoogleGemini3RetryThinkingLevel(modelId: string): GoogleThinkingLevel | undefined {
  if (isGoogleGemini3ProModel(modelId)) {
    return "LOW";
  }
  if (isGoogleGemini3FlashModel(modelId)) {
    return "MINIMAL";
  }
  return undefined;
}

function cloneGoogleGenerateContentRequest(
  params: GoogleGenerateContentRequest,
): GoogleGenerateContentRequest {
  const serialized = JSON.stringify(params);
  return JSON.parse(serialized) as GoogleGenerateContentRequest;
}

function buildGoogleGemini3FirstResponseRetryParams(params: {
  model: GoogleTransportModel;
  request: GoogleGenerateContentRequest;
}): GoogleGenerateContentRequest | undefined {
  const thinkingLevel = resolveGoogleGemini3RetryThinkingLevel(params.model.id);
  if (!thinkingLevel) {
    return undefined;
  }
  const retryRequest = cloneGoogleGenerateContentRequest(params.request);
  const generationConfig =
    retryRequest.generationConfig && typeof retryRequest.generationConfig === "object"
      ? retryRequest.generationConfig
      : {};
  const thinkingConfig =
    generationConfig.thinkingConfig && typeof generationConfig.thinkingConfig === "object"
      ? { ...(generationConfig.thinkingConfig as Record<string, unknown>) }
      : {};

  // Gemini 3 defaults to dynamic high thinking when the request omits an
  // explicit level. On a zero-output stall, retry with the smallest supported
  // native level and suppress thought streaming so the recovery call prioritizes
  // producing a visible first token.
  delete thinkingConfig.thinkingBudget;
  delete thinkingConfig.includeThoughts;
  thinkingConfig.thinkingLevel = thinkingLevel;
  generationConfig.thinkingConfig = thinkingConfig;
  retryRequest.generationConfig = generationConfig;
  return retryRequest;
}

function createChildSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => {
    controller.abort(parent?.reason);
  };
  if (parent) {
    if (parent.aborted) {
      abortFromParent();
    } else {
      parent.addEventListener("abort", abortFromParent, { once: true });
    }
  }
  if (!controller.signal.aborted && timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      timeout = undefined;
      controller.abort(new Error("Google Gemini first response retry deadline reached"));
    }, timeoutMs);
    timeout.unref?.();
  }
  const clearDeadline = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clearDeadline,
    cleanup: () => {
      clearDeadline();
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function iteratorToAsyncGenerator<T>(
  iterator: AsyncIterator<T>,
  cleanup?: () => void,
): AsyncGenerator<T> {
  return (async function* () {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } finally {
      cleanup?.();
      await iterator.return?.();
    }
  })();
}

type GoogleSseAttempt =
  | {
      type: "ready";
      firstChunk?: GoogleSseChunk;
      chunks: AsyncGenerator<GoogleSseChunk>;
    }
  | { type: "timeout" };

async function notifyGoogleTransportHttpResponse(
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  await notifyProviderHttpResponse({
    options,
    response,
    model: canonicalGoogleModel(model),
    signal,
  });
}

async function openGoogleSseAttempt(params: {
  guardedFetch: ReturnType<typeof buildGuardedModelFetch>;
  url: string;
  headers: Record<string, string>;
  request: GoogleGenerateContentRequest;
  videoSlots: Record<string, unknown>[];
  parentSignal?: AbortSignal;
  firstResponseTimeoutMs: number;
  errorPrefix: string;
  model: GoogleTransportModel;
  options: GoogleTransportOptions | undefined;
}): Promise<GoogleSseAttempt> {
  const attemptSignal =
    params.firstResponseTimeoutMs > 0
      ? createChildSignal(params.parentSignal, params.firstResponseTimeoutMs)
      : undefined;
  const signal = attemptSignal?.signal ?? params.parentSignal;
  const handleTimedOperationError = (error: unknown): GoogleSseAttempt => {
    attemptSignal?.cleanup();
    if (attemptSignal?.timedOut() && !params.parentSignal?.aborted) {
      return { type: "timeout" };
    }
    throw error;
  };
  let response: Response;
  try {
    response = await params.guardedFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: serializeGoogleRequest(params.request, params.videoSlots),
      signal,
    });
  } catch (error) {
    return handleTimedOperationError(error);
  }
  try {
    // Response hooks share the first-response deadline. A stalled hook must cancel
    // the unread body and enter the same Gemini fallback as a stalled fetch or body.
    await notifyGoogleTransportHttpResponse(params.model, params.options, response, signal);
  } catch (error) {
    return handleTimedOperationError(error);
  }
  if (!response.ok) {
    attemptSignal?.cleanup();
    throw await createProviderHttpError(response, params.errorPrefix);
  }
  const chunks = parseGoogleSseChunks(response, signal);
  const iterator = chunks[Symbol.asyncIterator]();
  let first: IteratorResult<GoogleSseChunk>;
  try {
    first = await iterator.next();
  } catch (error) {
    return handleTimedOperationError(error);
  }
  attemptSignal?.clearDeadline();
  if (first.done) {
    return {
      type: "ready",
      chunks: iteratorToAsyncGenerator(iterator, attemptSignal?.cleanup),
    };
  }
  return {
    type: "ready",
    firstChunk: first.value,
    chunks: iteratorToAsyncGenerator(iterator, attemptSignal?.cleanup),
  };
}

async function openGoogleSseChunks(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
  options: GoogleTransportOptions | undefined;
  guardedFetch: ReturnType<typeof buildGuardedModelFetch>;
  url: string;
  headers: Record<string, string>;
  request: GoogleGenerateContentRequest;
  videoSlots: Record<string, unknown>[];
}): Promise<Extract<GoogleSseAttempt, { type: "ready" }>> {
  const errorPrefix =
    params.kind === "google-vertex"
      ? "Google Vertex AI API error"
      : "Google Generative AI API error";
  if (!shouldRetryGoogleGemini3FirstResponse({ kind: params.kind, model: params.model })) {
    const response = await params.guardedFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: serializeGoogleRequest(params.request, params.videoSlots),
      signal: params.options?.signal,
    });
    await notifyGoogleTransportHttpResponse(
      params.model,
      params.options,
      response,
      params.options?.signal,
    );
    if (!response.ok) {
      throw await createProviderHttpError(response, errorPrefix);
    }
    return {
      type: "ready",
      chunks: parseGoogleSseChunks(response, params.options?.signal),
    };
  }

  const retryMs = resolveGoogleGemini3FirstResponseRetryMs();
  if (retryMs <= 0) {
    const response = await params.guardedFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: serializeGoogleRequest(params.request, params.videoSlots),
      signal: params.options?.signal,
    });
    await notifyGoogleTransportHttpResponse(
      params.model,
      params.options,
      response,
      params.options?.signal,
    );
    if (!response.ok) {
      throw await createProviderHttpError(response, errorPrefix);
    }
    return {
      type: "ready",
      chunks: parseGoogleSseChunks(response, params.options?.signal),
    };
  }

  const firstAttempt = await openGoogleSseAttempt({
    guardedFetch: params.guardedFetch,
    url: params.url,
    headers: params.headers,
    request: params.request,
    videoSlots: params.videoSlots,
    parentSignal: params.options?.signal,
    firstResponseTimeoutMs: retryMs,
    errorPrefix,
    model: params.model,
    options: params.options,
  });
  if (firstAttempt.type === "ready") {
    return firstAttempt;
  }

  // The first serialization owns video shedding. Clone only after it times out
  // so the retry inherits those exact omissions instead of restoring stale bytes.
  const retryRequest = buildGoogleGemini3FirstResponseRetryParams({
    model: params.model,
    request: params.request,
  })!;
  const retryAttempt = await openGoogleSseAttempt({
    guardedFetch: params.guardedFetch,
    url: params.url,
    headers: params.headers,
    request: retryRequest,
    videoSlots: params.videoSlots,
    parentSignal: params.options?.signal,
    firstResponseTimeoutMs: 0,
    errorPrefix,
    model: params.model,
    options: params.options,
  });
  if (retryAttempt.type === "timeout") {
    throw new Error("Google Gemini first response retry timed out unexpectedly");
  }
  return retryAttempt;
}

async function buildGoogleTransportHeaders(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
  apiKey: string | undefined;
  optionHeaders: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, string>> {
  return params.kind === "google-vertex"
    ? await buildGoogleVertexHeaders(
        params.model,
        params.apiKey,
        params.optionHeaders,
        params.fetchImpl,
      )
    : buildGoogleHeaders(params.model, params.apiKey, params.optionHeaders);
}

async function* parseGoogleSseChunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GoogleSseChunk> {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const abortHandler = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler);
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      // Cancellation settles a pending read as done; never mistake that for EOF.
      signal?.throwIfAborted();
      if (done) {
        buffer += decoder.decode();
        const trailingData = buffer
          .split(/\r\n|\n|\r/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        const trailingPayload = trailingData || buffer.trim();
        if (!trailingPayload || (!trailingData && !trailingPayload.startsWith("{"))) {
          completed = true;
          break;
        }
        let trailingChunk: unknown;
        try {
          trailingChunk = JSON.parse(trailingPayload);
        } catch {
          throw new Error("Google SSE stream ended with an incomplete frame");
        }
        if (!isRecord(trailingChunk) || !isRecord(trailingChunk.error)) {
          throw new Error("Google SSE stream ended with an incomplete frame");
        }
        // Provider errors can arrive as bare JSON or data frames without their final delimiter.
        buffer = `data: ${JSON.stringify(trailingChunk)}\n\n`;
      } else {
        buffer += decoder.decode(value, { stream: true });
      }
      let boundary = GOOGLE_SSE_EVENT_BOUNDARY_RE.exec(buffer);
      while (boundary) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        boundary = GOOGLE_SSE_EVENT_BOUNDARY_RE.exec(buffer);
        const data = rawEvent
          .split(/\r\n|\n|\r/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") {
          continue;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new Error("Google SSE stream returned malformed JSON");
        }
        if (isRecord(chunk) && isRecord(chunk.error)) {
          const providerError = chunk.error;
          throw Object.assign(
            new Error(normalizeOptionalString(providerError.message) ?? "Google stream failed"),
            {
              code: normalizeOptionalString(providerError.status) ?? "GOOGLE_STREAM_ERROR",
              status: typeof providerError.code === "number" ? providerError.code : undefined,
              type: "google_stream_failed",
            },
          );
        }
        yield chunk as GoogleSseChunk;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    if (!completed) {
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function createGoogleTransportStreamFn(kind: CanonicalGoogleTransportApi): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as GoogleTransportModel;
    const canonicalModel = canonicalGoogleModel(model);
    const options = rawOptions as GoogleTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant",
        content: [],
        api: kind,
        provider: model.provider,
        model: model.id,
        usage: createEmptyTransportUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? undefined;
        const guardedFetch = buildGuardedModelFetch(canonicalModel);
        const providerContext = supportsGoogleNativeVideo(model)
          ? await resolveProviderContext(context, options)
          : context;
        const videoSlots: GoogleVideoSlots = new Map();
        let params = buildGoogleGenerativeAiParams(model, providerContext, options, videoSlots);
        const nextParams = await options?.onPayload?.(params, canonicalModel);
        if (nextParams !== undefined) {
          params = nextParams as GoogleGenerateContentRequest;
        }
        const trustedVideoSlots = materializeGoogleVideoSlots(params, videoSlots);
        const requestUrl = buildGoogleTransportRequestUrl(kind, model, options);
        const fetchImpl = (options as { fetch?: typeof fetch } | undefined)?.fetch;
        const openSse = async (apiKeyForRequest: string | undefined) => {
          const requestHeaders = await buildGoogleTransportHeaders({
            kind,
            model,
            apiKey: apiKeyForRequest,
            optionHeaders: options?.headers,
            fetchImpl,
          });
          return await openGoogleSseChunks({
            kind,
            model,
            options,
            guardedFetch,
            url: requestUrl,
            headers: requestHeaders,
            request: params,
            videoSlots: trustedVideoSlots,
          });
        };
        const apiKeys = collectGoogleTransportApiKeys({
          kind,
          model,
          options,
          primaryApiKey: apiKey,
        });
        const sse =
          apiKeys.length > 0
            ? await executeWithApiKeyRotation({
                provider: model.provider,
                apiKeys,
                transientRetry: providerOperationRetryConfig("read"),
                execute: openSse,
              })
            : await openSse(apiKey);
        const chunks =
          sse.firstChunk === undefined
            ? sse.chunks
            : (async function* (firstChunk: GoogleSseChunk) {
                yield firstChunk;
                yield* sse.chunks;
              })(sse.firstChunk);
        await consumeGoogleGenerateContentStream({
          chunks,
          model: canonicalModel,
          output,
          stream,
          signal: options?.signal,
          nextToolCallId: (name) => `${name || "tool"}_${Date.now()}_${++toolCallCounter}`,
          // Managed SSE has always accumulated text deltas; the SDK preserves signed Parts.
          profile: "managed",
          normalizeModelId: (id) =>
            resolveGoogleModelPath(id.replace(GOOGLE_VERTEX_MODEL_RESOURCE_PREFIX, "")),
          resolveStopReason: mapStopReasonString,
        });
      } catch (error) {
        failTransportStream({ stream, output, signal: options?.signal, error });
      }
    })();
    return eventStream;
  };
}

export function createGoogleGenerativeAiTransportStreamFn(): StreamFn {
  return createGoogleTransportStreamFn("google-generative-ai");
}

export function createGoogleVertexTransportStreamFn(): StreamFn {
  return createGoogleTransportStreamFn("google-vertex");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
