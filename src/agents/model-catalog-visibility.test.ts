import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveVisibleModelCatalog } from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithRuntimeMock(params),
}));

describe("resolveVisibleModelCatalog", () => {
  beforeEach(() => {
    normalizeProviderModelIdWithRuntimeMock.mockReset();
  });

  it("can use static auth checks for gateway read-only model lists", async () => {
    const authChecker = vi.fn((provider: string) => provider === "openai");
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-test", name: "Claude Test" },
      { provider: "openai", id: "gpt-test", name: "GPT Test" },
    ];
    const cfg = {} as OpenClawConfig;

    const result = await resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "openai",
      runtimeAuthDiscovery: false,
      providerAuthChecker: authChecker,
    });

    expect(authChecker).toHaveBeenNthCalledWith(1, "anthropic");
    expect(authChecker).toHaveBeenNthCalledWith(2, "openai");
    expect(authChecker).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ provider: "openai", id: "gpt-test", name: "GPT Test" }]);
  });

  it("keeps Codex-routable canonical OpenAI rows visible through Codex OAuth auth", async () => {
    const authChecker = vi.fn(
      (provider: string, api?: string) => api === "openai-chatgpt-responses",
    );
    const catalog: ModelCatalogEntry[] = [
      {
        provider: "openai",
        id: "chat-latest",
        name: "Chat Latest",
        api: "openai-responses",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT 5.5",
        api: "openai-responses",
      },
    ];

    const result = await resolveVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      defaultProvider: "openai",
      runtimeAuthDiscovery: false,
      providerAuthChecker: authChecker,
    });

    expect(authChecker).toHaveBeenNthCalledWith(1, "openai", "openai-responses");
    expect(authChecker).toHaveBeenNthCalledWith(2, "openai", "openai-responses");
    expect(authChecker).toHaveBeenNthCalledWith(3, "openai", "openai-chatgpt-responses");
    expect(authChecker).toHaveBeenCalledTimes(3);
    expect(result).toEqual([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT 5.5",
        api: "openai-responses",
      },
    ]);
  });

  it("does not runtime-normalize unrestricted default browse", async () => {
    normalizeProviderModelIdWithRuntimeMock.mockImplementation(() => "custom-modern-model");

    const result = await resolveVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog: [{ provider: "custom-provider", id: "custom-legacy-model", name: "Custom Legacy" }],
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      runtimeAuthDiscovery: false,
      providerAuthChecker: vi.fn(() => true),
    });

    expect(result).toEqual([
      { provider: "custom-provider", id: "custom-legacy-model", name: "Custom Legacy" },
    ]);
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("limits visible catalog to provider wildcard entries after default discovery", async () => {
    const authChecker = vi.fn((provider: string) => provider !== "blocked");
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-test", name: "Claude Test" },
      { provider: "openai", id: "gpt-codex-test", name: "GPT Codex Test" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
      { provider: "blocked", id: "blocked-test", name: "Blocked Test" },
    ];

    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
            "openai/*": {},
            "blocked/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const result = await resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: true,
      providerAuthChecker: authChecker,
    });

    expect(authChecker).toHaveBeenNthCalledWith(1, "anthropic");
    expect(authChecker).toHaveBeenNthCalledWith(2, "openai");
    expect(authChecker).toHaveBeenNthCalledWith(3, "vllm");
    expect(authChecker).toHaveBeenNthCalledWith(4, "blocked");
    expect(authChecker).toHaveBeenCalledTimes(4);
    expect(result).toEqual([
      { provider: "openai", id: "gpt-codex-test", name: "GPT Codex Test" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
    ]);
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  }, 240_000);

  it("uses runtime model normalization for exact allowlist entries", async () => {
    normalizeProviderModelIdWithRuntimeMock.mockImplementation(({ provider, context }) => {
      if (
        provider === "custom-provider" &&
        (context as { modelId?: string }).modelId === "custom-legacy-model"
      ) {
        return "custom-modern-model";
      }
      return undefined;
    });

    const cfg = {
      agents: {
        defaults: {
          models: {
            "custom-provider/custom-legacy-model": {},
          },
        },
      },
    } as OpenClawConfig;

    const result = await resolveVisibleModelCatalog({
      cfg,
      catalog: [{ provider: "custom-provider", id: "custom-modern-model", name: "Custom Modern" }],
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: false,
      providerAuthChecker: vi.fn(() => true),
    });

    expect(result).toEqual([
      { provider: "custom-provider", id: "custom-modern-model", name: "Custom Modern" },
    ]);
    expect(normalizeProviderModelIdWithRuntimeMock).toHaveBeenCalled();
  });

  it("does not broaden visibility when selected providers have no catalog rows", async () => {
    const authChecker = vi.fn(() => true);

    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const result = await resolveVisibleModelCatalog({
      cfg,
      catalog: [{ provider: "anthropic", id: "claude-test", name: "Claude Test" }],
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: true,
      providerAuthChecker: authChecker,
    });

    expect(authChecker).toHaveBeenCalledWith("anthropic");
    expect(authChecker).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });
});
