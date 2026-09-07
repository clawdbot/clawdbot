// Public video-generation helpers and types for provider plugins.

import {
  DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_MODELS,
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
  DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
  runDashscopeVideoGenerationTask,
} from "../video-generation/dashscope-compatible.js";
import type { VideoGenerationProvider, VideoGenerationResult } from "../video-generation/types.js";
import { resolveApiKeyForProvider } from "./provider-auth-runtime.js";
import { isProviderApiKeyConfigured } from "./provider-auth.js";
import {
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "./provider-http.js";

export type {
  GeneratedVideoAsset,
  VideoGenerationResolution,
  VideoGenerationAssetRole,
  VideoGenerationSourceAsset,
  VideoGenerationProviderConfiguredContext,
  VideoGenerationModelCapabilitiesContext,
  VideoGenerationRequest,
  VideoGenerationResult,
  VideoGenerationMode,
  VideoGenerationProviderOptionType,
  VideoGenerationModeCapabilities,
  VideoGenerationTransformCapabilities,
  VideoGenerationProviderCapabilities,
  VideoGenerationCatalogModelEntry,
  VideoGenerationProvider,
} from "../video-generation/types.js";

export type DashscopeVideoGenerationProviderOptions = {
  providerId: string;
  label: string;
  taskLabel: string;
  apiKeyLabel?: string;
  defaultBaseUrl: string;
  resolveRequestBaseUrl?: (configuredBaseUrl: string | undefined) => string;
  resolveAigcBaseUrl?: (baseUrl: string) => string;
  credentialPolicy?: {
    acceptsApiKey: (apiKey: string) => boolean;
    acceptsBaseUrl?: (configuredBaseUrl: string | undefined) => boolean;
    unsupportedMessage: string;
  };
};

/** Builds one provider descriptor for the shared DashScope async video task protocol. */
export function buildDashscopeVideoGenerationProvider(
  options: DashscopeVideoGenerationProviderOptions,
): VideoGenerationProvider {
  const resolveRequestBaseUrl =
    options.resolveRequestBaseUrl ??
    ((configuredBaseUrl) => configuredBaseUrl?.trim() || options.defaultBaseUrl);
  const resolveAigcBaseUrl =
    options.resolveAigcBaseUrl ?? ((baseUrl) => baseUrl.replace(/\/+$/u, ""));

  return {
    id: options.providerId,
    label: options.label,
    defaultModel: DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
    models: [...DASHSCOPE_WAN_VIDEO_MODELS],
    catalogByModel: DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL,
    resolveModelCapabilities: ({ model }) =>
      DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL[model]?.capabilities,
    isConfigured: (ctx) => {
      const baseUrl = ctx.cfg?.models?.providers?.[options.providerId]?.baseUrl;
      if (options.credentialPolicy?.acceptsBaseUrl?.(baseUrl) === false) {
        return false;
      }
      return isProviderApiKeyConfigured({
        provider: options.providerId,
        ...ctx,
        profileTypes: options.credentialPolicy ? ["api_key"] : undefined,
        acceptsApiKey: options.credentialPolicy?.acceptsApiKey,
      });
    },
    capabilities: DASHSCOPE_WAN_VIDEO_CAPABILITIES,
    async generateVideo(req): Promise<VideoGenerationResult> {
      const providerConfig = req.cfg?.models?.providers?.[options.providerId];
      if (options.credentialPolicy?.acceptsBaseUrl?.(providerConfig?.baseUrl) === false) {
        throw new Error(options.credentialPolicy.unsupportedMessage);
      }
      const auth = await resolveApiKeyForProvider({
        provider: options.providerId,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error(`${options.apiKeyLabel ?? options.label} API key missing`);
      }
      if (options.credentialPolicy?.acceptsApiKey(auth.apiKey) === false) {
        throw new Error(options.credentialPolicy.unsupportedMessage);
      }

      const requestBaseUrl = resolveRequestBaseUrl(providerConfig?.baseUrl);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: requestBaseUrl,
          defaultBaseUrl: options.defaultBaseUrl,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
          },
          provider: options.providerId,
          capability: "video",
          transport: "http",
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
        });
      const aigcBaseUrl = resolveAigcBaseUrl(baseUrl);

      return await runDashscopeVideoGenerationTask({
        providerLabel: options.taskLabel,
        model: req.model?.trim() || DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
        req,
        url: `${aigcBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
        headers,
        baseUrl: aigcBaseUrl,
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
        defaultTimeoutMs: DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
      });
    },
  };
}

export {
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_MODELS,
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
  DEFAULT_VIDEO_GENERATION_DURATION_SECONDS,
  DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
  DEFAULT_VIDEO_RESOLUTION_TO_SIZE,
  buildDashscopeVideoGenerationInput,
  buildDashscopeVideoGenerationParameters,
  downloadDashscopeGeneratedVideos,
  extractDashscopeVideoUrls,
  pollDashscopeVideoTaskUntilComplete,
  resolveVideoGenerationReferenceUrls,
  runDashscopeVideoGenerationTask,
} from "../video-generation/dashscope-compatible.js";

export type { DashscopeVideoGenerationResponse } from "../video-generation/dashscope-compatible.js";
