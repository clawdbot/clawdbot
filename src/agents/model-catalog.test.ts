import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import {
  __setModelCatalogImportForTest,
  loadModelCatalog,
  resetModelCatalogCacheForTest,
} from "./model-catalog.js";

type PiSdkModule = typeof import("@mariozechner/pi-coding-agent");

vi.mock("./models-config.js", () => ({
  ensureMoltbotModelsJson: vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false }),
}));

vi.mock("./agent-paths.js", () => ({
  resolveMoltbotAgentDir: () => "/tmp/moltbot",
}));

describe("loadModelCatalog", () => {
  beforeEach(() => {
    resetModelCatalogCacheForTest();
  });

  afterEach(() => {
    __setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    vi.restoreAllMocks();
  });

  it("retries after import failure without poisoning the cache", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let call = 0;

    __setModelCatalogImportForTest(async () => {
      call += 1;
      if (call === 1) {
        throw new Error("boom");
      }
      return {
        discoverAuthStorage: () => ({}),
        discoverModels: () => [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
      } as unknown as PiSdkModule;
    });

    const cfg = {} as MoltbotConfig;
    const first = await loadModelCatalog({ config: cfg });
    expect(first).toEqual([]);

    const second = await loadModelCatalog({ config: cfg });
    expect(second).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
    expect(call).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns partial results on discovery errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    __setModelCatalogImportForTest(
      async () =>
        ({
          discoverAuthStorage: () => ({}),
          discoverModels: () => ({
            getAll: () => [
              { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
              {
                get id() {
                  throw new Error("boom");
                },
                provider: "openai",
                name: "bad",
              },
            ],
          }),
        }) as unknown as PiSdkModule,
    );

    const result = await loadModelCatalog({ config: {} as MoltbotConfig });
    expect(result).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
