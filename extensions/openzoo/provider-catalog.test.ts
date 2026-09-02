// Openzoo tests cover implicit provider plugin behavior.
import { afterAll, describe, expect, it, vi } from "vitest";

const { discoverOpenzooModelsMock } = vi.hoisted(() => ({
  discoverOpenzooModelsMock: vi.fn(),
}));

vi.mock("./provider-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-models.js")>();
  return {
    ...actual,
    discoverOpenzooModels: (...args: unknown[]) => discoverOpenzooModelsMock(...args),
  };
});

import { buildOpenzooProvider, buildOpenzooProviderWithDiscovery } from "./provider-catalog.js";

afterAll(() => {
  vi.doUnmock("./provider-models.js");
  vi.resetModules();
});

describe("openzoo implicit provider", () => {
  it("publishes the static provider catalog used by implicit provider setup", () => {
    const provider = buildOpenzooProvider();

    expect(provider.baseUrl).toBe("http://localhost:8402/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toStrictEqual([
      {
        id: "auto",
        name: "auto",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000000,
        maxTokens: 8192,
      },
    ]);
  });

  it("builds the discovered provider on the resolved base URL", async () => {
    const discovered = [{ ...buildOpenzooProvider().models![0]!, id: "anthropic/claude-sonnet-5" }];
    discoverOpenzooModelsMock.mockResolvedValueOnce(discovered);

    const provider = await buildOpenzooProviderWithDiscovery({
      baseUrl: "http://proxy-host:8402/v1",
    });

    expect(discoverOpenzooModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://proxy-host:8402/v1",
    });
    expect(provider).toEqual({
      baseUrl: "http://proxy-host:8402/v1",
      api: "openai-completions",
      models: discovered,
    });
  });
});
