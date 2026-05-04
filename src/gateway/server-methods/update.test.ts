import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE,
  type RestartSentinelPayload,
} from "../../infra/restart-sentinel.js";
import type { UpdateInstallSurface, UpdateRunResult } from "../../infra/update-runner.js";

// Capture the sentinel payload written during update.run
let capturedPayload: RestartSentinelPayload | undefined;

const runGatewayUpdateMock = vi.fn<() => Promise<UpdateRunResult>>();
const resolveUpdateInstallSurfaceMock = vi.fn<() => Promise<UpdateInstallSurface>>(async () => ({
  kind: "git",
  mode: "git",
  root: "/tmp/openclaw",
  packageRoot: "/tmp/openclaw",
}));
const getLatestUpdateRestartSentinelMock = vi.fn<() => RestartSentinelPayload | null>(() => null);
const isRestartEnabledMock = vi.fn(() => true);
const readPackageVersionMock = vi.fn(async () => "1.0.0");
const detectRespawnSupervisorMock = vi.fn(() => null);

const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ update: {} }),
}));

vi.mock("../../config/commands.flags.js", () => ({
  isRestartEnabled: isRestartEnabledMock,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: (sessionKey: string | undefined) => {
    if (!sessionKey) {
      return { deliveryContext: undefined, threadId: undefined };
    }
    // Simulate a threaded Slack session
    if (sessionKey.includes(":thread:")) {
      return {
        deliveryContext: { channel: "slack", to: "slack:C0123ABC", accountId: "workspace-1" },
        threadId: "1234567890.123456",
      };
    }
    return {
      deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
      threadId: undefined,
    };
  },
}));

vi.mock("../../infra/openclaw-root.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/openclaw-root.js")>(
    "../../infra/openclaw-root.js",
  );
  return {
    ...actual,
    resolveOpenClawPackageRoot: async () => "/tmp/openclaw",
  };
});

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual("../../infra/restart-sentinel.js");
  return {
    ...(actual as Record<string, unknown>),
    writeRestartSentinel: async (payload: RestartSentinelPayload) => {
      capturedPayload = payload;
      return "/tmp/sentinel.json";
    },
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/package-json.js", () => ({
  readPackageVersion: readPackageVersionMock,
}));

vi.mock("../../infra/supervisor-markers.js", () => ({
  detectRespawnSupervisor: detectRespawnSupervisorMock,
}));

vi.mock("../../infra/update-channels.js", () => ({
  normalizeUpdateChannel: () => undefined,
}));

vi.mock("../../infra/update-runner.js", () => ({
  resolveUpdateInstallSurface: resolveUpdateInstallSurfaceMock,
  runGatewayUpdate: runGatewayUpdateMock,
}));

vi.mock("../protocol/index.js", () => ({
  validateUpdateStatusParams: () => true,
  validateUpdateRunParams: () => true,
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: getLatestUpdateRestartSentinelMock,
  recordLatestUpdateRestartSentinel: vi.fn(),
}));

vi.mock("./restart-request.js", () => ({
  parseRestartRequestParams: (params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    note: params.note,
    continuationMessage: params.continuationMessage,
    restartDelayMs: undefined,
  }),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  capturedPayload = undefined;
  isRestartEnabledMock.mockReset();
  isRestartEnabledMock.mockReturnValue(true);
  readPackageVersionMock.mockClear();
  readPackageVersionMock.mockResolvedValue("1.0.0");
  detectRespawnSupervisorMock.mockReset();
  detectRespawnSupervisorMock.mockReturnValue(null);
  runGatewayUpdateMock.mockClear();
  runGatewayUpdateMock.mockResolvedValue({
    status: "ok",
    mode: "npm",
    after: { version: "2.0.0" },
    steps: [],
    durationMs: 100,
  });
  resolveUpdateInstallSurfaceMock.mockClear();
  resolveUpdateInstallSurfaceMock.mockResolvedValue({
    kind: "git",
    mode: "git",
    root: "/tmp/openclaw",
    packageRoot: "/tmp/openclaw",
  });
  getLatestUpdateRestartSentinelMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
});

async function invokeUpdateRun(
  params: Record<string, unknown>,
  respond?: (ok: boolean, response?: unknown) => void,
) {
  const { updateHandlers } = await import("./update.js");
  const onRespond = respond ?? (() => {});
  await updateHandlers["update.run"]({
    params,
    respond: onRespond as never,
    context: { getRuntimeConfig: () => ({ update: {} }) },
  } as never);
}

