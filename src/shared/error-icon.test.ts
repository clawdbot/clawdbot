import { describe, expect, it } from "vitest";
import { stripErrorIconPrefix } from "./error-icon.js";

describe("stripErrorIconPrefix", () => {
  it.each([
    ["⚠️ hello", "hello"],
    ["⚠️ ⚠️ hello", "hello"],
    ["⚠️⚠️  hello", "hello"],
    ["⚠️ hello ⚠️ world", "hello ⚠️ world"],
  ])("normalizes leading warning prefixes without touching body icons", (input, expected) => {
    expect(stripErrorIconPrefix(input)).toBe(expected);
  });
});
