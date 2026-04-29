import { beforeEach, describe, expect, it, vi } from "vitest";

const discoverAuthStorageMock = vi.fn<(agentDir?: string) => { mocked: true }>(() => ({
  mocked: true,
}));
const discoverModelsMock = vi.fn<
  (authStorage: unknown, agentDir: string) => { find: ReturnType<typeof vi.fn> }
>(() => ({ find: vi.fn(() => null) }));

const prepareProviderDynamicModelMock = vi.fn<(params: unknown) => Promise<void>>(async () => {});
let dynamicAttempts = 0;
const runProviderDynamicModelMock = vi.fn<(params: unknown) => unknown>(() =>
  dynamicAttempts > 1
    ? {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      }
    : undefined,
);

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: discoverAuthStorageMock,
  discoverModels: discoverModelsMock,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

describe("resolveModelAsync startup retry", () => {
  const runtimeHooks = {
    applyProviderResolvedModelCompatWithPlugins: () => undefined,
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    normalizeProviderResolvedModelWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
    prepareProviderDynamicModel: (params: unknown) => prepareProviderDynamicModelMock(params),
    runProviderDynamicModel: (params: unknown) => runProviderDynamicModelMock(params),
    applyProviderResolvedTransportWithPlugin: () => undefined,
  };

  beforeEach(() => {
    dynamicAttempts = 0;
    prepareProviderDynamicModelMock.mockClear();
    prepareProviderDynamicModelMock.mockImplementation(async () => {
      dynamicAttempts += 1;
    });
    runProviderDynamicModelMock.mockClear();
    discoverAuthStorageMock.mockClear();
    discoverModelsMock.mockClear();
  });

  it("retries once after a transient provider-runtime miss", async () => {
    const { resolveModelAsync } = await import("./model.js");

    const result = await resolveModelAsync(
      "openai-codex",
      "gpt-5.4",
      "/tmp/agent",
      {},
      {
        retryTransientProviderRuntimeMiss: true,
        runtimeHooks,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      api: "openai-codex-responses",
    });
    expect(prepareProviderDynamicModelMock).toHaveBeenCalledTimes(2);
    expect(runProviderDynamicModelMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry during steady-state misses", async () => {
    const { resolveModelAsync } = await import("./model.js");

    const result = await resolveModelAsync(
      "openai-codex",
      "gpt-5.4",
      "/tmp/agent",
      {},
      { runtimeHooks },
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai-codex/gpt-5.4");
    expect(prepareProviderDynamicModelMock).toHaveBeenCalledTimes(1);
    expect(runProviderDynamicModelMock).toHaveBeenCalledTimes(1);
  });
});
