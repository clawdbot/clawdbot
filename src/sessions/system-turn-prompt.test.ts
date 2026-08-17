import { describe, expect, it } from "vitest";
import { formatSystemTurnPrompt } from "./system-turn-prompt.js";

describe("formatSystemTurnPrompt", () => {
  it.each([
    ["resume the turn", "[System] resume the turn"],
    ["  resume the turn  ", "[System] resume the turn"],
    ["  [System] resume the turn  ", "[System] resume the turn"],
  ])("formats %j without duplicating the system prefix", (body, expected) => {
    expect(formatSystemTurnPrompt(body)).toBe(expected);
  });
});
