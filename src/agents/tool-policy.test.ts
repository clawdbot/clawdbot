import { describe, expect, it } from "vitest";
import {
  expandToolGroups,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy.js";

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups([
      "group:runtime",
      "BASH",
      "apply-patch",
      "group:fs",
    ]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("bash")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("group:fs");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:clawdbot", () => {
    const group = TOOL_GROUPS["group:clawdbot"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("session_status");
  });
});
