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

import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
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

  it("does not reuse standalone suppression rules across fresh operation owners", () => {
    const config = {};
    const firstOwner = createPluginCache();
    const secondOwner = createPluginCache();
    mocks.buildManifestBuiltInModelSuppressionResolver.mockImplementation(() => {
      const suppressed = getPluginCache() === firstOwner;
      return () =>
        suppressed ? { suppress: true, errorMessage: "first operation policy" } : undefined;
    });
    const check = () =>
      shouldSuppressBuiltInModelCore({ provider: "fixture", id: "model", config });

    expect(withPluginCache(firstOwner, check)).toBe(true);
    expect(withPluginCache(secondOwner, check)).toBe(false);
    expect(withPluginCache(firstOwner, check)).toBe(true);
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
  });

  it("returns false when no manifest suppression applies", () => {
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

  it("delegates repeated checks to the manifest-owned resolver", () => {
    const resolver = vi.fn().mockReturnValue(undefined);
    const config = {};
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValue(resolver);

    expect(shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config })).toBe(
      false,
    );
    expect(shouldSuppressBuiltInModelCore({ provider: "anthropic", id: "claude-4", config })).toBe(
      false,
    );

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(2);
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

  it("reads each concurrent generation's suppression rules across A/B/A interleaving", async () => {
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
    const resultA = withPluginRuntimeGenerationScope({ metadataSnapshot: snapshotA }, async () => {
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
    });
    await aReady;

    const resultB = await withPluginRuntimeGenerationScope(
      { metadataSnapshot: snapshotB },
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
    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(3);
  });

  it("passes config identity and workspace to the manifest owner", () => {
    const configA = {} satisfies OpenClawConfig;
    const configB = {} satisfies OpenClawConfig;
    const snapshot = createPluginMetadataSnapshot({
      config: configA,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValue(() => undefined);

    const check = (config: OpenClawConfig, workspaceDir: string) =>
      withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, () =>
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
    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(4);
  });

  it("does not fingerprint metadata while delegating prepared generation reads", () => {
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

    withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, () => {
      shouldSuppressBuiltInModelCore({ provider: "openai", id: "gpt-5.3", config });
      controlPlaneFingerprint.mockClear();
      envFingerprint.mockClear();

      shouldSuppressBuiltInModelCore({ provider: "anthropic", id: "claude-4", config });

      expect(controlPlaneFingerprint).not.toHaveBeenCalled();
      expect(envFingerprint).not.toHaveBeenCalled();
    });
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

    it("reuses the manifest owner for repeated model decisions", () => {
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
    });
  });
});
