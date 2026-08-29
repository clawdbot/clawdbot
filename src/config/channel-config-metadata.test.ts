// Verifies channel config metadata collection stays total on untrusted manifest schemas.

import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
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

function makePreferOverRecord(params: {
  id: string;
  tokenField: string;
  preferOver?: readonly string[];
}) {
  return {
    id: params.id,
    name: params.id,
    origin: "workspace" as const,
    channels: ["zzproofchat", "qqbot"] as const,
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir: `/tmp/${params.id}`,
    source: `/tmp/${params.id}/index.js`,
    manifestPath: `/tmp/${params.id}/openclaw.plugin.json`,
    channelConfigs: {
      zzproofchat: {
        id: "zzproofchat",
        label: "ZZProof Chat",
        ...(params.preferOver ? { preferOver: params.preferOver } : {}),
        schema: {
          type: "object",
          properties: { [params.tokenField]: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
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

  it("gives the channel schema to the plugin declared as the preferOver replacement", () => {
    const registry = {
      plugins: [
        makePreferOverRecord({
          id: "zzproof-plus",
          tokenField: "plusToken",
          preferOver: ["zzproof-core"],
        }),
        makePreferOverRecord({ id: "zzproof-core", tokenField: "coreToken" }),
      ],
      diagnostics: [],
    } as unknown as PluginManifestRegistry;

    const entry = collectChannelSchemaMetadataWithOwnership(registry).find(
      (candidate) => candidate.id === "zzproofchat",
    );

    // The Gateway activates zzproof-plus over zzproof-core because plus declares
    // preferOver, so the schema it publishes must match that serving plugin. The
    // pre-fix code ordered same-origin claimants by iteration order and let
    // zzproof-core win the channel, which then validated the running plus plugin
    // against the displaced core schema.
    expect(entry?.schemaPluginId).toBe("zzproof-plus");
    const schemaKeys = Object.keys(entry?.configSchema?.properties ?? {});
    expect(schemaKeys).toContain("plusToken");
    expect(schemaKeys).not.toContain("coreToken");
  });

  it("is deterministic across registry iteration order", () => {
    const makeRegistry = (first: "zzproof-plus" | "zzproof-core") =>
      ({
        plugins:
          first === "zzproof-plus"
            ? [
                makePreferOverRecord({
                  id: "zzproof-plus",
                  tokenField: "plusToken",
                  preferOver: ["zzproof-core"],
                }),
                makePreferOverRecord({ id: "zzproof-core", tokenField: "coreToken" }),
              ]
            : [
                makePreferOverRecord({ id: "zzproof-core", tokenField: "coreToken" }),
                makePreferOverRecord({
                  id: "zzproof-plus",
                  tokenField: "plusToken",
                  preferOver: ["zzproof-core"],
                }),
              ],
        diagnostics: [],
      }) as unknown as PluginManifestRegistry;

    for (const order of ["zzproof-plus", "zzproof-core"] as const) {
      const entry = collectChannelSchemaMetadataWithOwnership(makeRegistry(order)).find(
        (candidate) => candidate.id === "zzproofchat",
      );
      expect(entry?.schemaPluginId).toBe("zzproof-plus");
    }
  });
});
