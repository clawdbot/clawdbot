import { beforeEach, describe, expect, it, vi } from "vitest";

const normalizeProviderModelIdWithManifestMock = vi.hoisted(() => vi.fn());
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-model-id-normalization.js", () => ({
  normalizeProviderModelIdWithManifest: normalizeProviderModelIdWithManifestMock,
}));

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeProviderModelIdWithRuntimeMock,
}));

describe("statusSummaryRuntime configured model normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    normalizeProviderModelIdWithManifestMock.mockReset();
    normalizeProviderModelIdWithRuntimeMock.mockReset();
  });

  it("skips manifest and plugin model normalization for configured model refs", async () => {
    const { statusSummaryRuntime } = await import("./status.summary.runtime.js");

    expect(
      statusSummaryRuntime.resolveConfiguredStatusModelRef({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai-codex/gpt-5.5" },
            },
          },
        } as never,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
      }),
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
    });

    expect(
      statusSummaryRuntime.resolveConfiguredStatusModelRef({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "fast-codex" },
              models: {
                "openai-codex/gpt-5.5": { alias: "fast-codex" },
              },
            },
          },
        } as never,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
      }),
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
    });

    expect(normalizeProviderModelIdWithManifestMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("skips manifest and plugin model normalization for providerless persisted session models", async () => {
    const { statusSummaryRuntime } = await import("./status.summary.runtime.js");
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
      },
    } as never;

    normalizeProviderModelIdWithManifestMock.mockReturnValue("claude-opus-4-6");
    normalizeProviderModelIdWithRuntimeMock.mockReturnValue("runtime-normalized-opus");

    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        model: "opus-4.6",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "opus-4.6",
    });

    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        model: "fallback-runtime-model",
        modelOverride: "opus-4.6",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "opus-4.6",
    });

    expect(
      statusSummaryRuntime.resolveStatusModelComparisonLabel({
        provider: "anthropic",
        model: "opus-4.6",
        defaultProvider: "anthropic",
      }),
    ).toBe("anthropic/claude-opus-4-6");
    expect(
      statusSummaryRuntime.resolveStatusModelLookupRef({
        provider: "anthropic",
        model: "opus-4.6",
        defaultProvider: "anthropic",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(normalizeProviderModelIdWithManifestMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });
});
