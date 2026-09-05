// Update method tests cover update.run/status, restart sentinel metadata,
// managed-service handoff, restart scheduling, and delivery context preservation.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { summarizeUpdateRunResponse } from "../update-run-summary.js";
import {
  sentinelState,
  runGatewayUpdateMock,
  runGatewayUpdatePreflightMock,
  resolveUpdateInstallSurfaceMock,
  initializeGatewayUpdateStatusMock,
  recordLatestUpdateRestartSentinelMock,
  isRestartEnabledMock,
  detectRespawnSupervisorMock,
  normalizeUpdateChannelMock,
  getUpdateAvailableMock,
  adoptUpdateCampaignMock,
  readConfigFileSnapshotMock,
  startManagedServiceUpdateHandoffMock,
  sendGatewayLifecycleNoticeMock,
  resolveGatewayLifecycleNoticeRouteMock,
  scheduleGatewaySigusr1RestartMock,
  runPostCoreFinalizeAfterGatewayUpdateMock,
  type UpdateRunPayload,
} from "./update.test-harness.js";

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
  if (
    payload?.result?.status &&
    payload.result.status !== "ok" &&
    payload.handoff?.status !== "started"
  ) {
    expect(getUpdateRun(payload.runId)).toMatchObject({
      status: payload.result.status === "skipped" ? "skipped" : "failed",
      phase: "finished",
      reason: payload.result.reason,
    });
  }
  return payload;
}

function readCapturedPayload(): RestartSentinelPayload {
  if (!sentinelState.capturedPayload) {
    throw new Error("expected restart sentinel payload");
  }
  return sentinelState.capturedPayload;
}

function mockGlobalInstallSurface() {
  initializeGatewayUpdateStatusMock.mockResolvedValueOnce({
    root: "/tmp/openclaw-global",
    status: { root: "/tmp/openclaw-global", installKind: "package", packageManager: "npm" },
    installReceipt: null,
  });
  resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
    kind: "global",
    mode: "npm",
    root: "/tmp/openclaw-global",
    packageRoot: "/tmp/openclaw-global",
  });
}

function mockGitInstallSurface(root: string) {
  initializeGatewayUpdateStatusMock.mockResolvedValueOnce({
    root,
    status: { root, installKind: "git", packageManager: "pnpm" },
    installReceipt: null,
  });
}

