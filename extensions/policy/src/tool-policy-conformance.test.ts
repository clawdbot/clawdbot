import { describe, expect, it } from "vitest";
import { expandPolicyToolRequirement, toolListCoversTool } from "./tool-policy-conformance.js";

describe("policy tool group conformance", () => {
  it("keeps computer control in both node and OpenClaw policy groups", () => {
    expect(expandPolicyToolRequirement("group:nodes")).toEqual(
      expect.arrayContaining(["computer", "mobile_ui"]),
    );
    expect(expandPolicyToolRequirement("group:openclaw")).toEqual(
      expect.arrayContaining(["computer", "mobile_ui"]),
    );
  });

  it("normalizes aliases and expands groups", () => {
    expect(toolListCoversTool(["bash"], "exec")).toBe(true);
    expect(toolListCoversTool(["apply-patch"], "apply_patch")).toBe(true);
    expect(expandPolicyToolRequirement("group:web")).toEqual([
      "web_search",
      "web_fetch",
      "x_search",
    ]);
  });

  it("keeps filesystem discovery tools in the filesystem policy group", () => {
    const filesystemTools = ["read", "grep", "find", "ls", "write", "edit", "apply_patch"];

    expect(expandPolicyToolRequirement("group:fs")).toEqual(filesystemTools);
    for (const tool of filesystemTools) {
      expect(toolListCoversTool(["group:fs"], tool)).toBe(true);
    }
  });

  it("matches wildcard tool requirements", () => {
    expect(toolListCoversTool(["web_*"], "web_search")).toBe(true);
    expect(toolListCoversTool(["web_*"], "memory_search")).toBe(false);
  });
});
