import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { MoltbotConfig } from "../config/config.js";
import { resolveImplicitOpenAiProvider } from "./models-config.providers.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "moltbot-models-openai-" });
}

describe("models-config OPENAI_BASE_URL env override", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("injects openai provider with baseUrl when OPENAI_BASE_URL is set", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevBaseUrl = process.env.OPENAI_BASE_URL;
      process.env.OPENAI_BASE_URL = "http://localhost:8000/v1";
      try {
        const { ensureMoltbotModelsJson } = await import("./models-config.js");
        const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

        const cfg: MoltbotConfig = {};

        await ensureMoltbotModelsJson(cfg);

        const modelPath = path.join(resolveMoltbotAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string; models?: unknown[] }>;
        };

        expect(parsed.providers.openai).toBeDefined();
        expect(parsed.providers.openai?.baseUrl).toBe("http://localhost:8000/v1");
        // models should be empty to keep built-in catalog
        expect(parsed.providers.openai?.models).toEqual([]);
      } finally {
        if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = prevBaseUrl;
      }
    });
  });

  it("does not inject openai provider when OPENAI_BASE_URL is not set", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevBaseUrl = process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_BASE_URL;
      try {
        const { ensureMoltbotModelsJson } = await import("./models-config.js");
        const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

        const cfg: MoltbotConfig = {};

        const result = await ensureMoltbotModelsJson(cfg);

        // With no implicit providers configured, no models.json should be written
        // (unless other implicit providers like ollama are detected)
        if (result.wrote) {
          const modelPath = path.join(resolveMoltbotAgentDir(), "models.json");
          const raw = await fs.readFile(modelPath, "utf8");
          const parsed = JSON.parse(raw) as {
            providers: Record<string, { baseUrl?: string }>;
          };
          // openai should not be present from env override
          expect(parsed.providers.openai?.baseUrl).toBeUndefined();
        }
      } finally {
        if (prevBaseUrl !== undefined) process.env.OPENAI_BASE_URL = prevBaseUrl;
      }
    });
  });

  it("explicit models.providers.openai.baseUrl takes precedence over env var", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevBaseUrl = process.env.OPENAI_BASE_URL;
      process.env.OPENAI_BASE_URL = "http://env-override:8000/v1";
      try {
        const { ensureMoltbotModelsJson } = await import("./models-config.js");
        const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

        const cfg: MoltbotConfig = {
          models: {
            providers: {
              openai: {
                baseUrl: "http://explicit-config:9000/v1",
                models: [],
              },
            },
          },
        };

        await ensureMoltbotModelsJson(cfg);

        const modelPath = path.join(resolveMoltbotAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        // Explicit config should take precedence
        expect(parsed.providers.openai?.baseUrl).toBe("http://explicit-config:9000/v1");
      } finally {
        if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = prevBaseUrl;
      }
    });
  });
});

describe("resolveImplicitOpenAiProvider", () => {
  it("returns null when OPENAI_BASE_URL is not set", () => {
    const result = resolveImplicitOpenAiProvider({ env: {} });
    expect(result).toBeNull();
  });

  it("returns provider config with baseUrl when OPENAI_BASE_URL is set", () => {
    const result = resolveImplicitOpenAiProvider({
      env: { OPENAI_BASE_URL: "http://test:8000/v1" },
    });

    expect(result).toEqual({
      baseUrl: "http://test:8000/v1",
      models: [],
    });
  });

  it("trims whitespace from OPENAI_BASE_URL", () => {
    const result = resolveImplicitOpenAiProvider({
      env: { OPENAI_BASE_URL: "  http://test:8000/v1  " },
    });

    expect(result?.baseUrl).toBe("http://test:8000/v1");
  });

  it("returns null for empty OPENAI_BASE_URL", () => {
    const result = resolveImplicitOpenAiProvider({
      env: { OPENAI_BASE_URL: "   " },
    });

    expect(result).toBeNull();
  });
});
