import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

describe("channel reply-to-mode configuration", () => {
  it.each(["feishu", "irc", "nextcloud-talk"])(
    "%s exposes the policy consumed by its reply transport",
    (channelId) => {
      const schema = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (entry) => entry.channelId === channelId,
      )?.schema;

      expect(schema?.properties).toHaveProperty("replyToMode");
    },
  );
});
