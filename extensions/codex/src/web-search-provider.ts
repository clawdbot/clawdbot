import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import type { CodexAppServerClientFactory } from "./app-server/shared-client.js";
import { createCodexWebSearchProviderBase } from "./web-search-provider.shared.js";

const loadCodexWebSearchRuntime = createLazyRuntimeModule(
  () => import("./web-search-provider.runtime.js"),
);

const CodexWebSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query. Include the desired region, time range, and constraints.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

type CodexWebSearchProviderOptions = {
  resolvePluginConfig?: () => unknown;
  clientFactory?: CodexAppServerClientFactory;
};

export function createCodexWebSearchProvider(
  options: CodexWebSearchProviderOptions = {},
): WebSearchProviderPlugin {
  return {
    ...createCodexWebSearchProviderBase(),
    createTool: (ctx) => {
      const nativeConfig = ctx.searchConfig?.openaiCodex;
      if (
        nativeConfig &&
        typeof nativeConfig === "object" &&
        !Array.isArray(nativeConfig) &&
        (nativeConfig as { enabled?: unknown }).enabled === false
      ) {
        return null;
      }
      return {
        description:
          "Search the current web through Codex hosted search and return a grounded answer with source URLs.",
        parameters: CodexWebSearchSchema,
        execute: async (args, executionContext) => {
          const { executeCodexWebSearchProviderTool } = await loadCodexWebSearchRuntime();
          return await executeCodexWebSearchProviderTool(ctx, args, executionContext, {
            pluginConfig:
              options.resolvePluginConfig?.() ?? resolvePluginConfigObject(ctx.config, "codex"),
            clientFactory: options.clientFactory,
          });
        },
      };
    },
  };
}
