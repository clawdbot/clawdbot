import { readFileSync } from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { BuzzConfigSchema } from "./config-schema.js";

const pluginManifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  channelConfigs: {
    buzz: { schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"] };
  };
};
const configSchemas = [
  ["runtime", BuzzConfigSchema.schema],
  ["manifest", pluginManifest.channelConfigs.buzz.schema],
] as const;

function parseBuzzConfig(value: unknown) {
  const runtime = BuzzConfigSchema.runtime;
  if (!runtime) {
    throw new Error("expected Buzz runtime config schema");
  }
  return runtime.safeParse(value);
}

function expectRelayUrlValidity(relayUrl: string, valid: boolean) {
  const config = { relayUrl, groupPolicy: "allowlist" };
  const jsonSchemaResult = validateJsonSchemaValue({
    cacheKey: "buzz.config-schema.test",
    schema: BuzzConfigSchema.schema,
    value: config,
  });

  expect(parseBuzzConfig(config).success).toBe(valid);
  expect(jsonSchemaResult.ok).toBe(valid);
}

describe("BuzzConfigSchema", () => {
  it.each(["[bot]", "auto", "", "[{model}]"])(
    "accepts responsePrefix %j in runtime and manifest schemas",
    (responsePrefix) => {
      const config = { groupPolicy: "allowlist", responsePrefix };
      expect(parseBuzzConfig(config).success).toBe(true);
      for (const [name, schema] of configSchemas) {
        expect(
          validateJsonSchemaValue({
            cacheKey: `buzz.config-schema.prefix.${name}`,
            schema,
            value: config,
          }).ok,
        ).toBe(true);
      }
    },
  );

  it.each([
    "ws://localhost:3000",
    "wss://buzz.example.com/relay",
    "Ws://localhost:3000",
    "WSS://buzz.example.com/relay",
  ])("accepts WebSocket relay URL %s", (relayUrl) => {
    expectRelayUrlValidity(relayUrl, true);
  });

  it.each(["http://localhost:3000", "https://buzz.example.com/relay", "ws://", "ws:// bad"])(
    "rejects non-WebSocket relay URL %s",
    (relayUrl) => {
      expectRelayUrlValidity(relayUrl, false);
    },
  );

  it("validates Buzz group keys in runtime and generated schemas", () => {
    for (const [groupId, valid] of [
      ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c", true],
      ["7C4A6D2A-2ED9-4B4E-A5E2-4D705EE9B34C", true],
      ["general", false],
      ["*", false],
      ["buzz:7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c", false],
    ] as const) {
      const config = { groupPolicy: "allowlist", groups: { [groupId]: {} } };
      const jsonSchemaResult = validateJsonSchemaValue({
        cacheKey: `buzz.config-schema.groups.${groupId}`,
        schema: BuzzConfigSchema.schema,
        value: config,
      });

      expect(parseBuzzConfig(config).success).toBe(valid);
      expect(jsonSchemaResult.ok).toBe(valid);
    }
  });

  it("accepts room-scoped sender policy overrides in both config schemas", () => {
    const config = {
      groupPolicy: "open",
      groups: {
        "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      },
    };

    expect(parseBuzzConfig(config).success).toBe(true);
    for (const [name, schema] of configSchemas) {
      expect(
        validateJsonSchemaValue({
          cacheKey: `buzz.config-schema.room-sender-policy.${name}`,
          schema,
          value: config,
        }).ok,
      ).toBe(true);
    }
  });
});
