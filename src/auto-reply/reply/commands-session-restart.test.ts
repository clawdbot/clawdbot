import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import type { HandleCommandsParams } from "./commands-types.js";

type ScheduleGatewayRestartArgs = Parameters<typeof scheduleGatewaySigusr1Restart>[0];

const mocks = vi.hoisted(() => ({
  unlink: vi.fn(async (_path: string) => undefined),
  isRestartEnabled: vi.fn(() => true),
  extractDeliveryInfo: vi.fn(() => ({
    deliveryContext: {
      channel: "telegram",
      to: "telegram:123",
      accountId: "default",
    },
    threadId: "thread-1",
  })),
  formatDoctorNonInteractiveHint: vi.fn(() => "Run: openclaw doctor --non-interactive"),
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => "/tmp/sentinel.json"),
  scheduleGatewaySigusr1Restart: vi.fn((_opts?: ScheduleGatewayRestartArgs) => ({
    scheduled: true,
  })),
  triggerOpenClawRestart: vi.fn(() => ({ ok: true, method: "launchctl" })),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    unlink: mocks.unlink,
  },
  unlink: mocks.unlink,
}));

vi.mock("../../config/commands.flags.js", () => ({
  isRestartEnabled: mocks.isRestartEnabled,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: mocks.extractDeliveryInfo,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(),
  normalizeChannelId: (value?: string | null) => value?.trim().toLowerCase() ?? null,
}));

vi.mock("../../channels/plugins/conversation-bindings.js", () => ({
  setChannelConversationBindingIdleTimeoutBySessionKey: vi.fn(),
  setChannelConversationBindingMaxAgeBySessionKey: vi.fn(),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: vi.fn(),
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    formatDoctorNonInteractiveHint: mocks.formatDoctorNonInteractiveHint,
    writeRestartSentinel: mocks.writeRestartSentinel,
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: mocks.scheduleGatewaySigusr1Restart,
  triggerOpenClawRestart: mocks.triggerOpenClawRestart,
}));

const { handleRestartCommand } = await import("./commands-session.js");

function restartCommandParams(overrides?: Partial<HandleCommandsParams>): HandleCommandsParams {
  return {
    ctx: {},
    cfg: {},
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "user-1",
      rawBodyNormalized: "/restart",
      commandBodyNormalized: "/restart",
      from: "telegram:123",
      to: "bot",
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:telegram:direct:123:thread:thread-1",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
    ...overrides,
  } as HandleCommandsParams;
}

describe("handleRestartCommand", () => {
  beforeEach(() => {
    mocks.isRestartEnabled.mockReset();
    mocks.isRestartEnabled.mockReturnValue(true);
    mocks.unlink.mockClear();
    mocks.extractDeliveryInfo.mockClear();
    mocks.formatDoctorNonInteractiveHint.mockClear();
    mocks.writeRestartSentinel.mockClear();
    mocks.scheduleGatewaySigusr1Restart.mockClear();
    mocks.triggerOpenClawRestart.mockReset();
    mocks.triggerOpenClawRestart.mockReturnValue({ ok: true, method: "launchctl" });
  });

  it("writes a routed restart sentinel before restarting from chat", async () => {
    const { DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE } =
      await import("../../infra/restart-sentinel.js");

    const result = await handleRestartCommand(restartCommandParams(), true);

    expect(result?.shouldContinue).toBe(false);
    expect(mocks.writeRestartSentinel).toHaveBeenCalledOnce();
    const sentinelPayload = mocks.writeRestartSentinel.mock.calls[0]?.[0];
    expect(sentinelPayload?.kind).toBe("restart");
    expect(sentinelPayload?.status).toBe("ok");
    expect(typeof sentinelPayload?.ts).toBe("number");
    expect(sentinelPayload?.sessionKey).toBe("agent:main:telegram:direct:123:thread:thread-1");
    expect(sentinelPayload?.deliveryContext).toEqual({
      channel: "telegram",
      to: "telegram:123",
      accountId: "default",
    });
    expect(sentinelPayload?.threadId).toBe("thread-1");
    expect(sentinelPayload?.message).toBe("/restart");
    expect(sentinelPayload?.continuation).toEqual({
      kind: "agentTurn",
      message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE,
    });
    expect(sentinelPayload?.doctorHint).toBe("Run: openclaw doctor --non-interactive");
    expect(sentinelPayload?.stats).toEqual({
      mode: "gateway.restart",
      reason: "/restart",
    });
    expect(mocks.triggerOpenClawRestart).toHaveBeenCalledTimes(1);
  });

  it("prepares the routed sentinel only when SIGUSR1 restart emits", async () => {
    const handler = () => {};
    process.on("SIGUSR1", handler);
    try {
      const result = await handleRestartCommand(restartCommandParams(), true);

      expect(result?.reply?.text).toContain("SIGUSR1");
      expect(mocks.writeRestartSentinel).not.toHaveBeenCalled();
      expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();

      const scheduledArgs = mocks.scheduleGatewaySigusr1Restart.mock.calls.at(-1)?.[0];
      await scheduledArgs?.emitHooks?.beforeEmit?.();

      expect(mocks.writeRestartSentinel).toHaveBeenCalledOnce();
      const sentinelPayload = mocks.writeRestartSentinel.mock.calls[0]?.[0];
      expect(sentinelPayload?.kind).toBe("restart");
      expect(sentinelPayload?.status).toBe("ok");
      expect(sentinelPayload?.sessionKey).toBe("agent:main:telegram:direct:123:thread:thread-1");
      expect(sentinelPayload?.continuation).toEqual({
        kind: "agentTurn",
        message:
          "The gateway restart completed successfully. Tell the user OpenClaw restarted successfully and continue any pending work.",
      });
    } finally {
      process.removeListener("SIGUSR1", handler);
    }
  });

  it("rejects authorized non-owner restart commands", async () => {
    const result = await handleRestartCommand(
      restartCommandParams({
        command: {
          ...restartCommandParams().command,
          senderIsOwner: false,
          isAuthorizedSender: true,
        },
      }),
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(mocks.writeRestartSentinel).not.toHaveBeenCalled();
    expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();
  });

  it("does not restart when the sentinel cannot be written", async () => {
    mocks.writeRestartSentinel.mockRejectedValueOnce(new Error("disk full"));

    const result = await handleRestartCommand(restartCommandParams(), true);

    expect(result?.reply?.text).toContain("could not persist");
    expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();
  });

  it("removes the success sentinel when fallback restart fails", async () => {
    mocks.triggerOpenClawRestart.mockReturnValueOnce({
      ok: false,
      method: "launchctl",
    });

    const result = await handleRestartCommand(restartCommandParams(), true);

    expect(result?.reply?.text).toContain("Restart failed");
    expect(mocks.unlink).toHaveBeenCalledWith("/tmp/sentinel.json");
  });
});
