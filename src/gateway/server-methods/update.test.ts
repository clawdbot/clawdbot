// Update method tests cover update.run/status, restart sentinel metadata,
// managed-service handoff, restart scheduling, and delivery context preservation.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { withEnvAsync } from "../../test-utils/env.js";

// Capture the sentinel payload written during update.run
let capturedPayload: RestartSentinelPayload | undefined;
let restartSentinelWriteError: Error | null = null;

const runGatewayUpdateMock = vi.fn<() => Promise<UpdateRunResult>>();
type UpdateInstallSurface = Awaited<
  ReturnType<typeof import("../../infra/update-runner.js").resolveUpdateInstallSurface>
>;
const resolveUpdateInstallSurfaceMock = vi.fn<() => Promise<UpdateInstallSurface>>(async () => ({
  kind: "git",
  mode: "git",
  root: "/tmp/openclaw",
  packageRoot: "/tmp/openclaw",
}));
const getLatestUpdateRestartSentinelMock = vi.fn<() => RestartSentinelPayload | null>(() => null);
const refreshLatestUpdateRestartSentinelMock = vi.fn<() => Promise<RestartSentinelPayload | null>>(
  async () => null,
);
const recordLatestUpdateRestartSentinelMock = vi.fn();
const isRestartEnabledMock = vi.fn(() => true);
const readPackageVersionMock = vi.fn(async () => "1.0.0");
const detectRespawnSupervisorMock = vi.fn<() => RespawnSupervisor | null>(() => null);
const normalizeUpdateChannelMock = vi.fn((): UpdateChannel | null => null);
const readConfigFileSnapshotMock = vi.fn<() => Promise<ConfigFileSnapshot>>();
const startManagedServiceUpdateHandoffMock = vi.fn(async () => ({
  status: "started" as const,
  pid: 12345,
  command: "openclaw update --yes --timeout 1800",
  logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
}));

const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

type PostCoreFinalizeOutcome = Awaited<
  ReturnType<
    typeof import("../../infra/update-post-core-finalize.js").runPostCoreFinalizeAfterGatewayUpdate
  >
>;
const runPostCoreFinalizeAfterGatewayUpdateMock = vi.fn<() => Promise<PostCoreFinalizeOutcome>>(
  async () => ({ status: "skipped", reason: "not-git-update" }),
);

type UpdateRunPayload = {
  ok: boolean;
  result?: { status?: string; reason?: string; mode?: string };
  handoff?: { status?: string; command?: string; message?: string };
  sentinel?: { persisted?: boolean };
  restart?: unknown;
};

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ update: {} }),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
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
      if (restartSentinelWriteError) {
        throw restartSentinelWriteError;
      }
      capturedPayload = payload;
    },
  };
});

vi.mock("../../infra/restart.js", () => ({
  resolveGatewayRestartDeferralTimeoutMs: (timeoutMs: unknown) => {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
      return 300_000;
    }
    return timeoutMs <= 0 ? undefined : Math.floor(timeoutMs);
  },
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/package-json.js", () => ({
  readPackageVersion: readPackageVersionMock,
}));

vi.mock("../../infra/supervisor-markers.js", () => ({
  detectRespawnSupervisor: detectRespawnSupervisorMock,
}));

vi.mock("../../infra/update-channels.js", () => ({
  normalizeUpdateChannel: normalizeUpdateChannelMock,
}));

vi.mock("../../infra/update-runner.js", () => ({
  resolveUpdateInstallSurface: resolveUpdateInstallSurfaceMock,
  runGatewayUpdate: runGatewayUpdateMock,
}));

// Keep the real `foldPostCoreFinalizeIntoResult` so the restart-gate behavior on
// finalize failure is exercised; only stub the subprocess-spawning finalizer.
vi.mock("../../infra/update-post-core-finalize.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-post-core-finalize.js")>(
    "../../infra/update-post-core-finalize.js",
  );
  return {
    ...actual,
    runPostCoreFinalizeAfterGatewayUpdate: runPostCoreFinalizeAfterGatewayUpdateMock,
  };
});

vi.mock("../../../packages/gateway-protocol/src/index.js", () => ({
  validateUpdateStatusParams: () => true,
  validateUpdateRunParams: () => true,
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: getLatestUpdateRestartSentinelMock,
  recordLatestUpdateRestartSentinel: recordLatestUpdateRestartSentinelMock,
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelMock,
}));

vi.mock("./restart-request.js", () => ({
  parseRestartRequestParams: (params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    note: params.note,
    continuationMessage: params.continuationMessage,
    restartDelayMs: params.restartDelayMs,
  }),
}));

vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  startManagedServiceUpdateHandoff: startManagedServiceUpdateHandoffMock,
  formatManagedServiceUpdateCommand: (params?: { timeoutMs?: number; channel?: UpdateChannel }) => {
    const args = ["openclaw", "update", "--yes"];
    if (params?.channel) {
      args.push("--channel", params.channel);
    }
    if (params?.timeoutMs) {
      args.push("--timeout", String(Math.ceil(params.timeoutMs / 1000)));
    }
    return args.join(" ");
  },
  buildManagedServiceHandoffUnavailableMessage: (command: string) =>
    [
      "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
      `Run \`${command}\` from a shell outside the gateway service, or restart/update from the host UI.`,
    ].join("\n"),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  capturedPayload = undefined;
  restartSentinelWriteError = null;
  isRestartEnabledMock.mockReset();
  isRestartEnabledMock.mockReturnValue(true);
  readPackageVersionMock.mockClear();
  readPackageVersionMock.mockResolvedValue("1.0.0");
  normalizeUpdateChannelMock.mockReset();
  normalizeUpdateChannelMock.mockReturnValue(null);
  readConfigFileSnapshotMock.mockReset();
  readConfigFileSnapshotMock.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {} as OpenClawConfig,
    sourceConfig: {} as OpenClawConfig,
    valid: true,
    config: {} as OpenClawConfig,
    runtimeConfig: {} as OpenClawConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
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
  refreshLatestUpdateRestartSentinelMock.mockClear();
  refreshLatestUpdateRestartSentinelMock.mockResolvedValue(null);
  recordLatestUpdateRestartSentinelMock.mockClear();
  startManagedServiceUpdateHandoffMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
  runPostCoreFinalizeAfterGatewayUpdateMock.mockClear();
  runPostCoreFinalizeAfterGatewayUpdateMock.mockResolvedValue({
    status: "skipped",
    reason: "not-git-update",
  });
});

async function invokeUpdateRun(
  params: Record<string, unknown>,
  respond?: (ok: boolean, response?: unknown) => void,
  runtimeConfig: OpenClawConfig = { update: {} },
) {
  const { updateHandlers } = await import("./update.js");
  const onRespond = respond ?? (() => {});
  await expectDefined(
    updateHandlers["update.run"],
    'updateHandlers["update.run"] test invariant',
  )({
    params,
    respond: onRespond as never,
    context: { getRuntimeConfig: () => runtimeConfig },
  } as never);
}

async function captureUpdateRunPayload(
  params: Record<string, unknown> = {},
  runtimeConfig?: OpenClawConfig,
): Promise<UpdateRunPayload | undefined> {
  let payload: UpdateRunPayload | undefined;
  await invokeUpdateRun(
    params,
    (_ok: boolean, response: unknown) => {
      payload = response as UpdateRunPayload;
    },
    runtimeConfig,
  );
  return payload;
}

function readCapturedPayload(): RestartSentinelPayload {
  if (!capturedPayload) {
    throw new Error("expected restart sentinel payload");
  }
  return capturedPayload;
}

function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

async function withProcessEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  return await withEnvAsync(updates, run);
}

function mockGlobalInstallSurface() {
  resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
    kind: "global",
    mode: "npm",
    root: "/tmp/openclaw-global",
    packageRoot: "/tmp/openclaw-global",
  });
}

function mockGitInstallSurface(root: string) {
  resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
    kind: "git",
    mode: "git",
    root,
    packageRoot: root,
  });
}

