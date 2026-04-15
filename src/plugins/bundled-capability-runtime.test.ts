import { describe, expect, it } from "vitest";
import { buildVitestCapabilityShimAliasMap } from "./bundled-capability-runtime.js";

describe("buildVitestCapabilityShimAliasMap", () => {
  it("keeps scoped and unscoped capability shim aliases aligned", () => {
    const aliasMap = buildVitestCapabilityShimAliasMap();

    expect(aliasMap["openclaw/plugin-sdk/llm-task"]).toBe(
      aliasMap["@openclaw/plugin-sdk/llm-task"],
    );
    expect(aliasMap["openclaw/plugin-sdk/config-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/config-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/media-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/media-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/provider-onboard"]).toBe(
      aliasMap["@openclaw/plugin-sdk/provider-onboard"],
    );
    expect(aliasMap["openclaw/plugin-sdk/speech-core"]).toBe(
      aliasMap["@openclaw/plugin-sdk/speech-core"],
    );
  });
});
