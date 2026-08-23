import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { describe, expect, it } from "vitest";

describe("normalization-core/agent-id", () => {
  it.each([
    [undefined, "main"],
    ["  OPS  ", "ops"],
    ["Agent not found: xyz", "agent-not-found-xyz"],
    ["../../../etc/passwd", "etc-passwd"],
    ["_".repeat(80), "_".repeat(64)],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeAgentId(input)).toBe(expected);
  });

  it.each([
    ["main", true],
    ["my-research_agent01", true],
    ["", false],
    ["Agent not found: xyz", false],
    ["a".repeat(65), false],
  ])("validates %j", (input, expected) => {
    expect(isValidAgentId(input)).toBe(expected);
  });
});
