import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
} from "@openclaw/ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import {
  resolveProviderStreamFn,
  resolveProviderTransportTurnStateWithPlugin,
  wrapProviderSimpleCompletionStreamFn,
} from "../plugins/provider-runtime.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { prepareGoogleSimpleCompletionModel } from "./google-simple-completion-stream.js";
import {
  resolveProviderRequestCapabilities,
  resolveProviderEndpoint,
} from "./provider-attribution.js";
import {
  attachModelProviderLocalService,
  getModelProviderLocalService,
} from "./provider-local-service.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";
import { transformTransportMessages } from "./transport-message-transform.js";

let configured = false;

/** Installs the agent and plugin ports only on paths that execute provider runtime. */
export function configureAiTransportRuntimeHost(): void {
  if (configured) {
    return;
  }
  const host = getAiTransportHost();
  configureAiTransportHost({
    ...host,
    plugin: {
      ...host.plugin,
      resolveProviderStream: (params) =>
        resolveProviderStreamFn({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          context: {
            ...params.context,
            config: params.context.config as OpenClawConfig | undefined,
            model: params.context.model as ProviderRuntimeModel,
          },
        }),
      resolveTransportTurnState: (params) =>
        resolveProviderTransportTurnStateWithPlugin({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          context: {
            ...params.context,
            model: params.context.model as ProviderRuntimeModel | undefined,
          },
        }),
      wrapSimpleCompletionStream: (params) =>
        wrapProviderSimpleCompletionStreamFn({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          context: {
            ...params.context,
            config: params.context.config as OpenClawConfig | undefined,
            model: params.context.model as ProviderRuntimeModel,
          },
        }),
      createAnthropicVertexStream: createAnthropicVertexStreamFnForModel,
    },
    buildCopilotDynamicHeaders: (messages) =>
      buildCopilotDynamicHeaders({ messages, hasImages: hasCopilotVisionInput(messages) }),
    resolveProviderEndpointClass: (baseUrl) => resolveProviderEndpoint(baseUrl).endpointClass,
    resolveProviderRequestCapabilities: (input) =>
      resolveProviderRequestCapabilities(input) as AiProviderRequestCapabilities,
    resolveProviderRequestHeaders: (input) =>
      resolveProviderRequestPolicyConfig({
        ...input,
        capability: "llm",
        transport: "stream",
      }).headers,
    requiresManagedTransport: (model) => {
      const request = getModelProviderRequestTransport(model);
      return Boolean(request?.proxy || request?.tls || getModelProviderLocalService(model));
    },
    inheritManagedTransport: (source, target) =>
      attachModelProviderLocalService(
        attachModelProviderRequestTransport(target, getModelProviderRequestTransport(source)),
        getModelProviderLocalService(source),
      ),
    transformTransportMessages,
    registerCustomApi: ensureCustomApiRegistered,
    prepareGoogleSimpleCompletionModel,
  });
  configured = true;
}

configureAiTransportRuntimeHost();
