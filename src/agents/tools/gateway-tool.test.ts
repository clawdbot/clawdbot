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
  formatDoctorNonInteractiveHintMock: vi.fn(() => "Run: openclaw doctor --non-interactive"),
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
  const payload = writeRestartSentinelMock.mock.calls.at(-1)?.[0];
  if (!payload) {
    throw new Error("expected restart sentinel payload");
  }
  return payload;
}

function requireScheduledRestartArgs(): NonNullable<ScheduleGatewayRestartArgs> {
  const args = scheduleGatewaySigusr1RestartMock.mock.calls.at(-1)?.[0];
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
    formatDoctorNonInteractiveHintMock.mockReturnValue("Run: openclaw doctor --non-interactive");
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

  it("instructs agents to use continuationMessage when a restart still needs a reply", async () => {
    const tool = createGatewayTool();

    expect(tool.description).toContain("still owe the user a reply");
    expect(tool.description).toContain("continuationMessage");
    expect(tool.description).toContain("do not write restart sentinel files directly");
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
    const scheduledArgs = scheduleGatewaySigusr1RestartMock.mock.calls.at(-1)?.[0];
    await scheduledArgs?.emitHooks?.beforeEmit?.();

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

    const scheduledArgs = scheduleGatewaySigusr1RestartMock.mock.calls.at(-1)?.[0];
    await scheduledArgs?.emitHooks?.beforeEmit?.();

    expect(requireRestartSentinelPayload().continuation).toEqual({
      kind: "agentTurn",
      message: "Reply after restart",
    });
  });

  it("defaults session-scoped restarts to a success continuation", async () => {
    const { DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE } =
      await import("../../infra/restart-sentinel.js");
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
      delayMs: 250,
      reason: "restart requested",
    });

    const scheduledArgs = scheduleGatewaySigusr1RestartMock.mock.calls.at(-1)?.[0];
    await scheduledArgs?.emitHooks?.beforeEmit?.();

    const payload = requireRestartSentinelPayload();
    expect(payload.sessionKey).toBe("agent:main:main");
    expect(payload.continuation).toEqual({
      kind: "agentTurn",
      message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE,
    });
  });

  it("removes the prepared sentinel when restart emission is rejected", async () => {
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
    });

    const scheduledArgs = scheduleGatewaySigusr1RestartMock.mock.calls.at(-1)?.[0];
    await scheduledArgs?.emitHooks?.beforeEmit?.();
    await scheduledArgs?.emitHooks?.afterEmitRejected?.();

    expect(removeRestartSentinelFileMock).toHaveBeenCalledWith("/tmp/restart");
  });
});
