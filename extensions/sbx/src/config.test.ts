// Sbx tests cover config plugin behavior.
import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import { createSbxPluginConfigSchema, resolveSbxPluginConfig } from "./config.js";

describe("sbx plugin config", () => {
  it("applies defaults", () => {
    expect(resolveSbxPluginConfig(undefined)).toEqual({
      command: "sbx",
      agent: "shell",
      template: undefined,
      pull: "missing",
      timeoutMs: 120_000,
    });
  });

  it("accepts an alternate agent/kit", () => {
    expect(resolveSbxPluginConfig({ agent: "opencode" }).agent).toBe("opencode");
  });

  it("accepts a pull policy override", () => {
    expect(resolveSbxPluginConfig({ pull: "always" }).pull).toBe("always");
  });

  it("rejects unknown pull policy", () => {
    expect(() => resolveSbxPluginConfig({ pull: "bogus" })).toThrow(
      "pull must be one of always, missing, never",
    );
  });

  it("rejects timeouts beyond Node's safe timer range", () => {
    expect(() => resolveSbxPluginConfig({ timeoutSeconds: 2_147_001 })).toThrow(
      "timeoutSeconds must be a number <= 2147000",
    );
  });

  it("converts timeoutSeconds to milliseconds", () => {
    expect(resolveSbxPluginConfig({ timeoutSeconds: 30 }).timeoutMs).toBe(30_000);
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fsSync.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(createSbxPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });
});