describe("update.run sentinel deliveryContext", () => {
  it("includes deliveryContext in sentinel payload when sessionKey is provided", async () => {
    capturedPayload = undefined;

    let responded = false;
    await invokeUpdateRun({ sessionKey: "agent:main:webchat:dm:user-123" }, () => {
      responded = true;
    });

    expect(responded).toBe(true);
    const payload = readCapturedPayload();
    expect(payload.deliveryContext).toEqual({
      channel: "webchat",
      to: "webchat:user-123",
      accountId: "default",
    });
    expect(payload.continuation).toBeUndefined();
  });

  it("omits deliveryContext when no sessionKey is provided", async () => {
    capturedPayload = undefined;

    await invokeUpdateRun({});

    const payload = readCapturedPayload();
    expect(payload.deliveryContext).toBeUndefined();
    expect(payload.threadId).toBeUndefined();
    expect(payload.continuation).toBeUndefined();
  });

  it("includes threadId in sentinel payload for threaded sessions", async () => {
    capturedPayload = undefined;

    await invokeUpdateRun({ sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456" });

    const payload = readCapturedPayload();
    expect(payload.deliveryContext).toEqual({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });
    expect(payload.threadId).toBe("1234567890.123456");
    expect(payload.continuation).toBeUndefined();
  });

  it("uses an explicit continuationMessage in successful update sentinels", async () => {
    capturedPayload = undefined;

    await invokeUpdateRun({
      sessionKey: "agent:main:webchat:dm:user-123",
      continuationMessage: "Check the running version and finish the update report.",
    });

    expect(readCapturedPayload().continuation).toEqual({
      kind: "agentTurn",
      message: "Check the running version and finish the update report.",
    });
  });
});

describe("update.run timeout normalization", () => {
  it("enforces a 1000ms minimum timeout for tiny values", async () => {
    await invokeUpdateRun({ timeoutMs: 1 });

    expect(runGatewayUpdateMock).toHaveBeenCalledTimes(1);
    const [updateParams] = firstMockCall(runGatewayUpdateMock, "gateway update") as [
      {
        timeoutMs?: number;
        allowGatewayServiceRepair?: boolean;
        allowGatewayActivation?: boolean;
      },
    ];
    expect(updateParams?.timeoutMs).toBe(1000);
    expect(updateParams?.allowGatewayServiceRepair).toBe(false);
    expect(updateParams?.allowGatewayActivation).toBe(false);
  });
});

describe("update.run restart scheduling", () => {
  it("schedules restart when update succeeds", async () => {
    const payload = await captureUpdateRunPayload();

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

    const payload = await captureUpdateRunPayload({
      sessionKey: "agent:main:webchat:dm:user-123",
      continuationMessage: "This should not run after a failed update.",
    });

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

    const payload = await captureUpdateRunPayload();

    expect(payload?.ok).toBe(false);
    expect(payload?.result?.status).toBe(status);
    expect(payload?.result?.reason).toBe(reason);
  });

  it("hands managed package updates to the CLI path instead of running them in-process", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    const payload = await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload({}, { gateway: { reload: { deferralTimeoutMs: 60_000 } } }),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw",
        restartDrainTimeoutMs: 60_000,
        restartDelayMs: 2000,
        handoffId: expect.any(String),
        supervisor: "launchd",
        meta: expect.objectContaining({
          handoffId: expect.any(String),
        }),
      }),
    );
    const [handoffParams] = firstMockCall(
      startManagedServiceUpdateHandoffMock,
      "managed handoff",
    ) as [{ handoffId?: string; meta?: { handoffId?: string } }];
    expect(handoffParams.meta?.handoffId).toBe(handoffParams.handoffId);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    const [restartParams] = firstMockCall(
      scheduleGatewaySigusr1RestartMock,
      "gateway restart schedule",
    ) as [{ delayMs?: number; reason?: string; skipCooldown?: boolean; skipDeferral?: boolean }];
    expect(restartParams?.reason).toBe("update.run");
    expect(restartParams?.skipCooldown).toBe(true);
    expect(restartParams?.skipDeferral).toBe(true);
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(
      (payload as { handoff?: { status?: string; command?: string } } | undefined)?.handoff,
    ).toEqual({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
    });
    expect(payload?.sentinel?.persisted).toBe(true);
    const sentinel = readCapturedPayload();
    expect(sentinel.kind).toBe("update");
    expect(sentinel.status).toBe("skipped");
    expect(sentinel.stats).toEqual(
      expect.objectContaining({
        handoffId: handoffParams.handoffId,
        reason: "managed-service-handoff-started",
      }),
    );
    expect(recordLatestUpdateRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update",
        status: "skipped",
        stats: expect.objectContaining({
          reason: "managed-service-handoff-started",
        }),
      }),
    );
  });

  it("preserves an indefinite restart drain for managed updates", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload({}, { gateway: { reload: { deferralTimeoutMs: 0 } } }),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ restartDrainTimeoutMs: undefined }),
    );
  });

  it("arms the managed restart before optional sentinel persistence", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    restartSentinelWriteError = new Error("state database unavailable");

    const payload = await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(payload?.sentinel?.persisted).toBe(false);
    expect(payload?.ok).toBe(true);
  });

  it("does not restart or report success when the handoff helper cannot spawn", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );

    const payload = await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.result).toMatchObject({
      status: "error",
      reason: "managed-service-handoff-failed",
    });
    expect(payload?.handoff).toBeUndefined();
  });

  it("keeps a startup grace before restarting after systemd handoff spawn", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("systemd");
    mockGlobalInstallSurface();

    await withProcessEnv({ OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" }, () =>
      invokeUpdateRun({ restartDelayMs: 0 }),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supervisor: "systemd",
        restartDelayMs: 2000,
      }),
    );
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 2000,
        reason: "update.run",
        skipCooldown: true,
        skipDeferral: true,
      }),
    );
  });

  it("starts managed package handoff when the gateway cwd is unavailable", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
    });
    try {
      await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
        invokeUpdateRun({}),
      );
    } finally {
      cwdSpy.mockRestore();
    }

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw",
      }),
    );
  });

  it("hands supervised git/dev updates to the CLI path instead of rebuilding live dist in-process", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");
    const payload = await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw",
        handoffId: expect.any(String),
        supervisor: "launchd",
        meta: expect.objectContaining({
          handoffId: expect.any(String),
        }),
      }),
    );
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff).toEqual({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
    });
    expect(readCapturedPayload().status).toBe("skipped");
  });

  it("hands Windows fallback gateways to the CLI path before doctor activation", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("schtasks");
    mockGitInstallSurface("C:\\openclaw");

    const payload = await withProcessEnv(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      () => captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supervisor: "schtasks",
        handoffId: expect.any(String),
      }),
    );
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
  });

  it("does not pass the stored stable channel to supervised git handoff CLI", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("stable");
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    const [handoffParams] = firstMockCall(
      startManagedServiceUpdateHandoffMock,
      "managed handoff",
    ) as [{ channel?: string }];
    expect(handoffParams).not.toHaveProperty("channel");
    expect(payload?.handoff?.command).not.toContain("--channel");
  });

  it("rejects stored extended-stable on Git without starting a handoff or mutation", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("extended-stable");
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.result).toMatchObject({
      status: "error",
      mode: "git",
      reason: "unsupported_git_channel",
    });
  });

  it("forwards stored extended-stable to package managed-service handoff", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("extended-stable");
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "extended-stable" }),
    );
  });

  it("keeps unsupervised git/dev updates on the in-process gateway update path", async () => {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "ok",
      mode: "git",
      after: { version: "2.0.0" },
      steps: [],
      durationMs: 100,
    });
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await captureUpdateRunPayload();

    expect(runGatewayUpdateMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("ok");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff).toBeUndefined();
    expect(readCapturedPayload().status).toBe("ok");
  });

  it("hands systemd-supervised git/dev updates to handoff from the durable unit identity", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("systemd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withProcessEnv(
      {
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "8a77e69a8f604bf0b7984879b9f17a7c",
      },
      () => captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw",
        supervisor: "systemd",
      }),
    );
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff?.status).toBe("started");
  });

  it("does not hand off systemd-supervised git/dev updates from generic systemd markers alone", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("systemd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withProcessEnv(
      {
        OPENCLAW_SYSTEMD_UNIT: undefined,
        INVOCATION_ID: "8a77e69a8f604bf0b7984879b9f17a7c",
      },
      () => captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.restart).toBeNull();
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-unavailable");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff?.status).toBe("unavailable");
  });

  it("returns a safe command when package updates cannot be handed off", async () => {
    mockGlobalInstallSurface();

    const payload = await captureUpdateRunPayload({ timeoutMs: 1_800_000 });

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.restart).toBeNull();
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-unavailable");
    expect(payload?.handoff).toEqual({
      status: "unavailable",
      command: "openclaw update --yes --timeout 1800",
      message:
        "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.\n" +
        "Run `openclaw update --yes --timeout 1800` from a shell outside the gateway service, or restart/update from the host UI.",
    });
  });

  it("blocks global package installs when the gateway cannot restart afterward", async () => {
    isRestartEnabledMock.mockReturnValue(false);
    detectRespawnSupervisorMock.mockReturnValue(null);
    mockGlobalInstallSurface();

    const payload = await captureUpdateRunPayload();

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("restart-unavailable");
    expect(payload?.result?.mode).toBe("npm");
  });
});

