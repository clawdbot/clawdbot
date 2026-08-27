import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";

const mocks = vi.hoisted(() => ({
  createUpdateConfigSnapshot: vi.fn(async () => undefined),
  runRestartScript: vi.fn(async () => undefined),
  waitForGatewayHealthyRestart: vi.fn(),
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

vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  createUpdateConfigSnapshot: mocks.createUpdateConfigSnapshot,
}));

import { maybeRestartService } from "./update-command-service.js";

describe("maybeRestartService", () => {
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
});
