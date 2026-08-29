import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { validateJsonSchemaValue } from "../schema-validator.js";

// These plugins load attachment bytes; URL-only transports do not gain a size setting.
const CHANNELS = ["clickclack", "mattermost", "qa-channel", "sms", "tlon", "zalouser"];

describe("media loader configuration", () => {
  it.each(CHANNELS)("validates root and named-account caps for %s", (channelId) => {
    const schema = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
      (entry) => entry.channelId === channelId,
    )?.schema;
    if (!schema) {
      throw new Error(`Missing ${channelId} config schema`);
    }
    for (const scoped of [false, true]) {
      for (const cap of [0.5, 20, 0, -1, "20"]) {
        const config = { mediaMaxMb: cap };
        const result = validateJsonSchemaValue({
          schema,
          cacheKey: `media-cap:${channelId}`,
          applyDefaults: true,
          value: scoped ? { accounts: { limited: config } } : config,
        });
        expect(result.ok, `${channelId} ${scoped ? "account" : "root"} cap=${cap}`).toBe(
          typeof cap === "number" && cap > 0,
        );
      }
    }
  });
});
