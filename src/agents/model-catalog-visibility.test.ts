import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveVisibleModelCatalog } from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createProviderAuthChecker } from "./model-provider-auth.js";

vi.mock("./model-provider-auth.js", () => ({
  createProviderAuthChecker: vi.fn(),
}));

const createProviderAuthCheckerMock = vi.mocked(createProviderAuthChecker);

describe("resolveVisibleModelCatalog", () => {
  beforeEach(() => {
    createProviderAuthCheckerMock.mockReset();
  });

  it("can use static auth checks for gateway read-only model lists", () => {
    const authChecker = vi.fn((provider: string) => provider === "openai");
    createProviderAuthCheckerMock.mockReturnValue(authChecker);
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-test", name: "Claude Test" },
      { provider: "openai", id: "gpt-test", name: "GPT Test" },
    ];

    const result = resolveVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      defaultProvider: "openai",
      runtimeAuthDiscovery: false,
    });

    expect(createProviderAuthCheckerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPluginSyntheticAuth: false,
        discoverExternalCliAuth: false,
      }),
    );
    expect(authChecker).toHaveBeenCalledWith("anthropic");
    expect(authChecker).toHaveBeenCalledWith("openai");
    expect(result).toEqual([{ provider: "openai", id: "gpt-test", name: "GPT Test" }]);
  });
});
