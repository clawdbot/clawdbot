import { describe, expect, it } from "vitest";
import { PROVIDER_IDS } from "../registry.js";
import { listProviderPlugins } from "./index.js";

describe("provider plugin registry", () => {
  it("stays in sync with provider ids", () => {
    const pluginIds = listProviderPlugins()
      .map((plugin) => plugin.id)
      .slice()
      .sort();
    const providerIds = [...PROVIDER_IDS].slice().sort();
    expect(pluginIds).toEqual(providerIds);
  });
});
