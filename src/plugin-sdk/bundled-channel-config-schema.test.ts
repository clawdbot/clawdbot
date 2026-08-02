import { describe, expect, it } from "vitest";
// Keep the facade cold here; plugin suites own schema behavior and loader fixtures own resolution.
import type { z } from "zod";
import { IMessageConfigSchema, TelegramConfigSchema } from "./bundled-channel-config-schema.js";
import type { OpenClawConfig } from "./config-contracts.js";

describe("bundled channel config schema facade", () => {
  it("exposes lazy Telegram and iMessage schemas with config-compatible output types", () => {
    type ChannelConfig = NonNullable<OpenClawConfig["channels"]>;
    const telegramConfig: NonNullable<ChannelConfig["telegram"]> = {} as z.output<
      typeof TelegramConfigSchema
    >;
    const imessageConfig: NonNullable<ChannelConfig["imessage"]> = {} as z.output<
      typeof IMessageConfigSchema
    >;

    expect([TelegramConfigSchema, IMessageConfigSchema]).toHaveLength(2);
    expect([telegramConfig, imessageConfig]).toEqual([{}, {}]);
  });
});
