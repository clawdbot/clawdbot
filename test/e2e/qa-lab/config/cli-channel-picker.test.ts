// CLI channel picker producer tests cover its unique config and redaction assertions.
import { describe, expect, it } from "vitest";
import { cliChannelPickerTestApi } from "./cli-channel-picker.js";

function validPickerConfig() {
  return {
    plugins: { entries: { telegram: { enabled: true } } },
    channels: {
      telegram: {
        enabled: true,
        botToken: cliChannelPickerTestApi.testBotToken,
        groups: { "*": { requireMention: true } },
      },
    },
    wizard: { lastRunCommand: "configure", lastRunMode: "local" },
  };
}

describe("CLI channel picker producer", () => {
  it("accepts only the expected isolated Telegram configuration", () => {
    expect(cliChannelPickerTestApi.assertPickerConfig(validPickerConfig())).toMatchObject({
      channelEnabled: true,
      defaultGroupRequiresMention: true,
      pluginEnabled: true,
      selectedChannel: "telegram",
      wizardCommand: "configure",
      wizardMode: "local",
    });

    expect(() =>
      cliChannelPickerTestApi.assertPickerConfig({
        ...validPickerConfig(),
        channels: { telegram: { enabled: true, botToken: "wrong" } },
      }),
    ).toThrow("entered Telegram bot token");
  });

  it("removes the synthetic token and ANSI control sequences from evidence", () => {
    const sanitized = cliChannelPickerTestApi.sanitizePickerTranscript(
      `\u001b[31m${cliChannelPickerTestApi.testBotToken}\u001b[0m`,
    );

    expect(sanitized).toBe("<test-token>");
    expect(sanitized).not.toContain("123456");
  });
});
