import { TELEGRAM_COMMAND_NAME_PATTERN as sdkTelegramCommandNamePattern } from "openclaw/plugin-sdk/telegram-command-config";
import { describe, expect, it } from "vitest";
import { TELEGRAM_COMMAND_NAME_PATTERN } from "./channel-config-api.js";

describe("telegram channel config api", () => {
  it("keeps the command regex aligned with the public SDK contract", () => {
    expect(TELEGRAM_COMMAND_NAME_PATTERN.toString()).toBe(sdkTelegramCommandNamePattern.toString());
  });
});
