import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureRemoteModelCatalogStartupSnapshot,
  checkRemoteModelCatalogUpdate,
  getRemoteModelCatalogPricing,
  getRemoteModelCatalogProviderOverlay,
} from "./remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

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
});

describe("remote model catalog overlay", () => {
  it("inspects pending generations without replacing the startup snapshot, rows, or prices", () => {
    const sourceUrl = "https://catalog.openclaw.ai/models/v1/catalog.json";
    const snapshot = captureRemoteModelCatalogStartupSnapshot();
    const overlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
    const pricing = getRemoteModelCatalogPricing({});
    expect(checkRemoteModelCatalogUpdate({}, { sourceUrl, generatedAt: 200 })).toBe("unchanged");
    expect(mocks.read).toHaveBeenCalledOnce();

    mocks.read.mockReturnValue({
      source_url: sourceUrl,
      bundle_json: JSON.stringify({
        ...bundle,
        generatedAt: 300,
        providers: { anthropic: { models: [{ id: "downloaded" }] } },
        pricing: { "openai/gpt-external": { input: 5, output: 20 } },
      }),
    });
    expect(checkRemoteModelCatalogUpdate({}, { sourceUrl, generatedAt: 300 })).toBe(
      "restart-required",
    );
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(snapshot);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBe(overlay);
    expect(getRemoteModelCatalogPricing({})).toBe(pricing);
  });

  it.each([{ enabled: false }, { url: "https://mirror.example.test/catalog.json" }])(
    "rejects a check superseded by config %j without reading stored data",
    (catalogRefresh) => {
      expect(
        checkRemoteModelCatalogUpdate(
          { models: { catalogRefresh } },
          { sourceUrl: "https://catalog.openclaw.ai/models/v1/catalog.json", generatedAt: 300 },
        ),
      ).toBe("superseded");
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    { sourceUrl: "https://mirror.example.test/catalog.json", generatedAt: 300 },
    { sourceUrl: "https://catalog.openclaw.ai/models/v1/catalog.json", generatedAt: 400 },
  ])("rejects a stored check superseded by %j", ({ sourceUrl, generatedAt }) => {
    const snapshot = captureRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue({
      source_url: sourceUrl,
      bundle_json: JSON.stringify({ ...bundle, generatedAt }),
    });
    expect(
      checkRemoteModelCatalogUpdate(
        {},
        {
          sourceUrl: "https://catalog.openclaw.ai/models/v1/catalog.json",
          generatedAt: 300,
        },
      ),
    ).toBe("superseded");
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(snapshot);
  });

  it("reports failed inspection without replacing a valid startup snapshot", () => {
    const snapshot = captureRemoteModelCatalogStartupSnapshot();
    mocks.read.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
      bundle_json: "{",
    });
    expect(() =>
      checkRemoteModelCatalogUpdate(
        {},
        {
          sourceUrl: "https://catalog.openclaw.ai/models/v1/catalog.json",
          generatedAt: 300,
        },
      ),
    ).toThrow(SyntaxError);
    expect(captureRemoteModelCatalogStartupSnapshot()).toBe(snapshot);
  });

  it("loads a newer compatible bundle once", () => {
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]).toEqual({
      input: 2.5,
      output: 10,
    });
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("keeps startup rows and prices when the configured source changes", () => {
    const overlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
    const pricing = getRemoteModelCatalogPricing({});
    mocks.read.mockReturnValue({
      bundle_json: JSON.stringify({
        ...bundle,
        generatedAt: 300,
        providers: { anthropic: { models: [{ id: "downloaded" }] } },
        pricing: { "openai/gpt-external": { input: 5, output: 20 } },
      }),
      source_url: "https://mirror.example.test/catalog.json",
    });
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toEqual(overlay);
    expect(getRemoteModelCatalogPricing({})).toEqual(pricing);
  });

  it("keeps invalid startup metadata absent after a successful download", () => {
    const valid = mocks.read();
    mocks.read.mockReturnValue({ ...valid, bundle_json: "{" });
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
    mocks.read.mockReturnValue(valid);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
    expect(getRemoteModelCatalogPricing({})).toBeUndefined();
  });

  it("passes the same startup rows and prices to later workers", async () => {
    const expected = {
      overlay: getRemoteModelCatalogProviderOverlay({}, "anthropic"),
      pricing: getRemoteModelCatalogPricing({}),
    };
    mocks.read.mockReturnValue(undefined);
    const worker = new Worker(new URL("./remote-overlay.worker.test-support.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
    });
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual(expected);
    } finally {
      await worker.terminate();
    }
  });

  it("fails closed when disabled, stale, or missing a build stamp", () => {
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { enabled: false } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.builtAt.mockReturnValue(200);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: mocks.builtAt,
      readStoredCatalog: mocks.read,
    });
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
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
