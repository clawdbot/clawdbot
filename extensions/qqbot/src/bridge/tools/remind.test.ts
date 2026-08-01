import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
// Qqbot tests cover remind plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: callGatewayToolMock,
}));

import { registerRemindTool } from "./remind.js";

function createRegisteredRemindTool(context: OpenClawPluginToolContext = {}): AnyAgentTool {
  let factory: ((ctx: OpenClawPluginToolContext) => AnyAgentTool) | undefined;
  const api = {
    registerTool(tool: AnyAgentTool | ((ctx: OpenClawPluginToolContext) => AnyAgentTool)) {
      if (typeof tool === "function") {
        factory = tool;
      }
    },
  } as unknown as OpenClawPluginApi;
  registerRemindTool(api);
  if (!factory) {
    throw new Error("Expected QQBot reminder tool factory");
  }
  return factory(context);
}

type CronAddToolPayload = {
  name?: string;
  schedule?: {
    kind?: string;
    at?: string;
    atMs?: number;
  };
  sessionTarget?: string;
  payload?: {
    kind?: string;
    message?: string;
    toolsAllow?: string[];
  };
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
    accountId?: string;
  };
};

describe("bridge/tools/remind", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  it("schedules reminders directly through Gateway cron with ambient QQ delivery context", async () => {
    callGatewayToolMock.mockResolvedValue({ id: "job-1" });
    const tool = createRegisteredRemindTool({
      deliveryContext: { to: "qqbot:c2c:user-openid", accountId: "bot2" },
    });

    const result = await tool.execute("tool-call-1", {
      action: "add",
      content: "drink water",
      time: "5m",
    });

    const addCall = callGatewayToolMock.mock.calls.at(0);
    const addPayload = addCall?.[2] as CronAddToolPayload | undefined;
    expect(addCall?.[0]).toBe("cron.add");
    expect(addCall?.[1]).toEqual({ timeoutMs: 60_000 });
    expect(addPayload).not.toHaveProperty("job");
    expect(addPayload?.name).toBe("Reminder: drink water");
    expect(addPayload?.schedule?.kind).toBe("at");
    expect(addPayload?.schedule?.at).toEqual(expect.any(String));
    expect(addPayload?.schedule).not.toHaveProperty("atMs");
    expect(addPayload?.sessionTarget).toBe("isolated");
    expect(addPayload?.payload?.kind).toBe("agentTurn");
    expect(addPayload?.payload?.message).toContain("drink water");
    expect(addPayload?.payload?.toolsAllow).toEqual([]);
    expect(addPayload?.delivery).toEqual({
      mode: "announce",
      channel: "qqbot",
      to: "qqbot:c2c:user-openid",
      accountId: "bot2",
    });
    expect(result.details).toEqual({
      ok: true,
      action: "add",
      summary: '⏰ Reminder in 5m: "drink water"',
      cronResult: { id: "job-1" },
    });
  });

  it("routes list and remove through Gateway cron without exposing generic cron to the model", async () => {
    const tool = createRegisteredRemindTool();

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
});
