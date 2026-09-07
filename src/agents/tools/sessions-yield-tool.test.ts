// sessions_yield tool tests cover cooperative turn yielding and unsupported
// context errors.
import { describe, expect, it, vi } from "vitest";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

type SessionsYieldDetails = {
  status?: string;
  acknowledgment?: string;
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
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => true,
      onYield,
    });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("yielded");
    expect(details).not.toHaveProperty("message");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.", undefined);
  });

  it.each([undefined, "Research started; results will follow."])(
    "keeps continuation context private with acknowledgment %s",
    async (acknowledgment) => {
      const message = "SYNTHETIC_PRIVATE_CONTINUATION_MARKER";
      const onYield = vi.fn();
      const tool = createSessionsYieldTool({
        sessionId: "test-session",
        claimYield: () => true,
        onYield,
      });
      const result = await tool.execute("call-1", { message, acknowledgment });

      expect(result.details).toEqual({
        status: "yielded",
        ...(acknowledgment ? { acknowledgment } : {}),
      });
      expect(JSON.stringify(result)).not.toContain(message);
      expect(onYield).toHaveBeenCalledOnce();
      expect(onYield).toHaveBeenCalledWith(message, acknowledgment);
    },
  );

  it("claims completion ownership before aborting the requester run", async () => {
    const order: string[] = [];
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => {
        order.push("claim");
        return true;
      },
      onYield: () => {
        order.push("abort");
      },
    });

    await tool.execute("call-1", {});

    expect(order).toEqual(["claim", "abort"]);
  });

  it("does not abort the requester when yield intent cannot persist", async () => {
    const failure = new Error("sqlite unavailable");
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => {
        throw failure;
      },
      onYield,
    });

    await expect(tool.execute("call-1", {})).rejects.toThrow(failure);
    expect(onYield).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the claim callback is unavailable" },
    { name: "the turn owns no pending child completion", claimYield: () => false },
  ])("keeps the turn active when $name", async ({ claimYield }) => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      ...(claimYield ? { claimYield } : {}),
      onYield,
    });

    const result = await tool.execute("call-1", {});

    expect(result.details).toMatchObject({
      status: "error",
      error:
        "No pending child completion is owned by this turn. Continue working because independent background operations complete separately.",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("returns error without onYield callback", async () => {
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("Yield not supported in this context");
  });
});
