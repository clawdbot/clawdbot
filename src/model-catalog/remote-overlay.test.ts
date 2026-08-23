import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRemoteModelCatalogPricing,
  getRemoteModelCatalogProviderOverlay,
} from "./remote-overlay.js";
import {
  resetRemoteModelCatalogOverlayForTest,
  setRemoteModelCatalogOverlaySourcesForTest,
} from "./remote-overlay.test-support.js";

const mocks = {
  builtAt: vi.fn<() => number | undefined>(),
  read: vi.fn(),
};

const bundle = {
  schemaVersion: 1,
  generatedAt: 200,
  minVersion: "2026.7.0",
  sourceCommit: "abc",
  providers: { anthropic: { models: [{ id: "new" }] } },
  pricing: { "openai/gpt-external": { input: 2.5, output: 10 } },
};

beforeEach(() => {
  resetRemoteModelCatalogOverlayForTest();
  mocks.builtAt.mockReset().mockReturnValue(100);
  mocks.read.mockReset().mockReturnValue({
    bundle_json: JSON.stringify(bundle),
    source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
  });
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: mocks.builtAt,
    readStoredCatalog: mocks.read,
  });
});

afterEach(() => {
  setRemoteModelCatalogOverlaySourcesForTest();
  resetRemoteModelCatalogOverlayForTest();
});

describe("remote model catalog overlay", () => {
  it("loads a newer compatible bundle once", () => {
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]).toEqual({
      input: 2.5,
      output: 10,
    });
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("fails closed when disabled, stale, or missing a build stamp", () => {
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { enabled: false } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
    resetRemoteModelCatalogOverlayForTest();
    mocks.builtAt.mockReturnValue(200);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
    resetRemoteModelCatalogOverlayForTest();
    mocks.builtAt.mockReturnValue(undefined);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
  });

  it("does not reuse a cached overlay after disablement or a URL change", () => {
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { enabled: false } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(
      getRemoteModelCatalogProviderOverlay(
        {
          models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } },
        },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});
