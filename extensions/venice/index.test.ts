import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("venice provider plugin", () => {
  it("applies the shared xAI compat patch to Grok-backed Venice models only", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "venice/grok-4",
        model: {
          id: "grok-4",
          compat: {
            supportsUsageInStreaming: true,
          },
        },
      } as never),
    ).toMatchObject({
      compat: {
        supportsUsageInStreaming: true,
        toolSchemaProfile: "xai",
        nativeWebSearchTool: true,
        toolCallArgumentsEncoding: "html-entities",
      },
    });

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "venice/llama-3.3-70b",
        model: {
          id: "llama-3.3-70b",
          compat: {},
        },
      } as never),
    ).toBeUndefined();
  });
});
