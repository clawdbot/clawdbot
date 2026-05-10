import { describe, expect, it, vi } from "vitest";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

type SessionsYieldDetails = {
  status?: string;
  message?: string;
  error?: string;
};

describe("sessions_yield tool", () => {
  it("returns error when no sessionId is provided", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ onYield });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("No session context");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("invokes onYield callback with default message", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("yielded");
    expect(details.message).toBe("Turn yielded.");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.");
  });

  it("passes the custom message through the yield callback", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", { message: "Waiting for fact-checker" });
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("yielded");
    expect(details.message).toBe("Waiting for fact-checker");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Waiting for fact-checker");
  });

  it("returns error without onYield callback", async () => {
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("Yield not supported in this context");
  });
});
