// Covers the recovery path a CLI-driven update takes when its own restart is
// refused because the package swap already installed a newer OpenClaw.
import { beforeEach, describe, expect, it, vi } from "vitest";

type FutureConfigBlock = {
  action: string;
  currentVersion: string;
  touchedVersion: string;
  message: string;
  hints: string[];
};

const mocks = vi.hoisted(() => ({
  restart: vi.fn(async () => ({ outcome: "completed" as const })),
  recoveryStart: vi.fn(async (_args?: unknown) => undefined),
  // Explicit return type so mockResolvedValue(block) is not narrowed to null.
  readFutureConfigBlock: vi.fn(async (_action?: string): Promise<FutureConfigBlock | null> => null),
  readState: vi.fn(async () => ({ installed: true })),
  log: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../daemon/future-config-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/future-config-guard.js")>()),
  readFutureConfigActionBlock: mocks.readFutureConfigBlock,
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({ restart: mocks.restart }),
  startGatewayServiceAfterFailedUpdate: mocks.recoveryStart,
  readGatewayServiceState: mocks.readState,
}));

vi.mock("../../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: { ...actual.defaultRuntime, log: mocks.log, error: mocks.error },
  };
});

import { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service.js";

const VERSION_GUARD_ERROR = new Error(
  "Refusing to restart the gateway service because this OpenClaw binary (2026.7.1-2) is older " +
    "than the config last written by OpenClaw 2026.7.2-beta.7.",
);

const NON_GUARD_ERROR = new Error("Something else went wrong.");

const serviceEnv = { OPENCLAW_PROFILE: "default" };

async function recover(jsonMode = false): Promise<void> {
  await maybeRestartServiceAfterFailedMutableUpdate({
    preManagedServiceStop: { stopped: true, serviceEnv } as never,
    jsonMode,
  });
}

function messages(): string {
  return [...mocks.log.mock.calls, ...mocks.error.mock.calls].map(String).join("\n");
}

describe("maybeRestartServiceAfterFailedMutableUpdate", () => {
  beforeEach(() => {
    mocks.restart.mockReset().mockResolvedValue({ outcome: "completed" });
    mocks.recoveryStart.mockReset().mockResolvedValue(undefined);
    mocks.readFutureConfigBlock.mockReset().mockResolvedValue(null);
    mocks.readState.mockReset().mockResolvedValue({ installed: true });
    mocks.log.mockReset();
    mocks.error.mockReset();
  });

  it("starts the installed unit when the version guard refuses the restart", async () => {
    mocks.restart.mockRejectedValue(VERSION_GUARD_ERROR);
    mocks.readFutureConfigBlock.mockResolvedValue({
      action: "restart",
      currentVersion: "0.0.0",
      touchedVersion: "9.9.9",
      message: "block",
      hints: [],
    });

    await recover();

    expect(mocks.recoveryStart).toHaveBeenCalledTimes(1);
    expect(mocks.recoveryStart.mock.calls[0]?.[0]).toMatchObject({ env: serviceEnv });
    expect(messages()).not.toContain("Failed to restart managed gateway service");
  });

  it("leaves a successful restart alone", async () => {
    await recover();

    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(mocks.recoveryStart).not.toHaveBeenCalled();
  });

  it("reports both failures when recovery cannot start the service either", async () => {
    mocks.restart.mockRejectedValue(VERSION_GUARD_ERROR);
    mocks.readFutureConfigBlock.mockResolvedValue({
      action: "restart",
      currentVersion: "0.0.0",
      touchedVersion: "9.9.9",
      message: "block",
      hints: [],
    });
    mocks.recoveryStart.mockRejectedValue(new Error("unit openclaw-gateway.service not found"));

    await recover();

    const reported = messages();
    expect(reported).toContain("Failed to restart managed gateway service after failed update");
    expect(reported).toContain("recovery start also failed");
    expect(reported).toContain("unit openclaw-gateway.service not found");
  });

  it("reports recovery failure through the error channel in json mode", async () => {
    mocks.restart.mockRejectedValue(VERSION_GUARD_ERROR);
    mocks.readFutureConfigBlock.mockResolvedValue({
      action: "restart",
      currentVersion: "0.0.0",
      touchedVersion: "9.9.9",
      message: "block",
      hints: [],
    });
    mocks.recoveryStart.mockRejectedValue(new Error("start refused"));

    await recover(true);

    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(String(mocks.error.mock.calls[0]?.[0])).toContain("recovery start also failed");
  });

  it("does nothing when no managed service was stopped", async () => {
    await maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop: { stopped: false } as never,
      jsonMode: false,
    });

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.recoveryStart).not.toHaveBeenCalled();
  });

  it("does not reach the exempt start when the config is not newer than this binary", async () => {
    mocks.restart.mockRejectedValue(NON_GUARD_ERROR);
    // readFutureConfigActionBlock returns null → config is not future-stamped
    mocks.readFutureConfigBlock.mockResolvedValue(null);

    await recover();

    expect(mocks.readFutureConfigBlock).toHaveBeenCalledTimes(1);
    expect(mocks.readState).not.toHaveBeenCalled();
    expect(mocks.recoveryStart).not.toHaveBeenCalled();
    expect(messages()).toContain("Failed to restart managed gateway service after failed update");
    expect(messages()).toContain("Something else went wrong");
  });

  it("reaches the exempt start when config is future-stamped and unit is installed", async () => {
    mocks.restart.mockRejectedValue(VERSION_GUARD_ERROR);
    mocks.readFutureConfigBlock.mockResolvedValue({
      action: "restart",
      currentVersion: "0.0.0",
      touchedVersion: "9.9.9",
      message: "block",
      hints: [],
    });
    mocks.readState.mockResolvedValue({ installed: true });

    await recover();

    expect(mocks.readFutureConfigBlock).toHaveBeenCalledTimes(1);
    expect(mocks.readState).toHaveBeenCalledTimes(1);
    expect(mocks.recoveryStart).toHaveBeenCalledTimes(1);
  });

  it("does not reach the exempt start when the unit is not installed", async () => {
    mocks.restart.mockRejectedValue(VERSION_GUARD_ERROR);
    mocks.readFutureConfigBlock.mockResolvedValue({
      action: "restart",
      currentVersion: "0.0.0",
      touchedVersion: "9.9.9",
      message: "block",
      hints: [],
    });
    mocks.readState.mockResolvedValue({ installed: false });

    await recover();

    expect(mocks.readFutureConfigBlock).toHaveBeenCalledTimes(1);
    expect(mocks.readState).toHaveBeenCalledTimes(1);
    expect(mocks.recoveryStart).not.toHaveBeenCalled();
    expect(messages()).toContain("recovery start skipped because no managed service is installed");
  });
});
