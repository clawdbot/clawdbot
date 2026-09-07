import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  createUpdateConfigSnapshot: vi.fn(async () => undefined),
  runRestartScript: vi.fn(async () => true),
  runUpdatedInstallGatewayCommand: vi.fn<
    typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
  >(async (_params, action) => (action === "restart" ? "accepted" : "unverified")),
  waitForGatewayHealthyRestart: vi.fn(),
  waitForGatewayHttpReadiness: vi.fn(),
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.runUpdatedInstallGatewayCommand,
}));
vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  recordUpdateRunPhase: vi.fn(),
  recordUpdateRunStep: vi.fn(),
  recordUpdateRunVerification: vi.fn(),
}));
vi.mock("../daemon-cli/restart-health-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health-probe.js")>()),
  resolveGatewayRestartProbeContext: async () => ({ config: {}, auth: undefined }),
}));

vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  assertGatewayServiceMutationAllowed: vi.fn(),
}));

vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness: mocks.waitForGatewayHttpReadiness,
}));

vi.mock("./restart-helper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart-helper.js")>()),
  runRestartScript: mocks.runRestartScript,
}));

vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: mocks.createUpdateConfigSnapshot,
}));

import { maybeRestartService } from "./update-command-service.js";

const run = { runId: "00000000-0000-4000-8000-000000000001", env: {} };
describe("maybeRestartService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitForGatewayHttpReadiness.mockResolvedValue({ healthz: 200, readyz: 200 });
    mocks.waitForGatewayHealthyRestart.mockResolvedValue({
      runtime: { status: "running", pid: 8000 },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
      healthy: true,
      staleGatewayPids: [],
      gatewayBuildId: "new-build",
    });
  });

  it.each(["new-build", undefined])(
    "enforces the available Git identity after restart: %s",
    async (buildId) => {
      const result = {
        status: "ok",
        mode: "git",
        root: "/tmp/openclaw-configured-ui-update",
        after: { version: "2026.9.1", buildId },
        steps: [],
        durationMs: 0,
      } satisfies UpdateRunResult;

      await expect(
        maybeRestartService({
          shouldRestart: true,
          result,
          opts: { json: true, run },
          refreshServiceEnv: false,
          serviceEnv: { HOME: "/home/operator" },
          serviceInstallEnv: {},
          gatewayPort: 18789,
          restartScriptPath: "/tmp/openclaw-configured-ui-restart.sh",
          timeoutMs: 1_000,
        }),
      ).resolves.toBe("ok");

      expect(mocks.runRestartScript).toHaveBeenCalledWith(
        "/tmp/openclaw-configured-ui-restart.sh",
        1_000,
      );
      expect(mocks.waitForGatewayHealthyRestart.mock.lastCall?.[0].expectedBuildId).toBe(buildId);
    },
  );

  it("does not infer activation from a detached script when the expected Git build is never observed", async () => {
    mocks.runRestartScript.mockResolvedValueOnce(false);
    mocks.waitForGatewayHealthyRestart.mockResolvedValue({
      runtime: { status: "stopped" },
      portUsage: {
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      },
      healthy: false,
      staleGatewayPids: [],
      expectedBuildId: "new-build",
      waitOutcome: "timeout",
    });

    await expect(
      maybeRestartService({
        shouldRestart: true,
        result: {
          status: "ok",
          mode: "git",
          root: "/tmp/openclaw-configured-ui-update",
          after: { version: "2026.9.1", buildId: "new-build" },
          steps: [],
          durationMs: 0,
        },
        opts: { json: true, run },
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/home/operator" },
        serviceInstallEnv: {},
        gatewayPort: 18789,
        restartScriptPath: "/tmp/openclaw-configured-ui-restart.sh",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("failed");
  });

  it.each(
    [false, true].flatMap((refreshServiceEnv) => [
      { refreshServiceEnv, readyz: 503, verified: false },
      { refreshServiceEnv, readyz: 200, verified: true },
    ]),
  )(
    "requires HTTP readiness (readyz=$readyz, refresh=$refreshServiceEnv)",
    async ({ refreshServiceEnv, readyz, verified }) => {
      mocks.waitForGatewayHttpReadiness.mockResolvedValue({ healthz: 200, readyz });
      const onVerified = vi.fn();
      const onVerificationFailure = vi.fn();
      const startedAtMs = Date.now();
      const actual = await maybeRestartService({
        shouldRestart: true,
        result: {
          status: "ok",
          mode: "git",
          after: { version: "2026.9.1", buildId: "new-build" },
          steps: [],
          durationMs: 0,
        },
        opts: { json: true, run },
        refreshServiceEnv,
        serviceEnv: { HOME: "/home/operator" },
        gatewayPort: 18789,
        restartScriptPath: "/tmp/openclaw-verification.sh",
        timeoutMs: 1_000,
        onVerified,
        onVerificationFailure,
      });
      expect(actual).toBe(verified ? "ok" : "restart-health-failed");
      expect(mocks.waitForGatewayHealthyRestart).toHaveBeenCalledTimes(1);
      expect(mocks.runRestartScript).toHaveBeenCalledTimes(refreshServiceEnv ? 0 : 1);
      expect(mocks.runUpdatedInstallGatewayCommand).toHaveBeenCalledTimes(
        refreshServiceEnv ? 1 : 0,
      );
      expect(onVerified).toHaveBeenCalledTimes(verified ? 1 : 0);
      if (verified) {
        const verifiedAtMs = onVerified.mock.calls[0]?.[0];
        expect(verifiedAtMs).toBeGreaterThanOrEqual(startedAtMs);
        expect(verifiedAtMs).toBeLessThanOrEqual(Date.now());
        expect(onVerificationFailure).not.toHaveBeenCalled();
      } else {
        expect(onVerificationFailure).toHaveBeenCalledWith("readyz-unhealthy");
      }
    },
  );

  it("rejects channel failures even when a Git target has no build identity", async () => {
    mocks.waitForGatewayHealthyRestart.mockResolvedValue({
      runtime: { status: "running", pid: 8000 },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
      healthy: false,
      staleGatewayPids: [],
      channelProbeErrors: [{ id: "fixture", error: "channel startup failed" }],
      waitOutcome: "timeout",
    });
    const onVerificationFailure = vi.fn();
    await expect(
      maybeRestartService({
        shouldRestart: true,
        result: { status: "ok", mode: "git", steps: [], durationMs: 0 },
        opts: { json: true, run },
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/home/operator" },
        gatewayPort: 18789,
        restartScriptPath: "/tmp/openclaw-verification.sh",
        timeoutMs: 1_000,
        onVerificationFailure,
      }),
    ).resolves.toBe("restart-health-failed");
    expect(onVerificationFailure).toHaveBeenCalledWith("channel-errors");
  });

  it("reports service ownership skips to JSON callers", async () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);

    await expect(
      maybeRestartService({
        shouldRestart: false,
        result: {
          status: "ok",
          mode: "npm",
          steps: [],
          durationMs: 0,
        },
        opts: { json: true, run },
        refreshServiceEnv: false,
        gatewayPort: 18789,
        serviceMutationSkipMessage: "service management skipped: ownership conflict",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("ok");

    expect(errorSpy).toHaveBeenCalledWith("service management skipped: ownership conflict");
  });
});
