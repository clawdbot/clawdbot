// Gateway tool restart tests cover the sentinel handoff that lets an agent
// resume private work after the gateway process restarts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createGatewayTool } from "./gateway-tool.js";

type ScheduleGatewayRestartArgs = Parameters<typeof scheduleGatewaySigusr1Restart>[0];

const {
  extractDeliveryInfoMock,
  formatDoctorNonInteractiveHintMock,
  isRestartEnabledMock,
  removeRestartSentinelFileMock,
  scheduleGatewaySigusr1RestartMock,
  writeRestartSentinelMock,
} = vi.hoisted(() => ({
  isRestartEnabledMock: vi.fn(() => true),
  extractDeliveryInfoMock: vi.fn(() => ({
    deliveryContext: {
      channel: "slack",
      to: "slack:C123",
      accountId: "workspace-1",
    },
    threadId: "thread-42",
  })),
  formatDoctorNonInteractiveHintMock: vi.fn(
    () =>
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
  ),
  writeRestartSentinelMock: vi.fn(async (_payload: RestartSentinelPayload) => "/tmp/restart"),
  removeRestartSentinelFileMock: vi.fn(async (_path: string | null | undefined) => undefined),
  scheduleGatewaySigusr1RestartMock: vi.fn((_opts?: ScheduleGatewayRestartArgs) => ({
    scheduled: true,
    delayMs: 250,
  })),
}));

