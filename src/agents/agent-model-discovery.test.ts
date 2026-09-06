/** Tests agent model discovery registry refresh and lookup cache behavior. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  discoverAuthStorage,
  discoverModels,
  discoverModelsFromCapturedSources,
} from "./agent-model-discovery.js";

// Discovery must not cold-load bundled plugin runtime: with build artifacts
// present, the openai plugin's normalizeResolvedModel currently overrides
// authored models.json api values, making these assertions machine-dependent.
// The ambient plugin metadata snapshot is cleared for the same reason.
beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => vi.unstubAllEnvs());

function writeModelsJson(agentDir: string, modelId: string): void {
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://example.test/v1",
          apiKey: "sk-test",
          api: "openai",
          models: [{ id: modelId, name: modelId }],
        },
      },
    }),
  );
}

describe("discoverModels", () => {
  it("uses a directory-independent source label for lifecycle-captured catalogs", () => {
    const firstAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-models-first-"));
    const secondAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-models-second-"));
    try {
      const createRegistry = (agentDir: string) =>
        discoverModelsFromCapturedSources(
          discoverAuthStorage(agentDir, { skipCredentials: true }),
          {
            includePluginCatalogs: true,
            modelsJsonContents: "not valid json",
            pluginCatalogs: [],
          },
        );

      const firstError = createRegistry(firstAgentDir).getError();
      const secondError = createRegistry(secondAgentDir).getError();

      expect(firstError).toBe(secondError);
      expect(firstError).toContain("captured:models.json");
      expect(firstError).not.toContain(firstAgentDir);
      expect(secondError).not.toContain(secondAgentDir);
    } finally {
      fs.rmSync(firstAgentDir, { recursive: true, force: true });
      fs.rmSync(secondAgentDir, { recursive: true, force: true });
    }
  });

  it("clears cached find results when the agent model registry refreshes", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-models-"));
    writeModelsJson(agentDir, "old-model");
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });
    const registry = discoverModels(authStorage, agentDir, { normalizeModels: false });

    expect(registry.find("custom", "new-model")).toBeUndefined();

    writeModelsJson(agentDir, "new-model");
    registry.refresh();

    expect(registry.getAll().some((model) => model.id === "new-model")).toBe(true);
    expect(registry.find("custom", "new-model")?.id).toBe("new-model");
  });

  it("preserves authored OpenAI Completions while normalizing models.json entries", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-models-"));
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                baseUrl: "https://api.openai.com/v1",
              },
            ],
          },
        },
      }),
    );
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                baseUrl: "https://api.openai.com/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });
    const registry = discoverModels(authStorage, agentDir, { config });

    expect(registry.find("openai", "gpt-5.5")?.api).toBe("openai-completions");
  });
});
