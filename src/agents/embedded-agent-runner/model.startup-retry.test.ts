// Coverage for retrying transient model-runtime misses during startup.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const discoverAuthStorageMock = vi.fn<(agentDir?: string) => { mocked: true }>(() => ({
  mocked: true,
}));
const discoverModelsMock = vi.fn<
  (authStorage: unknown, agentDir: string) => { find: ReturnType<typeof vi.fn> }
>(() => ({ find: vi.fn(() => null) }));

const prepareProviderDynamicModelMock = vi.fn<(params: unknown) => Promise<void>>(async () => {});
let dynamicAttempts = 0;
const runProviderDynamicModelMock = vi.fn<(params: unknown) => unknown>(() =>
  // First dynamic lookup simulates startup catalog warmup; the retry path must
  // resolve on the second attempt only when explicitly enabled.
  dynamicAttempts > 1
    ? {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      }
    : undefined,
);

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: discoverAuthStorageMock,
  discoverModels: discoverModelsMock,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  resolveExternalAuthProfilesWithPlugins: () => [],
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

describe("resolveModelAsync startup retry", () => {
  let resolveModelAsync: typeof import("./model.js").resolveModelAsync;

  const runtimeHooks = {
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    normalizeProviderResolvedModelWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
    prepareProviderDynamicModel: (params: unknown) => prepareProviderDynamicModelMock(params),
    runProviderDynamicModel: (params: unknown) => runProviderDynamicModelMock(params),
    applyProviderResolvedTransportWithPlugin: () => undefined,
  };

  beforeAll(async () => {
    ({ resolveModelAsync } = await import("./model.js"));
  });

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
    const result = await resolveModelAsync(
      "openai",
      "gpt-5.4",
      "/tmp/agent",
      {},
      {
        agentRuntimeId: "openclaw",
        retryTransientProviderRuntimeMiss: true,
        runtimeHooks,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.model?.provider).toBe("openai");
    expect(result.model?.id).toBe("gpt-5.4");
    expect(result.model?.api).toBe("openai-chatgpt-responses");
    expect(prepareProviderDynamicModelMock).toHaveBeenCalledTimes(2);
    expect(runProviderDynamicModelMock).toHaveBeenCalledTimes(2);
    for (const call of [prepareProviderDynamicModelMock, runProviderDynamicModelMock]) {
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ agentRuntimeId: "openclaw" }),
        }),
      );
    }
  });

  it("does not retry during steady-state misses", async () => {
    // Normal runtime lookups should not double-hit providers after startup; that
    // would add latency and duplicate plugin side effects.
    const result = await resolveModelAsync("openai", "gpt-5.4", "/tmp/agent", {}, { runtimeHooks });

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai/gpt-5.4");
    expect(prepareProviderDynamicModelMock).toHaveBeenCalledTimes(1);
    expect(runProviderDynamicModelMock).toHaveBeenCalledTimes(1);
  });
});
