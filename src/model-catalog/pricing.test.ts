import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelCostConfig } from "../utils/usage-format.js";
import {
  resetRemoteModelCatalogOverlayForTest,
  setRemoteModelCatalogOverlaySourcesForTest,
} from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readStoredCatalog = vi.fn();

beforeEach(() => {
  resetRemoteModelCatalogOverlayForTest();
  readStoredCatalog.mockReset().mockReturnValue({
    source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
    bundle_json: JSON.stringify({
      schemaVersion: 1,
      generatedAt: 200,
      minVersion: "2026.7.0",
      sourceCommit: "pricing-test",
      providers: { openai: { models: [{ id: "gpt-catalog", cost: { input: 1, output: 2 } }] } },
      pricing: { "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 } },
    }),
  });
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 100,
    readStoredCatalog,
  });
});

afterEach(() => {
  setRemoteModelCatalogOverlaySourcesForTest();
  resetRemoteModelCatalogOverlayForTest();
});

function configFor(baseUrl: string): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl,
          models: [{ id: "gpt-external", name: "External GPT" }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("hosted model pricing", () => {
  it("resolves a non-catalog model from the stored hosted pricing map", () => {
    const agentDir = tempDirs.make("openclaw-hosted-pricing-");
    expect(
      resolveModelCostConfig({
        config: configFor("https://api.openai.com/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toEqual({ input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 });
  });

  it("prefers merged catalog pricing over configured pricing", () => {
    const agentDir = tempDirs.make("openclaw-catalog-pricing-");
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-catalog",
                name: "Catalog GPT",
                cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "openai", model: "gpt-catalog" }),
    ).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("does not apply hosted pricing to private endpoints or unknown models", () => {
    const agentDir = tempDirs.make("openclaw-private-pricing-");
    expect(
      resolveModelCostConfig({
        config: configFor("http://127.0.0.1:8080/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toBeUndefined();
    expect(
      resolveModelCostConfig({
        config: configFor("https://api.openai.com/v1"),
        agentDir,
        provider: "openai",
        model: "unknown-model",
      }),
    ).toBeUndefined();
    const disabled = configFor("https://api.openai.com/v1");
    disabled.models = {
      ...disabled.models,
      catalogRefresh: { enabled: false },
    };
    expect(
      resolveModelCostConfig({
        config: disabled,
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toBeUndefined();
  });
});
