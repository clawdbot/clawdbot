import { describe, expect, it } from "vitest";
// Bundled channel config schema tests cover lazy plugin-owned schema resolution.
import { z } from "zod";
import {
  DiscordConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  TelegramConfigSchema,
} from "./bundled-channel-config-schema.js";
import type { OpenClawConfig } from "./config-contracts.js";

describe("bundled channel config schema facade", () => {
  it("resolves bundled schemas from plugin public APIs", () => {
    expect(DiscordConfigSchema.safeParse({ dmPolicy: "pairing" }).success).toBe(true);
    expect(TelegramConfigSchema.safeParse({ dmPolicy: "pairing" }).success).toBe(true);
    expect(IMessageConfigSchema.safeParse({ dmPolicy: "pairing" }).success).toBe(true);
    expect(MSTeamsConfigSchema.safeParse({ dmPolicy: "pairing" }).success).toBe(true);

    const extended = TelegramConfigSchema.safeExtend({ testOnly: z.literal(true) });
    expect(extended.safeParse({ dmPolicy: "pairing", testOnly: true }).success).toBe(true);

    type ChannelConfig = NonNullable<OpenClawConfig["channels"]>;
    const discordConfig: NonNullable<ChannelConfig["discord"]> = DiscordConfigSchema.parse({});
    const telegramConfig: NonNullable<ChannelConfig["telegram"]> = TelegramConfigSchema.parse({});
    const imessageConfig: NonNullable<ChannelConfig["imessage"]> = IMessageConfigSchema.parse({});
    const msteamsConfig: NonNullable<ChannelConfig["msteams"]> = MSTeamsConfigSchema.parse({});
    expect(discordConfig).toBeDefined();
    expect(telegramConfig).toBeDefined();
    expect(imessageConfig).toBeDefined();
    expect(msteamsConfig).toBeDefined();
  });
});
