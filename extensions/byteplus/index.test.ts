import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { BYTEPLUS_CODING_MODEL_CATALOG, BYTEPLUS_MODEL_CATALOG } from "./models.js";

describe("byteplus plugin", () => {
  it("augments the catalog with bundled standard and plan models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({
      env: process.env,
      entries: [],
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "byteplus",
        id: BYTEPLUS_MODEL_CATALOG[0].id,
        name: BYTEPLUS_MODEL_CATALOG[0].name,
        reasoning: BYTEPLUS_MODEL_CATALOG[0].reasoning,
        input: [...BYTEPLUS_MODEL_CATALOG[0].input],
        contextWindow: BYTEPLUS_MODEL_CATALOG[0].contextWindow,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "byteplus-plan",
        id: BYTEPLUS_CODING_MODEL_CATALOG[0].id,
        name: BYTEPLUS_CODING_MODEL_CATALOG[0].name,
        reasoning: BYTEPLUS_CODING_MODEL_CATALOG[0].reasoning,
        input: [...BYTEPLUS_CODING_MODEL_CATALOG[0].input],
        contextWindow: BYTEPLUS_CODING_MODEL_CATALOG[0].contextWindow,
      }),
    );
  });

  it("declares its coding provider auth alias in the manifest", () => {
    const pluginJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"),
    );

    expect(pluginJson.providerAuthAliases).toEqual({
      "byteplus-plan": "byteplus",
    });
  });

  it("keeps Kimi catalog metadata aligned with provider capabilities", () => {
    const standardKimi = BYTEPLUS_MODEL_CATALOG.find((entry) => entry.id === "kimi-k2-5-260127");
    const planKimi = BYTEPLUS_CODING_MODEL_CATALOG.find((entry) => entry.id === "kimi-k2.5");
    const thinkingKimi = BYTEPLUS_CODING_MODEL_CATALOG.find(
      (entry) => entry.id === "kimi-k2-thinking",
    );

    for (const entry of [standardKimi, planKimi, thinkingKimi]) {
      expect(entry).toEqual(
        expect.objectContaining({
          reasoning: true,
          maxTokens: 32768,
          cost: expect.objectContaining({
            input: 0.6,
            output: 2.5,
            cacheRead: 0.12,
            cacheWrite: 0,
          }),
        }),
      );
    }
  });
});
