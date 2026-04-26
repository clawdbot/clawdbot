import { describe, expect, it } from "vitest";
import { isToolResultMessage, normalizeRoleForGrouping } from "./role-normalizer.ts";

describe("normalizeRoleForGrouping", () => {
  it("returns tool for tool result role variants", () => {
    expect(normalizeRoleForGrouping("toolresult")).toBe("tool");
    expect(normalizeRoleForGrouping("toolResult")).toBe("tool");
    expect(normalizeRoleForGrouping("TOOLRESULT")).toBe("tool");
    expect(normalizeRoleForGrouping("tool_result")).toBe("tool");
    expect(normalizeRoleForGrouping("TOOL_RESULT")).toBe("tool");
  });

  it("returns tool for tool and function roles", () => {
    expect(normalizeRoleForGrouping("tool")).toBe("tool");
    expect(normalizeRoleForGrouping("Tool")).toBe("tool");
    expect(normalizeRoleForGrouping("function")).toBe("tool");
    expect(normalizeRoleForGrouping("Function")).toBe("tool");
  });

  it("preserves core roles", () => {
    expect(normalizeRoleForGrouping("user")).toBe("user");
    expect(normalizeRoleForGrouping("User")).toBe("User");
    expect(normalizeRoleForGrouping("assistant")).toBe("assistant");
    expect(normalizeRoleForGrouping("system")).toBe("system");
  });

  it("detects only tool result role variants", () => {
    expect(isToolResultMessage({ role: "toolresult" })).toBe(true);
    expect(isToolResultMessage({ role: "toolResult" })).toBe(true);
    expect(isToolResultMessage({ role: "TOOLRESULT" })).toBe(true);
    expect(isToolResultMessage({ role: "tool_result" })).toBe(true);
    expect(isToolResultMessage({ role: "TOOL_RESULT" })).toBe(true);
    expect(isToolResultMessage({ role: "user" })).toBe(false);
    expect(isToolResultMessage({ role: "assistant" })).toBe(false);
    expect(isToolResultMessage({ role: "tool" })).toBe(false);
    expect(isToolResultMessage({})).toBe(false);
    expect(isToolResultMessage({ content: "test" })).toBe(false);
    expect(isToolResultMessage({ role: 123 })).toBe(false);
    expect(isToolResultMessage({ role: null })).toBe(false);
  });
});
