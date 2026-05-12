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

function expectWorkspaceHookCall(mock: { mock: { calls: unknown[][] } }) {
  expect(mock.mock.calls).toHaveLength(1);
  const [arg] = mock.mock.calls.at(0) ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error("Expected runtime hook call argument");
  }
  const call = arg as { context?: unknown; workspaceDir?: unknown };
  expect(call.workspaceDir).toBe("/tmp/workspace");
  if (!call.context || typeof call.context !== "object") {
    throw new Error("Expected runtime hook context");
  }
  const context = call.context as { workspaceDir?: unknown };
  expect(context.workspaceDir).toBe("/tmp/workspace");
}

beforeEach(async () => {
  vi.clearAllMocks();
  ({ resolveModelAsync } = await import("./model.js"));
});

describe("resolveModelAsync skipPiDiscovery runtime hooks", () => {
  it("uses only target-provider dynamic hooks", async () => {
    const result = await resolveModelAsync("ollama", "llama3.2:latest", "/tmp/agent", undefined, {
      skipPiDiscovery: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(result.error).toBeUndefined();
    if (!result.model) {
      throw new Error("Expected resolved model");
    }
    expect(result.model.provider).toBe("ollama");
    expect(result.model.id).toBe("llama3.2:latest");
    expect(result.model.api).toBe("ollama");
    expect(mocks.discoverAuthStorage).not.toHaveBeenCalled();
    expect(mocks.discoverModels).not.toHaveBeenCalled();
    expectWorkspaceHookCall(mocks.prepareProviderDynamicModel);
    expectWorkspaceHookCall(mocks.runProviderDynamicModel);
    expectWorkspaceHookCall(mocks.normalizeProviderResolvedModelWithPlugin);
    expect(mocks.applyProviderResolvedModelCompatWithPlugins).not.toHaveBeenCalled();
    expect(mocks.applyProviderResolvedTransportWithPlugin).not.toHaveBeenCalled();
    expect(mocks.normalizeProviderTransportWithPlugin).not.toHaveBeenCalled();
  });
});
