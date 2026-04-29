import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderQaMarkdownReport } from "../../report.js";
import { __testing as liveTesting } from "./runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

type MatrixQaSummaryInput = Parameters<typeof liveTesting.buildMatrixQaSummary>[0];
type MatrixQaSummaryInputOverrides = Partial<Omit<MatrixQaSummaryInput, "timings">> & {
  timings?: Partial<MatrixQaSummaryInput["timings"]>;
};

function buildMatrixQaSummaryInput(
  overrides: MatrixQaSummaryInputOverrides = {},
): MatrixQaSummaryInput {
  const timings: MatrixQaSummaryInput["timings"] = {
    artifactWriteMs: 5,
    canaryMs: 40,
    harnessBootMs: 100,
    initialGatewayBootMs: 200,
    provisioningMs: 300,
    scenarioGatewayBootMs: 50,
    scenarioRestartGatewayMs: 60,
    scenarioTransportInterruptMs: 70,
    scenarios: [],
    totalMs: 825,
    ...overrides.timings,
  };

  return {
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
    scenarios: [],
    startedAt: "2026-04-10T10:00:00.000Z",
    sutAccountId: "sut",
    userIds: {
      driver: "@driver:matrix-qa.test",
      observer: "@observer:matrix-qa.test",
      sut: "@sut:matrix-qa.test",
    },
    ...overrides,
    timings,
  };
}

