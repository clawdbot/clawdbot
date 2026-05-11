import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function collectLegacyExtendedLevelIds(levels: readonly { id: string }[] | undefined): string[] {
  const ids: string[] = [];
  for (const level of levels ?? []) {
    if (level.id === "xhigh" || level.id === "max") {
      ids.push(level.id);
    }
  }
  return ids;
}

const OPENAI_XHIGH_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "xhigh" },
];

const CLAUDE_ADAPTIVE_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "adaptive" },
];

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

    expect(profile).toStrictEqual({ levels: OPENAI_XHIGH_LEVELS });
  });

  it("exposes Codex xhigh through the OpenAI upstream prefix", async () => {
    const provider = await getProvider();

    const profile = provider.resolveThinkingProfile?.({
      provider: "vercel-ai-gateway",
      modelId: "openai/gpt-5.3-codex-spark",
    });

    expect(profile).toStrictEqual({ levels: OPENAI_XHIGH_LEVELS });
  });

  it("reuses Claude thinking defaults for trusted Anthropic upstream refs", async () => {
    const provider = await getProvider();

    const profile = provider.resolveThinkingProfile?.({
      provider: "vercel-ai-gateway",
      modelId: "anthropic/claude-opus-4.6",
    });

    expect(profile).toStrictEqual({
      levels: CLAUDE_ADAPTIVE_LEVELS,
      defaultLevel: "adaptive",
    });
    expect(collectLegacyExtendedLevelIds(profile?.levels)).toStrictEqual([]);
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
