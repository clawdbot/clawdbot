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
import {
  createMatrixQaScenarioClient,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("matrix scenario observation", () => {
  it("resets passive observers without acknowledging encrypted-device messages", async () => {
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
        driver: { accessToken: "driver-primary", userId: "@driver:test" },
        observer: { accessToken: "observer-primary", userId: "@observer:test" },
        observationAccounts: {
          driver: { accessToken: "driver-room-observation" },
          observer: { accessToken: "observer-room-observation" },
        },
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
    const staleObserver = { prime: vi.fn() } as never;
    first.scenarioContext.syncStreams!.driver = staleObserver;
    first.scenarioContext.syncStreams!.observer = staleObserver;

    const second = await environment.prepareFlow(input);

    expect(second.scenarioContext.syncState).toEqual({});
    expect(second.scenarioContext.syncStreams!.driver).not.toBe(staleObserver);
    expect(second.scenarioContext.syncStreams!.observer).not.toBe(staleObserver);
    expect(second.scenarioContext.timeoutMs).toBe(8_000);
    expect(input.waitForConfigRestartSettle).not.toHaveBeenCalled();
    expect(runMatrixQaCanary).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));

    // Matrix acknowledges device messages when the next /sync uses next_batch.
    // Room observation must not consume the encrypted client's verification event.
    const done = { type: "m.key.verification.done", content: { transaction_id: "qr-fixture" } };
    const pending = new Map([
      ["driver-primary", [done]],
      ["observer-primary", [done]],
    ]);
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : request);
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (url.searchParams.get("since") === `${token}-delivered`) {
        pending.delete(token);
      }
      return Response.json({
        next_batch: `${token}-delivered`,
        to_device: { events: pending.get(token) ?? [] },
        rooms: {
          join: {
            "!room:test": {
              timeline: {
                events: [
                  {
                    event_id: "$reply",
                    sender: "@sut:test",
                    type: "m.room.message",
                    content: { body: "reply", msgtype: "m.text" },
                  },
                ],
              },
            },
          },
        },
      });
    };
    vi.stubGlobal("fetch", fetchImpl);
    for (const actorId of ["driver", "observer"] as const) {
      const accessToken = second.scenarioContext[`${actorId}AccessToken`];
      const client = createMatrixQaScenarioClient({
        accessToken,
        actorId,
        baseUrl: second.scenarioContext.baseUrl,
        observedEvents: second.scenarioContext.observedEvents,
        syncState: second.scenarioContext.syncState,
        syncStreams: second.scenarioContext.syncStreams,
      });
      await client.primeRoom();
      await client.waitForRoomEvent({
        observedEvents: [],
        predicate: (event) => event.eventId === "$reply",
        roomId: "!room:test",
        timeoutMs: 1_000,
      });
      const sdkSync = await fetchImpl(
        "http://127.0.0.1:8008/_matrix/client/v3/sync?since=sdk-before",
        {
          headers: { authorization: `Bearer ${accessToken}` },
        },
      );
      expect((await sdkSync.json()).to_device.events).toEqual([done]);
    }
  });
});
