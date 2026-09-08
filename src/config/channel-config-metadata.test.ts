import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
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
  it.each(
    ["core", "plus", undefined].flatMap((selected) =>
      [false, true].map((reverse) => ({ selected, reverse })),
    ),
  )(
    "preserves every owner's sensitivity with $selected selected and reverse=$reverse",
    ({ selected, reverse }) => {
      const schema = {
        type: "object",
        properties: { core: { type: "string" }, plus: { type: "string" } },
      };
      const registry = {
        diagnostics: [],
        plugins: ["core", "plus"].map((id) =>
          createPluginManifestRecordFixture({
            id,
            origin: "global",
            channels: ["proofchat"],
            channelConfigs: {
              proofchat: {
                schema,
                label: id,
                uiHints: {
                  [id]: { sensitive: true, label: id },
                  [id === "core" ? "plus" : "core"]: {
                    sensitive: false,
                    label: "selected presentation",
                  },
                  [id === "core" ? " .endpoint " : "endpoint"]: {
                    sensitive: false,
                    tags: id === "core" ? ["url-secret", "inactive-tag"] : ["selected-tag"],
                    label: id,
                  },
                  [`accounts.*.${id}`]: { sensitive: true },
                  [`entries[].${id}`]: { sensitive: true },
                  [id === "core" ? " .shared " : "shared"]: { sensitive: id === "core", label: id },
                },
              },
            },
          }),
        ),
      };
      if (reverse) {
        registry.plugins.reverse();
      }
      const before = structuredClone(registry);
      const owner = selected ?? registry.plugins.at(-1)?.id;
      const channels = collectChannelSchemaMetadataWithOwnership(
        registry,
        selected ? new Set([selected]) : undefined,
      );
      expect(channels[0]).toMatchObject({ label: owner, schemaPluginId: owner });
      expect(channels[0]?.configSchema?.properties).toMatchObject(schema.properties);
      const hints = channels[0]?.configUiHints;
      for (const path of [
        "core",
        "plus",
        "shared",
        "accounts.*.core",
        "accounts.*.plus",
        "entries[].core",
        "entries[].plus",
      ]) {
        expect(hints?.[path]?.sensitive, path).toBe(true);
      }
      expect(hints?.endpoint).toMatchObject({ sensitive: false, label: owner });
      expect(hints?.endpoint?.tags).toEqual(
        owner === "core" ? ["url-secret", "inactive-tag"] : ["selected-tag", "url-secret"],
      );
      expect(registry).toEqual(before);
    },
  );

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
