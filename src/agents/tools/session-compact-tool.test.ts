// session_compact tool tests cover request scheduling and unsupported context errors.
import { describe, expect, it, vi } from "vitest";
import { createSessionCompactTool } from "./session-compact-tool.js";

type SessionCompactDetails = {
  status?: string;
  focus?: string;
  error?: string;
};

describe("session_compact tool", () => {
  it("returns error when no sessionId is provided", async () => {
    const onRequestCompaction = vi.fn();
    const tool = createSessionCompactTool({ onRequestCompaction });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionCompactDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("No session context");
    expect(onRequestCompaction).not.toHaveBeenCalled();
  });

  it("returns error when the runtime cannot service compaction requests", async () => {
    const tool = createSessionCompactTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionCompactDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("Compaction cannot be requested in this context");
  });

  it("schedules compaction without focus", async () => {
    const onRequestCompaction = vi.fn();
    const tool = createSessionCompactTool({ sessionId: "test-session", onRequestCompaction });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionCompactDetails;
    expect(details.status).toBe("scheduled");
    expect(details.focus).toBeUndefined();
    expect(onRequestCompaction).toHaveBeenCalledOnce();
    expect(onRequestCompaction).toHaveBeenCalledWith({});
  });

  it("passes focus guidance through the compaction request", async () => {
    const onRequestCompaction = vi.fn();
    const tool = createSessionCompactTool({ sessionId: "test-session", onRequestCompaction });
    const result = await tool.execute("call-1", {
      focus: "The database migration discussion is complete; keep the schema decisions",
    });
    const details = result.details as SessionCompactDetails;
    expect(details.status).toBe("scheduled");
    expect(details.focus).toBe(
      "The database migration discussion is complete; keep the schema decisions",
    );
    expect(onRequestCompaction).toHaveBeenCalledOnce();
    expect(onRequestCompaction).toHaveBeenCalledWith({
      focus: "The database migration discussion is complete; keep the schema decisions",
    });
  });
});
