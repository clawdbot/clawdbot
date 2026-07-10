// Verifies provider public artifacts extracted from plugin metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";

describe("provider public artifacts", () => {
  const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const originalTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

  afterEach(() => {
    if (originalBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
    }
    if (originalTrustBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPluginsDir;
    }
    vi.doUnmock("./bundled-dir.js");
    vi.doUnmock("./manifest-registry.js");
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
    expect(
      surface
        ?.resolveThinkingProfile?.({ provider: "openai", modelId: "gpt-5.5" })
        ?.levels.map((level) => level.id),
    ).toContain("xhigh");
  });

  it("loads MiniMax thinking policy before runtime registration", () => {
    const surface = resolveBundledProviderPolicySurface("minimax");

    expect(
      surface?.resolveThinkingProfile?.({ provider: "minimax", modelId: "MiniMax-M2.7" })
        ?.defaultLevel,
    ).toBe("off");
    expect(
      surface?.resolveThinkingProfile?.({ provider: "minimax", modelId: "MiniMax-M3" })
        ?.defaultLevel,
    ).toBe("adaptive");
  });

  it("loads Moonshot Kimi K2.7 thinking policy before runtime registration", () => {
    const surface = resolveBundledProviderPolicySurface("moonshot");

    expect(
      surface?.resolveThinkingProfile?.({
        provider: "moonshot",
        modelId: "kimi-k2.7-code",
      }),
    ).toEqual({
      levels: [{ id: "low", label: "on" }],
      defaultLevel: "low",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("resolves multi-provider policy artifacts by manifest-owned provider id", async () => {
    const bundledPluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-policy-"));
    const pluginDir = path.join(bundledPluginsDir, "openai");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "openai",
        configSchema: { type: "object" },
        providers: ["openai", "openai"],
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      "export default { register() {} };\n",
      "utf8",
    );

    const resolveThinkingProfile = vi.fn(({ modelId }: { modelId: string }) => ({
      levels: modelId === "gpt-5.5" ? [{ id: "xhigh" }] : [{ id: "low" }],
    }));
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(({ dirName }: { dirName: string }) => {
      if (dirName !== "openai") {
        throw new Error(`Unable to resolve bundled plugin public surface ${dirName}`);
      }
      return { resolveThinkingProfile };
    });

    vi.doMock("./bundled-dir.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./bundled-dir.js")>();
      return {
        ...actual,
        resolveBundledPluginsDir: () => bundledPluginsDir,
      };
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));

    try {
      const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
        typeof import("./provider-public-artifacts.js")
      >(import.meta.url, "./provider-public-artifacts.js?scope=provider-alias");

      const surface = resolvePolicySurface("openai");

      expect(surface?.resolveThinkingProfile).toBeTypeOf("function");
      expect(loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
        dirName: "openai",
        artifactBasename: "provider-policy-api.js",
      });
      expect(
        surface
          ?.resolveThinkingProfile?.({
            provider: "openai",
            modelId: "gpt-5.5",
          })
          ?.levels.map((level) => level.id),
      ).toContain("xhigh");
      expect(
        surface
          ?.resolveThinkingProfile?.({
            provider: "openai",
            modelId: "gpt-4.1",
          })
          ?.levels.map((level) => level.id),
      ).not.toContain("xhigh");
    } finally {
      fs.rmSync(bundledPluginsDir, { force: true, recursive: true });
    }
  });

  it("resolves bundled policy artifacts through provider auth aliases", async () => {
    const loadPluginManifestRegistry = vi.fn(() => {
      throw new Error("unexpected manifest registry scan");
    });
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(({ dirName }: { dirName: string }) => {
      if (dirName !== "xai") {
        throw new Error(`Unable to resolve bundled plugin public surface ${dirName}`);
      }
      return {
        resolveThinkingProfile: ({ provider, modelId }: { provider: string; modelId: string }) =>
          provider === "x-ai" && modelId === "grok-4.5"
            ? {
                levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
                defaultLevel: "high",
              }
            : { levels: [{ id: "off" }], defaultLevel: "off" },
      };
    });

    vi.doMock("./manifest-registry.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./manifest-registry.js")>();
      return {
        ...actual,
        loadPluginManifestRegistry,
      };
    });
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=provider-auth-alias");

    const surface = resolvePolicySurface("x-ai", {
      manifestRegistry: {
        plugins: [
          {
            id: "xai",
            channels: [],
            cliBackends: [],
            hooks: [],
            origin: "bundled",
            manifestPath: "/tmp/xai/openclaw.plugin.json",
            providers: ["xai"],
            providerAuthAliases: { "x-ai": "xai" },
            rootDir: "/tmp/xai",
            skills: [],
            source: "/tmp/xai/index.js",
          },
        ],
      },
    });

    expect(surface?.resolveThinkingProfile?.({ provider: "x-ai", modelId: "grok-4.5" })).toEqual({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "high",
    });
    expect(loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "xai",
      artifactBasename: "provider-policy-api.js",
    });
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("resolves bundled policy artifacts for a plugin-owned CLI backend", async () => {
    const loadPluginManifestRegistry = vi.fn(() => {
      throw new Error("unexpected manifest registry scan");
    });
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(({ dirName }: { dirName: string }) => {
      if (dirName !== "anthropic") {
        throw new Error(`Unable to resolve bundled plugin public surface ${dirName}`);
      }
      return {
        resolveThinkingProfile: ({ provider }: { provider: string }) => ({
          levels: [{ id: provider }],
        }),
      };
    });

    vi.doMock("./manifest-registry.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./manifest-registry.js")>();
      return {
        ...actual,
        loadPluginManifestRegistry,
      };
    });
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=provider-cli-backend");

    // CLI backend ids use the same provider-policy owner boundary as provider ids.
    // Without it, claude-cli subagents fall back to the base thinking profile.
    const surface = resolvePolicySurface("claude-cli", {
      manifestRegistry: {
        plugins: [
          {
            id: "anthropic",
            channels: [],
            cliBackends: ["claude-cli"],
            hooks: [],
            origin: "bundled",
            manifestPath: "/tmp/anthropic/openclaw.plugin.json",
            providers: ["anthropic"],
            rootDir: "/tmp/anthropic",
            skills: [],
            source: "/tmp/anthropic/index.js",
          },
        ],
      },
    });

    expect(
      surface?.resolveThinkingProfile?.({ provider: "claude-cli", modelId: "claude-opus-4-8" }),
    ).toEqual({
      levels: [{ id: "claude-cli" }],
    });
    expect(loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "anthropic",
      artifactBasename: "provider-policy-api.js",
    });
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("does not cache manifest-owned provider policy aliases across bundled metadata changes", async () => {
    const bundledPluginsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-provider-policy-refresh-"),
    );
    const writePlugin = (pluginId: string, providers: string[], version: number) => {
      const pluginDir = path.join(bundledPluginsDir, pluginId);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          name: `${pluginId} ${version}`,
          configSchema: { type: "object" },
          providers,
        }),
      );
      fs.writeFileSync(
        path.join(pluginDir, "index.js"),
        "export default { register() {} };\n",
        "utf8",
      );
    };

    const loadBundledPluginPublicArtifactModuleSync = vi.fn(({ dirName }: { dirName: string }) => {
      if (dirName !== "first" && dirName !== "second") {
        throw new Error(`Unable to resolve bundled plugin public surface ${dirName}`);
      }
      return {
        resolveThinkingProfile: () => ({ levels: [{ id: dirName }] }),
      };
    });

    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    try {
      writePlugin("first", ["fixture-provider"], 1);
      writePlugin("second", [], 1);
      const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
        typeof import("./provider-public-artifacts.js")
      >(import.meta.url, "./provider-public-artifacts.js?scope=provider-alias-refresh");

      expect(
        resolvePolicySurface("fixture-provider")
          ?.resolveThinkingProfile?.({ provider: "fixture-provider", modelId: "demo" })
          ?.levels.map((level) => level.id),
      ).toEqual(["first"]);

      writePlugin("first", [], 2);
      writePlugin("second", ["fixture-provider"], 2);

      expect(
        resolvePolicySurface("fixture-provider")
          ?.resolveThinkingProfile?.({ provider: "fixture-provider", modelId: "demo" })
          ?.levels.map((level) => level.id),
      ).toEqual(["second"]);
    } finally {
      fs.rmSync(bundledPluginsDir, { force: true, recursive: true });
    }
  });

  it("uses caller-provided manifest metadata for provider policy aliases", async () => {
    const loadPluginManifestRegistry = vi.fn(() => {
      throw new Error("unexpected manifest registry scan");
    });
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(({ dirName }: { dirName: string }) => {
      if (dirName !== "owner") {
        throw new Error(`Unable to resolve bundled plugin public surface ${dirName}`);
      }
      return {
        resolveThinkingProfile: () => ({ levels: [{ id: dirName }] }),
      };
    });

    vi.doMock("./manifest-registry.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./manifest-registry.js")>();
      return {
        ...actual,
        loadPluginManifestRegistry,
      };
    });
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=provider-alias-manifest");

    const surface = resolvePolicySurface("alias", {
      manifestRegistry: {
        plugins: [
          {
            id: "owner",
            channels: [],
            cliBackends: [],
            hooks: [],
            origin: "bundled",
            manifestPath: "/tmp/owner/openclaw.plugin.json",
            providers: ["alias"],
            rootDir: "/tmp/owner",
            skills: [],
            source: "/tmp/owner/index.js",
          },
        ],
      },
    });

    expect(surface?.resolveThinkingProfile?.({ provider: "alias", modelId: "demo" })).toEqual({
      levels: [{ id: "owner" }],
    });
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("loads provider policy surfaces without package-manager repair", async () => {
    const loadBundledPluginPublicArtifactModuleSync = vi.fn(() => ({
      normalizeConfig: (ctx: { providerConfig: ModelProviderConfig }) => ctx.providerConfig,
    }));
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=no-runtime-deps");

    const surface = resolvePolicySurface("openai");
    expect(surface?.normalizeConfig).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "openai",
      artifactBasename: "provider-policy-api.js",
    });
  });
});
