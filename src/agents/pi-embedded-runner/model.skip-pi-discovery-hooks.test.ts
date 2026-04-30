import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
  applyProviderResolvedModelCompatWithPlugins: vi.fn(() => {
    throw new Error("compat hook should not run during skipPiDiscovery");
  }),
  applyProviderResolvedTransportWithPlugin: vi.fn(() => {
    throw new Error("transport hook should not run during skipPiDiscovery");
  }),
  buildProviderUnknownModelHintWithPlugin: vi.fn(() => undefined),
  normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
  normalizeProviderTransportWithPlugin: vi.fn(() => {
    throw new Error("transport normalization hook should not run during skipPiDiscovery");
  }),
  prepareProviderDynamicModel: vi.fn(async () => undefined),
  runProviderDynamicModel: vi.fn(
    ({ context }: { context: { provider: string; modelId: string } }) => ({
      id: context.modelId,
      name: context.modelId,
      provider: context.provider,
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    }),
  ),
  shouldPreferProviderRuntimeResolvedModel: vi.fn(() => false),
}));

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: mocks.discoverAuthStorage,
  discoverModels: mocks.discoverModels,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedModelCompatWithPlugins: mocks.applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin: mocks.applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin: mocks.buildProviderUnknownModelHintWithPlugin,
  normalizeProviderResolvedModelWithPlugin: mocks.normalizeProviderResolvedModelWithPlugin,
  normalizeProviderTransportWithPlugin: mocks.normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel: mocks.prepareProviderDynamicModel,
  runProviderDynamicModel: mocks.runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel: mocks.shouldPreferProviderRuntimeResolvedModel,
}));

let resolveModelAsync: typeof import("./model.js").resolveModelAsync;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ resolveModelAsync } = await import("./model.js"));
});

describe("resolveModelAsync skipPiDiscovery runtime hooks", () => {
  it("uses only target-provider dynamic hooks", async () => {
    const result = await resolveModelAsync("ollama", "llama3.2:latest", "/tmp/agent", undefined, {
      skipPiDiscovery: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "ollama",
      id: "llama3.2:latest",
      api: "ollama",
    });
    expect(mocks.discoverAuthStorage).not.toHaveBeenCalled();
    expect(mocks.discoverModels).not.toHaveBeenCalled();
    expect(mocks.prepareProviderDynamicModel).toHaveBeenCalledTimes(1);
    expect(mocks.runProviderDynamicModel).toHaveBeenCalledTimes(1);
    expect(mocks.normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.applyProviderResolvedModelCompatWithPlugins).not.toHaveBeenCalled();
    expect(mocks.applyProviderResolvedTransportWithPlugin).not.toHaveBeenCalled();
    expect(mocks.normalizeProviderTransportWithPlugin).not.toHaveBeenCalled();
  });
});
