// QA Lab Matrix tests cover scenario environment crash-restart shutdown mode.
import { describe, expect, it, vi } from "vitest";

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

describe("matrix scenario environment hard shutdown", () => {
  it("uses a hard gateway shutdown before queueing the catchup message", async () => {
    let configReadCount = 0;
    const queueMessage = vi.fn(async () => {});
    const restartAfterStateMutation = vi.fn(
      async (
        mutateState: (context: {
          configPath: string;
          runtimeEnv: NodeJS.ProcessEnv;
          stateDir: string;
          tempRoot: string;
        }) => Promise<void>,
      ) => {
        await mutateState({
          configPath: "/tmp/matrix-qa/openclaw.json",
          runtimeEnv: {},
          stateDir: "/tmp/matrix-qa/state",
          tempRoot: "/tmp/matrix-qa",
        });
      },
    );
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      restartAfterStateMutation,
      call: vi.fn(async (method: string) => {
        if (method === "config.get") {
          configReadCount += 1;
          if (configReadCount === 1) {
            return { config: {} };
          }
          if (configReadCount === 2) {
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
    const prepared = await environment.prepareFlow({
      config: {},
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      scenarioId: "matrix-initial-catchup-then-incremental",
      scenarioTitle: "Matrix initial catchup is followed by incremental replies",
      timeoutMs: 1_000,
      waitForConfigRestartSettle: vi.fn(),
    });

    await prepared.scenarioContext.restartGatewayWithQueuedMessage?.(queueMessage);

    expect(restartAfterStateMutation).toHaveBeenCalledWith(expect.any(Function), {
      shutdownMode: "hard",
    });
    expect(queueMessage).toHaveBeenCalledOnce();
  });
});
