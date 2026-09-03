// Verifies channel schema failures follow the plugin manifest trust boundary.

import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

const malformedSchema = {
  type: "object",
  properties: { mode: { $ref: "#/$defs/Mode" } },
};

function createRegistry(origin: PluginManifestRecord["origin"]): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "schema-owner",
        channels: ["schema-channel"],
        channelConfigs: { "schema-channel": { schema: malformedSchema } },
        cliBackends: [],
        hooks: [],
        manifestPath: "/plugins/schema-owner/openclaw.plugin.json",
        origin,
        providers: [],
        rootDir: "/plugins/schema-owner",
        skills: [],
        source: "/plugins/schema-owner/index.js",
      },
    ],
  };
}

function validate(origin: PluginManifestRecord["origin"]) {
  return validateConfigObjectRawWithPlugins(
    { channels: { "schema-channel": {} } },
    { pluginMetadataSnapshot: { manifestRegistry: createRegistry(origin) } },
  );
}

describe("channel schema error ownership", () => {
  it("reports malformed external channel schemas as scoped issues", () => {
    const result = validate("global");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.schema-channel",
          message: expect.stringContaining("invalid schema"),
        }),
      );
    }
  });

  it("keeps malformed bundled channel schemas on the throwing path", () => {
    expect(() => validate("bundled")).toThrow("invalid schema");
  });
});
