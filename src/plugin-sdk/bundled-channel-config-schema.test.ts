import { describe, expect, it } from "vitest";
// Bundled channel config schema tests cover lazy plugin-owned schema resolution.
import { z } from "zod";
import { IMessageConfigSchema, TelegramConfigSchema } from "./bundled-channel-config-schema.js";
import type { OpenClawConfig } from "./config-contracts.js";

describe("bundled channel config schema facade", () => {
  it("resolves Telegram and iMessage schemas from bundled plugin public APIs", () => {
    expect(TelegramConfigSchema.safeParse({ dmPolicy: "pairing" }).success).toBe(true);
    expect(IMessageConfigSchema.safeParse({ dmPolicy: "pairing" }).success).toBe(true);

    const extended = TelegramConfigSchema.safeExtend({ testOnly: z.literal(true) });
    expect(extended.safeParse({ dmPolicy: "pairing", testOnly: true }).success).toBe(true);

    type ChannelConfig = NonNullable<OpenClawConfig["channels"]>;
    const telegramConfig: NonNullable<ChannelConfig["telegram"]> = TelegramConfigSchema.parse({});
    const imessageConfig: NonNullable<ChannelConfig["imessage"]> = IMessageConfigSchema.parse({});
    expect(telegramConfig).toBeDefined();
    expect(imessageConfig).toBeDefined();
  });
});
