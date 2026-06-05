// Coverage for classifying SDK tools into the embedded runner runtime surface.
import { describe, expect, it } from "vitest";
import { splitSdkTools } from "./embedded-agent-runner.js";
import {
  collectRegisteredToolNames,
  toSessionToolAllowlist,
} from "./embedded-agent-runner/tool-name-allowlist.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

describe("splitSdkTools", () => {
  const tools = [
    createStubTool("read"),
    createStubTool("exec"),
    createStubTool("edit"),
    createStubTool("write"),
    createStubTool("browser"),
  ];

  it("routes all tools to customTools when sandboxed", () => {
    const { customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
    });
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("routes all tools to customTools even when not sandboxed", () => {
    const { customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("keeps OpenClaw-managed custom tools in OpenClaw runtime's session allowlist", () => {
    // Session tools are OpenClaw-managed custom tools; dropping them from the
    // allowlist would break inter-agent routing even when sandboxing is enabled.
    const { customTools } = splitSdkTools({
      tools: [createStubTool("read"), createStubTool("sessions_spawn")],
      sandboxEnabled: true,
    });
    const allowlist = toSessionToolAllowlist(collectRegisteredToolNames(customTools));

    expect(customTools.map((tool) => tool.name)).toContain("sessions_spawn");
    expect(allowlist).toContain("sessions_spawn");
  });
});
