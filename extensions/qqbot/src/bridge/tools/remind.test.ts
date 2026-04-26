import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: callGatewayToolMock,
}));

import { createRemindTool } from "./remind.js";

describe("bridge/tools/remind", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  it("marks qqbot_remind as owner-only", () => {
    const tool = createRemindTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("schedules reminders directly through Gateway cron with ambient QQ delivery context", async () => {
    callGatewayToolMock.mockResolvedValue({ id: "job-1" });
    const tool = createRemindTool({
      senderIsOwner: true,
      deliveryContext: { to: "qqbot:c2c:user-openid", accountId: "bot2" },
    });

    const result = await tool.execute("tool-call-1", {
      action: "add",
      content: "drink water",
      time: "5m",
    });

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "cron.add",
      { timeoutMs: 60_000 },
      {
        job: expect.objectContaining({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: expect.stringContaining("drink water") },
          delivery: {
            mode: "announce",
            channel: "qqbot",
            to: "qqbot:c2c:user-openid",
            accountId: "bot2",
          },
        }),
      },
    );
    expect(result.details).toEqual({
      ok: true,
      action: "add",
      summary: '⏰ Reminder in 5m: "drink water"',
      cronResult: { id: "job-1" },
    });
  });

  it("routes list and remove through Gateway cron without exposing generic cron to the model", async () => {
    const tool = createRemindTool({ senderIsOwner: true });

    await tool.execute("tool-call-1", { action: "list" });
    await tool.execute("tool-call-2", { action: "remove", jobId: "job-1" });

    expect(callGatewayToolMock).toHaveBeenNthCalledWith(1, "cron.list", { timeoutMs: 60_000 }, {});
    expect(callGatewayToolMock).toHaveBeenNthCalledWith(
      2,
      "cron.remove",
      { timeoutMs: 60_000 },
      { jobId: "job-1" },
    );
  });

  it("supports injected cron scheduler dependencies for engine-level tests", async () => {
    const callCron = vi.fn(async () => ({ id: "job-1" }));
    const tool = createRemindTool(
      {
        senderIsOwner: true,
        deliveryContext: { to: "qqbot:c2c:user-openid", accountId: "bot2" },
      },
      { callCron },
    );

    await tool.execute("tool-call-1", {
      action: "add",
      content: "drink water",
      time: "5m",
    });

    expect(callCron).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "add",
        job: expect.objectContaining({
          delivery: expect.objectContaining({ to: "qqbot:c2c:user-openid", accountId: "bot2" }),
        }),
      }),
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("does not schedule when sender ownership is missing", async () => {
    const callCron = vi.fn(async () => ({ id: "job-1" }));
    const tool = createRemindTool(
      {
        deliveryContext: { to: "qqbot:c2c:user-openid", accountId: "bot2" },
      },
      { callCron },
    );

    const result = await tool.execute("tool-call-1", {
      action: "add",
      content: "drink water",
      time: "5m",
    });

    expect(callCron).not.toHaveBeenCalled();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      error: "QQ reminders require an owner-authorized sender.",
    });
  });
});
