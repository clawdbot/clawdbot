// Verifies every bundled channel schema accepts the documented configWrites policy key.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import {
  asChannelSchema as asSchema,
  channelAccountSchemas as accountSchemas,
  channelSchemaRejectsKey as rejectsKey,
} from "./test-helpers/channel-schema-keys.js";

describe("bundled channel configWrites contract", () => {
  const channels = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => ({
    id: entry.channelId,
    schema: asSchema(entry.schema),
  }));

  it("covers the bundled channels", () => {
    expect(channels.length).toBeGreaterThan(0);
  });

  it.each(channels.map((channel) => [channel.id, channel] as const))(
    "%s accepts channels.<id>.configWrites",
    (_id, channel) => {
      expect(rejectsKey(channel.schema, "configWrites")).toBe(false);
    },
  );

  it.each(channels.map((channel) => [channel.id, channel] as const))(
    "%s accepts channels.<id>.accounts.<account>.configWrites",
    (_id, channel) => {
      expect(
        accountSchemas(channel.schema).some((account) => rejectsKey(account, "configWrites")),
      ).toBe(false);
    },
  );
});
