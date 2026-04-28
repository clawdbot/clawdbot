import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  postJsonRequest,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  parseOpenAiCompatibleImageResponse,
  type OpenAiCompatibleImageResponsePayload,
} from "./image-assets.js";
import type {
  ImageGenerationProvider,
  ImageGenerationProviderCapabilities,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "./types.js";

type ModelProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];

export type OpenAiCompatibleImageRequestMode = "generate" | "edit";

export type OpenAiCompatibleImageProviderRequestParams = {
  req: ImageGenerationRequest;
  inputImages: ImageGenerationSourceImage[];
  model: string;
  count: number;
  mode: OpenAiCompatibleImageRequestMode;
};

export type OpenAiCompatibleImageProviderRequestBody =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "multipart"; form: FormData };

export type OpenAiCompatibleImageProviderOptions = {
  id: string;
  label: string;
  defaultModel: string;
  models: readonly string[];
  capabilities: ImageGenerationProviderCapabilities;
  defaultBaseUrl: string;
  providerConfigKey?: string;
  normalizeModel?: (model: string | undefined, fallback: string) => string;
  resolveBaseUrl?: (params: {
    req: ImageGenerationRequest;
    providerConfig?: ModelProviderConfig;
    defaultBaseUrl: string;
  }) => string;
  resolveAllowPrivateNetwork?: (params: {
    baseUrl: string;
    req: ImageGenerationRequest;
    providerConfig?: ModelProviderConfig;
  }) => boolean | undefined;
  useConfiguredRequest?: boolean;
  defaultTimeoutMs?: number;
  resolveCount?: (params: {
    req: ImageGenerationRequest;
    mode: OpenAiCompatibleImageRequestMode;
  }) => number;
  buildGenerateRequest: (
    params: OpenAiCompatibleImageProviderRequestParams & { mode: "generate" },
  ) => OpenAiCompatibleImageProviderRequestBody;
  buildEditRequest: (
    params: OpenAiCompatibleImageProviderRequestParams & { mode: "edit" },
  ) => OpenAiCompatibleImageProviderRequestBody;
  response?: {
    defaultMimeType?: string;
    fileNamePrefix?: string;
    sniffMimeType?: boolean;
  };
  missingApiKeyError?: string;
  tooManyInputImagesError?: string;
  missingInputImageError?: string;
  emptyResponseError?: string;
  failureLabels?: {
    generate?: string;
    edit?: string;
  };
};

function readProviderConfig(
  cfg: OpenClawConfig | undefined,
  providerConfigKey: string,
): ModelProviderConfig | undefined {
  return cfg?.models?.providers?.[providerConfigKey];
}

function resolveDefaultModel(model: string | undefined, fallback: string): string {
  return normalizeOptionalString(model) ?? fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function appendImagesPath(baseUrl: string, mode: OpenAiCompatibleImageRequestMode): string {
  return `${trimTrailingSlash(baseUrl)}/images/${mode === "edit" ? "edits" : "generations"}`;
}

function resolveRequestTimeoutMs(params: {
  options: OpenAiCompatibleImageProviderOptions;
  req: ImageGenerationRequest;
  mode: OpenAiCompatibleImageRequestMode;
}): number | undefined {
  if (params.options.defaultTimeoutMs === undefined) {
    return params.req.timeoutMs;
  }
  const label =
    params.mode === "edit"
      ? (params.options.failureLabels?.edit ?? `${params.options.label} image edit`)
      : (params.options.failureLabels?.generate ?? `${params.options.label} image generation`);
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.req.timeoutMs,
    label,
  });
  return resolveProviderOperationTimeoutMs({
    deadline,
    defaultTimeoutMs: params.options.defaultTimeoutMs,
  });
}

