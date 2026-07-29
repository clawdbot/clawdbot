// Tool summary metadata tests cover canvas actions and shouldEmitToolResult
// overrides in subscribed embedded sessions.
import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

describe("subscribeEmbeddedAgentSession", () => {
  it("includes canvas action metadata in tool summaries", async () => {
    // Canvas actions need their JSONL path in summaries so users can inspect the
    // generated artifact without verbose tool output.
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-canvas-tool",
      verboseLevel: "on",
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "canvas",
      toolCallId: "tool-canvas-1",
      args: { action: "a2ui_push", jsonlPath: "/tmp/a2ui.jsonl" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = onToolResult.mock.calls.at(0)?.[0];
    expect(payload.text).toContain("🖼️");
    expect(payload.text).toContain("Canvas");
    expect(payload.text).toContain("/tmp/a2ui.jsonl");
  });
  it("skips tool summaries when shouldEmitToolResult is false", () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-tool-off",
      shouldEmitToolResult: () => false,
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: { path: "/tmp/b.txt" },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });
  it("emits tool summaries when shouldEmitToolResult overrides verbose", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-tool-override",
      verboseLevel: "off",
      shouldEmitToolResult: () => true,
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-3",
      args: { path: "/tmp/c.txt" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
});
