// QA Lab Matrix tests cover scenario environment readiness boundaries.
import { describe, expect, it, vi } from "vitest";

const buildMatrixQaConfig = vi.hoisted(() =>
  vi.fn(() => ({ channels: { matrix: { execApprovals: { enabled: true } } } })),
);

vi.mock("../substrate/config.js", () => ({ buildMatrixQaConfig }));
vi.mock("./scenario-runtime-room.js", () => ({ runMatrixQaCanary: vi.fn() }));

import { createMatrixQaScenarioEnvironment } from "./scenario-environment.js";

describe("matrix scenario environment", () => {
  it("waits for config restart settle before accepting Matrix readiness", async () => {
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
          return configReadCount === 1 ? { config: {} } : { hash: "config-hash" };
        }
        if (method === "config.patch") {
          return { ok: true };
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
                  lastStartAt: 100,
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

    const prepared = await environment.prepareFlow({
      config: {},
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      timeoutMs: 1_000,
      waitForConfigRestartSettle,
    });
    const scenarioContext = prepared.scenarioContext;
    await scenarioContext.gatewayCall?.(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );

    expect(statusReadCount).toBe(1);
    expect(callOrder).toEqual([
      "config.get",
      "config.get",
      "config.patch",
      "config.settle",
      "channels.status",
      "exec.approval.request",
    ]);
    expect(waitForConfigRestartSettle).toHaveBeenCalledWith({
      restartDelayMs: 0,
      timeoutMs: 1_000,
    });
    expect(gateway.call).toHaveBeenLastCalledWith(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );
  });
});
