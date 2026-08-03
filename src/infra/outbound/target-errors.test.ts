// Covers user-facing target error messages and hint formatting.
import { describe, expect, it } from "vitest";
import {
  ambiguousTargetError,
  isReservedTargetLiteralError,
  missingTargetError,
  reservedTargetLiteralError,
  unknownTargetError,
} from "./target-errors.js";

describe("target error helpers", () => {
  it.each([
    {
      actual: missingTargetError("Slack").message,
      expected: "Delivering to Slack requires target",
    },
    {
      actual: missingTargetError("Slack", "Use channel:C123").message,
      expected: "Delivering to Slack requires target Use channel:C123",
    },
    {
      actual: missingTargetError("Slack", "   ").message,
      expected: "Delivering to Slack requires target",
    },
    {
      actual: ambiguousTargetError("Discord", "general", "   ").message,
      expected: 'Ambiguous target "general" for Discord. Provide a unique name or an explicit id.',
    },
    {
      actual: unknownTargetError("Discord", "general", "   ").message,
      expected: 'Unknown target "general" for Discord.',
    },
    {
      actual: ambiguousTargetError("Discord", "general", "Use channel:123").message,
      expected:
        'Ambiguous target "general" for Discord. Provide a unique name or an explicit id. Hint: Use channel:123',
    },
    {
      actual: unknownTargetError("Discord", "general", "Use channel:123").message,
      expected: 'Unknown target "general" for Discord. Hint: Use channel:123',
    },
    {
      actual: unknownTargetError("Discord", "general").message,
      expected: 'Unknown target "general" for Discord.',
    },
    {
      actual: missingTargetError("Slack", "  Use channel:C123  ").message,
      expected: "Delivering to Slack requires target Use channel:C123",
    },
    {
      actual: unknownTargetError("Discord", "general", "  Use channel:123  ").message,
      expected: 'Unknown target "general" for Discord. Hint: Use channel:123',
    },
  ])("formats target error helper output for %j", ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });

  it("includes the hint in ambiguous target errors", () => {
    expect(ambiguousTargetError("Discord", "general", "Use channel:123").message).toContain(
      "Hint: Use channel:123",
    );
  });

  it("identifies reserved target literal errors", () => {
    expect(isReservedTargetLiteralError(reservedTargetLiteralError("Telegram", "current"))).toBe(
      true,
    );
    expect(isReservedTargetLiteralError(new Error('Unknown target "current" for Telegram.'))).toBe(
      false,
    );
  });
});
