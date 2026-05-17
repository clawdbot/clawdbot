import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "../agents/minimax-vlm.js";
import {
  getApiKeyForModel,
  requireApiKey,
  resolveApiKeyForProvider,
} from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import { registerProviderStreamForModel } from "../agents/provider-stream.js";
import {
  coerceImageAssistantText,
  hasImageReasoningOnlyResponse,
} from "../agents/tools/image-tool.helpers.js";
import { isSecretRef } from "../config/types.secrets.js";
import {
  buildCopilotIdeHeaders,
  COPILOT_INTEGRATION_ID,
  resolveCopilotApiToken,
} from "../plugin-sdk/provider-auth.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type {
  ImageDescriptionRequest,
  ImageDescriptionResult,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
} from "./types.js";

function resolveImageToolMaxTokens(modelMaxTokens: number | undefined, requestedMaxTokens = 4096) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNativeResponsesReasoningPayload(model: Model<Api>): boolean {
  if (
    model.api !== "openai-responses" &&
    model.api !== "azure-openai-responses" &&
    model.api !== "openai-codex-responses"
  ) {
    return false;
  }
  return resolveProviderRequestCapabilities({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "image",
    transport: "media-understanding",
  }).usesKnownNativeOpenAIRoute;
}

function formatModelInputCapabilities(input: Model<Api>["input"] | undefined): string {
  return input && input.length > 0 ? input.join(", ") : "none";
}

function removeReasoningInclude(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const next = value.filter((entry) => entry !== "reasoning.encrypted_content");
  return next.length > 0 ? next : undefined;
}

function disableReasoningForImageRetryPayload(payload: unknown, model: Model<Api>): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  const next = { ...payload };
  delete next.reasoning;
  delete next.reasoning_effort;

  const include = removeReasoningInclude(next.include);
  if (include === undefined) {
    delete next.include;
  } else {
    next.include = include;
  }

  if (isNativeResponsesReasoningPayload(model)) {
    next.reasoning = { effort: "none" };
  }
  return next;
}

function isImageModelNoTextError(err: unknown): boolean {
  return err instanceof Error && /^Image model returned no text\b/.test(err.message);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function";
}

function composeImageDescriptionPayloadHandlers(
  first: ProviderStreamOptions["onPayload"] | undefined,
  second: ProviderStreamOptions["onPayload"] | undefined,
): ProviderStreamOptions["onPayload"] | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return (payload, payloadModel) => {
    const runSecond = (firstResult: unknown) => {
      const nextPayload = firstResult === undefined ? payload : firstResult;
      const secondResult = second(nextPayload, payloadModel);
      const coerceResult = (resolvedSecond: unknown) =>
        resolvedSecond === undefined ? firstResult : resolvedSecond;
      return isPromiseLike(secondResult)
        ? Promise.resolve(secondResult).then(coerceResult)
        : coerceResult(secondResult);
    };
    const firstResult = first(payload, payloadModel);
    if (isPromiseLike(firstResult)) {
      return Promise.resolve(firstResult).then(runSecond);
    }
    return runSecond(firstResult);
  };
}

