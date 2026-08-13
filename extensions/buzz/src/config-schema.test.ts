import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { BuzzConfigSchema } from "./config-schema.js";

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

  it("accepts named accounts in runtime and generated schemas", () => {
    const config = {
      groupPolicy: "allowlist",
      defaultAccount: "ada",
      accounts: {
        default: {
          relayUrl: "wss://default.example.com",
          privateKey: "11".repeat(32),
        },
        ada: {
          name: "Ada",
          relayUrl: "wss://ada.example.com",
          privateKey: "22".repeat(32),
        },
      },
    };

    expect(parseBuzzConfig(config).success).toBe(true);
    expect(
      validateJsonSchemaValue({
        cacheKey: "buzz.config-schema.accounts",
        schema: BuzzConfigSchema.schema,
        value: config,
      }).ok,
    ).toBe(true);
  });

  it("does not inject the root group policy default into account overrides", () => {
    const result = parseBuzzConfig({
      groupPolicy: "open",
      accounts: {
        ada: {
          relayUrl: "wss://ada.example.com",
          privateKey: "22".repeat(32),
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as {
        groupPolicy?: string;
        accounts?: Record<string, { groupPolicy?: string }>;
      };
      expect(parsed.groupPolicy).toBe("open");
      expect(parsed.accounts?.ada?.groupPolicy).toBeUndefined();
    }
  });

  it("validates scoped SecretRefs in the plugin manifest schema", () => {
    const schema = manifest.channelConfigs.buzz.schema;
    const validate = (privateKey: unknown) =>
      validateJsonSchemaValue({
        cacheKey: `buzz.manifest-schema.secret-ref.${JSON.stringify(privateKey)}`,
        schema,
        value: {
          groupPolicy: "allowlist",
          accounts: {
            ada: {
              relayUrl: "wss://ada.example.com",
              privateKey,
            },
          },
        },
      }).ok;

    expect(validate({})).toBe(false);
    expect(validate({ source: "env", provider: "default", id: "BUZZ_ADA_PRIVATE_KEY" })).toBe(true);
  });
});
