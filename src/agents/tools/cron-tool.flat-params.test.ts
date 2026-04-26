import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import { createCronTool } from "./cron-tool.js";

describe("cron tool flat-params", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  it("preserves explicit top-level sessionKey during flat-params recovery", async () => {
    const tool = createCronTool(
      { agentSessionKey: "agent:main:discord:channel:ops" },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-flat-session-key", {
      action: "add",
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      message: "do stuff",
    });

    const [method, _gatewayOpts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      { sessionKey?: string },
    ];
    expect(method).toBe("cron.add");
    expect(params.sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
  });

  it("recovers flat cron schedule shorthand for add", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-cron-add", {
      action: "add",
      name: "hourly report",
      cron: "0 * * * *",
      tz: "UTC",
      staggerMs: 5000,
      message: "send report",
    });

    const [method, _gatewayOpts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      {
        schedule?: unknown;
        payload?: unknown;
      },
    ];
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({
      kind: "cron",
      expr: "0 * * * *",
      tz: "UTC",
      staggerMs: 5000,
    });
    expect(params.payload).toEqual({
      kind: "agentTurn",
      message: "send report",
    });
  });

  it("recovers flat cron schedule shorthand for update", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-cron-update", {
      action: "update",
      jobId: "job-123",
      cron: "15 8 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 30_000,
    });

    const [method, _gatewayOpts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      {
        id?: string;
        patch?: { schedule?: unknown };
      },
    ];
    expect(method).toBe("cron.update");
    expect(params.id).toBe("job-123");
    expect(params.patch?.schedule).toEqual({
      kind: "cron",
      expr: "15 8 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 30_000,
    });
  });
});