vi.mock("../../config/commands.js", () => ({
  isRestartEnabled: isRestartEnabledMock,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    formatDoctorNonInteractiveHint: formatDoctorNonInteractiveHintMock,
    removeRestartSentinelFile: removeRestartSentinelFileMock,
    writeRestartSentinel: writeRestartSentinelMock,
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
  })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

function requireRestartSentinelPayload(): RestartSentinelPayload {
  const calls = writeRestartSentinelMock.mock.calls;
  const payload = calls[calls.length - 1]?.[0];
  if (!payload) {
    throw new Error("expected restart sentinel payload");
  }
  return payload;
}

function requireScheduledRestartArgs(): NonNullable<ScheduleGatewayRestartArgs> {
  const calls = scheduleGatewaySigusr1RestartMock.mock.calls;
  const args = calls[calls.length - 1]?.[0];
  if (!args) {
    throw new Error("expected scheduled restart args");
  }
  return args;
}

describe("gateway tool restart continuation", () => {
  beforeEach(() => {
    isRestartEnabledMock.mockReset();
    isRestartEnabledMock.mockReturnValue(true);
    extractDeliveryInfoMock.mockReset();
    extractDeliveryInfoMock.mockReturnValue({
      deliveryContext: {
        channel: "slack",
        to: "slack:C123",
        accountId: "workspace-1",
      },
      threadId: "thread-42",
    });
    formatDoctorNonInteractiveHintMock.mockReset();
    formatDoctorNonInteractiveHintMock.mockReturnValue(
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
    );
    writeRestartSentinelMock.mockReset();
    writeRestartSentinelMock.mockResolvedValue("/tmp/restart");
    removeRestartSentinelFileMock.mockClear();
    scheduleGatewaySigusr1RestartMock.mockReset();
    scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true, delayMs: 250 });
  });

  it("does not expose system-event continuations to the agent tool", async () => {
    const tool = createGatewayTool();

    const parameters = tool.parameters as {
      properties?: {
        continuationKind?: unknown;
      };
    };
    expect(parameters.properties?.continuationKind).toBeUndefined();
  });

  it("advertises restart delays as non-negative integers", async () => {
    const tool = createGatewayTool();

    const parameters = tool.parameters as {
      properties?: {
        delayMs?: { minimum?: number; type?: string };
        restartDelayMs?: { minimum?: number; type?: string };
        timeoutMs?: { minimum?: number; type?: string };
      };
    };
    expect(parameters.properties?.delayMs).toMatchObject({ type: "integer", minimum: 0 });
    expect(parameters.properties?.restartDelayMs).toMatchObject({ type: "integer", minimum: 0 });
    expect(parameters.properties?.timeoutMs).toMatchObject({ type: "integer", minimum: 1 });
  });

  it("instructs agents to use continuationMessage for internal post-restart work", async () => {
    const tool = createGatewayTool();

    expect(tool.description).toContain("post-restart work must continue internally");
    expect(tool.description).toContain(
      "visible follow-up from that turn must use the message tool",
    );
    expect(tool.description).toContain("continuationMessage");
    expect(tool.description).toContain("Do not write restart sentinel files directly");
  });

  it("writes an agentTurn continuation into the restart sentinel", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    const result = await tool.execute?.("tool-call-1", {
      action: "restart",
      delayMs: 250,
      reason: "continue after reboot",
      note: "Gateway restarting now",
      continuationMessage: "Reply with exactly: Yay! I did it!",
    });

    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
    // The sentinel is emitted by the restart scheduler hook, so failed restart
    // delivery can still clean up a prepared file before the process exits.
    await requireScheduledRestartArgs().emitHooks?.beforeEmit?.();

    const payload = requireRestartSentinelPayload();
    expect(payload.kind).toBe("restart");
    expect(payload.status).toBe("ok");
    expect(payload.sessionKey).toBe("agent:main:main");
    expect(payload.deliveryContext).toEqual({
      channel: "slack",
      to: "slack:C123",
      accountId: "workspace-1",
    });
    expect(payload.threadId).toBe("thread-42");
    expect(payload.message).toBe("Gateway restarting now");
    expect(payload.continuation).toEqual({
      kind: "agentTurn",
      message: "Reply with exactly: Yay! I did it!",
    });
    const restartArgs = requireScheduledRestartArgs();
    expect(restartArgs.delayMs).toBe(250);
    expect(restartArgs.reason).toBe("continue after reboot");
    expect(typeof restartArgs.emitHooks?.beforeEmit).toBe("function");
    expect(typeof restartArgs.emitHooks?.afterEmitRejected).toBe("function");
    expect(result?.details).toEqual({ scheduled: true, delayMs: 250 });
  });

  it.each([-1, 1.5, "soon"])("rejects invalid restart delayMs value %s", async (delayMs) => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await expect(
      tool.execute?.("tool-call-invalid-delay", {
        action: "restart",
        delayMs,
      }),
    ).rejects.toThrow("delayMs must be a non-negative integer");
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("accepts string restart delayMs values through the shared numeric reader", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-string-delay", {
      action: "restart",
      delayMs: "250",
    });

    expect(requireScheduledRestartArgs().delayMs).toBe(250);
  });

  it("coerces legacy continuationKind inputs to an agentTurn", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
      continuationKind: "systemEvent",
      continuationMessage: "Reply after restart",
    });

    await requireScheduledRestartArgs().emitHooks?.beforeEmit?.();

    // Older model-facing arguments should not reintroduce system-event
    // continuations; visible replies still go through the message tool.
    expect(requireRestartSentinelPayload().continuation).toEqual({
      kind: "agentTurn",
      message: "Reply after restart",
    });
  });

  it("does not infer a continuation for session-scoped restarts", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
      delayMs: 250,
      reason: "restart requested",
    });

    await requireScheduledRestartArgs().emitHooks?.beforeEmit?.();

    const payload = requireRestartSentinelPayload();
    expect(payload.sessionKey).toBe("agent:main:main");
    expect(payload.continuation).toBeNull();
  });

  it("removes the prepared sentinel when restart emission is rejected", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
    });

    const scheduledArgs = requireScheduledRestartArgs();
    await scheduledArgs.emitHooks?.beforeEmit?.();
    await scheduledArgs.emitHooks?.afterEmitRejected?.();

    expect(removeRestartSentinelFileMock).toHaveBeenCalledWith("/tmp/restart");
  });
});
