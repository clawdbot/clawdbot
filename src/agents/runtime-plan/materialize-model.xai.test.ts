import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../plugin-sdk/plugin-test-runtime.js";
import { loadBundledPluginPublicSurface } from "../../plugin-sdk/test-helpers/public-surface-loader.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type { StreamFn } from "../runtime/index.js";
import { materializePreparedRuntimeModel } from "./materialize-model.js";

describe("xAI OAuth runtime materialization", () => {
  it("retains the selected alias through auth resolution and sends its canonical target", async () => {
    const plugin = await loadBundledPluginPublicSurface<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "xai", artifactBasename: "index.js" });
    const provider = await registerSingleProviderPlugin(plugin.default);
    const model: ProviderRuntimeModel = {
      provider: "xai",
      id: "auto",
      name: "Subscription default",
      api: "openai-responses",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      params: { canonicalModelId: "grok-4.6" },
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 500_000,
      maxTokens: 64_000,
    };
    const materialized = await materializePreparedRuntimeModel({
      provider: "xai",
      modelId: "auto",
      model,
      config: {},
      plan: {
        providerForAuth: "xai",
        authProfileProviderForAuth: "xai",
        selectedAuthMode: "oauth",
        forwardedAuthProfileId: "xai:fixture",
      },
      forceResolve: true,
      resolveModel: async (request) => {
        expect(request.authProfileId).toBe("xai:fixture");
        expect(request.authProfileMode).toBe("oauth");
        return {
          model: provider.normalizeResolvedModel?.({ provider: "xai", modelId: "auto", model }),
        };
      },
    });
    expect(materialized?.id).toBe("auto");
    expect(materialized?.thinkingLevelMap?.xhigh).toBe("xhigh");
    let wireModelId: string | undefined;
    let wireHeaders: Record<string, string> | undefined;
    const streamFn: StreamFn = (wireModel, _context, options) => {
      wireModelId = wireModel.id;
      wireHeaders = options?.headers;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = provider.wrapStreamFn?.({
      provider: "xai",
      modelId: "auto",
      model: materialized,
      streamFn,
      extraParams: { tool_stream: false },
    });
    if (!materialized || !wrapped) {
      throw new Error("expected materialized subscription stream");
    }
    await wrapped(materialized, { messages: [] }, {});
    expect(wireModelId).toBe("grok-4.6");
    expect(wireHeaders?.["x-grok-model-override"]).toBe(wireModelId);
  });
});
