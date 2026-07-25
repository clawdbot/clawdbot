import { describe, expect, it } from "vitest";
import {
  DiscordConfigSchema,
  MSTeamsConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
} from "./bundled-channel-config-schema.js";
import {
  createLegacyCompatChannelDmPolicy,
  promptLegacyChannelAllowFromForAccount,
} from "./setup-runtime.js";

describe("shipped external channel compatibility", () => {
  it("retains named config schema exports used by published channel packages", () => {
    for (const schema of [
      SlackConfigSchema,
      DiscordConfigSchema,
      SignalConfigSchema,
      MSTeamsConfigSchema,
    ]) {
      expect(schema.safeParse({ legacySetting: true })).toMatchObject({ success: true });
      expect(schema.toJSONSchema({ target: "draft-07" })).toMatchObject({ type: "object" });
    }
  });

  it("retains setup helpers used by published Slack and Discord packages", () => {
    expect(createLegacyCompatChannelDmPolicy).toBeTypeOf("function");
    expect(promptLegacyChannelAllowFromForAccount).toBeTypeOf("function");
  });
});
