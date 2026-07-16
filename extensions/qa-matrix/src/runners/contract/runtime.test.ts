import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as liveTesting } from "./runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("matrix live qa runtime", () => {
  it("injects a temporary Matrix account into the QA gateway config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core", "qa-channel"],
        entries: {
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
      },
    };

    const next = liveTesting.buildMatrixQaConfig(baseCfg, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      sutAccessToken: "syt_sut",
      sutAccountId: "sut",
      sutDeviceId: "DEVICE123",
      sutUserId: "@sut:matrix-qa.test",
      topology: {
        defaultRoomId: "!room:matrix-qa.test",
        defaultRoomKey: "main",
        rooms: [
          {
            key: "main",
            kind: "group",
            memberRoles: ["driver", "observer", "sut"],
            memberUserIds: [
              "@driver:matrix-qa.test",
              "@observer:matrix-qa.test",
              "@sut:matrix-qa.test",
            ],
            name: "Matrix QA",
            requireMention: true,
            roomId: "!room:matrix-qa.test",
          },
        ],
      },
    });

    expect(next.plugins?.allow).toContain("matrix");
    expect(next.plugins?.entries?.matrix).toEqual({ enabled: true });
    expect(next.channels?.matrix).toEqual({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          accessToken: "syt_sut",
          deviceId: "DEVICE123",
          dm: { enabled: false },
          enabled: true,
          encryption: false,
          groupAllowFrom: ["@driver:matrix-qa.test"],
          groupPolicy: "allowlist",
          groups: {
            "!room:matrix-qa.test": {
              enabled: true,
              requireMention: true,
            },
          },
          homeserver: "http://127.0.0.1:28008/",
          network: {
            dangerouslyAllowPrivateNetwork: true,
          },
          replyToMode: "off",
          threadReplies: "inbound",
          userId: "@sut:matrix-qa.test",
        },
      },
    });
  });

  it("derives Matrix DM + multi-room config from provisioned topology", () => {
    const next = liveTesting.buildMatrixQaConfig(
      {},
      {
        driverUserId: "@driver:matrix-qa.test",
        homeserver: "http://127.0.0.1:28008/",
        observerUserId: "@observer:matrix-qa.test",
        sutAccessToken: "syt_sut",
        sutAccountId: "sut",
        sutUserId: "@sut:matrix-qa.test",
        topology: {
          defaultRoomId: "!room-a:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: "main",
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Matrix QA A",
              requireMention: true,
              roomId: "!room-a:matrix-qa.test",
            },
            {
              key: "secondary",
              kind: "group",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "Matrix QA B",
              requireMention: false,
              roomId: "!room-b:matrix-qa.test",
            },
            {
              key: "sut-dm",
              kind: "dm",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "Matrix QA DM",
              requireMention: false,
              roomId: "!dm:matrix-qa.test",
            },
          ],
        },
      },
    );

    expect(next.channels?.matrix?.accounts?.sut?.dm).toEqual({
      allowFrom: ["@driver:matrix-qa.test"],
      enabled: true,
      policy: "allowlist",
    });
    expect(next.channels?.matrix?.accounts?.sut?.groups).toEqual({
      "!room-a:matrix-qa.test": {
        enabled: true,
        requireMention: true,
      },
      "!room-b:matrix-qa.test": {
        enabled: true,
        requireMention: false,
      },
    });
  });

  it("records default and per-scenario Matrix config snapshots in the summary", () => {
    expect(
      liveTesting.buildMatrixQaSummary({
        artifactPaths: {
          observedEvents: "/tmp/observed.json",
          report: "/tmp/report.md",
          summary: "/tmp/summary.json",
        },
        checks: [{ name: "Matrix harness ready", status: "pass" }],
        config: {
          default: liveTesting.buildMatrixQaConfigSnapshot({
            driverUserId: "@driver:matrix-qa.test",
            observerUserId: "@observer:matrix-qa.test",
            sutUserId: "@sut:matrix-qa.test",
            topology: {
              defaultRoomId: "!room:matrix-qa.test",
              defaultRoomKey: "main",
              rooms: [
                {
                  key: "main",
                  kind: "group",
                  memberRoles: ["driver", "observer", "sut"],
                  memberUserIds: [
                    "@driver:matrix-qa.test",
                    "@observer:matrix-qa.test",
                    "@sut:matrix-qa.test",
                  ],
                  name: "Matrix QA",
                  requireMention: true,
                  roomId: "!room:matrix-qa.test",
                },
              ],
            },
          }),
          scenarios: [
            {
              id: "matrix-room-thread-reply-override",
              title: "Matrix threadReplies always keeps room replies threaded",
              config: liveTesting.buildMatrixQaConfigSnapshot({
                driverUserId: "@driver:matrix-qa.test",
                observerUserId: "@observer:matrix-qa.test",
                overrides: {
                  threadReplies: "always",
                },
                sutUserId: "@sut:matrix-qa.test",
                topology: {
                  defaultRoomId: "!room:matrix-qa.test",
                  defaultRoomKey: "main",
                  rooms: [
                    {
                      key: "main",
                      kind: "group",
                      memberRoles: ["driver", "observer", "sut"],
                      memberUserIds: [
                        "@driver:matrix-qa.test",
                        "@observer:matrix-qa.test",
                        "@sut:matrix-qa.test",
                      ],
                      name: "Matrix QA",
                      requireMention: true,
                      roomId: "!room:matrix-qa.test",
                    },
                  ],
                },
              }),
            },
          ],
        },
        finishedAt: "2026-04-10T10:05:00.000Z",
        harness: {
          baseUrl: "http://127.0.0.1:28008/",
          composeFile: "/tmp/docker-compose.yml",
          dmRoomIds: [],
          image: "ghcr.io/matrix-construct/tuwunel:v1.5.1",
          roomId: "!room:matrix-qa.test",
          roomIds: ["!room:matrix-qa.test"],
          serverName: "matrix-qa.test",
        },
        observedEventCount: 0,
        scenarios: [],
        startedAt: "2026-04-10T10:00:00.000Z",
        sutAccountId: "sut",
        userIds: {
          driver: "@driver:matrix-qa.test",
          observer: "@observer:matrix-qa.test",
          sut: "@sut:matrix-qa.test",
        },
      }).config,
    ).toMatchObject({
      default: {
        replyToMode: "off",
        threadReplies: "inbound",
      },
      scenarios: [
        {
          id: "matrix-room-thread-reply-override",
          config: {
            threadReplies: "always",
          },
        },
      ],
    });
  });

  it("preserves negative-scenario artifacts in the Matrix summary", () => {
    expect(
      liveTesting.buildMatrixQaSummary({
        artifactPaths: {
          observedEvents: "/tmp/observed.json",
          report: "/tmp/report.md",
          summary: "/tmp/summary.json",
        },
        checks: [{ name: "Matrix harness ready", status: "pass" }],
        config: {
          default: liveTesting.buildMatrixQaConfigSnapshot({
            driverUserId: "@driver:matrix-qa.test",
            observerUserId: "@observer:matrix-qa.test",
            sutUserId: "@sut:matrix-qa.test",
            topology: {
              defaultRoomId: "!room:matrix-qa.test",
              defaultRoomKey: "main",
              rooms: [],
            },
          }),
          scenarios: [],
        },
        finishedAt: "2026-04-10T10:05:00.000Z",
        harness: {
          baseUrl: "http://127.0.0.1:28008/",
          composeFile: "/tmp/docker-compose.yml",
          dmRoomIds: [],
          image: "ghcr.io/matrix-construct/tuwunel:v1.5.1",
          roomId: "!room:matrix-qa.test",
          roomIds: ["!room:matrix-qa.test"],
          serverName: "matrix-qa.test",
        },
        observedEventCount: 4,
        scenarios: [
          {
            id: "matrix-mention-gating",
            title: "Matrix room message without mention does not trigger",
            status: "pass",
            details: "no reply",
            artifacts: {
              actorUserId: "@driver:matrix-qa.test",
              driverEventId: "$driver",
              expectedNoReplyWindowMs: 8_000,
              token: "MATRIX_QA_NOMENTION_TOKEN",
              triggerBody: "reply with only this exact marker: MATRIX_QA_NOMENTION_TOKEN",
            },
          },
        ],
        startedAt: "2026-04-10T10:00:00.000Z",
        sutAccountId: "sut",
        userIds: {
          driver: "@driver:matrix-qa.test",
          observer: "@observer:matrix-qa.test",
          sut: "@sut:matrix-qa.test",
        },
      }),
    ).toMatchObject({
      counts: {
        total: 2,
        passed: 2,
        failed: 0,
      },
      scenarios: [
        {
          id: "matrix-mention-gating",
          artifacts: {
            actorUserId: "@driver:matrix-qa.test",
            expectedNoReplyWindowMs: 8_000,
            triggerBody: "reply with only this exact marker: MATRIX_QA_NOMENTION_TOKEN",
          },
        },
      ],
    });
  });

  it("batches Matrix scenarios by config key while preserving stable in-group order", () => {
    const scenarios = liveTesting.findMatrixQaScenarios([
      "matrix-top-level-reply-shape",
      "matrix-room-thread-reply-override",
      "matrix-thread-follow-up",
      "matrix-room-quiet-streaming-preview",
      "matrix-reaction-notification",
    ]);

    expect(
      liveTesting.scheduleMatrixQaScenariosByConfig(scenarios).map(({ scenario }) => scenario.id),
    ).toEqual([
      "matrix-thread-follow-up",
      "matrix-top-level-reply-shape",
      "matrix-reaction-notification",
      "matrix-room-thread-reply-override",
      "matrix-room-quiet-streaming-preview",
    ]);
  });

  it("treats only connected, healthy Matrix accounts as ready", () => {
    expect(liveTesting.isMatrixAccountReady({ running: true, connected: true })).toBe(true);
    expect(liveTesting.isMatrixAccountReady({ running: true, connected: false })).toBe(false);
    expect(
      liveTesting.isMatrixAccountReady({
        running: true,
        connected: true,
        restartPending: true,
      }),
    ).toBe(false);
    expect(
      liveTesting.isMatrixAccountReady({
        running: true,
        connected: true,
        healthState: "degraded",
      }),
    ).toBe(false);
  });

  it("waits past not-ready Matrix status snapshots until the account is really ready", async () => {
    vi.useFakeTimers();
    const gateway = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          channelAccounts: {
            matrix: [{ accountId: "sut", running: true, connected: false }],
          },
        })
        .mockResolvedValueOnce({
          channelAccounts: {
            matrix: [{ accountId: "sut", running: true, connected: true }],
          },
        }),
    };

    const waitPromise = liveTesting.waitForMatrixChannelReady(gateway as never, "sut", {
      timeoutMs: 1_000,
      pollMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(waitPromise).resolves.toBeUndefined();
    expect(gateway.call).toHaveBeenCalledTimes(2);
  });

  it("fails readiness when the Matrix account never reaches a healthy connected state", async () => {
    vi.useFakeTimers();
    const gateway = {
      call: vi.fn().mockResolvedValue({
        channelAccounts: {
          matrix: [{ accountId: "sut", running: true, connected: true, healthState: "degraded" }],
        },
      }),
    };

    const waitPromise = liveTesting.waitForMatrixChannelReady(gateway as never, "sut", {
      timeoutMs: 250,
      pollMs: 100,
    });
    const expectation = expect(waitPromise).rejects.toThrow(
      'matrix account "sut" did not become ready',
    );
    await vi.advanceTimersByTimeAsync(300);
    await expectation;
  });
});