async function resolveImageRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
  authStore?: ImageDescriptionRequest["authStore"];
  workspaceDir?: string;
}): Promise<{ apiKey: string; model: Model<Api> }> {
  const resolvedRef = normalizeModelRef(params.provider, params.model);
  const fastResolved = await resolveModelAsync(
    resolvedRef.provider,
    resolvedRef.model,
    params.agentDir,
    params.cfg,
    {
      allowBundledStaticCatalogFallback: true,
      skipPiDiscovery: true,
      skipProviderRuntimeHooks: true,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    },
  );
  if (fastResolved.model?.input?.includes("image")) {
    const normalizedResolved = await resolveModelAsync(
      resolvedRef.provider,
      resolvedRef.model,
      params.agentDir,
      params.cfg,
      {
        allowBundledStaticCatalogFallback: true,
        skipPiDiscovery: true,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      },
    );
    if (normalizedResolved.model?.input?.includes("image")) {
      return await prepareResolvedImageRuntime(
        params,
        normalizedResolved.model,
        normalizedResolved.authStorage,
      );
    }
  }

  const modelsOptions = params.workspaceDir ? { workspaceDir: params.workspaceDir } : undefined;
  await ensureOpenClawModelsJson(params.cfg, params.agentDir, modelsOptions);
  const resolved = await resolveModelAsync(
    resolvedRef.provider,
    resolvedRef.model,
    params.agentDir,
    params.cfg,
    {
      allowBundledStaticCatalogFallback: true,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    },
  );
  const { authStorage } = resolved;
  let { model } = resolved;
  if (!model) {
    throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
  }
  if (!model.input?.includes("image")) {
    // resolveModelWithRegistry may synthesize a text-only fallback for configured
    // providers, which would change "Unknown model" → "Model does not support images"
    // and skip the MiniMax VLM recovery path. Throw Unknown model for MiniMax VLM
    // models so the caller can attempt the fallback.
    if (isMinimaxVlmModel(resolvedRef.provider, resolvedRef.model)) {
      throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
    }
    throw new Error(
      `Model does not support images: ${params.provider}/${params.model} ` +
        `(resolved ${model.provider}/${model.id} input: ${formatModelInputCapabilities(model.input)})`,
    );
  }
  return await prepareResolvedImageRuntime(params, model, authStorage);
}

async function prepareResolvedImageRuntime(
  params: {
    cfg: ImageDescriptionRequest["cfg"];
    agentDir: string;
    provider: string;
    model: string;
    profile?: string;
    preferredProfile?: string;
    authStore?: ImageDescriptionRequest["authStore"];
    workspaceDir?: string;
  },
  resolvedModel: Model<Api>,
  authStorage: Awaited<ReturnType<typeof resolveModelAsync>>["authStorage"],
): Promise<{ apiKey: string; model: Model<Api> }> {
  let model = resolvedModel;
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    store: params.authStore,
  });
  let apiKey = requireApiKey(apiKeyInfo, model.provider);
  // Image tool bypasses prepareRuntimeAuth — exchange OAuth token for
  // a short-lived Copilot API token so the integrator scope (vscode-chat)
  // matches what runtime chat requests send.
  if (model.provider === "github-copilot") {
    const copilotToken = await resolveCopilotApiToken({
      githubToken: apiKey,
    });
    apiKey = copilotToken.token;
    const runtimeBaseUrl = copilotToken.baseUrl?.trim();
    if (runtimeBaseUrl) {
      model = { ...model, baseUrl: runtimeBaseUrl };
    }
  }
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return { apiKey, model };
}

function buildImageContext(
  prompt: string,
  images: Array<{ buffer: Buffer; mime?: string }>,
  opts?: { promptInUserContent?: boolean },
): Context {
  const imageContent = images.map((image) => ({
    type: "image" as const,
    data: image.buffer.toString("base64"),
    mimeType: image.mime ?? "image/jpeg",
  }));
  const content = opts?.promptInUserContent
    ? [{ type: "text" as const, text: prompt }, ...imageContent]
    : imageContent;

  return {
    ...(opts?.promptInUserContent ? {} : { systemPrompt: prompt }),
    messages: [
      {
        role: "user",
        content,
        timestamp: Date.now(),
      },
    ],
  };
}

function shouldPlaceImagePromptInUserContent(model: Model<Api>): boolean {
  // GitHub Copilot models (including Gemini 3.1 Pro Preview) require the
  // prompt text to be in the user message alongside the image. Placing it
  // in a separate system message produces "Request must contain at least
  // one non-empty message" (400).
  if (model.provider === "github-copilot") {
    return true;
  }
  const capabilities = resolveProviderRequestCapabilities({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "image",
    transport: "media-understanding",
  });
  return (
    capabilities.endpointClass === "openrouter" ||
    (model.provider.toLowerCase() === "openrouter" && capabilities.endpointClass === "default")
  );
}

function buildImageRequestHeaders(model: Model<Api>): Record<string, string> | undefined {
  if (model.provider !== "github-copilot") {
    return undefined;
  }
  return {
    ...buildCopilotIdeHeaders(),
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "Openai-Organization": "github-copilot",
    "x-initiator": "user",
    "Copilot-Vision-Request": "true",
  };
}

