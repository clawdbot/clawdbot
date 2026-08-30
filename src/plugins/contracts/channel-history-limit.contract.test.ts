import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

describe("supported channel history limits", () => {
  it.each(["clickclack", "line", "mattermost", "qa-channel", "tlon", "twitch", "zalo"])(
    "%s exposes historyLimit in every supported config branch",
    (channelId) => {
      const schema = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (entry) => entry.channelId === channelId,
      )?.schema;

      expect(schema).toBeDefined();
      const roots = Array.isArray(schema?.anyOf) ? schema.anyOf : [schema];
      expect(roots).not.toHaveLength(0);
      for (const root of roots) {
        expect(root?.properties).toHaveProperty("historyLimit");
        const accountProperties = root?.properties?.accounts?.additionalProperties?.properties;
        if (accountProperties) {
          expect(Object.hasOwn(accountProperties, "historyLimit")).toBe(
            channelId === "line" || channelId === "mattermost",
          );
        }
      }
    },
  );
});
