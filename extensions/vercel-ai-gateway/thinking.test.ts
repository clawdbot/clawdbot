import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("vercel ai gateway thinking profile", () => {
  async function getProvider() {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "vercel-ai-gateway",
      name: "Vercel AI Gateway Provider",
    });
    return requireRegisteredProvider(providers, "vercel-ai-gateway");
  }

  it("exposes xhigh for trusted OpenAI upstream refs", async () => {
    const provider = await getProvider();

    const profile = provider.resolveThinkingProfile?.({
      provider: "vercel-ai-gateway",
      modelId: "openai/gpt-5.4",
    });

    expect(profile?.levels).toEqual(expect.arrayContaining([{ id: "xhigh" }]));
  });

  it("exposes Codex xhigh through the OpenAI upstream prefix", async () => {
    const provider = await getProvider();

    const profile = provider.resolveThinkingProfile?.({
      provider: "vercel-ai-gateway",
      modelId: "openai/gpt-5.3-codex-spark",
    });

    expect(profile?.levels).toEqual(expect.arrayContaining([{ id: "xhigh" }]));
  });

  it("reuses Claude thinking defaults for trusted Anthropic upstream refs", async () => {
    const provider = await getProvider();

    const profile = provider.resolveThinkingProfile?.({
      provider: "vercel-ai-gateway",
      modelId: "anthropic/claude-opus-4.6",
    });

    expect(profile).toMatchObject({
      levels: expect.arrayContaining([{ id: "adaptive" }]),
      defaultLevel: "adaptive",
    });
    expect(profile?.levels.some((level) => level.id === "xhigh" || level.id === "max")).toBe(false);
  });

  it("falls through for unsupported OpenAI or untrusted namespaced refs", async () => {
    const provider = await getProvider();
    const resolveThinkingProfile = provider.resolveThinkingProfile!;

    expect(
      resolveThinkingProfile({
        provider: "vercel-ai-gateway",
        modelId: "openai/gpt-4.1",
      }),
    ).toBeUndefined();
    expect(
      resolveThinkingProfile({
        provider: "vercel-ai-gateway",
        modelId: "acme/gpt-5.4",
      }),
    ).toBeUndefined();
  });
});
