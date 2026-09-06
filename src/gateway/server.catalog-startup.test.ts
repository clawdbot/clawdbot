import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getRemoteModelCatalogPricing,
  getRemoteModelCatalogProviderOverlay,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { startGatewayServerCore } from "./server-start.js";
import * as bootstrap from "./server-startup-bootstrap.js";

describe("Gateway startup catalog", () => {
  it.each([false, true])("captures metadata before bootstrap awaits, absent=%s", async (absent) => {
    const bundle = {
      schemaVersion: 1,
      generatedAt: 200,
      sourceCommit: "fixture",
      providers: { anthropic: { models: [{ id: "startup-model" }] } },
      pricing: { "anthropic/startup-model": { input: 1, output: 2 } },
    };
    const stored = {
      id: 1,
      bundle_json: JSON.stringify(bundle),
      generated_at: 200,
      min_version: null,
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
      etag: null,
      last_modified: null,
      checked_at: 200,
    };
    const read = vi.fn(() => (absent ? undefined : stored));
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog: read,
    });
    const pending = createDeferred<never>();
    const stopped = new Error("fixture stops bootstrap");
    const prepare = vi
      .spyOn(bootstrap, "prepareGatewayServerBootstrap")
      .mockImplementationOnce(() => {
        return pending.promise;
      });
    const startup = startGatewayServerCore(0).catch((error: unknown) => error);
    try {
      read.mockReturnValue({
        ...stored,
        bundle_json: JSON.stringify({
          ...bundle,
          providers: { anthropic: { models: [{ id: "downloaded-model" }] } },
          pricing: { "anthropic/startup-model": { input: 3, output: 4 } },
        }),
      });
      expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toEqual(
        absent ? undefined : bundle.providers.anthropic,
      );
      expect(getRemoteModelCatalogPricing({})).toEqual(absent ? undefined : bundle.pricing);
    } finally {
      pending.reject(stopped);
      const outcome = await startup;
      prepare.mockRestore();
      setRemoteModelCatalogOverlaySourcesForTest();
      expect(outcome).toBe(stopped);
    }
  });
});
