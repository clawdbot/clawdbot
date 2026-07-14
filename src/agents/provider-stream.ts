/**
 * Provider stream registration entry point.
 * Resolves plugin-owned or transport-aware stream functions and registers the
 * model API once a concrete stream implementation exists.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Api, Model } from "../llm/types.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import {
  unwrapHeaderSentinelsForProviderEgress,
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import { createTransportAwareStreamFnForModel } from "./provider-transport-stream.js";
import type { StreamFn } from "./runtime/index.js";

/** Resolves and registers the stream function for a provider-backed model. */
export function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
  registerStream?: boolean;
}): StreamFn | undefined {
  // Plugin stream factories may capture model headers, so construction is the
  // last safe boundary for providers that do not expose the host fetch seam.
  const pluginModel = unwrapModelHeaderSentinelsForProviderEgress(
    params.model,
    "plugin provider stream construction",
  );
  const providerStreamFn = resolveProviderStreamFn({
    provider: params.model.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    allowRuntimePluginLoad: params.allowRuntimePluginLoad,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.model.provider,
      modelId: params.model.id,
      model: pluginModel,
    },
  });
  const transportFallback = providerStreamFn
    ? undefined
    : createTransportAwareStreamFnForModel(
        params.model.api === "google-generative-ai" ? pluginModel : params.model,
        {
          cfg: params.cfg,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          env: params.env,
        },
      );
  const streamFn = providerStreamFn
    ? wrapPluginProviderStream(providerStreamFn)
    : transportFallback && params.model.api === "google-generative-ai"
      ? wrapPluginProviderStream(transportFallback)
      : transportFallback;
  if (!streamFn) {
    return undefined;
  }
  // Register custom APIs only after a concrete stream exists, so later callers
  // can route by model.api without reloading provider runtime hooks.
  if (params.registerStream !== false) {
    ensureCustomApiRegistered(params.model.api, streamFn);
  }
  return streamFn;
}

function wrapPluginProviderStream(streamFn: StreamFn): StreamFn {
  const boundary = "plugin provider stream handoff";
  return (model, context, options) => {
    const apiKey = options?.apiKey
      ? unwrapSecretSentinelsForProviderEgress(options.apiKey, boundary)
      : options?.apiKey;
    const headers = options?.headers
      ? unwrapHeaderSentinelsForProviderEgress(options.headers, boundary)
      : options?.headers;
    const resolvedOptions =
      apiKey === options?.apiKey && headers === options?.headers
        ? options
        : { ...options, apiKey, headers };
    return streamFn(
      unwrapModelHeaderSentinelsForProviderEgress(model, boundary),
      context,
      resolvedOptions,
    );
  };
}
