import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  createUpdateConfigSnapshot: vi.fn(async () => undefined),
  doctorCommand: vi.fn<typeof import("../../commands/doctor.js").doctorCommand>(),
  runDaemonInstall: vi.fn<typeof import("../daemon-cli.js").runDaemonInstall>(),
  runDaemonRestart: vi.fn<typeof import("../daemon-cli.js").runDaemonRestart>(),
  runRestartScript: vi.fn(async () => undefined),
  waitForGatewayHealthyRestart: vi.fn(),
}));

vi.mock("../../commands/doctor.js", () => ({ doctorCommand: mocks.doctorCommand }));
vi.mock("../daemon-cli.js", () => ({
  runDaemonInstall: mocks.runDaemonInstall,
  runDaemonRestart: mocks.runDaemonRestart,
}));

vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  assertGatewayServiceMutationAllowed: vi.fn(),
}));

vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.waitForGatewayHealthyRestart,
}));

vi.mock("./restart-helper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart-helper.js")>()),
  runRestartScript: mocks.runRestartScript,
}));

vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: mocks.createUpdateConfigSnapshot,
}));

import { maybeRestartService } from "./update-command-service.js";

describe("maybeRestartService", () => {
  afterEach(() => {
    expect(mocks.doctorCommand).not.toHaveBeenCalled();
    expect(mocks.runDaemonInstall).not.toHaveBeenCalled();
    expect(mocks.runDaemonRestart).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("forwards the built Git identity into restart verification", async () => {
    const result = {
      status: "ok",
      mode: "git",
      root: "/tmp/openclaw-configured-ui-update",
      after: { buildId: "new-build" },
      steps: [],
      durationMs: 0,
    } satisfies UpdateRunResult;

    await expect(
      maybeRestartService({
        shouldRestart: true,
        result,
        channel: "dev",
        opts: { json: true },
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/home/operator" },
        serviceInstallEnv: {},
        gatewayPort: 18789,
        restartScriptPath: "/tmp/openclaw-configured-ui-restart.sh",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(true);

    expect(mocks.runRestartScript).toHaveBeenCalledWith("/tmp/openclaw-configured-ui-restart.sh");
    expect(mocks.waitForGatewayHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({ expectedBuildId: "new-build" }),
    );
  });

  it("rejects a Git restart when the expected build is never observed", async () => {
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
          after: { buildId: "new-build" },
          steps: [],
          durationMs: 0,
        },
        channel: "dev",
        opts: { json: true },
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/home/operator" },
        serviceInstallEnv: {},
        gatewayPort: 18789,
        restartScriptPath: "/tmp/openclaw-configured-ui-restart.sh",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(false);
  });

  it.each(["stable", "beta"] as const)(
    "does not enforce Git build identity for the %s channel",
    async (channel) => {
      const result = {
        status: "ok",
        mode: "git",
        root: "/tmp/openclaw-channel-update",
        after: { buildId: "new-build" },
        steps: [],
        durationMs: 0,
      } satisfies UpdateRunResult;

      await expect(
        maybeRestartService({
          shouldRestart: true,
          result,
          channel,
          opts: { json: true },
          refreshServiceEnv: false,
          serviceEnv: { HOME: "/home/operator" },
          serviceInstallEnv: {},
          gatewayPort: 18789,
          restartScriptPath: "/tmp/openclaw-channel-restart.sh",
          timeoutMs: 1_000,
        }),
      ).resolves.toBe(true);

      expect(mocks.waitForGatewayHealthyRestart).toHaveBeenCalledWith(
        expect.not.objectContaining({ expectedBuildId: expect.anything() }),
      );
    },
  );

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
        channel: "stable",
        opts: { json: true },
        refreshServiceEnv: false,
        gatewayPort: 18789,
        serviceMutationSkipMessage: "service management skipped: ownership conflict",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(true);

    expect(errorSpy).toHaveBeenCalledWith("service management skipped: ownership conflict");
  });
});
