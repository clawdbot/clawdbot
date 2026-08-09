import { describe, expect, it } from "vitest";
import { expandPolicyToolRequirement, toolListCoversTool } from "./tool-policy-conformance.js";

describe("policy tool group conformance", () => {
  it("keeps computer control in both node and OpenClaw policy groups", () => {
    expect(expandPolicyToolRequirement("group:nodes")).toEqual(["nodes", "computer", "mobile_ui"]);
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
    expect(toolListCoversTool(["cron"], "automations")).toBe(true);
    expect(expandPolicyToolRequirement("group:sessions")).toEqual([
      "sessions",
      "sessions_list",
      "sessions_history",
      "sessions_search",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "sessions_send",
      "sessions_spawn",
      "agents_wait",
      "sessions_yield",
      "subagents",
      "session_status",
      "spawn_task",
      "dismiss_task",
    ]);
    expect(expandPolicyToolRequirement("group:ui")).toEqual([
      "browser",
      "screen",
      "dashboard",
      "terminal",
      "canvas",
      "show_widget",
    ]);
  });

  it("matches wildcard tool requirements", () => {
    expect(toolListCoversTool(["web_*"], "web_search")).toBe(true);
    expect(toolListCoversTool(["web_*"], "memory_search")).toBe(false);
  });
});