describe("update.run sentinel deliveryContext", () => {
  it("includes deliveryContext in sentinel payload when sessionKey is provided", async () => {
    capturedPayload = undefined;

    let responded = false;
    await invokeUpdateRun({ sessionKey: "agent:main:webchat:dm:user-123" }, () => {
      responded = true;
    });

    expect(responded).toBe(true);
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toEqual({
      channel: "webchat",
      to: "webchat:user-123",
      accountId: "default",
    });
    expect(capturedPayload!.continuation).toEqual({
      kind: "agentTurn",
      message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE,
    });
  });

  it("omits deliveryContext when no sessionKey is provided", async () => {
    capturedPayload = undefined;

    await invokeUpdateRun({});

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toBeUndefined();
    expect(capturedPayload!.threadId).toBeUndefined();
    expect(capturedPayload!.continuation).toBeUndefined();
  });

  it("includes threadId in sentinel payload for threaded sessions", async () => {
    capturedPayload = undefined;

    await invokeUpdateRun({ sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456" });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toEqual({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });
    expect(capturedPayload!.threadId).toBe("1234567890.123456");
    expect(capturedPayload!.continuation).toEqual({
      kind: "agentTurn",
      message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE,
    });
  });

  it("uses an explicit continuationMessage in successful update sentinels", async () => {
    capturedPayload = undefined;

    await invokeUpdateRun({
      sessionKey: "agent:main:webchat:dm:user-123",
      continuationMessage: "Check the running version and finish the update report.",
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.continuation).toEqual({
      kind: "agentTurn",
      message: "Check the running version and finish the update report.",
    });
  });
});

describe("update.run timeout normalization", () => {
  it("enforces a 1000ms minimum timeout for tiny values", async () => {
    await invokeUpdateRun({ timeoutMs: 1 });

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1000,
      }),
    );
  });
});

describe("update.run restart scheduling", () => {
  it("schedules restart when update succeeds", async () => {
    let payload: { ok: boolean; restart: unknown } | undefined;

    await invokeUpdateRun({}, (_ok: boolean, response: unknown) => {
      const typed = response as { ok: boolean; restart: unknown };
      payload = typed;
    });

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(payload?.ok).toBe(true);
    expect(payload?.restart).toEqual({ scheduled: true });
  });

  it("skips restart when update fails", async () => {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "error",
      mode: "git",
      reason: "build-failed",
      steps: [],
      durationMs: 100,
    });

    let payload: { ok: boolean; restart: unknown } | undefined;

    await invokeUpdateRun(
      {
        sessionKey: "agent:main:webchat:dm:user-123",
        continuationMessage: "This should not run after a failed update.",
      },
      (_ok: boolean, response: unknown) => {
        const typed = response as { ok: boolean; restart: unknown };
        payload = typed;
      },
    );

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.restart).toBeNull();
    expect(capturedPayload?.continuation).toBeUndefined();
  });

  it.each([
    { status: "skipped" as const, reason: "dirty" },
    { status: "skipped" as const, reason: "not-git-install" },
    { status: "skipped" as const, reason: "restart-disabled" },
    { status: "error" as const, reason: "deps-install-failed" },
    { status: "error" as const, reason: "build-failed" },
    { status: "error" as const, reason: "global-install-failed" },
  ])("returns ok=false for $status:$reason", async ({ status, reason }) => {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status,
      mode: "git",
      reason,
      steps: [],
      durationMs: 100,
    });

    let payload: { ok: boolean; result?: { status?: string; reason?: string } } | undefined;

    await invokeUpdateRun({}, (_ok: boolean, response: unknown) => {
      payload = response as typeof payload;
    });

    expect(payload?.ok).toBe(false);
    expect(payload?.result).toEqual(
      expect.objectContaining({
        status,
        reason,
      }),
    );
  });

  it("forces an immediate restart after successful package-manager updates", async () => {
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
      kind: "global",
      mode: "npm",
      root: "/tmp/openclaw-global",
      packageRoot: "/tmp/openclaw-global",
    });

    let payload:
      | { ok: boolean; result?: { status?: string; reason?: string; mode?: string } }
      | undefined;

    await invokeUpdateRun({}, (_ok: boolean, response: unknown) => {
      payload = response as typeof payload;
    });

    expect(runGatewayUpdateMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 0,
        reason: "update.run",
        skipCooldown: true,
        skipDeferral: true,
      }),
    );
    expect(payload?.ok).toBe(true);
  });

  it("blocks global package installs when the gateway cannot restart afterward", async () => {
    isRestartEnabledMock.mockReturnValue(false);
    detectRespawnSupervisorMock.mockReturnValue(null);
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
      kind: "global",
      mode: "npm",
      root: "/tmp/openclaw-global",
      packageRoot: "/tmp/openclaw-global",
    });

    let payload:
      | { ok: boolean; result?: { status?: string; reason?: string; mode?: string } }
      | undefined;

    await invokeUpdateRun({}, (_ok: boolean, response: unknown) => {
      payload = response as typeof payload;
    });

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        result: expect.objectContaining({
          status: "skipped",
          reason: "restart-unavailable",
          mode: "npm",
        }),
      }),
    );
  });
});

describe("update.status", () => {
  it("returns the latest cached update sentinel", async () => {
    getLatestUpdateRestartSentinelMock.mockReturnValueOnce({
      kind: "update",
      status: "ok",
      ts: 1,
      stats: {
        after: { version: "2.0.0" },
      },
    });
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();

    await updateHandlers["update.status"]({
      params: {},
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(true, {
      sentinel: expect.objectContaining({
        kind: "update",
        status: "ok",
      }),
    });
  });
});
