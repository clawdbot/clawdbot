import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildManifestBuiltInModelSuppressionResolver: vi.fn(),
  resolveManifestBuiltInModelSuppression: vi.fn(),
}));

vi.mock("../plugins/manifest-model-suppression.js", () => ({
  buildManifestBuiltInModelSuppressionResolver: mocks.buildManifestBuiltInModelSuppressionResolver,
  resolveManifestBuiltInModelSuppression: mocks.resolveManifestBuiltInModelSuppression,
}));

import {
  buildShouldSuppressBuiltInModel,
  shouldSuppressBuiltInModel,
} from "./model-suppression.js";

describe("model suppression", () => {
  beforeEach(() => {
    mocks.buildManifestBuiltInModelSuppressionResolver.mockReset();
    mocks.resolveManifestBuiltInModelSuppression.mockReset();
  });

  it("uses manifest suppression", () => {
    mocks.resolveManifestBuiltInModelSuppression.mockReturnValueOnce({
      suppress: true,
      errorMessage: "manifest suppression",
    });

    expect(
      shouldSuppressBuiltInModel({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        config: {},
      }),
    ).toBe(true);

    expect(mocks.resolveManifestBuiltInModelSuppression).toHaveBeenCalledOnce();
  });

  it("does not run deprecated runtime suppression hooks", () => {
    expect(
      shouldSuppressBuiltInModel({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        config: {},
      }),
    ).toBe(false);

    expect(mocks.resolveManifestBuiltInModelSuppression).toHaveBeenCalledOnce();
  });

  describe("buildShouldSuppressBuiltInModel", () => {
    beforeEach(() => {
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReset();
    });

    it("creates a reusable manifest resolver with normalized provider and model ids", () => {
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
        provider: "amazon-bedrock",
        id: "claude-3",
      });
      expect(resolver).toHaveBeenNthCalledWith(2, {
        provider: "amazon-bedrock",
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
