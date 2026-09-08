import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createOllamaWebSearchProvider as createOllamaWebSearchProviderContract } from "../web-search-contract-api.js";
import {
  OLLAMA_WEB_SEARCH_TOOL_DESCRIPTION,
  OLLAMA_WEB_SEARCH_TOOL_PARAMETERS,
} from "./web-search-contract.js";

const loadOllamaWebSearchProvider = createLazyRuntimeModule(
  () => import("./web-search-provider.runtime.js"),
);

export function createLazyOllamaWebSearchProvider(): WebSearchProviderPlugin {
  let providerPromise:
    | Promise<Pick<WebSearchProviderPlugin, "runSetup" | "createTool">>
    | undefined;
  const loadProvider = () =>
    (providerPromise ??= loadOllamaWebSearchProvider().then((runtime) =>
      runtime.createOllamaWebSearchProvider(),
    ));
  return {
    ...createOllamaWebSearchProviderContract(),
    runSetup: async (ctx) => {
      const provider = await loadProvider();
      return provider.runSetup ? await provider.runSetup(ctx) : ctx.config;
    },
    createTool: (ctx) => {
      let toolPromise: Promise<ReturnType<WebSearchProviderPlugin["createTool"]>> | undefined;
      const loadTool = () =>
        (toolPromise ??= loadProvider().then((provider) => provider.createTool(ctx)));
      return {
        description: OLLAMA_WEB_SEARCH_TOOL_DESCRIPTION,
        parameters: OLLAMA_WEB_SEARCH_TOOL_PARAMETERS,
        execute: async (args, executionContext) => {
          const tool = await loadTool();
          if (!tool) {
            throw new Error("Ollama web search runtime did not create a tool");
          }
          return await tool.execute(args, executionContext);
        },
      };
    },
  };
}