async function describeImagesWithMinimax(params: {
  apiKey: string;
  provider: string;
  modelId: string;
  modelBaseUrl?: string;
  prompt: string;
  timeoutMs?: number;
  images: Array<{ buffer: Buffer; mime?: string }>;
}): Promise<ImagesDescriptionResult> {
  const responses: string[] = [];
  for (const [index, image] of params.images.entries()) {
    const prompt =
      params.images.length > 1
        ? `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
        : params.prompt;
    const text = await minimaxUnderstandImage({
      apiKey: params.apiKey,
      provider: params.provider,
      prompt,
      imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      modelBaseUrl: params.modelBaseUrl,
      timeoutMs: params.timeoutMs,
    });
    responses.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
  }
  return {
    text: responses.join("\n\n").trim(),
    model: params.modelId,
  };
}

function isUnknownModelError(err: unknown): boolean {
  return err instanceof Error && /^Unknown model:/i.test(err.message);
}

function resolveConfiguredProviderBaseUrl(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): string | undefined {
  const direct = cfg.models?.providers?.[provider];
  if (typeof direct?.baseUrl === "string" && direct.baseUrl.trim()) {
    return direct.baseUrl.trim();
  }
  const normalizedProvider = normalizeMediaProviderId(provider);
  const normalized = cfg.models?.providers?.[normalizedProvider];
  if (typeof normalized?.baseUrl === "string" && normalized.baseUrl.trim()) {
    if (isMinimaxCnAlias(provider) && !isMinimaxCnBaseUrl(normalized.baseUrl)) {
      return undefined;
    }
    return normalized.baseUrl.trim();
  }
  return undefined;
}

function isMinimaxCnAlias(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "minimax-cn" || normalized === "minimax-portal-cn";
}

function isMinimaxCnBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase() === "api.minimaxi.com";
  } catch {
    return false;
  }
}

function hasConfiguredProviderApiKey(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): boolean {
  const apiKey = cfg.models?.providers?.[provider]?.apiKey;
  return (typeof apiKey === "string" && apiKey.trim().length > 0) || isSecretRef(apiKey);
}

function resolveMinimaxVlmAuthProvider(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): string {
  if (!isMinimaxCnAlias(provider) || hasConfiguredProviderApiKey(cfg, provider)) {
    return provider;
  }
  return normalizeMediaProviderId(provider);
}

async function resolveMinimaxVlmFallbackRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  workspaceDir?: string;
  provider: string;
  profile?: string;
  preferredProfile?: string;
}): Promise<{ apiKey: string; modelBaseUrl?: string }> {
  const authProvider = resolveMinimaxVlmAuthProvider(params.cfg, params.provider);
  const auth = await resolveApiKeyForProvider({
    provider: authProvider,
    cfg: params.cfg,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return {
    apiKey: requireApiKey(auth, authProvider),
    modelBaseUrl: resolveConfiguredProviderBaseUrl(params.cfg, params.provider),
  };
}

function resolveImageDescriptionTimeoutMs(timeoutMs: number | undefined, startedAtMs: number) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(timeoutMs - (Date.now() - startedAtMs)));
}

async function withImageDescriptionTimeout<T>(params: {
  task: Promise<T>;
  timeoutMs: number | undefined;
  controller: AbortController;
}): Promise<T> {
  if (params.timeoutMs === undefined) {
    return await params.task;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      params.task,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          params.controller.abort();
          reject(new Error(`image description timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function describeImagesWithModelInternal(
  params: ImagesDescriptionRequest,
  options: { onPayload?: ProviderStreamOptions["onPayload"] } = {},
): Promise<ImagesDescriptionResult> {
  const prompt = params.prompt ?? "Describe the image.";
  const startedAtMs = Date.now();
  const controller = new AbortController();
  let apiKey: string;
  let model: Model<Api> | undefined;

  try {
    const resolved = await withImageDescriptionTimeout({
      controller,
      timeoutMs: resolveImageDescriptionTimeoutMs(params.timeoutMs, startedAtMs),
      task: resolveImageRuntime(params),
    });
    apiKey = resolved.apiKey;
    model = resolved.model;
  } catch (err) {
    if (!isMinimaxVlmModel(params.provider, params.model) || !isUnknownModelError(err)) {
      throw err;
    }
    const fallback = await resolveMinimaxVlmFallbackRuntime(params);
    return await describeImagesWithMinimax({
      apiKey: fallback.apiKey,
      provider: params.provider,
      modelId: params.model,
      modelBaseUrl: fallback.modelBaseUrl,
      prompt,
      timeoutMs: params.timeoutMs,
      images: params.images,
    });
  }

  if (isMinimaxVlmModel(model.provider, model.id)) {
    return await describeImagesWithMinimax({
      apiKey,
      provider: model.provider,
      modelId: model.id,
      modelBaseUrl: model.baseUrl,
      prompt,
      timeoutMs: params.timeoutMs,
      images: params.images,
    });
  }

  const providerStreamFn = registerProviderStreamForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });

  const context = buildImageContext(prompt, params.images, {
    promptInUserContent: shouldPlaceImagePromptInUserContent(model),
  });

  const maxTokens = resolveImageToolMaxTokens(model.maxTokens, params.maxTokens ?? 512);
  const completeImage = async (onPayload?: ProviderStreamOptions["onPayload"]) => {
    const payloadHandler = composeImageDescriptionPayloadHandlers(onPayload, options.onPayload);
    const timeoutMs = resolveImageDescriptionTimeoutMs(params.timeoutMs, startedAtMs);
    const headers = buildImageRequestHeaders(model);
    const streamOptions = {
      apiKey,
      maxTokens,
      signal: controller.signal,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(headers ? { headers } : {}),
      ...(payloadHandler ? { onPayload: payloadHandler } : {}),
    };
    const task: Promise<AssistantMessage> = providerStreamFn
      ? (async () => await (await providerStreamFn(model, context, streamOptions)).result())()
      : complete(model, context, streamOptions);
    return await withImageDescriptionTimeout({
      controller,
      timeoutMs,
      task,
    });
  };

  const message = await completeImage();
  try {
    const text = coerceImageAssistantText({
      message,
      provider: model.provider,
      model: model.id,
    });
    return { text, model: model.id };
  } catch (err) {
    if (!isImageModelNoTextError(err) || !hasImageReasoningOnlyResponse(message)) {
      throw err;
    }
  }

  const retryMessage = await completeImage(disableReasoningForImageRetryPayload);
  const text = coerceImageAssistantText({
    message: retryMessage,
    provider: model.provider,
    model: model.id,
  });
  return { text, model: model.id };
}

