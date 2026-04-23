import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManifestContractOwnerPluginId } from "../../plugins/manifest-registry.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import {
  resolveWebSearchDefinition,
  resolveWebSearchProviderId,
  runWebSearch,
} from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult } from "./common.js";
import { SEARCH_CACHE } from "./web-search-provider-common.js";

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  const runtimeProviderId =
    options?.runtimeWebSearch?.selectedProvider ?? options?.runtimeWebSearch?.providerConfigured;
  const preferRuntimeProviders =
    Boolean(runtimeProviderId) &&
    !resolveManifestContractOwnerPluginId({
      contract: "webSearchProviders",
      value: runtimeProviderId,
      origin: "bundled",
      config: options?.config,
    });
  const resolved = resolveWebSearchDefinition({
    ...options,
    preferRuntimeProviders,
  });
  if (!resolved) {
    return null;
  }

  return {
    label: "Web Search",
    name: "web_search",
    description: resolved.definition.description,
    parameters: resolved.definition.parameters,
    execute: async (_toolCallId, args) => {
      const result = await runWebSearch({
        config: options?.config,
        sandboxed: options?.sandboxed,
        runtimeWebSearch: options?.runtimeWebSearch,
        preferRuntimeProviders,
        args: asToolParamsRecord(args),
      });
      return jsonResult({
        ...result.result,
        provider: result.provider,
      });
    },
  };
}

export const __testing = {
  SEARCH_CACHE,
  resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) =>
    resolveWebSearchProviderId({ search }),
};