describe("matrix live qa runtime", () => {
  it("prints Matrix QA progress by default for non-interactive runs", () => {
    const previous = process.env.OPENCLAW_QA_MATRIX_PROGRESS;
    delete process.env.OPENCLAW_QA_MATRIX_PROGRESS;
    try {
      expect(liveTesting.shouldWriteMatrixQaProgress()).toBe(true);
      process.env.OPENCLAW_QA_MATRIX_PROGRESS = "0";
      expect(liveTesting.shouldWriteMatrixQaProgress()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_MATRIX_PROGRESS;
      } else {
        process.env.OPENCLAW_QA_MATRIX_PROGRESS = previous;
      }
    }
  });

  it("normalizes the Matrix QA hard timeout env", () => {
    const previous = process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS;
    try {
      process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = "12345";
      expect(liveTesting.createMatrixQaRunDeadline().timeoutMs).toBe(12345);
      process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = "nope";
      expect(liveTesting.createMatrixQaRunDeadline().timeoutMs).toBe(30 * 60_000);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_QA_MATRIX_TIMEOUT_MS = previous;
      }
    }
  });

  it("normalizes the Matrix QA canary timeout env", () => {
    const previous = process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS;
    try {
      delete process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS;
      expect(liveTesting.resolveMatrixQaCanaryTimeoutMs()).toBe(45_000);
      process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS = "90000";
      expect(liveTesting.resolveMatrixQaCanaryTimeoutMs()).toBe(90_000);
      process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS = "nope";
      expect(liveTesting.resolveMatrixQaCanaryTimeoutMs()).toBe(45_000);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS = previous;
      }
    }
  });

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
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
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
        timings: {
          artifactWriteMs: 5,
          canaryMs: 40,
          harnessBootMs: 100,
          initialGatewayBootMs: 200,
          provisioningMs: 300,
          scenarioGatewayBootMs: 50,
          scenarioRestartGatewayMs: 60,
          scenarioTransportInterruptMs: 70,
          scenarios: [],
          totalMs: 825,
        },
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
      liveTesting.buildMatrixQaSummary(
        buildMatrixQaSummaryInput({
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
          timings: {
            scenarios: [
              {
                durationMs: 80,
                gatewayBootMs: 0,
                gatewayRestartMs: 0,
                id: "matrix-mention-gating",
                title: "Matrix room message without mention does not trigger",
                transportInterruptMs: 0,
              },
            ],
            totalMs: 905,
          },
        }),
      ),
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
      timings: {
        totalMs: 905,
      },
    });
  });

  it("keeps failing Matrix scenario details and timings complete in summary + report output", () => {
    const summary = liveTesting.buildMatrixQaSummary(
      buildMatrixQaSummaryInput({
        observedEventCount: 6,
        scenarios: [
          {
            id: "matrix-reaction-not-a-reply",
            title: "Matrix reactions do not trigger a fresh bot reply",
            status: "fail",
            details: [
              "unexpected SUT reply after reaction from @driver:matrix-qa.test",
              "reaction event: $reaction",
              "unexpected reply event: $reply",
            ].join("\n"),
          },
        ],
        timings: {
          scenarios: [
            {
              durationMs: 8_000,
              gatewayBootMs: 0,
              gatewayRestartMs: 0,
              id: "matrix-reaction-not-a-reply",
              title: "Matrix reactions do not trigger a fresh bot reply",
              transportInterruptMs: 0,
            },
          ],
          totalMs: 825,
        },
      }),
    );

    expect(summary).toMatchObject({
      counts: {
        total: 2,
        passed: 1,
        failed: 1,
      },
      scenarios: [
        {
          id: "matrix-reaction-not-a-reply",
          status: "fail",
          details: expect.stringContaining("reaction event: $reaction"),
        },
      ],
      timings: {
        scenarios: [
          {
            id: "matrix-reaction-not-a-reply",
            durationMs: 8_000,
          },
        ],
      },
    });

    const report = renderQaMarkdownReport({
      title: "Matrix QA Report",
      startedAt: new Date(summary.startedAt),
      finishedAt: new Date(summary.finishedAt),
      checks: summary.checks,
      scenarios: summary.scenarios.map((scenario) => ({
        details: scenario.details,
        name: scenario.title,
        status: scenario.status,
      })),
      notes: [`observed events: ${summary.observedEventsPath}`],
    });

    expect(report).toContain("### Matrix reactions do not trigger a fresh bot reply");
    expect(report).toContain("unexpected SUT reply after reaction from @driver:matrix-qa.test");
    expect(report).toContain("reaction event: $reaction");
    expect(report).toContain("observed events: /tmp/observed.json");
  });

  it("groups Matrix scenario execution by gateway config while preserving tail scenarios", () => {
    const scenarios = liveTesting.findMatrixQaScenarios([
      "matrix-thread-follow-up",
      "matrix-e2ee-cli-encryption-setup-multi-account",
      "matrix-thread-isolation",
      "matrix-e2ee-cli-setup-then-gateway-reply",
      "matrix-e2ee-cli-self-verification",
      "matrix-e2ee-wrong-account-recovery-key",
    ]);

    expect(
      liveTesting
        .scheduleMatrixQaScenariosInCatalogOrder(scenarios)
        .map(({ scenario }) => scenario.id),
    ).toEqual([
      "matrix-thread-follow-up",
      "matrix-thread-isolation",
      "matrix-e2ee-cli-self-verification",
      "matrix-e2ee-cli-encryption-setup-multi-account",
      "matrix-e2ee-cli-setup-then-gateway-reply",
      "matrix-e2ee-wrong-account-recovery-key",
    ]);
  });

  it("uses the scenario timeout for post-restart Matrix readiness", () => {
    expect(
      liveTesting.getMatrixQaScenarioRestartReadyTimeoutMs({
        timeoutMs: 180_000,
      }),
    ).toBe(180_000);
  });

  it("retries Matrix gateway config patches after a stale config hash", async () => {
    const patch = {
      channels: {
        matrix: {
          enabled: true,
        },
      },
    };
    const gateway = {
      call: vi
        .fn()
        .mockResolvedValueOnce({ hash: "hash-old" })
        .mockRejectedValueOnce(
          new Error("config changed since last load; re-run config.get and retry"),
        )
        .mockResolvedValueOnce({ hash: "hash-fresh" })
        .mockResolvedValueOnce(undefined),
    };

    await liveTesting.patchMatrixQaGatewayConfig({
      gateway: gateway as never,
      patch,
      restartDelayMs: 250,
    });

    expect(gateway.call).toHaveBeenNthCalledWith(1, "config.get", {}, { timeoutMs: 60_000 });
    expect(gateway.call).toHaveBeenNthCalledWith(
      2,
      "config.patch",
      {
        baseHash: "hash-old",
        raw: JSON.stringify(patch, null, 2),
        restartDelayMs: 250,
      },
      { timeoutMs: 60_000 },
    );
    expect(gateway.call).toHaveBeenNthCalledWith(3, "config.get", {}, { timeoutMs: 60_000 });
    expect(gateway.call).toHaveBeenNthCalledWith(
      4,
      "config.patch",
      {
        baseHash: "hash-fresh",
        raw: JSON.stringify(patch, null, 2),
        restartDelayMs: 250,
      },
      { timeoutMs: 60_000 },
    );
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