describe("update.run acknowledgement", () => {
  const sessionKey = "agent:main:slack:dm:C0123ABC:thread:1234567890.123456";

  it.each([false, true])(
    "awaits the chat acknowledgement before updating (managed=%s)",
    async (managed) => {
      if (managed) {
        mockGlobalInstallSurface();
        detectRespawnSupervisorMock.mockReturnValue("launchd");
        getUpdateAvailableMock.mockReturnValue({
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          channel: "stable",
        });
      }
      const acknowledgement = createDeferredCore<boolean>();
      const acknowledgementStarted = createDeferredCore();
      sendGatewayLifecycleNoticeMock.mockImplementationOnce(() => {
        acknowledgementStarted.resolve();
        return acknowledgement.promise;
      });
      const running = captureUpdateRunPayload({ sessionKey });
      try {
        await Promise.race([acknowledgementStarted.promise, running]);
        expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledOnce();
        expect(runGatewayUpdateMock).not.toHaveBeenCalled();
        expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      } finally {
        acknowledgement.resolve(true);
        await running;
      }
      const response = await running;
      expect(response?.ackDelivered).toBe(true);
      expect(response?.runId).toEqual(expect.any(String));
      const run = getUpdateRun(response!.runId);
      expect(run).toMatchObject({
        runId: response?.runId,
        status: "running",
        origin: { sessionKey },
      });
      expect(listUpdateRuns()).toHaveLength(1);
      expect(readCapturedPayload().stats?.runId).toBe(response?.runId);
      if (managed) {
        expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: response?.runId,
            meta: expect.objectContaining({ runId: response?.runId }),
          }),
        );
        expect(run?.steps).toContainEqual(
          expect.objectContaining({ step: "managed-service update handoff", status: "completed" }),
        );
      } else {
        expect(runGatewayUpdateMock).toHaveBeenCalledWith(
          expect.objectContaining({ runId: response?.runId }),
        );
        expect(
          run?.steps
            .filter((step) =>
              ["requested", "staging", "validating", "restarting"].includes(step.step),
            )
            .map((step) => step.step),
        ).toEqual(["requested", "staging", "validating", "restarting"]);
      }
      expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey,
          channel: "slack",
          to: "slack:C0123ABC",
          threadId: "1234567890.123456",
          message: `⬆️ Updating OpenClaw 1.0.0 → ${managed ? "2.0.0" : "the latest release"}. You'll get a message here before the gateway restarts and when verification finishes.`,
          deliveryIntentId: expect.stringMatching(/^update-run-ack:/),
        }),
      );
    },
  );

  it("merges explicit route fields and reports a synchronous failure after acknowledgement", async () => {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "error",
      mode: "git",
      reason: "build-failed",
      steps: [],
      durationMs: 1,
    });
    const response = await captureUpdateRunPayload({
      sessionKey,
      deliveryContext: { to: "slack:C0456DEF" },
    });
    expect(response?.ackDelivered).toBe(true);
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(resolveGatewayLifecycleNoticeRouteMock).toHaveBeenCalledOnce();
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledTimes(2);
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: "slack:C0456DEF",
        message: expect.stringContaining("⚠️ OpenClaw update failed: build-failed."),
      }),
    );
  });

  it("records activation and awaits its notice before parking the managed gateway", async () => {
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    getUpdateAvailableMock.mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const response = await captureUpdateRunPayload({ sessionKey });
    const beforePark = startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].beforePark;
    if (!response || !beforePark) {
      throw new Error("expected admitted managed handoff");
    }
    expect(getUpdateRun(response.runId)?.phase).toBe("requested");
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledOnce();
    const delivered = createDeferredCore<boolean>();
    const started = createDeferredCore();
    sendGatewayLifecycleNoticeMock.mockImplementationOnce(() => {
      started.resolve();
      return delivered.promise;
    });
    let parked = false;
    const park = beforePark().then(() => {
      parked = true;
    });
    try {
      await Promise.race([started.promise, park]);
      expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledTimes(2);
      expect(getUpdateRun(response.runId)?.phase).toBe("activating");
      expect(parked).toBe(false);
    } finally {
      delivered.resolve(true);
    }
    await park;
    await beforePark();
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledTimes(2);
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "⏳ Restarting the gateway now (v1.0.0 → v2.0.0)…",
      }),
    );
  });

  it("continues the update when the bounded acknowledgement fails", async () => {
    sendGatewayLifecycleNoticeMock.mockResolvedValueOnce(false);
    const response = await captureUpdateRunPayload({ sessionKey });
    expect(response?.ackDelivered).toBe(false);
    expect(runGatewayUpdateMock).toHaveBeenCalledOnce();
  });

  it("records an internal API origin from only its persisted session key", async () => {
    const internalSessionKey = "agent:main:webchat:lane";
    await upsertSessionEntryCore(
      {
        agentId: "main",
        sessionKey: internalSessionKey,
        storePath: resolveDefaultSessionStorePath("main"),
      },
      { sessionId: "internal-api-update", updatedAt: 1, delivery: { kind: "internal" } },
    );
    const { extractDeliveryInfo } = await import("../../config/sessions/delivery-info.js");
    const sessions = await import("../../config/sessions.js");
    vi.mocked(sessions.extractDeliveryInfo).mockImplementationOnce(extractDeliveryInfo);
    const response = await captureUpdateRunPayload({ sessionKey: internalSessionKey });
    expect(response).toMatchObject({ ok: true, ackDelivered: true });
    const run = getUpdateRun(response!.runId);
    expect(run).toMatchObject({ trigger: "api", origin: { sessionKey: internalSessionKey } });
    expect(run?.origin.deliveryContext).toEqual({ channel: INTERNAL_MESSAGE_CHANNEL });
  });

  it("does not acknowledge a preflight refusal or a missing route", async () => {
    isRestartEnabledMock.mockReturnValue(false);
    expect((await captureUpdateRunPayload({ sessionKey }))?.ackDelivered).toBe(false);
    isRestartEnabledMock.mockReturnValue(true);
    expect((await captureUpdateRunPayload({}))?.ackDelivered).toBe(false);
    expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
  });
});

