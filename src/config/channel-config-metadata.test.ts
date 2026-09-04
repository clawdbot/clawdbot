// Verifies channel config metadata collection stays total on untrusted manifest schemas.

import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";

function createChannelSchemaRegistry(
  channelId: string,
  schema: Record<string, unknown>,
  origin: PluginManifestRecord["origin"] = "global",
) {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "deep-channel-schema-plugin",
        channels: [channelId],
        channelConfigs: { [channelId]: { schema } },
        cliBackends: [],
        hooks: [],
        manifestPath: "/tmp/deep-channel-schema-plugin/openclaw.plugin.json",
        origin,
        providers: [],
        rootDir: "/tmp/deep-channel-schema-plugin",
        skills: [],
        source: "/tmp/deep-channel-schema-plugin/index.js",
      } satisfies PluginManifestRecord,
    ],
  };
}

describe("collectChannelSchemaMetadataWithOwnership", () => {
  // Non-bundled channel schemas are cloned and recursively walked here, before any validator
  // runs, so this producer is where a deeply nested manifest has to be contained; otherwise
  // config validation dies with a raw RangeError instead of reporting an issue. "feishu" takes
  // only the core-owned normalization; "qqbot" additionally hits the official-channel secret
  // widening, which clones the schema a second time.
  it.each(["feishu", "qqbot"])(
    "surfaces a deeply nested %s schema instead of overflowing the stack",
    (channelId) => {
      let schema: Record<string, unknown> = { type: "object" };
      for (let depth = 0; depth < 3_000; depth++) {
        schema = { type: "object", properties: { nested: schema } };
      }

      const entries = collectChannelSchemaMetadataWithOwnership(
        createChannelSchemaRegistry(channelId, schema),
      );

      expect(entries).toContainEqual(
        expect.objectContaining({ id: channelId, configSchema: schema }),
      );
    },
  );

  it("keeps bundled schema preparation failures on the throwing path", () => {
    let schema: Record<string, unknown> = { type: "object" };
    for (let depth = 0; depth < 3_000; depth++) {
      schema = { type: "object", properties: { nested: schema } };
    }

    expect(() =>
      collectChannelSchemaMetadataWithOwnership(
        createChannelSchemaRegistry("qqbot", schema, "bundled"),
      ),
    ).toThrow();
  });
});
