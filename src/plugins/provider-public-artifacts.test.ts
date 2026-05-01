import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";

describe("provider public artifacts", () => {
  afterEach(() => {
    vi.doUnmock("./public-surface-loader.js");
    vi.resetModules();
  });

  it("loads a lightweight bundled provider policy artifact smoke", () => {
    const surface = resolveBundledProviderPolicySurface("openai");
    expect(surface?.normalizeConfig).toBeTypeOf("function");

    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [],
    };
    expect(
      surface?.normalizeConfig?.({
        provider: "openai",
        providerConfig,
      }),
    ).toBe(providerConfig);
  });

  it("loads provider policy surfaces without staging runtime deps", async () => {
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(() => ({
      normalizeConfig: (ctx: { providerConfig: ModelProviderConfig }) => ctx.providerConfig,
    }));
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));
    vi.resetModules();

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=no-runtime-deps");

    const surface = resolvePolicySurface("openai");
    expect(surface?.normalizeConfig).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "openai",
      artifactBasename: "provider-policy-api.js",
      installRuntimeDeps: false,
    });
  });
});
