/**
 * Provider stream registration entry point.
 * Resolves plugin-owned or transport-aware stream functions and registers the
 * model API once a concrete stream implementation exists.
 */
import type { ApiRegistry } from "@openclaw/ai";
import "./ai-transport-runtime-host.js";
import { createTransportAwareStreamFnForModel } from "@openclaw/ai/transports";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { Api, Model } from "../llm/types.js";
import {
  attachModelProviderRuntimePluginHandle,
  getModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import {
  unwrapHeaderSentinelsForProviderEgress,
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import type { StreamFn } from "./runtime/index.js";

/** Resolves and registers the stream function for a provider-backed model. */
export function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
  wrapProviderStream?: boolean;
  apiRegistry?: ApiRegistry;
}): StreamFn | undefined {
  const apiRegistry = params.apiRegistry ?? getModelLlmRuntime(params.model)?.registry;
  const runtimeHandle =
    getModelProviderRuntimePluginHandle(params.model) ??
    (params.allowRuntimePluginLoad === false
      ? undefined
      : resolveProviderRuntimePluginHandle({
          provider: params.model.provider,
          modelId: params.model.id,
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          env: params.env,
        }));
  const runtimeModel = runtimeHandle
    ? attachModelProviderRuntimePluginHandle(params.model, runtimeHandle)
    : params.model;
  // Plugin stream factories may capture model headers, so construction is the
  // last safe boundary for providers that do not expose the host fetch seam.
  const pluginModel = unwrapModelHeaderSentinelsForProviderEgress(
    runtimeModel,
    "plugin provider stream construction",
  );
  const providerStreamFn = resolveProviderStreamFn({
    provider: runtimeModel.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtimeHandle,
    allowRuntimePluginLoad: params.allowRuntimePluginLoad,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: runtimeModel.provider,
      modelId: runtimeModel.id,
      model: pluginModel,
    },
  });
  const transportFallback = providerStreamFn
    ? undefined
    : createTransportAwareStreamFnForModel(
        runtimeModel.api === "google-generative-ai" ? pluginModel : runtimeModel,
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
  const providerWrappedStreamFn =
    params.wrapProviderStream && runtimeHandle
      ? (runtimeHandle.plugin?.wrapStreamFn?.({
          config: params.cfg,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          provider: runtimeModel.provider,
          modelId: runtimeModel.id,
          model: runtimeModel,
          streamFn,
        }) ?? streamFn)
      : streamFn;
  const preparedStreamFn = runtimeHandle
    ? bindProviderRuntimeHandle(providerWrappedStreamFn, runtimeHandle)
    : providerWrappedStreamFn;
  // Register custom APIs only after a concrete stream exists, so later callers
  // can route by model.api without reloading provider runtime hooks.
  if (apiRegistry) {
    ensureCustomApiRegistered(apiRegistry, runtimeModel.api, preparedStreamFn);
  }
  return preparedStreamFn;
}

function bindProviderRuntimeHandle(
  streamFn: StreamFn,
  runtimeHandle: ProviderRuntimePluginHandle,
): StreamFn {
  return (model, context, options) =>
    streamFn(attachModelProviderRuntimePluginHandle(model, runtimeHandle), context, options);
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
