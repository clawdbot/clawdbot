import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { BuzzConfigSchema } from "./config-schema.js";

// Cold (discovery-time) validation uses the zod-derived generated bundled
// channel metadata, which the generator builds from this same config-schema
// module — the manifest and official catalog carry no schema copies to drift
// (see #131292). The JSON projection below is exactly what they publish.

function parseBuzzConfig(value: unknown) {
  const runtime = BuzzConfigSchema.runtime;
  if (!runtime) {
    throw new Error("expected Buzz runtime config schema");
  }
  return runtime.safeParse(value);
}

function expectJsonSchemaValidity(cacheKey: string, value: unknown, valid: boolean) {
  expect(validateJsonSchemaValue({ cacheKey, schema: BuzzConfigSchema.schema, value }).ok).toBe(
    valid,
  );
}

function expectRelayUrlValidity(relayUrl: string, valid: boolean) {
  const config = { relayUrl, groupPolicy: "allowlist" };
  expect(parseBuzzConfig(config).success).toBe(valid);
  expectJsonSchemaValidity("buzz.config-schema.test", config, valid);
}

describe("BuzzConfigSchema", () => {
  it.each([
    ["ada", true],
    ["default", true],
    ["bot-2", true],
    ["Ada", false],
    ["", false],
    ["constructor", false],
    ["prototype", false],
  ])("validates account key %j in runtime and generated schemas", (accountId, valid) => {
    const config = {
      groupPolicy: "allowlist",
      accounts: { [accountId]: { relayUrl: "wss://buzz.example.com" } },
    };
    expect(parseBuzzConfig(config).success).toBe(valid);
    expectJsonSchemaValidity(`buzz.account.${accountId}`, config, valid);
    expect(parseBuzzConfig({ defaultAccount: accountId }).success).toBe(valid);
    expectJsonSchemaValidity(
      `buzz.default-account.${accountId}`,
      { groupPolicy: "allowlist", defaultAccount: accountId },
      valid,
    );
  });

  it("keeps nested policy optional and validates nested channel fields", () => {
    const parsed = parseBuzzConfig({ accounts: { ada: { replyToMode: "off", historyLimit: 2 } } });
    expect(parsed).toMatchObject({
      success: true,
      data: { accounts: { ada: { replyToMode: "off", historyLimit: 2 } } },
    });
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("accounts.ada.groupPolicy");
    }
    const invalid = {
      accounts: { ada: { relayUrl: "https://invalid.example.com", historyLimit: 21 } },
    };
    expect(parseBuzzConfig(invalid).success).toBe(false);
    expectJsonSchemaValidity("buzz.invalid-nested-account", invalid, false);
  });
  it.each(["[bot]", "auto", "", "[{model}]"])(
    "accepts responsePrefix %j in runtime and JSON schemas",
    (responsePrefix) => {
      const config = { groupPolicy: "allowlist", responsePrefix };
      expect(parseBuzzConfig(config).success).toBe(true);
      expectJsonSchemaValidity("buzz.config-schema.prefix", config, true);
    },
  );

  it.each([
    [0, true],
    [20, true],
    [-1, false],
    [21, false],
    [1.5, false],
  ])("bounds passive historyLimit %s in runtime and JSON schemas", (historyLimit, valid) => {
    const config = { historyLimit, groupPolicy: "allowlist" };
    expect(parseBuzzConfig(config).success).toBe(valid);
    expectJsonSchemaValidity(`buzz.history.${historyLimit}`, config, valid);
  });
  it.each([
    ["off", true],
    ["all", true],
    ["first", false],
    ["batched", false],
    [false, false],
  ])("validates replyToMode %s in runtime and JSON schemas", (replyToMode, valid) => {
    const config = { replyToMode, groupPolicy: "allowlist" };
    expect(parseBuzzConfig(config).success).toBe(valid);
    expectJsonSchemaValidity(`buzz.reply-mode.${replyToMode}`, config, valid);
  });

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
      expect(parseBuzzConfig(config).success).toBe(valid);
      expectJsonSchemaValidity(`buzz.config-schema.groups.${groupId}`, config, valid);
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
    expectJsonSchemaValidity("buzz.config-schema.room-sender-policy", config, true);
  });
});
