// Xai plugin module implements web search behavior.
import type {
  WebSearchProviderPlugin,
  WebSearchProviderSetupContext,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { buildXaiWebSearchProviderBase } from "./web-search-provider-shared.js";

type XaiWebSearchProviderRuntime = typeof import("./src/web-search-provider.runtime.js");

let xaiWebSearchProviderRuntimePromise: Promise<XaiWebSearchProviderRuntime> | undefined;

function loadXaiWebSearchProviderRuntime(): Promise<XaiWebSearchProviderRuntime> {
  xaiWebSearchProviderRuntimePromise ??= import("./src/web-search-provider.runtime.js");
  return xaiWebSearchProviderRuntimePromise;
}

const GenericXaiSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

async function runXaiSearchProviderSetup(
  ctx: WebSearchProviderSetupContext,
): Promise<WebSearchProviderSetupContext["config"]> {
  const runtime = await loadXaiWebSearchProviderRuntime();
  return await runtime.runXaiSearchProviderSetup(ctx);
}

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildXaiWebSearchProviderBase(),
    runSetup: runXaiSearchProviderSetup,
    createTool: (ctx) => ({
      description:
        "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
      parameters: GenericXaiSearchSchema,
      execute: async (args) => {
        const { executeXaiWebSearchProviderTool } = await loadXaiWebSearchProviderRuntime();
        return await executeXaiWebSearchProviderTool(ctx, args);
      },
    }),
  };
}
