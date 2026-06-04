/**
 * Tests Telegram command config helpers and command UI behavior.
 */
import { describe, expect, it } from "vitest";
import * as telegramCommandConfig from "./telegram-command-config.js";

describe("telegram command config", () => {
  it("exposes the same regex via the helper", () => {
    expect(telegramCommandConfig.getTelegramCommandNamePattern()).toBe(
      telegramCommandConfig.TELEGRAM_COMMAND_NAME_PATTERN,
    );
    expect(telegramCommandConfig.TELEGRAM_COMMAND_NAME_PATTERN.test("hello_world")).toBe(true);
  });

  it("validates and normalizes commands", () => {
    expect(telegramCommandConfig.TELEGRAM_COMMAND_NAME_PATTERN.test("hello_world")).toBe(true);
    expect(telegramCommandConfig.normalizeTelegramCommandName("/Hello-World")).toBe("hello_world");
    expect(telegramCommandConfig.normalizeTelegramCommandDescription("  hi  ")).toBe("hi");

    expect(
      telegramCommandConfig.resolveTelegramCustomCommands({
        commands: [
          { command: "/Hello-World", description: "  Says hi  " },
          { command: "/Hello-World", description: "duplicate" },
          { command: "", description: "missing command" },
          { command: "/ok", description: "" },
        ],
      }),
    ).toEqual({
      commands: [{ command: "hello_world", description: "Says hi" }],
      issues: [
        {
          index: 1,
          field: "command",
          message: 'Telegram custom command "/hello_world" is duplicated.',
        },
        {
          index: 2,
          field: "command",
          message: "Telegram custom command is missing a command name.",
        },
        {
          index: 3,
          field: "description",
          message: 'Telegram custom command "/ok" is missing a description.',
        },
      ],
    });
  });
});
