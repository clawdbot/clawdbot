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

  it("restores ordered override-heavy config to defaults from fresh current config", async () => {
    buildMatrixQaConfig.mockClear();
    const execApprovalOverrides = {
      agentFilter: ["main", "stale"],
      approvers: ["@driver:test", "@stale:test"],
      sessionFilter: ["matrix", "stale"],
    };
    const audioOverrides = {
      scope: {
        default: "deny" as const,
        rules: [{ action: "deny" as const }],
      },
    };
    const baselineConfig = {
      channels: {
        matrix: {
          accounts: { sut: { enabled: true } },
          enabled: false,
        },
      },
    };
    const firstTarget = {
      channels: {
        matrix: {
          accounts: {
            sut: {
              enabled: true,
              execApprovals: execApprovalOverrides,
            },
          },
          enabled: true,
        },
      },
      tools: {
        media: {
          audio: {
            scope: {
              default: "deny",
              rules: [{ action: "deny" }],
            },
          },
        },
      },
    };
    const currentConfig = {
      channels: {
        matrix: {
          accounts: {
            sibling: { enabled: true },
            sut: {
              autoJoin: "allowlist",
              autoJoinAllowlist: ["@driver:test", "@stale:test"],
              deviceId: "CURRENT-DEVICE",
              dm: {
                allowFrom: ["@driver:test", "@stale:test"],
                sessionScope: "per-user",
              },
              execApprovals: execApprovalOverrides,
              groupAllowFrom: ["@driver:test", "@stale:test"],
              groups: {
                "!room:test": {
                  tools: {
                    allow: ["read", "write"],
                    deny: ["shell", "network"],
                  },
                },
              },
              lifecycleState: "preserve",
            },
            "qa-driver-bot-source": { enabled: true },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["@sut", "@sut"],
        },
      },
      plugins: {
        entries: {
          matrix: {
            config: { preserve: "matrix-config" },
            enabled: false,
            hooks: { allowConversationAccess: true },
            llm: { allowModelOverride: true },
            subagent: { allowModelOverride: true },
          },
        },
      },
      tools: {
        media: {
          audio: {
            scope: {
              default: "deny",
              rules: [{ action: "allow" }, { action: "deny" }],
            },
          },
          models: [{ provider: "first" }, { provider: "stale" }],
        },
      },
      unrelated: { preserve: true },
    };
    const secondTarget = {
      channels: {
        matrix: {
          accounts: {
            sibling: { enabled: true },
            sut: {
              autoJoinAllowlist: ["@driver:test"],
              deviceId: "CURRENT-DEVICE",
              dm: { allowFrom: ["@driver:test"] },
              groupAllowFrom: ["@driver:test"],
              groups: {
                "!room:test": {
                  tools: {
                    allow: ["read"],
                    deny: ["shell"],
                  },
                },
              },
              lifecycleState: "preserve",
            },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["@sut"],
        },
      },
      plugins: {
        entries: {
          matrix: {
            config: { preserve: "matrix-config" },
            enabled: true,
            hooks: { allowConversationAccess: true },
            llm: { allowModelOverride: true },
            subagent: { allowModelOverride: true },
          },
        },
      },
      tools: {
        media: {
          audio: {
            scope: {
              rules: [{ action: "allow" }],
            },
          },
          models: [{ provider: "first" }],
        },
      },
      unrelated: { preserve: true },
    };
    buildMatrixQaConfig
      .mockReturnValueOnce(firstTarget as never)
      .mockReturnValueOnce(secondTarget as never);
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
          _opts?: { deadlineMs?: number; expectFinal?: boolean; timeoutMs?: number },
        ) => {
          if (method === "config.get") {
            configReadCount += 1;
            const scenario = Math.ceil(configReadCount / 3);
            const phase = (configReadCount - 1) % 3;
            if (phase === 0) {
              return { config: scenario === 1 ? baselineConfig : currentConfig };
            }
            if (phase === 1) {
              return { hash: `base-${scenario}` };
            }
            return {
              appliedConfigHash: `patched-${scenario}`,
              configRevisionHash: `patched-${scenario}`,
              hash: `patched-${scenario}`,
            };
          }
          if (method === "config.patch") {
            patchCount += 1;
            return { hash: `patched-${patchCount}`, ok: true };
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
                    lastStartAt: statusCount,
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
    const input = {
      config: {
        matrixConfigOverrides: {
          audio: audioOverrides,
          execApprovals: execApprovalOverrides,
        },
      } as Record<string, unknown>,
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      scenarioId: "matrix-state-reset",
      scenarioTitle: "Matrix state reset",
      timeoutMs: 8_000,
      waitForConfigRestartSettle: vi.fn(),
    };

    await environment.prepareFlow(input);
    input.config = {};
    await environment.prepareFlow(input);

    expect(buildMatrixQaConfig).toHaveBeenNthCalledWith(
      1,
      baselineConfig,
      expect.objectContaining({
        currentConfig: baselineConfig,
        overrides: {
          audio: audioOverrides,
          execApprovals: execApprovalOverrides,
        },
      }),
    );
    expect(buildMatrixQaConfig).toHaveBeenNthCalledWith(
      2,
      baselineConfig,
      expect.objectContaining({ currentConfig, overrides: undefined }),
    );
    const patchCalls = gateway.call.mock.calls.filter(([method]) => method === "config.patch");
    expect(patchCalls).toHaveLength(2);
    const secondPatchParams = patchCalls[1]?.[1] as {
      raw: string;
      replacePaths?: string[];
    };
    const secondPatch = JSON.parse(secondPatchParams.raw) as Record<string, unknown>;
    expect(secondPatch).toMatchObject({
      channels: {
        matrix: {
          accounts: {
            sut: {
              autoJoin: null,
              dm: { sessionScope: null },
              execApprovals: null,
            },
            "qa-driver-bot-source": null,
          },
        },
      },
    });
    expect(secondPatch).toMatchObject({
      plugins: {
        entries: {
          matrix: { enabled: true },
        },
      },
      tools: {
        media: {
          audio: {
            scope: {
              default: null,
            },
          },
        },
      },
    });
    expect(
      (secondPatch.plugins as { entries?: Record<string, unknown> }).entries?.matrix as Record<
        string,
        unknown
      >,
    ).toEqual({ enabled: true });
    expect(secondPatchParams.replacePaths).toEqual([
      "channels.matrix.accounts.sut.autoJoinAllowlist",
      "channels.matrix.accounts.sut.dm.allowFrom",
      "channels.matrix.accounts.sut.execApprovals.agentFilter",
      "channels.matrix.accounts.sut.execApprovals.approvers",
      "channels.matrix.accounts.sut.execApprovals.sessionFilter",
      "channels.matrix.accounts.sut.groupAllowFrom",
      "channels.matrix.accounts.sut.groups.!room:test.tools.allow",
      "channels.matrix.accounts.sut.groups.!room:test.tools.deny",
      "messages.groupChat.mentionPatterns",
      "tools.media.audio.scope.rules",
      "tools.media.models",
    ]);
    expect(
      secondPatchParams.replacePaths?.filter(
        (path) => path === "messages.groupChat.mentionPatterns",
      ),
    ).toHaveLength(1);
    expect(secondPatchParams.replacePaths).not.toEqual(
      expect.arrayContaining(["channels.matrix", "messages", "tools", "agents.defaults"]),
    );
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
    const patchCall = gateway.call.mock.calls.find(([method]) => method === "config.patch");
    expect(patchCall?.[1]).not.toHaveProperty("replacePaths");
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

  it("rejects a stale account start after a delayed failed pre-restart status read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let configReadCount = 0;
    let statusReadCount = 0;
    const mutateState = vi.fn(async () => undefined);
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      restartAfterStateMutation: vi.fn(
        async (
          mutate: (context: {
            configPath: string;
            runtimeEnv: NodeJS.ProcessEnv;
            stateDir: string;
            tempRoot: string;
          }) => Promise<void>,
        ) => {
          await mutate({
            configPath: "/tmp/matrix-qa/config.json",
            runtimeEnv: {},
            stateDir: "/tmp/matrix-qa/state",
            tempRoot: "/tmp/matrix-qa",
          });
        },
      ),
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
          statusReadCount += 1;
          if (statusReadCount === 3) {
            vi.setSystemTime(1_500);
            throw new Error("status temporarily unavailable");
          }
          return {
            channelAccounts: {
              matrix: [
                {
                  accountId: "sut",
                  connected: true,
                  healthState: "healthy",
                  lastStartAt:
                    statusReadCount === 4 ? 1_200 : statusReadCount === 5 ? 1_500 : 1_600,
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
      scenarioId: "matrix-state-restart",
      scenarioTitle: "Matrix state restart",
      timeoutMs: 2_000,
      waitForConfigRestartSettle: vi.fn(),
    });

    const restarting = prepared.scenarioContext.restartGatewayAfterStateMutation?.(mutateState, {
      timeoutMs: 2_000,
    });
    await vi.runAllTimersAsync();
    await restarting;

    expect(mutateState).toHaveBeenCalledOnce();
    expect(statusReadCount).toBe(6);
  });
});
