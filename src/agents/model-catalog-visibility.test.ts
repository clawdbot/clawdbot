import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveVisibleModelCatalog } from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

describe("resolveVisibleModelCatalog", () => {
  it("can use static auth checks for gateway read-only model lists", () => {
    const authChecker = vi.fn((provider: string) => provider === "openai");
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-test", name: "Claude Test" },
      { provider: "openai", id: "gpt-test", name: "GPT Test" },
    ];
    const cfg = {} as OpenClawConfig;

    const result = resolveVisibleModelCatalog({
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

  it("limits visible catalog to provider wildcard entries after default discovery", () => {
    const authChecker = vi.fn((provider: string) => provider !== "blocked");
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-test", name: "Claude Test" },
      { provider: "openai-codex", id: "gpt-codex-test", name: "GPT Codex Test" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
      { provider: "blocked", id: "blocked-test", name: "Blocked Test" },
    ];

    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
            "openai-codex/*": {},
            "blocked/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: true,
      providerAuthChecker: authChecker,
    });

    expect(authChecker).toHaveBeenNthCalledWith(1, "anthropic");
    expect(authChecker).toHaveBeenNthCalledWith(2, "openai-codex");
    expect(authChecker).toHaveBeenNthCalledWith(3, "vllm");
    expect(authChecker).toHaveBeenNthCalledWith(4, "blocked");
    expect(authChecker).toHaveBeenCalledTimes(4);
    expect(result).toEqual([
      { provider: "openai-codex", id: "gpt-codex-test", name: "GPT Codex Test" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
    ]);
  });

  it("does not broaden visibility when selected providers have no catalog rows", () => {
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

    const result = resolveVisibleModelCatalog({
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
