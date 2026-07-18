// Byteplus tests cover index plugin behavior.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { BYTEPLUS_CODING_MODEL_CATALOG, BYTEPLUS_MODEL_CATALOG } from "./models.js";

describe("byteplus plugin", () => {
  it("augments the catalog with bundled standard and plan models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const standardModel = expectDefined(BYTEPLUS_MODEL_CATALOG[0], "BytePlus standard model");
    const codingModel = expectDefined(BYTEPLUS_CODING_MODEL_CATALOG[0], "BytePlus coding model");
    const entries = await provider.augmentModelCatalog?.({
      env: process.env,
      entries: [],
    } as never);

    const standardEntry = entries?.find(
      (entry) => entry.provider === "byteplus" && entry.id === standardModel.id,
    );
    expect(standardEntry?.name).toBe(standardModel.name);
    expect(standardEntry?.reasoning).toBe(standardModel.reasoning);
    expect(standardEntry?.input).toEqual([...standardModel.input]);
    expect(standardEntry?.contextWindow).toBe(standardModel.contextWindow);

    const planEntry = entries?.find(
      (entry) => entry.provider === "byteplus-plan" && entry.id === codingModel.id,
    );
    expect(planEntry?.name).toBe(codingModel.name);
    expect(planEntry?.reasoning).toBe(codingModel.reasoning);
    expect(planEntry?.input).toEqual([...codingModel.input]);
    expect(planEntry?.contextWindow).toBe(codingModel.contextWindow);
    expect(BYTEPLUS_CODING_MODEL_CATALOG.map((entry) => entry.id)).toEqual([
      "ark-code-latest",
      "glm-4.7",
      "kimi-k2.5",
    ]);
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

    for (const entry of [standardKimi, planKimi]) {
      expect(entry?.reasoning).toBe(true);
      expect(entry?.maxTokens).toBe(32768);
      expect(entry?.cost?.input).toBe(0.6);
      expect(entry?.cost?.output).toBe(2.5);
      expect(entry?.cost?.cacheRead).toBe(0.12);
      expect(entry?.cost?.cacheWrite).toBe(0);
    }
  });
});