export function createOpenAiCompatibleImageGenerationProvider(
  options: OpenAiCompatibleImageProviderOptions,
): ImageGenerationProvider {
  const providerConfigKey = options.providerConfigKey ?? options.id;
  const normalizeModel = options.normalizeModel ?? resolveDefaultModel;
  const resolveCount =
    options.resolveCount ??
    (({ req }) => {
      return req.count ?? 1;
    });

  return {
    id: options.id,
    label: options.label,
    defaultModel: options.defaultModel,
    models: [...options.models],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: options.id,
        agentDir,
      }),
    capabilities: options.capabilities,
    async generateImage(req): Promise<ImageGenerationResult> {
      const inputImages = req.inputImages ?? [];
      const mode: OpenAiCompatibleImageRequestMode = inputImages.length > 0 ? "edit" : "generate";
      const maxInputImages = options.capabilities.edit.maxInputImages;
      if (mode === "edit" && !options.capabilities.edit.enabled) {
        throw new Error(`${options.label} image editing is not supported.`);
      }
      if (mode === "edit" && maxInputImages !== undefined && inputImages.length > maxInputImages) {
        throw new Error(
          options.tooManyInputImagesError ??
            `${options.label} image editing supports up to ${maxInputImages} reference image${
              maxInputImages === 1 ? "" : "s"
            }.`,
        );
      }
      if (mode === "edit" && inputImages.length === 0) {
        throw new Error(
          options.missingInputImageError ?? `${options.label} image edit missing reference image.`,
        );
      }

      const auth = await resolveApiKeyForProvider({
        provider: options.id,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error(options.missingApiKeyError ?? `${options.label} API key missing`);
      }

      const providerConfig = readProviderConfig(req.cfg, providerConfigKey);
      const resolvedBaseUrl =
        options.resolveBaseUrl?.({
          req,
          providerConfig,
          defaultBaseUrl: options.defaultBaseUrl,
        }) ??
        normalizeOptionalString(providerConfig?.baseUrl) ??
        options.defaultBaseUrl;
      const allowPrivateNetwork = options.resolveAllowPrivateNetwork?.({
        baseUrl: resolvedBaseUrl,
        req,
        providerConfig,
      });
      const {
        baseUrl,
        allowPrivateNetwork: resolvedAllowPrivateNetwork,
        headers,
        dispatcherPolicy,
      } = resolveProviderHttpRequestConfig({
        baseUrl: resolvedBaseUrl,
        defaultBaseUrl: options.defaultBaseUrl,
        allowPrivateNetwork,
        request: options.useConfiguredRequest
          ? sanitizeConfiguredModelProviderRequest(providerConfig?.request)
          : undefined,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
        },
        provider: options.id,
        capability: "image",
        transport: "http",
      });

      const model = normalizeModel(req.model, options.defaultModel);
      const count = resolveCount({ req, mode });
      const requestParams = { req, inputImages, model, count, mode };
      const requestBody =
        mode === "edit"
          ? options.buildEditRequest({ ...requestParams, mode })
          : options.buildGenerateRequest({ ...requestParams, mode });
      const timeoutMs = resolveRequestTimeoutMs({ options, req, mode });
      const request =
        requestBody.kind === "multipart"
          ? postMultipartRequest({
              url: appendImagesPath(baseUrl, mode),
              headers: (() => {
                const multipartHeaders = new Headers(headers);
                multipartHeaders.delete("Content-Type");
                return multipartHeaders;
              })(),
              body: requestBody.form,
              timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork: resolvedAllowPrivateNetwork,
              dispatcherPolicy,
            })
          : postJsonRequest({
              url: appendImagesPath(baseUrl, mode),
              headers: (() => {
                const jsonHeaders = new Headers(headers);
                jsonHeaders.set("Content-Type", "application/json");
                return jsonHeaders;
              })(),
              body: requestBody.body,
              timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork: resolvedAllowPrivateNetwork,
              dispatcherPolicy,
            });

      const { response, release } = await request;
      try {
        await assertOkOrThrowHttpError(
          response,
          mode === "edit"
            ? (options.failureLabels?.edit ?? `${options.label} image edit failed`)
            : (options.failureLabels?.generate ?? `${options.label} image generation failed`),
        );
        const images = parseOpenAiCompatibleImageResponse(
          (await response.json()) as OpenAiCompatibleImageResponsePayload,
          options.response,
        );
        if (options.emptyResponseError && images.length === 0) {
          throw new Error(options.emptyResponseError);
        }
        return { images, model };
      } finally {
        await release();
      }
    },
  };
}