describe("update.run post-core plugin finalize", () => {
  function mockGitOkUpdate(root: string) {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "ok",
      mode: "git",
      root,
      after: { version: "2026.6.1" },
      steps: [],
      durationMs: 100,
    });
    mockGitInstallSurface(root);
  }

  it("resumes official plugin convergence after a git/source core update", async () => {
    runPostCoreFinalizeAfterGatewayUpdateMock.mockResolvedValueOnce({
      status: "ok",
      entrypoint: "/tmp/openclaw-git/dist/index.mjs",
    });
    mockGitOkUpdate("/tmp/openclaw-git");

    const payload = await captureUpdateRunPayload();

    expect(runPostCoreFinalizeAfterGatewayUpdateMock).toHaveBeenCalledTimes(1);
    const [finalizeParams] = firstMockCall(
      runPostCoreFinalizeAfterGatewayUpdateMock,
      "post-core finalize",
    ) as [{ result?: UpdateRunResult; serviceRepairPolicy?: string }];
    expect(finalizeParams.result?.mode).toBe("git");
    expect(finalizeParams.result?.status).toBe("ok");
    expect(finalizeParams.serviceRepairPolicy).toBe("external");
    // Convergence succeeded, so the gateway is allowed to restart onto the new core.
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("ok");
  });

  it("carries the pre-doctor source config into the git finalizer", async () => {
    const preUpdateConfig = {
      channels: {
        whatsapp: {
          enabled: true,
        },
      },
    } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: JSON.stringify(preUpdateConfig),
      parsed: preUpdateConfig,
      resolved: preUpdateConfig,
      sourceConfig: preUpdateConfig,
      valid: true,
      config: preUpdateConfig,
      runtimeConfig: preUpdateConfig,
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    runPostCoreFinalizeAfterGatewayUpdateMock.mockResolvedValueOnce({
      status: "ok",
      entrypoint: "/tmp/openclaw-git/dist/index.mjs",
    });
    mockGitOkUpdate("/tmp/openclaw-git");

    await captureUpdateRunPayload();

    const [finalizeParams] = firstMockCall(
      runPostCoreFinalizeAfterGatewayUpdateMock,
      "post-core finalize",
    ) as [{ preUpdateConfig?: { sourceConfig?: OpenClawConfig; authoredConfig?: OpenClawConfig } }];
    expect(finalizeParams.preUpdateConfig).toEqual({
      sourceConfig: preUpdateConfig,
      authoredConfig: preUpdateConfig,
    });
  });

  it("blocks the restart when post-core plugin finalize fails", async () => {
    runPostCoreFinalizeAfterGatewayUpdateMock.mockResolvedValueOnce({
      status: "error",
      reason: "nonzero-exit",
      entrypoint: "/tmp/openclaw-git/dist/index.mjs",
      exitCode: 1,
      message: "convergence failed",
    });
    mockGitOkUpdate("/tmp/openclaw-git");

    const payload = await captureUpdateRunPayload();

    // Restarting onto the new core with unreconciled plugins is the bug we avoid.
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.result?.status).toBe("error");
    expect(payload?.result?.reason).toBe("post-core-plugin-finalize-failed");
    expect(readCapturedPayload().status).toBe("error");
  });

  it("does not run finalize on the managed-service handoff path", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    await withProcessEnv({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(runPostCoreFinalizeAfterGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
  });
});

