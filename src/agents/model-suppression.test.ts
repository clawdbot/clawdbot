/**
 * Regression coverage for built-in model suppression helpers.
 * Verifies plugin manifest suppression rules, cache reuse, and lifecycle clears.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  buildManifestBuiltInModelSuppressionResolver: vi.fn(),
}));

vi.mock("../plugins/manifest-model-suppression.js", () => ({
  buildManifestBuiltInModelSuppressionResolver: mocks.buildManifestBuiltInModelSuppressionResolver,
}));

import {
  getCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import * as pluginControlPlaneContext from "../plugins/plugin-control-plane-context.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadataSnapshot from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  buildShouldSuppressBuiltInModelCore,
  shouldSuppressBuiltInModelCore,
} from "./model-suppression.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

describe("model suppression", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCurrentPluginMetadataSnapshot(undefined);
    if (originalBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
    }
  });

  it("uses manifest suppression", () => {
    const resolver = vi.fn().mockReturnValueOnce({
      suppress: true,
      errorMessage: "manifest suppression",
    });
    const config = {};
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValueOnce(resolver);

    expect(
      shouldSuppressBuiltInModelCore({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        config,
      }),
    ).toBe(true);

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledOnce();
    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledWith({
      config,
      env: process.env,
    });
    expect(resolver).toHaveBeenCalledWith({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
    });
  });

  it("does not run deprecated runtime suppression hooks", () => {
    const resolver = vi.fn().mockReturnValueOnce(undefined);
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValueOnce(resolver);

    expect(
      shouldSuppressBuiltInModelCore({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        config: {},
      }),
    ).toBe(false);

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledOnce();
  });

  it("reuses manifest suppression resolver for repeated checks with the same scope", () => {
    const resolver = vi.fn().mockReturnValue(undefined);
    const config = {};
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValueOnce(resolver);

    expect(shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config })).toBe(
      false,
    );
    expect(shouldSuppressBuiltInModelCore({ provider: "anthropic", id: "claude-4", config })).toBe(
      false,
    );

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("refreshes manifest suppression resolver when the current metadata snapshot changes", () => {
    const firstResolver = vi.fn().mockReturnValue(undefined);
    const secondResolver = vi.fn().mockReturnValue(undefined);
    const config = {};
    mocks.buildManifestBuiltInModelSuppressionResolver
      .mockReturnValueOnce(firstResolver)
      .mockReturnValueOnce(secondResolver);

    const firstSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const secondSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    setCurrentPluginMetadataSnapshot(firstSnapshot, { config });
    expect(shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config })).toBe(
      false,
    );

    setCurrentPluginMetadataSnapshot(secondSnapshot, { config });
    expect(shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config })).toBe(
      false,
    );

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(2);
    expect(firstResolver).toHaveBeenCalledOnce();
    expect(secondResolver).toHaveBeenCalledOnce();
  });

  it("reuses each concurrent generation's suppression resolver across A/B/A interleaving", async () => {
    const config = {} satisfies OpenClawConfig;
    const snapshotA = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const snapshotB = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    setCurrentPluginMetadataSnapshot(snapshotB, { config });
    mocks.buildManifestBuiltInModelSuppressionResolver.mockImplementation(() => {
      const snapshot = getCurrentPluginMetadataSnapshot({ config, env: process.env });
      return () =>
        snapshot === snapshotA ? { suppress: true, errorMessage: "generation A" } : undefined;
    });
    let releaseA!: () => void;
    let markAReady!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const aReady = new Promise<void>((resolve) => {
      markAReady = resolve;
    });
    const resultA = withPluginRuntimeGenerationScope(
      { config, metadataSnapshot: snapshotA },
      async () => {
        const result = shouldSuppressBuiltInModelCore({
          provider: "openai",
          id: "generation-model",
          config,
        });
        markAReady();
        await holdA;
        return [
          result,
          shouldSuppressBuiltInModelCore({
            provider: "openai",
            id: "generation-model",
            config,
          }),
        ];
      },
    );
    await aReady;

    const resultB = await withPluginRuntimeGenerationScope(
      { config, metadataSnapshot: snapshotB },
      async () =>
        shouldSuppressBuiltInModelCore({
          provider: "openai",
          id: "generation-model",
          config,
        }),
    );
    releaseA();

    await expect(resultA).resolves.toEqual([true, true]);
    expect(resultB).toBe(false);
    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(2);
  });

  it("keys generation resolvers by config identity and workspace", () => {
    const configA = {} satisfies OpenClawConfig;
    const configB = {} satisfies OpenClawConfig;
    const snapshot = createPluginMetadataSnapshot({
      config: configA,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValue(() => undefined);

    const check = (config: OpenClawConfig, workspaceDir: string) =>
      withPluginRuntimeGenerationScope({ config, metadataSnapshot: snapshot }, () =>
        shouldSuppressBuiltInModelCore({
          provider: "openai",
          id: "generation-model",
          config,
          workspaceDir,
        }),
      );

    expect(check(configA, "/workspace/a")).toBe(false);
    expect(check(configB, "/workspace/a")).toBe(false);
    expect(check(configA, "/workspace/b")).toBe(false);
    expect(check(configA, "/workspace/a")).toBe(false);
    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(3);
  });

  it("does not recompute content fingerprints on a stable generation cache hit", () => {
    const config = {} satisfies OpenClawConfig;
    const snapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValue(() => undefined);
    const controlPlaneFingerprint = vi.spyOn(
      pluginControlPlaneContext,
      "resolvePluginControlPlaneFingerprint",
    );
    const envFingerprint = vi.spyOn(pluginMetadataSnapshot, "resolvePluginMetadataEnvFingerprint");

    withPluginRuntimeGenerationScope({ config, metadataSnapshot: snapshot }, () => {
      shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config });
      controlPlaneFingerprint.mockClear();
      envFingerprint.mockClear();

      shouldSuppressBuiltInModelCore({ provider: "anthropic", id: "claude-4", config });

      expect(controlPlaneFingerprint).not.toHaveBeenCalled();
      expect(envFingerprint).not.toHaveBeenCalled();
    });
  });

  it("rebuilds a generation resolver after plugin metadata lifecycle caches clear", () => {
    const config = {} satisfies OpenClawConfig;
    const snapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValue(() => undefined);

    withPluginRuntimeGenerationScope({ config, metadataSnapshot: snapshot }, () => {
      shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config });
      clearPluginMetadataLifecycleCaches();
      shouldSuppressBuiltInModelCore({ provider: "anthropic", id: "claude-4", config });
    });

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(2);
  });

  it("refreshes manifest suppression resolver when process env plugin metadata inputs change", () => {
    const firstResolver = vi.fn().mockReturnValue(undefined);
    const secondResolver = vi.fn().mockReturnValue(undefined);
    const config = {};
    mocks.buildManifestBuiltInModelSuppressionResolver
      .mockReturnValueOnce(firstResolver)
      .mockReturnValueOnce(secondResolver);

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/tmp/openclaw-bundled-a";
    expect(shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config })).toBe(
      false,
    );

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/tmp/openclaw-bundled-b";
    expect(shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config })).toBe(
      false,
    );

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(2);
    expect(firstResolver).toHaveBeenCalledOnce();
    expect(secondResolver).toHaveBeenCalledOnce();
  });

  it("refreshes manifest suppression resolver when config plugin inputs mutate in place", () => {
    const firstResolver = vi.fn().mockReturnValue(undefined);
    const secondResolver = vi.fn().mockReturnValue(undefined);
    const config = { plugins: { load: { paths: ["/tmp/openclaw-plugin-a"] } } };
    mocks.buildManifestBuiltInModelSuppressionResolver
      .mockReturnValueOnce(firstResolver)
      .mockReturnValueOnce(secondResolver);

    expect(shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config })).toBe(
      false,
    );

    config.plugins.load.paths = ["/tmp/openclaw-plugin-b"];
    expect(shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config })).toBe(
      false,
    );

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(2);
    expect(firstResolver).toHaveBeenCalledOnce();
    expect(secondResolver).toHaveBeenCalledOnce();
  });

  describe("buildShouldSuppressBuiltInModelCore", () => {
    beforeEach(() => {
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReset();
    });

    it("creates a reusable manifest resolver with lowercase provider and model ids", () => {
      const resolver = vi
        .fn()
        .mockReturnValueOnce({ suppress: true, errorMessage: "manifest suppression" })
        .mockReturnValueOnce(undefined);
      const config = {};
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValueOnce(resolver);

      const shouldSuppress = buildShouldSuppressBuiltInModelCore({ config });

      expect(shouldSuppress({ provider: "bedrock", id: "Claude-3" })).toBe(true);
      expect(shouldSuppress({ provider: "aws-bedrock", id: "claude-4" })).toBe(false);
      expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledOnce();
      expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledWith({
        config,
        env: process.env,
      });
      expect(resolver).toHaveBeenNthCalledWith(1, {
        provider: "bedrock",
        id: "claude-3",
      });
      expect(resolver).toHaveBeenNthCalledWith(2, {
        provider: "aws-bedrock",
        id: "claude-4",
      });
    });

    it("does not call the manifest resolver for empty provider or model ids", () => {
      const resolver = vi.fn();
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValueOnce(resolver);

      const shouldSuppress = buildShouldSuppressBuiltInModelCore({});

      expect(shouldSuppress({ provider: "openai", id: "" })).toBe(false);
      expect(shouldSuppress({ provider: "", id: "gpt-5.5" })).toBe(false);
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});
