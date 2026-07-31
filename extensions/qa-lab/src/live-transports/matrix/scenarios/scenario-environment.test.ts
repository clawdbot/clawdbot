// QA Lab Matrix tests cover scenario environment readiness boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";

const buildMatrixQaConfig = vi.hoisted(() =>
  vi.fn(() => ({ channels: { matrix: { execApprovals: { enabled: true } } } })),
);
const runMatrixQaCanary = vi.hoisted(() =>
  vi.fn(async () => ({
    driverEventId: "$canary-driver",
    reply: { eventId: "$canary-reply" },
    token: "MATRIX_QA_CANARY",
  })),
);

vi.mock("../substrate/config.js", () => ({ buildMatrixQaConfig }));
vi.mock("./scenario-runtime-room.js", () => ({ runMatrixQaCanary }));

import { createMatrixQaScenarioEnvironment } from "./scenario-environment.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("matrix scenario environment", () => {
  it("drops actor sync cursors and observers at a scenario boundary", async () => {
    let configReadCount = 0;
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(async (method: string) => {
        if (method === "config.get") {
          configReadCount += 1;
          const phase = (configReadCount - 1) % 3;
          if (phase === 0) {
            return { config: {} };
          }
          if (phase === 1) {
            return { hash: "config-hash" };
          }
          return {
            appliedConfigHash: "config-hash",
            configRevisionHash: "config-hash",
            hash: "config-hash",
          };
        }
        if (method === "config.patch") {
          return { hash: "config-hash", noop: true, ok: true };
        }
        if (method === "channels.status") {
          return {
            channelAccounts: {
              matrix: [
                {
                  accountId: "sut",
                  connected: true,
                  healthState: "healthy",
                  lastStartAt: 100,
                  restartPending: false,
                  running: true,
                },
              ],
            },
          };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };
    const environment = createMatrixQaScenarioEnvironment({
      accountId: "sut",
      harness: { baseUrl: "http://127.0.0.1:8008", recording: {} } as never,
      observedEvents: [],
      provisioning: {
        driver: { accessToken: "fixture", userId: "@driver:test" },
        observer: { accessToken: "fixture", userId: "@observer:test" },
        roomId: "!room:test",
        sut: { accessToken: "fixture", userId: "@sut:test" },
        topology: { rooms: [] },
      } as never,
    });
    const input = {
      config: { matrixRequireCanary: true },
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      scenarioId: "matrix-observer-reset",
      scenarioTitle: "Matrix observer reset",
      timeoutMs: 8_000,
      waitForConfigRestartSettle: vi.fn(),
    };
    const first = await environment.prepareFlow(input);
    const syncState: MatrixQaScenarioContext["syncState"] = first.scenarioContext.syncState;
    syncState.driver = "s1";
    syncState.observer = "s2";
    first.scenarioContext.syncStreams!.driver = { prime: vi.fn() } as never;
    first.scenarioContext.syncStreams!.observer = { prime: vi.fn() } as never;

    const second = await environment.prepareFlow(input);

    expect(second.scenarioContext.syncState).toEqual({});
    expect(second.scenarioContext.syncStreams).toEqual({});
    expect(runMatrixQaCanary).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
  });

  it("waits for the changed Matrix account to restart before accepting readiness", async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];
    let configReadCount = 0;
    let statusReadCount = 0;
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(async (method: string) => {
        callOrder.push(method);
        if (method === "config.get") {
          configReadCount += 1;
          if (configReadCount === 1) {
            return { config: {} };
          }
          if (configReadCount === 2) {
            return { hash: "config-hash" };
          }
          return {
            appliedConfigHash: configReadCount === 3 ? "old-revision" : "new-revision",
            configRevisionHash: "new-revision",
            hash: "patched-config-hash",
          };
        }
        if (method === "config.patch") {
          return {
            hash: "patched-config-hash",
            ok: true,
          };
        }
        if (method === "channels.status") {
          statusReadCount += 1;
          return {
            channelAccounts: {
              matrix: [
                {
                  accountId: "sut",
                  connected: true,
                  healthState: "healthy",
                  lastStartAt: statusReadCount < 3 ? 100 : 200,
                  restartPending: false,
                  running: true,
                },
              ],
            },
          };
        }
        if (method === "exec.approval.request") {
          return { id: "approval-1", status: "accepted" };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };
    const environment = createMatrixQaScenarioEnvironment({
      accountId: "sut",
      harness: { baseUrl: "http://127.0.0.1:8008", recording: {} } as never,
      observedEvents: [],
      provisioning: {
        driver: { accessToken: "fixture", userId: "@driver:test" },
        observer: { accessToken: "fixture", userId: "@observer:test" },
        roomId: "!room:test",
        sut: { accessToken: "fixture", userId: "@sut:test" },
        topology: { rooms: [] },
      } as never,
    });
    const waitForConfigRestartSettle = vi.fn(async () => {
      callOrder.push("config.settle");
    });

    const preparing = environment.prepareFlow({
      config: {},
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      scenarioId: "matrix-approval",
      scenarioTitle: "Matrix approval",
      timeoutMs: 1_000,
      waitForConfigRestartSettle,
    });
    await vi.runAllTimersAsync();
    const prepared = await preparing;
    const scenarioContext = prepared.scenarioContext;
    await scenarioContext.gatewayCall?.(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );

    expect(statusReadCount).toBe(3);
    expect(callOrder).toEqual([
      "config.get",
      "channels.status",
      "config.get",
      "config.patch",
      "config.settle",
      "config.get",
      "config.get",
      "channels.status",
      "channels.status",
      "exec.approval.request",
    ]);
    expect(waitForConfigRestartSettle).toHaveBeenCalledWith({
      restartDelayMs: 0,
      timeoutMs: 1_000,
    });
    expect(gateway.call).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        replacePaths: [
          "channels.matrix",
          "channels.matrix.accounts.sut.groupAllowFrom",
          "messages",
        ],
      }),
      { timeoutMs: 60_000 },
    );
    expect(gateway.call).toHaveBeenLastCalledWith(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );
  });

  it("waits for a pending config revision after a no-op patch", async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];
    let configReadCount = 0;
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(async (method: string) => {
        callOrder.push(method);
        if (method === "config.get") {
          configReadCount += 1;
          if (configReadCount === 1) {
            return { config: {} };
          }
          if (configReadCount === 2) {
            return { hash: "config-hash" };
          }
          return {
            appliedConfigHash: configReadCount === 3 ? "old-revision" : "new-revision",
            configRevisionHash: "new-revision",
            hash: "config-hash",
          };
        }
        if (method === "config.patch") {
          return {
            noop: true,
            ok: true,
          };
        }
        if (method === "channels.status") {
          return {
            channelAccounts: {
              matrix: [
                {
                  accountId: "sut",
                  connected: true,
                  healthState: "healthy",
                  lastStartAt: 100,
                  restartPending: false,
                  running: true,
                },
              ],
            },
          };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };
    const environment = createMatrixQaScenarioEnvironment({
      accountId: "sut",
      harness: { baseUrl: "http://127.0.0.1:8008", recording: {} } as never,
      observedEvents: [],
      provisioning: {
        driver: { accessToken: "fixture", userId: "@driver:test" },
        observer: { accessToken: "fixture", userId: "@observer:test" },
        roomId: "!room:test",
        sut: { accessToken: "fixture", userId: "@sut:test" },
        topology: { rooms: [] },
      } as never,
    });
    const waitForConfigRestartSettle = vi.fn(async () => {
      callOrder.push("config.settle");
    });

    const preparing = environment.prepareFlow({
      config: {},
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      scenarioId: "matrix-restart",
      scenarioTitle: "Matrix restart",
      timeoutMs: 1_000,
      waitForConfigRestartSettle,
    });
    await vi.runAllTimersAsync();
    await preparing;

    expect(callOrder).toEqual([
      "config.get",
      "channels.status",
      "config.get",
      "config.patch",
      "config.get",
      "config.get",
      "channels.status",
    ]);
    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
  });
});
