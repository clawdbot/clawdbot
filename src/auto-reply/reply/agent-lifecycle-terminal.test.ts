// CLI-backend runs persist their assistant turn outside `AgentSession`, so the
// produced transcript id reaches the terminal lifecycle event through run meta
// rather than through the session's `lastAssistantMessageId`. These tests pin
// that hand-off.
import { describe, expect, it } from "vitest";
import { resolveAgentLifecycleTerminalMetadata } from "./agent-lifecycle-terminal.js";

describe("resolveAgentLifecycleTerminalMetadata", () => {
  it("forwards the produced messageId from run meta", () => {
    const metadata = resolveAgentLifecycleTerminalMetadata({
      durationMs: 1234,
      messageId: "msg-abc123",
      stopReason: "completed",
    });

    expect(metadata).toMatchObject({ messageId: "msg-abc123", stopReason: "completed" });
    // Unrelated meta keys stay off the wire.
    expect(metadata).not.toHaveProperty("durationMs");
  });

  it("omits messageId when the run persisted no assistant message", () => {
    const metadata = resolveAgentLifecycleTerminalMetadata({
      durationMs: 1234,
      stopReason: "completed",
    });

    // Absent rather than undefined/empty, so clients cannot dedup on a bogus id.
    expect(metadata).not.toHaveProperty("messageId");
  });

  it("returns nothing for absent or non-object meta", () => {
    expect(resolveAgentLifecycleTerminalMetadata(undefined)).toEqual({});
    expect(resolveAgentLifecycleTerminalMetadata("msg-abc123")).toEqual({});
  });
});
