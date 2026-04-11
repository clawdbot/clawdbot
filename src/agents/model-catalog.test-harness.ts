import { afterEach, beforeEach, vi } from "vitest";
import { resetProviderRuntimeHookCacheForTest } from "../plugins/provider-runtime.js";
import { __setModelCatalogImportForTest, resetModelCatalogCacheForTest } from "./model-catalog.js";

export type PiSdkModule = typeof import("./pi-model-discovery.js");

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false }),
}));

vi.mock("./agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/openclaw",
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: vi.fn().mockResolvedValue([]),
}));

export function installModelCatalogTestHooks() {
  beforeEach(() => {
    resetModelCatalogCacheForTest();
    resetProviderRuntimeHookCacheForTest();
  });

  afterEach(() => {
    __setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    resetProviderRuntimeHookCacheForTest();
    vi.restoreAllMocks();
  });
}

export function mockCatalogImportFailThenRecover() {
  let call = 0;
  __setModelCatalogImportForTest(async () => {
    call += 1;
    if (call === 1) {
      throw new Error("boom");
    }
    return {
      discoverAuthStorage: () => ({}),
      AuthStorage: function AuthStorage() {},
      ModelRegistry: class {
        getAll() {
          return [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }];
        }
      },
    } as unknown as PiSdkModule;
  });
  return () => call;
}
