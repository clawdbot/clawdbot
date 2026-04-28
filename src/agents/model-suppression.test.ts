import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveManifestBuiltInModelSuppression: vi.fn(),
}));

vi.mock("../plugins/manifest-model-suppression.js", () => ({
  resolveManifestBuiltInModelSuppression: mocks.resolveManifestBuiltInModelSuppression,
}));

import { shouldSuppressBuiltInModel } from "./model-suppression.js";

describe("model suppression", () => {
  beforeEach(() => {
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
});