describe("update.run sentinel deliveryContext", () => {
  it.each([
    { sessionKey: undefined, deliveryContext: undefined, threadId: undefined },
    {
      sessionKey: "agent:main:webchat:dm:user-123",
      deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
      threadId: undefined,
    },
    {
      sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456",
      deliveryContext: { channel: "slack", to: "slack:C0123ABC", accountId: "workspace-1" },
      threadId: "1234567890.123456",
    },
  ])(
    "preserves the sentinel route for $sessionKey",
    async ({ sessionKey, deliveryContext, threadId }) => {
      expect((await captureUpdateRunPayload({ sessionKey }))?.ok).toBe(true);
      expect(adoptUpdateCampaignMock).toHaveBeenCalledOnce();
      const payload = readCapturedPayload();
      expect(payload.deliveryContext).toEqual(deliveryContext);
      expect(payload.threadId).toBe(threadId);
      expect(payload.continuation).toBeUndefined();
    },
  );

  it("uses an explicit continuationMessage in successful update sentinels", async () => {
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
    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1000,
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      }),
    );
  });
});

describe("update.run restart scheduling", () => {
  it("schedules restart when update succeeds", async () => {
    const payload = await captureUpdateRunPayload();

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(payload?.ok).toBe(true);
    expect(payload?.restart).toEqual({ scheduled: true });
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

    const payload = await captureUpdateRunPayload({
      sessionKey: "agent:main:webchat:dm:user-123",
      continuationMessage: "This should not run after a failed update.",
    });

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.restart).toBeNull();
    expect(readCapturedPayload().continuation).toBeUndefined();
    expect(payload?.result?.status).toBe(status);
    expect(payload?.result?.reason).toBe(reason);
  });

  it("hands managed package updates to the CLI path instead of running them in-process", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload({}, {}),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw-global",
        restartDrainTimeoutMs: 300_000,
        restartDelayMs: 2000,
        handoffId: expect.any(String),
        supervisor: "launchd",
        meta: expect.objectContaining({
          handoffId: expect.any(String),
          root: "/tmp/openclaw-global",
        }),
      }),
    );
    const handoffId = startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].handoffId;
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ handoffId }),
      }),
    );
    expect(runPostCoreFinalizeAfterGatewayUpdateMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "update.run",
        successorOwner: {
          kind: "managed-update-handoff",
          handoffId,
          installRoot: "/tmp/openclaw-global",
        },
        skipCooldown: true,
        skipDeferral: true,
      }),
    );
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.handoff).toEqual({
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
        handoffId,
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

  it("rejects a joining request instead of dropping its restart continuation", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    startManagedServiceUpdateHandoffMock.mockResolvedValueOnce({
      status: "joined",
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
      logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
      handoffId: "handoff-existing",
    });

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload({
        sessionKey: "agent:main:webchat:dm:user-123",
        continuationMessage: "Report the update result after restart.",
      }),
    );

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
    expect(sentinelState.capturedPayload).toBeUndefined();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          sessionKey: "agent:main:webchat:dm:user-123",
          continuationMessage: "Report the update result after restart.",
        }),
      }),
    );
    expect(payload?.ok).toBe(false);
    expect(payload?.result).toMatchObject({
      status: "skipped",
      reason: "managed-service-handoff-already-running",
    });
    expect(payload?.handoff).toEqual({
      status: "already-running",
      command: "openclaw update --yes --timeout 1800",
      message: "Another managed update is already running; retry after it completes.",
    });
    expect(payload?.sentinel?.persisted).toBe(false);
  });

  it.each([false, true])(
    "keeps restart ownership and records failed notice persistence (managed=%s)",
    async (managed) => {
      if (managed) {
        detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
        mockGlobalInstallSurface();
      }
      sentinelState.restartSentinelWriteError = new Error("state database unavailable");
      const payload = await captureUpdateRunPayload();

      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(managed ? 1 : 0);
      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledOnce();
      expect(payload?.sentinel?.persisted).toBe(false);
      expect(payload?.ok).toBe(true);
      const run = getUpdateRun(payload!.runId);
      if (managed) {
        expect(run?.status).toBe("running");
      } else {
        expect(run).toMatchObject({ status: "failed", reason: "unexpected-error" });
        expect(payload?.message).toBe(run?.origin.nextAction);
        expect(summarizeUpdateRunResponse(payload).next).toContain(
          "Run openclaw update status after the gateway restarts.",
        );
      }
    },
  );

  it("does not restart or report success when the handoff helper cannot spawn", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
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

    await withEnvAsync({ OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" }, () =>
      invokeUpdateRun({ restartDelayMs: 0 }),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supervisor: "systemd",
        restartDrainTimeoutMs: 300_000,
        restartDelayMs: 2000,
      }),
    );
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 2000,
        reason: "update.run",
        successorOwner: {
          kind: "managed-update-handoff",
          handoffId: expect.any(String),
          installRoot: "/tmp/openclaw-global",
        },
        skipCooldown: true,
        skipDeferral: true,
      }),
    );
  });

  it.each(["launchd", "systemd"] as const)(
    "normalizes overflow-sized %s handoff and restart delays together",
    async (supervisor) => {
      detectRespawnSupervisorMock.mockReturnValueOnce(supervisor);
      mockGlobalInstallSurface();

      await invokeUpdateRun({ restartDelayMs: 2_147_153_648 });

      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
        expect.objectContaining({ supervisor, restartDelayMs: 60_000 }),
      );
      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith(
        expect.objectContaining({ delayMs: 60_000 }),
      );
    },
  );

  it("starts managed package handoff when the gateway cwd is unavailable", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
    });
    try {
      await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
        invokeUpdateRun({}),
      );
    } finally {
      cwdSpy.mockRestore();
    }

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw-global",
      }),
    );
  });

  it("preflights supervised git/dev updates before handing them to the CLI path", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");
    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(runGatewayUpdatePreflightMock).toHaveBeenCalledWith(
      "/tmp/openclaw-git",
      undefined,
      undefined,
    );
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw-git",
        handoffId: expect.any(String),
        supervisor: "launchd",
        meta: expect.objectContaining({
          handoffId: expect.any(String),
          root: "/tmp/openclaw-git",
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

  it("keeps the serving gateway when managed git target preflight rejects active config", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");
    runGatewayUpdatePreflightMock.mockResolvedValueOnce({
      status: "error",
      mode: "git",
      root: "/tmp/openclaw-git",
      reason: "preflight-no-good-commit",
      steps: [
        {
          name: "preflight config validate (target)",
          command: "openclaw config validate --json",
          cwd: "/tmp/openclaw-candidate",
          durationMs: 1,
          exitCode: 1,
          stderrTail: "target rejected the active config",
        },
      ],
      durationMs: 1,
    });

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.result).toMatchObject({
      status: "error",
      reason: "preflight-no-good-commit",
    });
  });

  it("hands Windows fallback gateways to the CLI path before doctor activation", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("schtasks");
    mockGitInstallSurface("C:\\openclaw");

    const payload = await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      () => captureUpdateRunPayload(),
    );

    expect(runGatewayUpdatePreflightMock).toHaveBeenCalledTimes(1);
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

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0]).not.toHaveProperty("channel");
    expect(payload?.handoff?.command).not.toContain("--channel");
  });

  it("rejects stored extended-stable on Git without starting a handoff or mutation", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("extended-stable");
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
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

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
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

    const payload = await withEnvAsync(
      {
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "8a77e69a8f604bf0b7984879b9f17a7c",
      },
      () => captureUpdateRunPayload(),
    );

    expect(runGatewayUpdatePreflightMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw-git",
        supervisor: "systemd",
      }),
    );
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff?.status).toBe("started");
  });

  it("hands marker-only systemd git/dev updates to the helper for exact ownership verification", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("systemd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withEnvAsync(
      {
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      () => captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/tmp/openclaw-git", supervisor: "systemd" }),
    );
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledOnce();
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff?.status).toBe("started");
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
        "Stop the foreground Gateway, run `openclaw update --yes --timeout 1800` from a shell, then launch the Gateway again. For a managed deployment, use its host's stop, update, and restart workflow.",
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

  it("keeps external update supervision authoritative even with native systemd markers", async () => {
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValue("systemd");

    const payload = await withEnvAsync(
      {
        OPENCLAW_SUPERVISOR_MODE: "external",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
      },
      () => captureUpdateRunPayload(),
    );

    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.restart).toBeNull();
    expect(payload?.result).toMatchObject({
      status: "skipped",
      mode: "npm",
      reason: "external-supervisor-update-required",
    });
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
    expect(runPostCoreFinalizeAfterGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ mode: "git", status: "ok" }),
        serviceRepairPolicy: "external",
      }),
    );
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

    expect(runPostCoreFinalizeAfterGatewayUpdateMock.mock.calls[0]?.[0].preUpdateConfig).toEqual({
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
});
