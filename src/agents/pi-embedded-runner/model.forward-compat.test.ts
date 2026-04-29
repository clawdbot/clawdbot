import { describe, it, vi } from "vitest";
import {
  buildForwardCompatTemplate,
  expectResolvedForwardCompatFallbackWithRegistryResult,
} from "./model.forward-compat.test-support.js";
import { resolveModelWithRegistry } from "./model.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => undefined,
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

const ANTHROPIC_OPUS_TEMPLATE = buildForwardCompatTemplate({
  id: "claude-opus-4-5",
  name: "Claude Opus 4.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
});

const ANTHROPIC_OPUS_EXPECTED = {
  provider: "anthropic",
  id: "claude-opus-4-6",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
};

const ANTHROPIC_SONNET_TEMPLATE = buildForwardCompatTemplate({
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
});

const ANTHROPIC_SONNET_EXPECTED = {
  provider: "anthropic",
  id: "claude-sonnet-4-6",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
};

const ZAI_GLM5_CASE = {
  provider: "zai",
  id: "glm-5",
  expectedModel: {
    provider: "zai",
    id: "glm-5",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    reasoning: true,
  },
  registryEntries: [
    {
      provider: "zai",
      modelId: "glm-4.7",
      model: buildForwardCompatTemplate({
        id: "glm-4.7",
        name: "GLM-4.7",
        provider: "zai",
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 131072,
      }),
    },
  ],
} as const;

function createRuntimeHooks() {
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["anthropic", "claude-cli", "zai", "openai-codex"],
  });
}

function createRegistry(
  entries: Array<{ provider: string; modelId: string; model: Record<string, unknown> }>,
) {
  return {
    find(provider: string, modelId: string) {
      const match = entries.find(
        (entry) => entry.provider === provider && entry.modelId === modelId,
      );
      return match?.model ?? null;
    },
  } as never;
}

function runAnthropicOpusForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistryResult({
    result: resolveModelWithRegistry({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/agent",
      modelRegistry: createRegistry([
        {
          provider: "anthropic",
          modelId: "claude-opus-4-5",
          model: ANTHROPIC_OPUS_TEMPLATE,
        },
      ]),
      runtimeHooks: createRuntimeHooks(),
    }),
    expectedModel: ANTHROPIC_OPUS_EXPECTED,
  });
}

function runAnthropicSonnetForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistryResult({
    result: resolveModelWithRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      agentDir: "/tmp/agent",
      modelRegistry: createRegistry([
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          model: ANTHROPIC_SONNET_TEMPLATE,
        },
      ]),
      runtimeHooks: createRuntimeHooks(),
    }),
    expectedModel: ANTHROPIC_SONNET_EXPECTED,
  });
}

function runClaudeCliSonnetForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistryResult({
    result: resolveModelWithRegistry({
      provider: "claude-cli",
      modelId: "claude-sonnet-4-6",
      agentDir: "/tmp/agent",
      modelRegistry: createRegistry([
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          model: ANTHROPIC_SONNET_TEMPLATE,
        },
      ]),
      runtimeHooks: createRuntimeHooks(),
    }),
    expectedModel: {
      ...ANTHROPIC_SONNET_EXPECTED,
      provider: "claude-cli",
    },
  });
}

function runZaiForwardCompatFallback() {
  const result = resolveModelWithRegistry({
    provider: ZAI_GLM5_CASE.provider,
    modelId: ZAI_GLM5_CASE.id,
    agentDir: "/tmp/agent",
    modelRegistry: createRegistry(
      ZAI_GLM5_CASE.registryEntries.map((entry) => ({
        provider: entry.provider,
        modelId: entry.modelId,
        model: entry.model,
      })),
    ),
    runtimeHooks: createRuntimeHooks(),
  });
  expectResolvedForwardCompatFallbackWithRegistryResult({
    result,
    expectedModel: ZAI_GLM5_CASE.expectedModel,
  });
}

describe("resolveModel forward-compat tail", () => {
  it(
    "builds an anthropic forward-compat fallback for claude-opus-4-6",
    runAnthropicOpusForwardCompatFallback,
  );

  it(
    "builds an anthropic forward-compat fallback for claude-sonnet-4-6",
    runAnthropicSonnetForwardCompatFallback,
  );

  it(
    "preserves the claude-cli provider for anthropic forward-compat fallback models",
    runClaudeCliSonnetForwardCompatFallback,
  );

  it("builds a zai forward-compat fallback for glm-5", runZaiForwardCompatFallback);
});
