import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildManifestBuiltInModelSuppressionResolver: vi.fn(),
}));

vi.mock("../plugins/manifest-model-suppression.js", () => ({
  buildManifestBuiltInModelSuppressionResolver: mocks.buildManifestBuiltInModelSuppressionResolver,
}));

import {
  clearCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "../plugins/current-plugin-metadata-state.js";
import {
  buildShouldSuppressBuiltInModel,
  clearModelSuppressionResolverCacheForTest,
  shouldSuppressBuiltInModel,
} from "./model-suppression.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

describe("model suppression", () => {
  beforeEach(() => {
    clearCurrentPluginMetadataSnapshotState();
    clearModelSuppressionResolverCacheForTest();
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReset();
  });

  afterEach(() => {
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
      shouldSuppressBuiltInModel({
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
      shouldSuppressBuiltInModel({
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

    expect(shouldSuppressBuiltInModel({ provider: "openai", id: "gpt-5.3", config })).toBe(false);
    expect(shouldSuppressBuiltInModel({ provider: "anthropic", id: "claude-4", config })).toBe(
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

    setCurrentPluginMetadataSnapshotState({ id: "first" }, undefined);
    expect(shouldSuppressBuiltInModel({ provider: "openai", id: "gpt-5.3", config })).toBe(false);

    setCurrentPluginMetadataSnapshotState({ id: "second" }, undefined);
    expect(shouldSuppressBuiltInModel({ provider: "openai", id: "gpt-5.3", config })).toBe(false);

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(2);
    expect(firstResolver).toHaveBeenCalledOnce();
    expect(secondResolver).toHaveBeenCalledOnce();
  });

  it("refreshes manifest suppression resolver when process env plugin metadata inputs change", () => {
    const firstResolver = vi.fn().mockReturnValue(undefined);
    const secondResolver = vi.fn().mockReturnValue(undefined);
    const config = {};
    mocks.buildManifestBuiltInModelSuppressionResolver
      .mockReturnValueOnce(firstResolver)
      .mockReturnValueOnce(secondResolver);

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/tmp/openclaw-bundled-a";
    expect(shouldSuppressBuiltInModel({ provider: "openai", id: "gpt-5.3", config })).toBe(false);

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/tmp/openclaw-bundled-b";
    expect(shouldSuppressBuiltInModel({ provider: "openai", id: "gpt-5.3", config })).toBe(false);

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

    expect(shouldSuppressBuiltInModel({ provider: "openai", id: "gpt-5.3", config })).toBe(false);

    config.plugins.load.paths = ["/tmp/openclaw-plugin-b"];
    expect(shouldSuppressBuiltInModel({ provider: "openai", id: "gpt-5.3", config })).toBe(false);

    expect(mocks.buildManifestBuiltInModelSuppressionResolver).toHaveBeenCalledTimes(2);
    expect(firstResolver).toHaveBeenCalledOnce();
    expect(secondResolver).toHaveBeenCalledOnce();
  });

  describe("buildShouldSuppressBuiltInModel", () => {
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

      const shouldSuppress = buildShouldSuppressBuiltInModel({ config });

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

      const shouldSuppress = buildShouldSuppressBuiltInModel({});

      expect(shouldSuppress({ provider: "openai", id: "" })).toBe(false);
      expect(shouldSuppress({ provider: "", id: "gpt-5.5" })).toBe(false);
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});