export async function describeImagesWithModel(
  params: ImagesDescriptionRequest,
): Promise<ImagesDescriptionResult> {
  return await describeImagesWithModelInternal(params);
}

export async function describeImagesWithModelPayloadTransform(
  params: ImagesDescriptionRequest,
  onPayload: ProviderStreamOptions["onPayload"],
): Promise<ImagesDescriptionResult> {
  return await describeImagesWithModelInternal(params, { onPayload });
}

export async function describeImageWithModel(
  params: ImageDescriptionRequest,
): Promise<ImageDescriptionResult> {
  return await describeImagesWithModel({
    images: [
      {
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.mime,
      },
    ],
    model: params.model,
    provider: params.provider,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
    preferredProfile: params.preferredProfile,
    authStore: params.authStore,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    cfg: params.cfg,
  });
}

export async function describeImageWithModelPayloadTransform(
  params: ImageDescriptionRequest,
  onPayload: ProviderStreamOptions["onPayload"],
): Promise<ImageDescriptionResult> {
  return await describeImagesWithModelPayloadTransform(
    {
      images: [
        {
          buffer: params.buffer,
          fileName: params.fileName,
          mime: params.mime,
        },
      ],
      model: params.model,
      provider: params.provider,
      prompt: params.prompt,
      maxTokens: params.maxTokens,
      timeoutMs: params.timeoutMs,
      profile: params.profile,
      preferredProfile: params.preferredProfile,
      authStore: params.authStore,
      agentDir: params.agentDir,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      cfg: params.cfg,
    },
    onPayload,
  );
}
