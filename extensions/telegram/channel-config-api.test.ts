import { describe, expect, it } from "vitest";
import { TELEGRAM_COMMAND_NAME_PATTERN } from "./channel-config-api.js";

describe("telegram channel config api", () => {
  it("exports the Telegram command regex", () => {
    expect(TELEGRAM_COMMAND_NAME_PATTERN.toString()).toBe("/^[a-z0-9_]{1,32}$/");
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("hello_world")).toBe(true);
    expect(TELEGRAM_COMMAND_NAME_PATTERN.test("Hello")).toBe(false);
  });
});
