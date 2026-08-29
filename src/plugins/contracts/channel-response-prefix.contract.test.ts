import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { validateJsonSchemaValue } from "../schema-validator.js";

// Exercise config admission, including Twitch's single/multi-account union.
const account = { username: "testbot", accessToken: "test-token", channel: "testroom" };
const configs = [
  { channelId: "buzz", config: { groupPolicy: "allowlist" }, accounts: false },
  { channelId: "clickclack", config: {}, accounts: true },
  { channelId: "feishu", config: {}, accounts: true },
  { channelId: "qa-channel", config: {}, accounts: true },
  { channelId: "twitch", config: account, accounts: true },
];

describe("channel responsePrefix config admission", () => {
  it.each(configs)(
    "validates root and supported account prefixes for $channelId",
    ({ channelId, config, accounts }) => {
      const schema = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (entry) => entry.channelId === channelId,
      )?.schema;
      expect(schema).toBeDefined();
      if (!schema) {
        throw new Error(`missing ${channelId} config schema`);
      }
      for (const responsePrefix of ["[bot]", "auto", "", "[{model}]", 42]) {
        const values: Record<string, unknown>[] = [{ ...config, responsePrefix }];
        if (accounts) {
          values.push({ responsePrefix, accounts: { default: { ...config, responsePrefix } } });
        }
        for (const value of values) {
          expect(
            validateJsonSchemaValue({ cacheKey: `response-prefix.${channelId}`, schema, value }).ok,
          ).toBe(typeof responsePrefix === "string");
        }
      }
    },
  );
});
