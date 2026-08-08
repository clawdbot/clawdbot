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
    expect(second.scenarioContext.timeoutMs).toBe(8_000);
    expect(input.waitForConfigRestartSettle).not.toHaveBeenCalled();
    expect(runMatrixQaCanary).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
  });

  it("shares the preparation deadline across revision and fresh account readiness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const callOrder: string[] = [];
    let configReadCount = 0;
    let statusReadCount = 0;
    const revisionTimeouts: number[] = [];
    const statusTimeouts: number[] = [];
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(
        async (
          method: string,
          _params?: unknown,
          opts?: { deadlineMs?: number; timeoutMs?: number },
        ) => {
          callOrder.push(method);
          if (method === "config.get") {
            configReadCount += 1;
            if (configReadCount === 1) {
              return { config: {} };
            }
            if (configReadCount === 2) {
              return { hash: "config-hash" };
            }
            revisionTimeouts.push(opts?.timeoutMs ?? -1);
            if (configReadCount === 3) {
              vi.setSystemTime(56_000);
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
            statusTimeouts.push(opts?.timeoutMs ?? -1);
            if (statusReadCount === 2) {
              vi.setSystemTime(56_500);
            }
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
        },
      ),
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
      timeoutMs: 8_000,
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
      "config.get",
      "config.get",
      "channels.status",
      "channels.status",
      "exec.approval.request",
    ]);
    expect(revisionTimeouts).toEqual([5_000, 4_000]);
    expect(statusTimeouts).toEqual([5_000, 4_000, 3_500]);
    expect(Date.now()).toBe(56_500);
    expect(scenarioContext.timeoutMs).toBe(8_000);
    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
    expect(gateway.call.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
    expect(gateway.call).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        replacePaths: [
          "channels.matrix",
          "channels.matrix.accounts.sut.groupAllowFrom",
          "messages",
        ],
      }),
      { deadlineMs: 60_000, timeoutMs: 60_000 },
    );
    expect(gateway.call).toHaveBeenLastCalledWith(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );
  });

  it("passes one deadline through stale-patch preparation calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let configReadCount = 0;
    let patchCount = 0;
    let statusCount = 0;
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(
        async (
          method: string,
          _params?: unknown,
          _opts?: { deadlineMs?: number; timeoutMs?: number },
        ) => {
          if (method === "config.get") {
            configReadCount += 1;
            if (configReadCount === 1) {
              return { config: {} };
            }
            if (configReadCount <= 3) {
              return { hash: `base-${configReadCount}` };
            }
            return {
              appliedConfigHash: "patched-config-hash",
              configRevisionHash: "patched-config-hash",
              hash: "patched-config-hash",
            };
          }
          if (method === "config.patch") {
            patchCount += 1;
            if (patchCount === 1) {
              throw new Error("config changed since last load");
            }
            return { hash: "patched-config-hash", ok: true };
          }
          if (method === "channels.status") {
            statusCount += 1;
            return {
              channelAccounts: {
                matrix: [
                  {
                    accountId: "sut",
                    connected: true,
                    healthState: "healthy",
                    lastStartAt: statusCount === 1 ? 100 : 200,
                    restartPending: false,
                    running: true,
                  },
                ],
              },
            };
          }
          throw new Error(`unexpected gateway method ${method}`);
        },
      ),
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

    await environment.prepareFlow({
      config: {},
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      scenarioId: "matrix-stale-patch",
      scenarioTitle: "Matrix stale patch",
      timeoutMs: 8_000,
      waitForConfigRestartSettle: vi.fn(),
    });

    expect(patchCount).toBe(2);
    expect(
      gateway.call.mock.calls.map((call) => (call[2] as { deadlineMs?: number }).deadlineMs),
    ).toEqual(Array.from({ length: gateway.call.mock.calls.length }, () => 60_000));
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

  it("fails preparation when fresh account readiness exhausts the shared deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let configReadCount = 0;
    let statusReadCount = 0;
    const statusTimeouts: number[] = [];
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(
        async (
          method: string,
          params?: unknown,
          opts?: { deadlineMs?: number; timeoutMs?: number },
        ) => {
          if (method === "config.get") {
            configReadCount += 1;
            if (configReadCount === 1) {
              return { config: {} };
            }
            if (configReadCount === 2) {
              return { hash: "config-hash" };
            }
            vi.setSystemTime(59_900);
            return {
              appliedConfigHash: "patched-config-hash",
              configRevisionHash: "patched-config-hash",
              hash: "patched-config-hash",
            };
          }
          if (method === "config.patch") {
            return { hash: "patched-config-hash", ok: true };
          }
          if (method === "channels.status") {
            statusReadCount += 1;
            statusTimeouts.push(opts?.timeoutMs ?? -1);
            if (statusReadCount === 2) {
              expect((params as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(100);
              vi.setSystemTime(60_000);
            }
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
        },
      ),
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
    const waitForConfigRestartSettle = vi.fn();
    const preparing = environment.prepareFlow({
      config: {},
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      scenarioId: "matrix-deadline",
      scenarioTitle: "Matrix deadline",
      timeoutMs: 8_000,
      waitForConfigRestartSettle,
    });
    const rejection = expect(preparing).rejects.toThrow(
      'matrix account "sut" did not become ready',
    );

    await vi.runAllTimersAsync();
    await rejection;

    expect(Date.now()).toBe(60_000);
    expect(statusTimeouts).toEqual([5_000, 100]);
    expect(
      gateway.call.mock.calls.map((call) => (call[2] as { deadlineMs?: number }).deadlineMs),
    ).toEqual(Array.from({ length: gateway.call.mock.calls.length }, () => 60_000));
    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
    expect(gateway.call.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
  });
});