describe("update.status", () => {
  it("refreshes the latest update sentinel before responding", async () => {
    getLatestUpdateRestartSentinelMock.mockReturnValueOnce({
      kind: "update",
      status: "skipped",
      ts: 1,
      stats: {
        reason: "restart-health-pending",
      },
    });
    refreshLatestUpdateRestartSentinelMock.mockResolvedValueOnce({
      kind: "update",
      status: "ok",
      ts: 2,
      stats: {
        after: { version: "2.0.0" },
      },
    });
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();

    await expectDefined(
      updateHandlers["update.status"],
      'updateHandlers["update.status"] test invariant',
    )({
      params: {},
      respond,
    } as never);

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, response] = firstMockCall(respond, "update status response") as [
      boolean,
      { sentinel?: { kind?: string; status?: string } } | undefined,
    ];
    expect(ok).toBe(true);
    expect(refreshLatestUpdateRestartSentinelMock).toHaveBeenCalledTimes(1);
    expect(response?.sentinel?.kind).toBe("update");
    expect(response?.sentinel?.status).toBe("ok");
  });

  it("falls back to the cached update sentinel when refresh fails", async () => {
    refreshLatestUpdateRestartSentinelMock.mockRejectedValueOnce(new Error("read failed"));
    getLatestUpdateRestartSentinelMock.mockReturnValueOnce({
      kind: "update",
      status: "skipped",
      ts: 1,
      stats: {
        reason: "restart-health-pending",
      },
    });
    const warn = vi.fn();
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();

    await expectDefined(
      updateHandlers["update.status"],
      'updateHandlers["update.status"] test invariant',
    )({
      params: {},
      respond,
      context: { logGateway: { warn } },
    } as never);

    expect(warn).toHaveBeenCalledWith("update.status sentinel refresh failed: read failed");
    const [, response] = firstMockCall(respond, "update status response") as [
      boolean,
      { sentinel?: { kind?: string; status?: string } } | undefined,
    ];
    expect(response?.sentinel?.kind).toBe("update");
    expect(response?.sentinel?.status).toBe("skipped");
  });
});
