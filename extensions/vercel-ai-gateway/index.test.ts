// Vercel Ai Gateway tests cover provider runtime hooks.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("vercel ai gateway provider hooks", () => {
  it("resolves live-only model ids for the embedded runner", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = provider.resolveDynamicModel?.({
      provider: "vercel-ai-gateway",
      modelId: "custom/provider-model",
      modelRegistry: { find: () => null },
    } as never);

    expect(model).toMatchObject({
      id: "custom/provider-model",
      provider: "vercel-ai-gateway",
      api: "anthropic-messages",
      baseUrl: "https://ai-gateway.vercel.sh",
    });
  });
});
