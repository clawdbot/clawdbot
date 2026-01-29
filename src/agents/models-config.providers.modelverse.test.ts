import { afterEach, describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Modelverse provider", () => {
  const previousKey = process.env.MODELVERSE_API_KEY;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.MODELVERSE_API_KEY;
    } else {
      process.env.MODELVERSE_API_KEY = previousKey;
    }
  });

  it("should not include modelverse when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "clawd-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.modelverse).toBeUndefined();
  });

  it("should include modelverse when MODELVERSE_API_KEY is configured", async () => {
    process.env.MODELVERSE_API_KEY = "sk-modelverse-test";
    const agentDir = mkdtempSync(join(tmpdir(), "clawd-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.modelverse).toBeDefined();
    expect(providers.modelverse).toMatchObject({
      baseUrl: "https://api.modelverse.cn/v1",
      api: "openai-completions",
    });
    expect(providers.modelverse.models.some((model) => model.id === "gpt-5.2")).toBe(true);
  });
});
