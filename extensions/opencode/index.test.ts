import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("opencode provider plugin", () => {
  it("registers image media understanding through the OpenCode plugin", async () => {
    const { mediaProviders } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });

    expect(mediaProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "opencode",
          capabilities: ["image"],
          defaultModels: { image: "gpt-5-nano" },
          describeImage: expect.any(Function),
          describeImages: expect.any(Function),
        }),
      ]),
    );
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "claude-opus-4.6",
    });
  });

  it("exposes Anthropic thinking levels for proxied Claude models", async () => {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const provider = requireRegisteredProvider(providers, "opencode");
    const resolveThinkingProfile = provider.resolveThinkingProfile!;

    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "claude-opus-4-7",
      }),
    ).toMatchObject({
      levels: expect.arrayContaining([{ id: "xhigh" }, { id: "adaptive" }, { id: "max" }]),
      defaultLevel: "off",
    });
    const opus46Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-opus-4.6",
    });
    expect(opus46Profile).toMatchObject({
      levels: expect.arrayContaining([{ id: "adaptive" }]),
      defaultLevel: "adaptive",
    });
    expect(opus46Profile?.levels.some((level) => level.id === "xhigh" || level.id === "max")).toBe(
      false,
    );
    const sonnet46Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-sonnet-4-6",
    });
    expect(sonnet46Profile).toMatchObject({
      levels: expect.arrayContaining([{ id: "adaptive" }]),
      defaultLevel: "adaptive",
    });
    expect(
      sonnet46Profile?.levels.some((level) => level.id === "xhigh" || level.id === "max"),
    ).toBe(false);
  });
});
