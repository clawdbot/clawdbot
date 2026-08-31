import {
  isValidAgentId,
  normalizeAgentId,
  normalizeAgentIdStrict,
} from "@openclaw/normalization-core/agent-id";
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

  it.each([
    ["", { ok: false, error: "unrepresentable" }],
    ["   ", { ok: false, error: "unrepresentable" }],
    ["агент✨", { ok: false, error: "unrepresentable" }],
    ["---", { ok: false, error: "unrepresentable" }],
    ["valid-id", { ok: true, value: "valid-id" }],
    ["../../etc/evil", { ok: true, value: "etc-evil" }],
    ["a".repeat(65), { ok: true, value: "a".repeat(64) }],
  ])("strictly normalizes %j", (input, expected) => {
    expect(normalizeAgentIdStrict(input)).toEqual(expected);
  });
});
