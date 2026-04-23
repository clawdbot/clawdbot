import { describe, expect, it } from "vitest";
import { splitSdkTools } from "./pi-embedded-runner.js";
import {
  collectRegisteredToolNames,
  toSessionToolAllowlist,
} from "./pi-embedded-runner/tool-name-allowlist.js";
import { createStubTool } from "./test-helpers/pi-tool-stubs.js";

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

  it("keeps OpenClaw-managed custom tools in Pi's session allowlist", () => {
    const { customTools } = splitSdkTools({
      tools: [createStubTool("read"), createStubTool("sessions_spawn")],
      sandboxEnabled: true,
    });
    const allowlist = toSessionToolAllowlist(collectRegisteredToolNames(customTools));

    expect(customTools.map((tool) => tool.name)).toContain("sessions_spawn");
    expect(allowlist).toContain("sessions_spawn");
  });
});
