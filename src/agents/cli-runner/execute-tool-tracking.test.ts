import { describe, expect, it } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";

function createTracking() {
  return createCliToolTracking(buildPreparedCliRunContext({ provider: "codex-cli" }));
}

describe("createCliToolTracking tool summaries", () => {
  it("attaches an explicit typed empty summary", () => {
    const tracking = createTracking();

    expect(tracking.withExecutionEvidence({ text: "done" }).toolSummary).toEqual({
      calls: 0,
      tools: [],
      failures: 0,
    });
  });

  it("correlates ids, preserves repeated-name calls, and counts terminal failures once", () => {
    const tracking = createTracking();
    tracking.handleCliToolUseStart({
      toolCallId: "call-1",
      name: "finance-data.lookup",
      kind: "mcp_tool_use",
      args: {},
    });
    tracking.handleCliToolUseStart({
      toolCallId: "call-1",
      name: "finance-data.lookup",
      kind: "mcp_tool_use",
      args: {},
    });
    tracking.handleCliToolUseStart({
      toolCallId: "call-2",
      name: "finance-data.lookup",
      kind: "mcp_tool_use",
      args: {},
    });
    tracking.handleCliToolResult({
      toolCallId: "call-1",
      name: "finance-data.lookup",
      isError: false,
    });
    tracking.handleCliToolResult({
      toolCallId: "call-2",
      name: "finance-data.lookup",
      isError: true,
    });
    tracking.handleCliToolResult({
      toolCallId: "call-2",
      name: "finance-data.lookup",
      isError: true,
    });
    tracking.handleCliToolResult({
      toolCallId: "terminal-only",
      name: "bash",
      isError: true,
    });

    expect(tracking.withExecutionEvidence({ text: "done" }).toolSummary).toEqual({
      calls: 3,
      tools: ["finance-data.lookup", "bash"],
      failures: 2,
    });
  });
});
