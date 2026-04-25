import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
const { createMatrixQaClient } = vi.hoisted(() => ({
  createMatrixQaClient: vi.fn(),
}));
const { createMatrixQaE2eeScenarioClient, runMatrixQaE2eeBootstrap, startMatrixQaFaultProxy } =
  vi.hoisted(() => ({
    createMatrixQaE2eeScenarioClient: vi.fn(),
    runMatrixQaE2eeBootstrap: vi.fn(),
    startMatrixQaFaultProxy: vi.fn(),
  }));
const {
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  resolveMatrixQaOpenClawCliEntryPath,
  runMatrixQaOpenClawCli,
  startMatrixQaOpenClawCli,
} = vi.hoisted(() => ({
  formatMatrixQaCliCommand: (args: string[]) => `openclaw ${args.join(" ")}`,
  redactMatrixQaCliOutput: (text: string) => text,
  resolveMatrixQaOpenClawCliEntryPath: (cwd: string) => `${cwd}/dist/index.js`,
  runMatrixQaOpenClawCli: vi.fn(),
  startMatrixQaOpenClawCli: vi.fn(),
}));

vi.mock("../../substrate/client.js", () => ({
  createMatrixQaClient,
}));
vi.mock("../../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient,
  runMatrixQaE2eeBootstrap,
}));
vi.mock("../../substrate/fault-proxy.js", () => ({
  startMatrixQaFaultProxy,
}));
vi.mock("./scenario-runtime-cli.js", () => ({
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  resolveMatrixQaOpenClawCliEntryPath,
  runMatrixQaOpenClawCli,
  startMatrixQaOpenClawCli,
}));

import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  findMissingLiveTransportStandardScenarios,
} from "../../shared/live-transport-scenarios.js";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import { MATRIX_QA_MEDIA_TYPE_COVERAGE_CASES } from "./scenario-media-fixtures.js";
import {
  __testing as scenarioTesting,
  MATRIX_QA_SCENARIOS,
  runMatrixQaScenario,
  type MatrixQaScenarioContext,
} from "./scenarios.js";

const MATRIX_SUBAGENT_MISSING_HOOK_ERROR =
  "thread=true is unavailable because no channel plugin registered subagent_spawning hooks.";
const MATRIX_QA_HOT_RELOAD_RESTART_DELAY_MS = 300_000;

function matrixQaScenarioContext(): MatrixQaScenarioContext {
  return {
    baseUrl: "http://127.0.0.1:28008/",
    canary: undefined,
    driverAccessToken: "driver-token",
    driverUserId: "@driver:matrix-qa.test",
    observedEvents: [],
    observerAccessToken: "observer-token",
    observerUserId: "@observer:matrix-qa.test",
    roomId: "!main:matrix-qa.test",
    restartGateway: undefined,
    syncState: {},
    sutAccessToken: "sut-token",
    sutUserId: "@sut:matrix-qa.test",
    timeoutMs: 8_000,
    topology: {
      defaultRoomId: "!main:matrix-qa.test",
      defaultRoomKey: "main",
      rooms: [],
    },
  };
}

async function writeTestJsonFile(pathname: string, value: unknown) {
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

function matrixSyncStoreFixture(nextBatch: string) {
  return {
    version: 1,
    cleanShutdown: true,
    savedSync: {
      nextBatch,
      accountData: [],
      roomsData: {
        join: {},
        invite: {},
        leave: {},
        knock: {},
      },
    },
  };
}

function matrixQaE2eeRoomKey(
  scenarioId: Parameters<typeof scenarioTesting.buildMatrixQaE2eeScenarioRoomKey>[0],
) {
  return scenarioTesting.buildMatrixQaE2eeScenarioRoomKey(scenarioId);
}

describe("matrix live qa scenarios", () => {
  beforeEach(() => {
    createMatrixQaClient.mockReset();
    createMatrixQaE2eeScenarioClient.mockReset();
    runMatrixQaE2eeBootstrap.mockReset();
    runMatrixQaOpenClawCli.mockReset();
    startMatrixQaOpenClawCli.mockReset();
    startMatrixQaFaultProxy.mockReset();
  });

  it("ships the Matrix live QA scenario set by default", () => {
    expect(scenarioTesting.findMatrixQaScenarios().map((scenario) => scenario.id)).toEqual([
      "matrix-thread-follow-up",
      "matrix-thread-root-preservation",
      "matrix-thread-nested-reply-shape",
      "matrix-thread-isolation",
      "matrix-subagent-thread-spawn",
      "matrix-top-level-reply-shape",
      "matrix-room-thread-reply-override",
      "matrix-room-quiet-streaming-preview",
      "matrix-room-block-streaming",
      "matrix-room-image-understanding-attachment",
      "matrix-room-generated-image-delivery",
      "matrix-media-type-coverage",
      "matrix-attachment-only-ignored",
      "matrix-unsupported-media-safe",
      "matrix-dm-reply-shape",
      "matrix-dm-shared-session-notice",
      "matrix-dm-thread-reply-override",
      "matrix-dm-per-room-session-override",
      "matrix-room-autojoin-invite",
      "matrix-secondary-room-reply",
      "matrix-secondary-room-open-trigger",
      "matrix-reaction-notification",
      "matrix-reaction-threaded",
      "matrix-reaction-not-a-reply",
      "matrix-reaction-redaction-observed",
      "matrix-restart-resume",
      "matrix-post-restart-room-continue",
      "matrix-initial-catchup-then-incremental",
      "matrix-restart-replay-dedupe",
      "matrix-stale-sync-replay-dedupe",
      "matrix-room-membership-loss",
      "matrix-homeserver-restart-resume",
      "matrix-mention-gating",
      "matrix-mxid-prefixed-command-block",
      "matrix-mention-metadata-spoof-block",
      "matrix-observer-allowlist-override",
      "matrix-allowlist-block",
      "matrix-allowlist-hot-reload",
      "matrix-multi-actor-ordering",
      "matrix-inbound-edit-ignored",
      "matrix-inbound-edit-no-duplicate-trigger",
      "matrix-e2ee-basic-reply",
      "matrix-e2ee-thread-follow-up",
      "matrix-e2ee-bootstrap-success",
      "matrix-e2ee-recovery-key-lifecycle",
      "matrix-e2ee-recovery-owner-verification-required",
      "matrix-e2ee-cli-self-verification",
      "matrix-e2ee-device-sas-verification",
      "matrix-e2ee-qr-verification",
      "matrix-e2ee-stale-device-hygiene",
      "matrix-e2ee-dm-sas-verification",
      "matrix-e2ee-restart-resume",
      "matrix-e2ee-verification-notice-no-trigger",
      "matrix-e2ee-artifact-redaction",
      "matrix-e2ee-media-image",
      "matrix-e2ee-key-bootstrap-failure",
    ]);
  });

  it("uses the repo-wide exact marker prompt shape for Matrix mentions", () => {
    expect(
      scenarioTesting.buildMentionPrompt("@sut:matrix-qa.test", "MATRIX_QA_CANARY_TOKEN"),
    ).toBe("@sut:matrix-qa.test reply with only this exact marker: MATRIX_QA_CANARY_TOKEN");
  });

  it("keeps live Matrix model and E2EE waits above observed CI latency", () => {
    const scenarios = new Map(MATRIX_QA_SCENARIOS.map((scenario) => [scenario.id, scenario]));

    expect(scenarios.get("matrix-subagent-thread-spawn")?.timeoutMs).toBeGreaterThanOrEqual(
      120_000,
    );
    expect(scenarios.get("matrix-room-generated-image-delivery")?.timeoutMs).toBeGreaterThanOrEqual(
      180_000,
    );
    expect(scenarios.get("matrix-e2ee-restart-resume")?.timeoutMs).toBeGreaterThanOrEqual(150_000);
    expect(scenarios.get("matrix-e2ee-artifact-redaction")?.timeoutMs).toBeGreaterThanOrEqual(
      150_000,
    );
    expect(scenarios.get("matrix-e2ee-media-image")?.timeoutMs).toBeGreaterThanOrEqual(180_000);
  });

  it("requires Matrix replies to match the exact marker body", () => {
    expect(
      scenarioTesting.buildMatrixReplyArtifact(
        {
          kind: "message",
          roomId: "!room:matrix-qa.test",
          eventId: "$event",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: "MATRIX_QA_TOKEN",
        },
        "MATRIX_QA_TOKEN",
      ).tokenMatched,
    ).toBe(true);
    expect(
      scenarioTesting.buildMatrixReplyArtifact(
        {
          kind: "message",
          roomId: "!room:matrix-qa.test",
          eventId: "$event-2",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: "prefix MATRIX_QA_TOKEN suffix",
        },
        "MATRIX_QA_TOKEN",
      ).tokenMatched,
    ).toBe(false);
  });

  it("fails when any requested Matrix scenario id is unknown", () => {
    expect(() =>
      scenarioTesting.findMatrixQaScenarios(["matrix-thread-follow-up", "typo-scenario"]),
    ).toThrow("unknown Matrix QA scenario id(s): typo-scenario");
  });

  it("covers the baseline live transport contract plus Matrix-specific extras", () => {
    expect(scenarioTesting.MATRIX_QA_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "thread-follow-up",
      "thread-isolation",
      "top-level-reply-shape",
      "reaction-observation",
      "restart-resume",
      "mention-gating",
      "allowlist-block",
    ]);
    expect(
      findMissingLiveTransportStandardScenarios({
        coveredStandardScenarioIds: scenarioTesting.MATRIX_QA_STANDARD_SCENARIO_IDS,
        expectedStandardScenarioIds: LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
      }),
    ).toEqual([]);
  });

  it("merges default and scenario-requested Matrix topology once per run", () => {
    expect(
      scenarioTesting.buildMatrixQaTopologyForScenarios({
        defaultRoomName: "OpenClaw Matrix QA run",
        scenarios: [
          MATRIX_QA_SCENARIOS[0],
          {
            id: "matrix-restart-resume",
            standardId: "restart-resume",
            timeoutMs: 60_000,
            title: "Matrix restart resume",
            topology: {
              defaultRoomKey: "main",
              rooms: [
                {
                  key: "driver-dm",
                  kind: "dm",
                  members: ["driver", "sut"],
                  name: "Driver/SUT DM",
                },
                {
                  key: "ops",
                  kind: "group",
                  members: ["driver", "observer", "sut"],
                  name: "Ops room",
                  requireMention: false,
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      defaultRoomKey: "main",
      rooms: [
        {
          encrypted: false,
          key: "main",
          kind: "group",
          members: ["driver", "observer", "sut"],
          name: "OpenClaw Matrix QA run",
          requireMention: true,
        },
        {
          key: "driver-dm",
          kind: "dm",
          members: ["driver", "sut"],
          name: "Driver/SUT DM",
        },
        {
          key: "ops",
          kind: "group",
          members: ["driver", "observer", "sut"],
          name: "Ops room",
          requireMention: false,
        },
      ],
    });
  });

  it("rejects conflicting Matrix topology room definitions", () => {
    expect(() =>
      scenarioTesting.buildMatrixQaTopologyForScenarios({
        defaultRoomName: "OpenClaw Matrix QA run",
        scenarios: [
          {
            id: "matrix-thread-follow-up",
            standardId: "thread-follow-up",
            timeoutMs: 60_000,
            title: "A",
            topology: {
              defaultRoomKey: "main",
              rooms: [
                {
                  key: "ops",
                  kind: "group",
                  members: ["driver", "observer", "sut"],
                  name: "Ops room",
                  requireMention: true,
                },
              ],
            },
          },
          {
            id: "matrix-thread-isolation",
            standardId: "thread-isolation",
            timeoutMs: 60_000,
            title: "B",
            topology: {
              defaultRoomKey: "main",
              rooms: [
                {
                  key: "ops",
                  kind: "group",
                  members: ["driver", "sut"],
                  name: "Ops room",
                  requireMention: true,
                },
              ],
            },
          },
        ],
      }),
    ).toThrow('Matrix QA topology room "ops" has conflicting definitions');
  });

  it("provisions isolated encrypted rooms for each E2EE scenario", () => {
    const topology = scenarioTesting.buildMatrixQaTopologyForScenarios({
      defaultRoomName: "OpenClaw Matrix QA run",
      scenarios: [
        MATRIX_QA_SCENARIOS.find((scenario) => scenario.id === "matrix-e2ee-basic-reply")!,
        MATRIX_QA_SCENARIOS.find((scenario) => scenario.id === "matrix-e2ee-thread-follow-up")!,
      ],
    });

    expect(topology.rooms).toEqual([
      {
        encrypted: false,
        key: "main",
        kind: "group",
        members: ["driver", "observer", "sut"],
        name: "OpenClaw Matrix QA run",
        requireMention: true,
      },
      {
        encrypted: true,
        key: "e2ee-basic-reply",
        kind: "group",
        members: ["driver", "observer", "sut"],
        name: "Matrix QA E2EE Basic Reply Room",
        requireMention: true,
      },
      {
        encrypted: true,
        key: "e2ee-thread-follow-up",
        kind: "group",
        members: ["driver", "observer", "sut"],
        name: "Matrix QA E2EE Thread Follow-up Room",
        requireMention: true,
      },
    ]);
  });

  it("resolves scenario room ids from provisioned topology keys", () => {
    expect(
      scenarioTesting.resolveMatrixQaScenarioRoomId(
        {
          roomId: "!main:matrix-qa.test",
          topology: {
            defaultRoomId: "!main:matrix-qa.test",
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
                name: "Main",
                requireMention: true,
                roomId: "!main:matrix-qa.test",
              },
              {
                key: "driver-dm",
                kind: "dm",
                memberRoles: ["driver", "sut"],
                memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
                name: "Driver DM",
                requireMention: false,
                roomId: "!dm:matrix-qa.test",
              },
            ],
          },
        },
        "driver-dm",
      ),
    ).toBe("!dm:matrix-qa.test");
    expect(
      scenarioTesting.resolveMatrixQaScenarioRoomId({
        roomId: "!main:matrix-qa.test",
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [],
        },
      }),
    ).toBe("!main:matrix-qa.test");
  });

  it("primes the observer sync cursor instead of reusing the driver's cursor", async () => {
    const primeRoom = vi.fn().mockResolvedValue("observer-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$observer-trigger");
    const waitForOptionalRoomEvent = vi.fn().mockImplementation(async (params) => {
      expect(params.since).toBe("observer-sync-start");
      return {
        matched: false,
        since: "observer-sync-next",
      };
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForOptionalRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find((entry) => entry.id === "matrix-allowlist-block");
    expect(scenario).toBeDefined();

    const syncState = {
      driver: "driver-sync-next",
    };

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!room:matrix-qa.test",
        restartGateway: undefined,
        syncState,
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!room:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        actorUserId: "@observer:matrix-qa.test",
        expectedNoReplyWindowMs: 8_000,
      },
    });

    expect(createMatrixQaClient).toHaveBeenCalledWith({
      accessToken: "observer-token",
      baseUrl: "http://127.0.0.1:28008/",
    });
    expect(primeRoom).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(1);
    expect(syncState).toEqual({
      driver: "driver-sync-next",
      observer: "observer-sync-next",
    });
  });

  it("allows observer messages when the sender allowlist override includes them", async () => {
    const primeRoom = vi.fn().mockResolvedValue("observer-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$observer-allow-trigger");
    const waitForRoomEvent = vi.fn().mockImplementation(async () => ({
      event: {
        kind: "message",
        roomId: "!room:matrix-qa.test",
        eventId: "$sut-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendTextMessage.mock.calls[0]?.[0]?.body).replace(
          "@sut:matrix-qa.test reply with only this exact marker: ",
          "",
        ),
      },
      since: "observer-sync-next",
    }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-observer-allowlist-override",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!room:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!room:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        actorUserId: "@observer:matrix-qa.test",
        driverEventId: "$observer-allow-trigger",
        reply: {
          tokenMatched: true,
        },
      },
    });

    expect(createMatrixQaClient).toHaveBeenCalledWith({
      accessToken: "observer-token",
      baseUrl: "http://127.0.0.1:28008/",
    });
    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("@sut:matrix-qa.test reply with only this exact marker:"),
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!room:matrix-qa.test",
    });
  });

  it("blocks MXID-prefixed Matrix control commands from non-allowlisted observers", async () => {
    const primeRoom = vi.fn().mockResolvedValue("observer-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$observer-command-trigger");
    const waitForOptionalRoomEvent = vi.fn().mockImplementation(async (params) => {
      expect(params.since).toBe("observer-sync-start");
      return {
        matched: false,
        since: "observer-sync-next",
      };
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForOptionalRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-mxid-prefixed-command-block",
    );
    expect(scenario).toBeDefined();

    await expect(runMatrixQaScenario(scenario!, matrixQaScenarioContext())).resolves.toMatchObject({
      artifacts: {
        actorUserId: "@observer:matrix-qa.test",
        driverEventId: "$observer-command-trigger",
      },
    });

    expect(createMatrixQaClient).toHaveBeenCalledWith({
      accessToken: "observer-token",
      baseUrl: "http://127.0.0.1:28008/",
    });
    expect(sendTextMessage).toHaveBeenCalledWith({
      body: "@sut:matrix-qa.test /new",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!main:matrix-qa.test",
      }),
    );
  });

  it("ignores stale Matrix SUT replies before a no-reply trigger", async () => {
    const primeRoom = vi.fn().mockResolvedValue("observer-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$observer-command-trigger");
    const waitForOptionalRoomEvent = vi.fn().mockImplementation(async (params) => {
      expect(
        params.predicate({
          eventId: "$previous-reply",
          kind: "message",
          relatesTo: {
            eventId: "$previous-trigger",
            inReplyToId: "$previous-trigger",
            isFallingBack: true,
            relType: "m.thread",
          },
          roomId: "!main:matrix-qa.test",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
        }),
      ).toBe(false);
      expect(
        params.predicate({
          eventId: "$observer-command-trigger",
          kind: "message",
          roomId: "!main:matrix-qa.test",
          sender: "@observer:matrix-qa.test",
          type: "m.room.message",
        }),
      ).toBe(false);
      expect(
        params.predicate({
          eventId: "$current-reply",
          kind: "message",
          relatesTo: {
            eventId: "$observer-command-trigger",
            inReplyToId: "$observer-command-trigger",
            isFallingBack: true,
            relType: "m.thread",
          },
          roomId: "!main:matrix-qa.test",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
        }),
      ).toBe(true);
      return {
        matched: false,
        since: "observer-sync-next",
      };
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForOptionalRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-mxid-prefixed-command-block",
    );
    expect(scenario).toBeDefined();

    await expect(runMatrixQaScenario(scenario!, matrixQaScenarioContext())).resolves.toMatchObject({
      artifacts: {
        driverEventId: "$observer-command-trigger",
      },
    });
  });

  it("hot-reloads group allowlist removals inside one running Matrix gateway", async () => {
    const patchGatewayConfig = vi.fn(async () => {});
    const primeRoom = vi.fn().mockResolvedValue("sync-start");
    const sendTextMessage = vi
      .fn()
      .mockResolvedValueOnce("$group-accepted")
      .mockResolvedValueOnce("$group-removed");
    const waitForOptionalRoomEvent = vi.fn().mockImplementation(async (params) => ({
      matched: false,
      since: `${params.roomId}:no-reply`,
    }));
    const waitForRoomEvent = vi.fn().mockImplementation(async (params) => {
      const sentBody = String(sendTextMessage.mock.calls.at(-1)?.[0]?.body ?? "");
      const token = sentBody
        .replace("@sut:matrix-qa.test reply with only this exact marker: ", "")
        .replace("reply with only this exact marker: ", "");
      return {
        event: {
          kind: "message",
          roomId: params.roomId,
          eventId: "$group-reply",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: token,
        },
        since: `${params.roomId}:reply`,
      };
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForOptionalRoomEvent,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-allowlist-hot-reload",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        ...matrixQaScenarioContext(),
        patchGatewayConfig,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
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
              name: "Main",
              requireMention: true,
              roomId: "!main:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        secondDriverEventId: "$group-removed",
        firstReply: {
          eventId: "$group-reply",
          tokenMatched: true,
        },
      },
    });

    expect(patchGatewayConfig).toHaveBeenCalledWith(
      {
        channels: {
          matrix: {
            accounts: {
              sut: {
                groupAllowFrom: ["@driver:matrix-qa.test"],
              },
            },
          },
        },
        gateway: {
          reload: {
            mode: "off",
          },
        },
      },
      {
        restartDelayMs: MATRIX_QA_HOT_RELOAD_RESTART_DELAY_MS,
      },
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        mentionUserIds: ["@sut:matrix-qa.test"],
        roomId: "!main:matrix-qa.test",
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        mentionUserIds: ["@sut:matrix-qa.test"],
        roomId: "!main:matrix-qa.test",
      }),
    );
  });

  it("queues a Matrix trigger during restart before proving incremental sync continues", async () => {
    const callOrder: string[] = [];
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockImplementation(async (params) => {
      callOrder.push(`send:${String(params.body).includes("CATCHUP") ? "catchup" : "incremental"}`);
      return String(params.body).includes("CATCHUP") ? "$catchup-trigger" : "$incremental-trigger";
    });
    const waitForRoomEvent = vi.fn().mockImplementation(async () => {
      const sentBody = String(sendTextMessage.mock.calls.at(-1)?.[0]?.body ?? "");
      const token = sentBody.replace("@sut:matrix-qa.test reply with only this exact marker: ", "");
      callOrder.push(`wait:${token.includes("CATCHUP") ? "catchup" : "incremental"}`);
      return {
        event: {
          kind: "message",
          roomId: "!restart:matrix-qa.test",
          eventId: token.includes("CATCHUP") ? "$catchup-reply" : "$incremental-reply",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: token,
        },
        since: token.includes("CATCHUP")
          ? "driver-sync-after-catchup"
          : "driver-sync-after-incremental",
      };
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-initial-catchup-then-incremental",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        restartGatewayWithQueuedMessage: async (queueMessage) => {
          callOrder.push("restart");
          await queueMessage();
          callOrder.push("ready");
        },
        roomId: "!room:matrix-qa.test",
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!room:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: "restart",
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Restart room",
              requireMention: true,
              roomId: "!restart:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        catchupDriverEventId: "$catchup-trigger",
        catchupReply: {
          eventId: "$catchup-reply",
          tokenMatched: true,
        },
        incrementalDriverEventId: "$incremental-trigger",
        incrementalReply: {
          eventId: "$incremental-reply",
          tokenMatched: true,
        },
      },
    });

    expect(callOrder).toEqual([
      "restart",
      "send:catchup",
      "ready",
      "wait:catchup",
      "send:incremental",
      "wait:incremental",
    ]);
  });

  it("fails if a handled Matrix event is redelivered after gateway restart", async () => {
    const callOrder: string[] = [];
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockImplementation(async (params) => {
      const body = String(params.body);
      const kind = body.includes("REPLAY_DEDUPE_FRESH") ? "fresh" : "first";
      callOrder.push(`send:${kind}`);
      return kind === "fresh" ? "$fresh-trigger" : "$first-trigger";
    });
    const waitForRoomEvent = vi.fn().mockImplementation(async () => {
      const sentBody = String(sendTextMessage.mock.calls.at(-1)?.[0]?.body ?? "");
      const token = sentBody.replace("@sut:matrix-qa.test reply with only this exact marker: ", "");
      const kind = token.includes("REPLAY_DEDUPE_FRESH") ? "fresh" : "first";
      callOrder.push(`wait:${kind}`);
      return {
        event: {
          kind: "message",
          roomId: "!restart:matrix-qa.test",
          eventId: kind === "fresh" ? "$fresh-reply" : "$first-reply",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: token,
        },
        since: kind === "fresh" ? "driver-sync-after-fresh" : "driver-sync-after-first",
      };
    });
    const waitForOptionalRoomEvent = vi.fn().mockImplementation(async () => {
      callOrder.push("wait:no-duplicate");
      return {
        matched: false,
        since: "driver-sync-after-no-duplicate-window",
      };
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForOptionalRoomEvent,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-restart-replay-dedupe",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        ...matrixQaScenarioContext(),
        restartGateway: async () => {
          callOrder.push("restart");
        },
        roomId: "!room:matrix-qa.test",
        topology: {
          defaultRoomId: "!room:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: "restart",
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Restart room",
              requireMention: true,
              roomId: "!restart:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        duplicateWindowMs: 8000,
        firstDriverEventId: "$first-trigger",
        firstReply: {
          eventId: "$first-reply",
          tokenMatched: true,
        },
        freshDriverEventId: "$fresh-trigger",
        freshReply: {
          eventId: "$fresh-reply",
          tokenMatched: true,
        },
      },
    });

    expect(callOrder).toEqual([
      "send:first",
      "wait:first",
      "restart",
      "wait:no-duplicate",
      "send:fresh",
      "wait:fresh",
    ]);
    expect(waitForOptionalRoomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!restart:matrix-qa.test",
        timeoutMs: 8000,
      }),
    );
  });

  it("forces a stale persisted Matrix sync cursor and expects inbound dedupe to absorb replay", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "matrix-stale-sync-"));
    try {
      const accountDir = path.join(stateRoot, "matrix", "accounts", "sut", "server", "token");
      const staleSyncRoomId = "!stale-sync:matrix-qa.test";
      const syncStorePath = path.join(accountDir, "bot-storage.json");
      const dedupeStorePath = path.join(accountDir, "inbound-dedupe.json");
      await mkdir(accountDir, { recursive: true });
      await writeTestJsonFile(path.join(accountDir, "storage-meta.json"), {
        accountId: "sut",
        userId: "@sut:matrix-qa.test",
      });
      await writeTestJsonFile(syncStorePath, matrixSyncStoreFixture("driver-sync-start"));

      const callOrder: string[] = [];
      const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
      const sendTextMessage = vi.fn().mockImplementation(async (params) => {
        const body = String(params.body);
        const kind = body.includes("STALE_SYNC_DEDUPE_FRESH") ? "fresh" : "first";
        callOrder.push(`send:${kind}`);
        return kind === "fresh" ? "$fresh-trigger" : "$first-trigger";
      });
      const waitForRoomEvent = vi.fn().mockImplementation(async () => {
        const sentBody = String(sendTextMessage.mock.calls.at(-1)?.[0]?.body ?? "");
        const token = sentBody.replace(
          "@sut:matrix-qa.test reply with only this exact marker: ",
          "",
        );
        const kind = token.includes("STALE_SYNC_DEDUPE_FRESH") ? "fresh" : "first";
        callOrder.push(`wait:${kind}`);
        if (kind === "first") {
          await writeTestJsonFile(dedupeStorePath, {
            version: 1,
            entries: [
              {
                key: `${staleSyncRoomId}|$first-trigger`,
                ts: Date.now(),
              },
            ],
          });
        }
        return {
          event: {
            kind: "message",
            roomId: staleSyncRoomId,
            eventId: kind === "fresh" ? "$fresh-reply" : "$first-reply",
            sender: "@sut:matrix-qa.test",
            type: "m.room.message",
            body: token,
          },
          since: kind === "fresh" ? "driver-sync-after-fresh" : "driver-sync-after-first",
        };
      });
      const waitForOptionalRoomEvent = vi.fn().mockImplementation(async () => {
        callOrder.push("wait:no-duplicate");
        return {
          matched: false,
          since: "driver-sync-after-no-duplicate-window",
        };
      });

      createMatrixQaClient.mockReturnValue({
        primeRoom,
        sendTextMessage,
        waitForOptionalRoomEvent,
        waitForRoomEvent,
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-stale-sync-replay-dedupe",
      );
      expect(scenario).toBeDefined();

      await expect(
        runMatrixQaScenario(scenario!, {
          ...matrixQaScenarioContext(),
          gatewayStateDir: stateRoot,
          restartGatewayAfterStateMutation: async (mutateState) => {
            callOrder.push("hard-restart");
            await writeTestJsonFile(
              syncStorePath,
              matrixSyncStoreFixture("driver-sync-after-first"),
            );
            await mutateState({ stateDir: stateRoot });
            const persisted = JSON.parse(await readFile(syncStorePath, "utf8")) as {
              savedSync?: { nextBatch?: string };
            };
            expect(persisted.savedSync?.nextBatch).toBe("driver-sync-start");
          },
          roomId: "!room:matrix-qa.test",
          sutAccountId: "sut",
          topology: {
            defaultRoomId: "!room:matrix-qa.test",
            defaultRoomKey: "main",
            rooms: [
              {
                key: "stale-sync",
                kind: "group",
                memberRoles: ["driver", "observer", "sut"],
                memberUserIds: [
                  "@driver:matrix-qa.test",
                  "@observer:matrix-qa.test",
                  "@sut:matrix-qa.test",
                ],
                name: "Stale sync room",
                requireMention: true,
                roomId: staleSyncRoomId,
              },
            ],
          },
        }),
      ).resolves.toMatchObject({
        artifacts: {
          dedupeCommitObserved: true,
          duplicateWindowMs: 8000,
          firstDriverEventId: "$first-trigger",
          firstReply: {
            eventId: "$first-reply",
            tokenMatched: true,
          },
          freshDriverEventId: "$fresh-trigger",
          freshReply: {
            eventId: "$fresh-reply",
            tokenMatched: true,
          },
          restartSignal: "hard-restart",
          staleSyncCursor: "driver-sync-start",
        },
      });

      expect(callOrder).toEqual([
        "send:first",
        "wait:first",
        "hard-restart",
        "wait:no-duplicate",
        "send:fresh",
        "wait:fresh",
      ]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("runs the DM scenario against the provisioned DM room without a mention", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$dm-trigger");
    const waitForRoomEvent = vi.fn().mockImplementation(async () => ({
      event: {
        roomId: "!dm:matrix-qa.test",
        eventId: "$sut-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendTextMessage.mock.calls[0]?.[0]?.body).replace(
          "reply with only this exact marker: ",
          "",
        ),
      },
      since: "driver-sync-next",
    }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find((entry) => entry.id === "matrix-dm-reply-shape");
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
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
              name: "Main",
              requireMention: true,
              roomId: "!main:matrix-qa.test",
            },
            {
              key: scenarioTesting.MATRIX_QA_DRIVER_DM_ROOM_KEY,
              kind: "dm",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "DM",
              requireMention: false,
              roomId: "!dm:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        actorUserId: "@driver:matrix-qa.test",
      },
    });

    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("reply with only this exact marker:"),
      roomId: "!dm:matrix-qa.test",
    });
    expect(waitForRoomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!dm:matrix-qa.test",
      }),
    );
  });

  it("uses room thread override scenarios against the main room", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$room-thread-trigger");
    const waitForRoomEvent = vi.fn().mockImplementation(async () => ({
      event: {
        kind: "message",
        roomId: "!main:matrix-qa.test",
        eventId: "$sut-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendTextMessage.mock.calls[0]?.[0]?.body).replace(
          "@sut:matrix-qa.test reply with only this exact marker: ",
          "",
        ),
        relatesTo: {
          relType: "m.thread",
          eventId: "$room-thread-trigger",
          inReplyToId: "$room-thread-trigger",
          isFallingBack: true,
        },
      },
      since: "driver-sync-next",
    }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-room-thread-reply-override",
    );
    expect(scenario).toBeDefined();

    await expect(runMatrixQaScenario(scenario!, matrixQaScenarioContext())).resolves.toMatchObject({
      artifacts: {
        driverEventId: "$room-thread-trigger",
        reply: {
          relatesTo: {
            relType: "m.thread",
            eventId: "$room-thread-trigger",
          },
        },
      },
    });
  });

  it("runs the subagent thread spawn scenario against a child thread", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$subagent-spawn-trigger");
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => ({
        event: {
          kind: "message",
          roomId: "!main:matrix-qa.test",
          eventId: "$subagent-thread-root",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: "qa session active. Messages here go directly to this session.",
        },
        since: "driver-sync-intro",
      }))
      .mockImplementationOnce(async () => {
        const childToken =
          /task="Reply exactly `([^`]+)`/.exec(
            String(sendTextMessage.mock.calls[0]?.[0]?.body),
          )?.[1] ?? "MATRIX_QA_SUBAGENT_CHILD_FIXED";
        return {
          event: {
            kind: "message",
            roomId: "!main:matrix-qa.test",
            eventId: "$subagent-completion",
            sender: "@sut:matrix-qa.test",
            type: "m.room.message",
            body: childToken,
            relatesTo: {
              relType: "m.thread",
              eventId: "$subagent-thread-root",
              inReplyToId: "$subagent-thread-root",
              isFallingBack: true,
            },
          },
          since: "driver-sync-next",
        };
      });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-subagent-thread-spawn",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        driverEventId: "$subagent-spawn-trigger",
        subagentCompletion: {
          eventId: "$subagent-completion",
          relatesTo: {
            relType: "m.thread",
            eventId: "$subagent-thread-root",
          },
          tokenMatched: true,
        },
        subagentIntro: {
          eventId: "$subagent-thread-root",
        },
        threadRootEventId: "$subagent-thread-root",
      },
    });

    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("Call sessions_spawn now for this QA check"),
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("runTimeoutSeconds=60"),
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
    expect(waitForRoomEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        since: "driver-sync-start",
      }),
    );
    expect(waitForRoomEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        predicate: expect.any(Function),
        since: "driver-sync-intro",
      }),
    );
    const introPredicate = waitForRoomEvent.mock.calls[0]?.[0]?.predicate as
      | ((event: MatrixQaObservedEvent) => boolean)
      | undefined;
    expect(() =>
      introPredicate?.({
        kind: "message",
        roomId: "!main:matrix-qa.test",
        eventId: "$missing-hook-error",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: MATRIX_SUBAGENT_MISSING_HOOK_ERROR,
      }),
    ).toThrow("missing hook error");
  });

  it("fails the subagent thread spawn scenario when Matrix lacks subagent hooks", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$subagent-spawn-trigger");
    const waitForRoomEvent = vi.fn().mockImplementationOnce(async (options) => {
      const event = {
        kind: "message",
        roomId: "!main:matrix-qa.test",
        eventId: "$missing-hook-error",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: MATRIX_SUBAGENT_MISSING_HOOK_ERROR,
      } satisfies MatrixQaObservedEvent;
      options.predicate(event);
      return {
        event,
        since: "driver-sync-error",
      };
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-subagent-thread-spawn",
    );
    expect(scenario).toBeDefined();

    await expect(runMatrixQaScenario(scenario!, matrixQaScenarioContext())).rejects.toThrow(
      "missing hook error",
    );

    expect(waitForRoomEvent).toHaveBeenCalledTimes(1);
  });

  it("captures quiet preview notices before the finalized Matrix reply", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$quiet-stream-trigger");
    const readFinalText = () =>
      /reply exactly `([^`]+)`/.exec(String(sendTextMessage.mock.calls[0]?.[0]?.body))?.[1] ??
      "MATRIX_QA_QUIET_STREAM_PREVIEW_COMPLETE";
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => ({
        event: {
          kind: "notice",
          roomId: "!main:matrix-qa.test",
          eventId: "$quiet-preview",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
        },
        since: "driver-sync-preview",
      }))
      .mockImplementationOnce(async () => ({
        event: {
          kind: "message",
          roomId: "!main:matrix-qa.test",
          eventId: "$quiet-final",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: readFinalText(),
          relatesTo: {
            relType: "m.replace",
            eventId: "$quiet-preview",
          },
        },
        since: "driver-sync-next",
      }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-room-quiet-streaming-preview",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        driverEventId: "$quiet-stream-trigger",
        previewEventId: "$quiet-preview",
        reply: {
          eventId: "$quiet-final",
        },
      },
    });

    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("Quiet streaming QA check"),
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
    expect(waitForRoomEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        since: "driver-sync-start",
      }),
    );
    expect(waitForRoomEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        predicate: expect.any(Function),
        since: "driver-sync-preview",
      }),
    );
  });

  it("preserves separate finalized block events when Matrix block streaming is enabled", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$block-stream-trigger");
    const readBlockText = (label: "First" | "Second") =>
      new RegExp(`${label} exact marker: \`([^\\\`]+)\``).exec(
        String(sendTextMessage.mock.calls[0]?.[0]?.body),
      )?.[1] ?? `MATRIX_QA_BLOCK_${label.toUpperCase()}_FIXED`;
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => ({
        event: {
          kind: "notice",
          roomId: "!main:matrix-qa.test",
          eventId: "$block-one",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: readBlockText("First"),
        },
        since: "driver-sync-block-one",
      }))
      .mockImplementationOnce(async () => ({
        event: {
          kind: "notice",
          roomId: "!main:matrix-qa.test",
          eventId: "$block-two",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: readBlockText("Second"),
        },
        since: "driver-sync-next",
      }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-room-block-streaming",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: "block",
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Block",
              requireMention: true,
              roomId: "!block:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        blockEventIds: ["$block-one", "$block-two"],
        driverEventId: "$block-stream-trigger",
      },
    });

    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("Block streaming QA check"),
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!block:matrix-qa.test",
    });
    expect(waitForRoomEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        since: "driver-sync-block-one",
      }),
    );
  });

  it("sends a real Matrix image attachment for image-understanding prompts", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendMediaMessage = vi.fn().mockResolvedValue("$image-understanding-trigger");
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => ({
        event: {
          kind: "message",
          roomId: "!media:matrix-qa.test",
          eventId: "$image-understanding-trigger",
          sender: "@driver:matrix-qa.test",
          type: "m.room.message",
          attachment: {
            kind: "image",
            filename: "red-top-blue-bottom.png",
            caption:
              "@sut:matrix-qa.test Image understanding check: describe the top and bottom colors in the attached image in one short sentence.",
          },
        },
        since: "driver-sync-attachment",
      }))
      .mockImplementationOnce(async () => ({
        event: {
          kind: "message",
          roomId: "!media:matrix-qa.test",
          eventId: "$sut-image-reply",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.",
        },
        since: "driver-sync-next",
      }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendMediaMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-room-image-understanding-attachment",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: scenarioTesting.MATRIX_QA_MEDIA_ROOM_KEY,
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Media",
              requireMention: true,
              roomId: "!media:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        attachmentFilename: "red-top-blue-bottom.png",
        driverEventId: "$image-understanding-trigger",
        reply: {
          eventId: "$sut-image-reply",
        },
      },
    });

    expect(sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Image understanding check"),
        contentType: "image/png",
        fileName: "red-top-blue-bottom.png",
        kind: "image",
        mentionUserIds: ["@sut:matrix-qa.test"],
        roomId: "!media:matrix-qa.test",
      }),
    );
    expect(waitForRoomEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        since: "driver-sync-attachment",
      }),
    );
  });

  it("waits for a real Matrix image attachment after image generation", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$image-generate-trigger");
    const waitForRoomEvent = vi.fn().mockResolvedValue({
      event: {
        kind: "message",
        roomId: "!media:matrix-qa.test",
        eventId: "$sut-image",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: "Protocol note: generated the QA lighthouse image successfully.",
        msgtype: "m.image",
        attachment: {
          kind: "image",
          filename: "qa-lighthouse.png",
        },
      },
      since: "driver-sync-next",
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-room-generated-image-delivery",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: scenarioTesting.MATRIX_QA_MEDIA_ROOM_KEY,
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Media",
              requireMention: true,
              roomId: "!media:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        attachmentEventId: "$sut-image",
        attachmentFilename: "qa-lighthouse.png",
        attachmentKind: "image",
        attachmentMsgtype: "m.image",
        driverEventId: "$image-generate-trigger",
      },
    });

    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("Image generation check: generate a QA lighthouse image"),
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!media:matrix-qa.test",
    });
  });

  it("covers every Matrix media msgtype with caption-triggered replies", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const mediaCases = MATRIX_QA_MEDIA_TYPE_COVERAGE_CASES.map((mediaCase) => ({
      ...mediaCase,
      eventId: `$media-${mediaCase.fileName}`,
    }));
    const sendMediaMessage = vi.fn().mockImplementation(async (opts: { fileName: string }) => {
      const mediaCase = mediaCases.find((entry) => entry.fileName === opts.fileName);
      return mediaCase?.eventId ?? "$unknown-media";
    });
    const waitForRoomEvent = vi.fn().mockImplementation(async () => {
      const callIndex = waitForRoomEvent.mock.calls.length - 1;
      const mediaCaseIndex = Math.floor(callIndex / 2);
      const mediaCase = mediaCases[mediaCaseIndex];
      const sendOpts = sendMediaMessage.mock.calls[mediaCaseIndex]?.[0];
      if (callIndex % 2 === 0) {
        return {
          event: {
            kind: "message",
            roomId: "!media:matrix-qa.test",
            eventId: mediaCase.eventId,
            sender: "@driver:matrix-qa.test",
            type: "m.room.message",
            msgtype: mediaCase.expectedMsgtype,
            attachment: {
              kind: mediaCase.expectedAttachmentKind,
              filename: mediaCase.fileName,
              caption: sendOpts?.body,
            },
          },
          since: `driver-sync-attachment-${callIndex}`,
        };
      }
      const token = String(sendOpts?.body).match(/MATRIX_QA_MEDIA_[A-Z]+_[A-Z0-9]+/)?.[0] ?? "";
      return {
        event: {
          kind: "message",
          roomId: "!media:matrix-qa.test",
          eventId: `$reply-${mediaCase.fileName}`,
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: token,
        },
        since: `driver-sync-reply-${callIndex}`,
      };
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendMediaMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find((entry) => entry.id === "matrix-media-type-coverage");
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: scenarioTesting.MATRIX_QA_MEDIA_ROOM_KEY,
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Media",
              requireMention: true,
              roomId: "!media:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        attachments: mediaCases.map((mediaCase) => ({
          eventId: mediaCase.eventId,
          filename: mediaCase.fileName,
          kind: mediaCase.expectedAttachmentKind,
          msgtype: mediaCase.expectedMsgtype,
        })),
        roomId: "!media:matrix-qa.test",
      },
    });

    expect(sendMediaMessage).toHaveBeenCalledTimes(mediaCases.length);
    for (const [index, mediaCase] of MATRIX_QA_MEDIA_TYPE_COVERAGE_CASES.entries()) {
      expect(sendMediaMessage).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          contentType: mediaCase.contentType,
          fileName: mediaCase.fileName,
          kind: mediaCase.kind,
          mentionUserIds: ["@sut:matrix-qa.test"],
        }),
      );
    }
    const firstReplyWait = waitForRoomEvent.mock.calls[1]?.[0];
    const firstToken =
      String(sendMediaMessage.mock.calls[0]?.[0]?.body).match(
        /MATRIX_QA_MEDIA_[A-Z]+_[A-Z0-9]+/,
      )?.[0] ?? "";
    expect(
      firstReplyWait.predicate({
        kind: "message",
        roomId: "!media:matrix-qa.test",
        eventId: "$verbose-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: `Sure, ${firstToken}`,
      }),
    ).toBe(false);
    expect(
      firstReplyWait.predicate({
        kind: "message",
        roomId: "!media:matrix-qa.test",
        eventId: "$exact-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: ` ${firstToken}\n`,
      }),
    ).toBe(true);
  });

  it("uses DM thread override scenarios against the provisioned DM room", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$dm-thread-trigger");
    const waitForRoomEvent = vi.fn().mockImplementation(async () => ({
      event: {
        kind: "message",
        roomId: "!dm:matrix-qa.test",
        eventId: "$sut-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendTextMessage.mock.calls[0]?.[0]?.body).replace(
          "reply with only this exact marker: ",
          "",
        ),
        relatesTo: {
          relType: "m.thread",
          eventId: "$dm-thread-trigger",
          inReplyToId: "$dm-thread-trigger",
          isFallingBack: true,
        },
      },
      since: "driver-sync-next",
    }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-dm-thread-reply-override",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: scenarioTesting.MATRIX_QA_DRIVER_DM_ROOM_KEY,
              kind: "dm",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "DM",
              requireMention: false,
              roomId: "!dm:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        driverEventId: "$dm-thread-trigger",
        reply: {
          relatesTo: {
            relType: "m.thread",
            eventId: "$dm-thread-trigger",
          },
        },
      },
    });
  });

  it("surfaces the shared DM session notice in the secondary DM room", async () => {
    const primePrimaryRoom = vi.fn().mockResolvedValue("driver-primary-sync-start");
    const sendPrimaryTextMessage = vi.fn().mockResolvedValue("$dm-primary-trigger");
    const waitPrimaryReply = vi.fn().mockImplementation(async () => ({
      event: {
        kind: "message",
        roomId: "!dm:matrix-qa.test",
        eventId: "$sut-primary-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendPrimaryTextMessage.mock.calls[0]?.[0]?.body).replace(
          "reply with only this exact marker: ",
          "",
        ),
      },
      since: "driver-primary-sync-next",
    }));
    const primeSecondaryReplyRoom = vi.fn().mockResolvedValue("driver-secondary-reply-sync-start");
    const sendSecondaryTextMessage = vi.fn().mockResolvedValue("$dm-secondary-trigger");
    const waitSecondaryReply = vi.fn().mockImplementation(async () => ({
      event: {
        kind: "message",
        roomId: "!dm-shared:matrix-qa.test",
        eventId: "$sut-secondary-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendSecondaryTextMessage.mock.calls[0]?.[0]?.body).replace(
          "reply with only this exact marker: ",
          "",
        ),
      },
      since: "driver-secondary-sync-next",
    }));
    const primeSecondaryNoticeRoom = vi
      .fn()
      .mockResolvedValue("driver-secondary-notice-sync-start");
    const waitSecondaryNotice = vi.fn().mockImplementation(async () => ({
      matched: true,
      event: {
        kind: "notice",
        roomId: "!dm-shared:matrix-qa.test",
        eventId: "$shared-notice",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: "This Matrix DM is sharing a session with another Matrix DM room. Set channels.matrix.dm.sessionScope to per-room to isolate each Matrix DM room.",
      },
      since: "driver-secondary-notice-sync-next",
    }));

    createMatrixQaClient
      .mockReturnValueOnce({
        primeRoom: primePrimaryRoom,
        sendTextMessage: sendPrimaryTextMessage,
        waitForRoomEvent: waitPrimaryReply,
      })
      .mockReturnValueOnce({
        primeRoom: primeSecondaryReplyRoom,
        sendTextMessage: sendSecondaryTextMessage,
        waitForRoomEvent: waitSecondaryReply,
      })
      .mockReturnValueOnce({
        primeRoom: primeSecondaryNoticeRoom,
        waitForOptionalRoomEvent: waitSecondaryNotice,
      });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-dm-shared-session-notice",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: scenarioTesting.MATRIX_QA_DRIVER_DM_ROOM_KEY,
              kind: "dm",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "DM",
              requireMention: false,
              roomId: "!dm:matrix-qa.test",
            },
            {
              key: scenarioTesting.MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
              kind: "dm",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "Shared DM",
              requireMention: false,
              roomId: "!dm-shared:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        noticeEventId: "$shared-notice",
        roomKey: scenarioTesting.MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
      },
    });

    expect(sendPrimaryTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("reply with only this exact marker:"),
      roomId: "!dm:matrix-qa.test",
    });
    expect(sendSecondaryTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("reply with only this exact marker:"),
      roomId: "!dm-shared:matrix-qa.test",
    });
    expect(waitSecondaryNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!dm-shared:matrix-qa.test",
      }),
    );
  });

  it("suppresses the shared DM notice when sessionScope is per-room", async () => {
    const primePrimaryRoom = vi.fn().mockResolvedValue("driver-primary-sync-start");
    const sendPrimaryTextMessage = vi.fn().mockResolvedValue("$dm-primary-trigger");
    const waitPrimaryReply = vi.fn().mockImplementation(async () => ({
      event: {
        kind: "message",
        roomId: "!dm:matrix-qa.test",
        eventId: "$sut-primary-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendPrimaryTextMessage.mock.calls[0]?.[0]?.body).replace(
          "reply with only this exact marker: ",
          "",
        ),
      },
      since: "driver-primary-sync-next",
    }));
    const primeSecondaryReplyRoom = vi.fn().mockResolvedValue("driver-secondary-reply-sync-start");
    const sendSecondaryTextMessage = vi.fn().mockResolvedValue("$dm-secondary-trigger");
    const waitSecondaryReply = vi.fn().mockImplementation(async () => ({
      event: {
        kind: "message",
        roomId: "!dm-shared:matrix-qa.test",
        eventId: "$sut-secondary-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendSecondaryTextMessage.mock.calls[0]?.[0]?.body).replace(
          "reply with only this exact marker: ",
          "",
        ),
      },
      since: "driver-secondary-sync-next",
    }));
    const primeSecondaryNoticeRoom = vi
      .fn()
      .mockResolvedValue("driver-secondary-notice-sync-start");
    const waitSecondaryNotice = vi.fn().mockImplementation(async () => ({
      matched: false,
      since: "driver-secondary-notice-sync-next",
    }));

    createMatrixQaClient
      .mockReturnValueOnce({
        primeRoom: primePrimaryRoom,
        sendTextMessage: sendPrimaryTextMessage,
        waitForRoomEvent: waitPrimaryReply,
      })
      .mockReturnValueOnce({
        primeRoom: primeSecondaryReplyRoom,
        sendTextMessage: sendSecondaryTextMessage,
        waitForRoomEvent: waitSecondaryReply,
      })
      .mockReturnValueOnce({
        primeRoom: primeSecondaryNoticeRoom,
        waitForOptionalRoomEvent: waitSecondaryNotice,
      });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-dm-per-room-session-override",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: scenarioTesting.MATRIX_QA_DRIVER_DM_ROOM_KEY,
              kind: "dm",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "DM",
              requireMention: false,
              roomId: "!dm:matrix-qa.test",
            },
            {
              key: scenarioTesting.MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
              kind: "dm",
              memberRoles: ["driver", "sut"],
              memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
              name: "Shared DM",
              requireMention: false,
              roomId: "!dm-shared:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        roomKey: scenarioTesting.MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
      },
    });

    expect(waitSecondaryNotice).toHaveBeenCalledTimes(1);
  });

  it("auto-joins a freshly invited Matrix group room before replying", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const createPrivateRoom = vi.fn().mockResolvedValue("!autojoin:matrix-qa.test");
    const sendTextMessage = vi.fn().mockResolvedValue("$autojoin-trigger");
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => ({
        event: {
          kind: "membership",
          roomId: "!autojoin:matrix-qa.test",
          eventId: "$autojoin-join",
          sender: "@sut:matrix-qa.test",
          stateKey: "@sut:matrix-qa.test",
          type: "m.room.member",
          membership: "join",
        },
        since: "driver-sync-join",
      }))
      .mockImplementationOnce(async () => ({
        event: {
          kind: "message",
          roomId: "!autojoin:matrix-qa.test",
          eventId: "$sut-autojoin-reply",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: String(sendTextMessage.mock.calls[0]?.[0]?.body).replace(
            "@sut:matrix-qa.test reply with only this exact marker: ",
            "",
          ),
        },
        since: "driver-sync-next",
      }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      createPrivateRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-room-autojoin-invite",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        joinedRoomId: "!autojoin:matrix-qa.test",
        membershipJoinEventId: "$autojoin-join",
      },
    });

    expect(createPrivateRoom).toHaveBeenCalledWith({
      inviteUserIds: ["@observer:matrix-qa.test", "@sut:matrix-qa.test"],
      name: expect.stringContaining("Matrix QA AutoJoin"),
    });
    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("@sut:matrix-qa.test reply with only this exact marker:"),
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!autojoin:matrix-qa.test",
    });
  });

  it("runs the secondary-room scenario against the provisioned secondary room", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$secondary-trigger");
    const waitForRoomEvent = vi.fn().mockImplementation(async () => ({
      event: {
        roomId: "!secondary:matrix-qa.test",
        eventId: "$sut-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: String(sendTextMessage.mock.calls[0]?.[0]?.body).replace(
          "@sut:matrix-qa.test reply with only this exact marker: ",
          "",
        ),
      },
      since: "driver-sync-next",
    }));

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-secondary-room-reply",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
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
              name: "Main",
              requireMention: true,
              roomId: "!main:matrix-qa.test",
            },
            {
              key: scenarioTesting.MATRIX_QA_SECONDARY_ROOM_KEY,
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "Secondary",
              requireMention: true,
              roomId: "!secondary:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        actorUserId: "@driver:matrix-qa.test",
      },
    });

    expect(sendTextMessage).toHaveBeenCalledWith({
      body: expect.stringContaining("@sut:matrix-qa.test"),
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!secondary:matrix-qa.test",
    });
    expect(waitForRoomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!secondary:matrix-qa.test",
      }),
    );
  });

  it("ignores stale E2EE replies when checking a verification notice", async () => {
    let noticeToken = "";
    const sendNoticeMessage = vi.fn().mockImplementation(async ({ body }) => {
      noticeToken = body.match(/MATRIX_QA_E2EE_VERIFY_NOTICE_[A-Z0-9]+/)?.[0] ?? "";
      return "$verification-notice";
    });
    const waitForOptionalRoomEvent = vi.fn().mockImplementation(async (params) => {
      expect(
        params.predicate({
          body: "MATRIX_QA_E2EE_AFTER_RESTART_STALE",
          eventId: "$stale-reply",
          originServerTs: Date.now() - 60_000,
          roomId: "!e2ee:matrix-qa.test",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
        }),
      ).toBe(false);
      expect(
        params.predicate({
          body: noticeToken,
          eventId: "$token-reply",
          roomId: "!e2ee:matrix-qa.test",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
        }),
      ).toBe(true);
      expect(
        params.predicate({
          eventId: "$related-reply",
          relatesTo: {
            inReplyToId: "$verification-notice",
          },
          roomId: "!e2ee:matrix-qa.test",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
        }),
      ).toBe(true);
      expect(
        params.predicate({
          eventId: "$new-unrelated-reply",
          originServerTs: Date.now() + 1_000,
          roomId: "!e2ee:matrix-qa.test",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
        }),
      ).toBe(true);
      return {
        matched: false,
        since: "e2ee:next",
      };
    });

    createMatrixQaE2eeScenarioClient.mockResolvedValue({
      prime: vi.fn().mockResolvedValue("e2ee:start"),
      sendNoticeMessage,
      stop: vi.fn().mockResolvedValue(undefined),
      waitForOptionalRoomEvent,
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-e2ee-verification-notice-no-trigger",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverDeviceId: "DRIVERDEVICE",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        outputDir: "/tmp/matrix-qa",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: matrixQaE2eeRoomKey("matrix-e2ee-verification-notice-no-trigger"),
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "E2EE",
              requireMention: true,
              roomId: "!e2ee:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        noticeEventId: "$verification-notice",
        roomId: "!e2ee:matrix-qa.test",
      },
    });

    expect(noticeToken).toMatch(/^MATRIX_QA_E2EE_VERIFY_NOTICE_[A-Z0-9]+$/);
    expect(waitForOptionalRoomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!e2ee:matrix-qa.test",
      }),
    );
  });

  it("applies a recovery key before restoring backed up room keys", async () => {
    const verifyWithRecoveryKey = vi.fn().mockResolvedValue({
      backup: {
        keyLoadError: null,
        serverVersion: "backup-v1",
        trusted: true,
      },
      backupUsable: true,
      deviceOwnerVerified: true,
      recoveryKeyAccepted: true,
      success: true,
    });
    const restoreRoomKeyBackup = vi.fn().mockResolvedValue({
      imported: 1,
      loadedFromSecretStorage: true,
      success: true,
      total: 1,
    });
    const resetRoomKeyBackup = vi.fn().mockResolvedValue({
      createdVersion: "backup-v2",
      deletedVersion: "backup-v1",
      previousVersion: "backup-v1",
      success: true,
    });
    const driverStop = vi.fn().mockResolvedValue(undefined);
    const recoveryStop = vi.fn().mockResolvedValue(undefined);
    createMatrixQaClient.mockReturnValue({
      loginWithPassword: vi.fn().mockResolvedValue({
        accessToken: "recovery-token",
        deviceId: "RECOVERYDEVICE",
        password: "driver-password",
        userId: "@driver:matrix-qa.test",
      }),
    });
    createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce({
        bootstrapOwnDeviceVerification: vi.fn().mockResolvedValue({
          crossSigning: {
            published: true,
          },
          success: true,
          verification: {
            backupVersion: "backup-v1",
            crossSigningVerified: true,
            recoveryKeyStored: true,
            signedByOwner: true,
            verified: true,
          },
        }),
        deleteOwnDevices: vi.fn().mockResolvedValue(undefined),
        getRecoveryKey: vi.fn().mockResolvedValue({
          encodedPrivateKey: "encoded-recovery-key",
          keyId: "SSSS",
        }),
        sendTextMessage: vi.fn().mockResolvedValue("$seeded-event"),
        stop: driverStop,
      })
      .mockResolvedValueOnce({
        resetRoomKeyBackup,
        restoreRoomKeyBackup,
        stop: recoveryStop,
        verifyWithRecoveryKey,
      });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-e2ee-recovery-key-lifecycle",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        outputDir: "/tmp/matrix-qa",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              encrypted: true,
              key: matrixQaE2eeRoomKey("matrix-e2ee-recovery-key-lifecycle"),
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "E2EE",
              requireMention: true,
              roomId: "!e2ee:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        backupRestored: true,
        recoveryDeviceId: "RECOVERYDEVICE",
        recoveryKeyUsable: true,
        recoveryVerified: true,
        restoreImported: 1,
        restoreTotal: 1,
      },
    });

    expect(verifyWithRecoveryKey).toHaveBeenCalledWith("encoded-recovery-key");
    expect(verifyWithRecoveryKey.mock.invocationCallOrder[0]).toBeLessThan(
      restoreRoomKeyBackup.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("keeps recovery-key backup access distinct from Matrix identity trust in Matrix E2EE QA", async () => {
    const verifyWithRecoveryKey = vi.fn().mockResolvedValue({
      backupUsable: true,
      deviceOwnerVerified: false,
      error:
        "Matrix recovery key was applied, but this device still lacks full Matrix identity trust.",
      recoveryKeyAccepted: true,
      success: false,
    });
    const restoreRoomKeyBackup = vi.fn().mockResolvedValue({
      imported: 1,
      loadedFromSecretStorage: true,
      success: true,
      total: 1,
    });
    const driverDeleteOwnDevices = vi.fn().mockResolvedValue(undefined);
    const driverStop = vi.fn().mockResolvedValue(undefined);
    const recoveryStop = vi.fn().mockResolvedValue(undefined);
    const proxyStop = vi.fn().mockResolvedValue(undefined);
    const proxyHits = vi.fn().mockReturnValue([
      {
        method: "POST",
        path: "/_matrix/client/v3/keys/signatures/upload",
        ruleId: "owner-signature-upload-blocked",
      },
    ]);
    startMatrixQaFaultProxy.mockResolvedValue({
      baseUrl: "http://127.0.0.1:39877",
      hits: proxyHits,
      stop: proxyStop,
    });
    createMatrixQaClient.mockReturnValue({
      loginWithPassword: vi.fn().mockResolvedValue({
        accessToken: "recovery-token",
        deviceId: "RECOVERYDEVICE",
        password: "driver-password",
        userId: "@driver:matrix-qa.test",
      }),
    });
    createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce({
        bootstrapOwnDeviceVerification: vi.fn().mockResolvedValue({
          crossSigning: {
            published: true,
          },
          success: true,
          verification: {
            backupVersion: "backup-v1",
            crossSigningVerified: true,
            recoveryKeyStored: true,
            signedByOwner: true,
            verified: true,
          },
        }),
        deleteOwnDevices: driverDeleteOwnDevices,
        getRecoveryKey: vi.fn().mockResolvedValue({
          encodedPrivateKey: "encoded-recovery-key",
          keyId: "SSSS",
        }),
        sendTextMessage: vi.fn().mockResolvedValue("$seeded-event"),
        stop: driverStop,
      })
      .mockResolvedValueOnce({
        restoreRoomKeyBackup,
        stop: recoveryStop,
        verifyWithRecoveryKey,
      });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-e2ee-recovery-owner-verification-required",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        outputDir: "/tmp/matrix-qa",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              encrypted: true,
              key: matrixQaE2eeRoomKey("matrix-e2ee-recovery-owner-verification-required"),
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "E2EE",
              requireMention: true,
              roomId: "!e2ee:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        backupRestored: true,
        backupUsable: true,
        faultHitCount: 1,
        faultRuleId: "owner-signature-upload-blocked",
        recoveryDeviceId: "RECOVERYDEVICE",
        recoveryKeyAccepted: true,
        recoveryVerified: false,
        restoreImported: 1,
        restoreTotal: 1,
        verificationSuccess: false,
      },
    });

    const proxyArgs = startMatrixQaFaultProxy.mock.calls[0]?.[0];
    expect(proxyArgs).toBeDefined();
    if (!proxyArgs) {
      throw new Error("expected Matrix QA fault proxy to start");
    }
    const [faultRule] = proxyArgs.rules;
    expect(faultRule).toBeDefined();
    if (!faultRule) {
      throw new Error("expected Matrix QA fault proxy rule");
    }
    expect(proxyArgs.targetBaseUrl).toBe("http://127.0.0.1:28008/");
    expect(
      faultRule.match({
        bearerToken: "recovery-token",
        headers: {},
        method: "POST",
        path: "/_matrix/client/v3/keys/signatures/upload",
        search: "",
      }),
    ).toBe(true);
    expect(
      faultRule.match({
        bearerToken: "recovery-token",
        headers: {},
        method: "GET",
        path: "/_matrix/client/v3/user/%40driver%3Amatrix-qa.test/account_data/m.megolm_backup.v1",
        search: "",
      }),
    ).toBe(false);
    expect(createMatrixQaE2eeScenarioClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accessToken: "recovery-token",
        baseUrl: "http://127.0.0.1:39877",
        deviceId: "RECOVERYDEVICE",
        scenarioId: "matrix-e2ee-recovery-owner-verification-required",
      }),
    );
    expect(verifyWithRecoveryKey).toHaveBeenCalledWith("encoded-recovery-key");
    expect(restoreRoomKeyBackup).toHaveBeenCalledWith({
      recoveryKey: "encoded-recovery-key",
    });
    expect(driverDeleteOwnDevices).toHaveBeenCalledWith(["RECOVERYDEVICE"]);
    expect(recoveryStop).toHaveBeenCalledTimes(1);
    expect(proxyStop).toHaveBeenCalledTimes(1);
  });

  it("runs Matrix self-verification through the interactive CLI command", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-cli-self-verification-"));
    try {
      const acceptVerification = vi.fn().mockResolvedValue(undefined);
      const confirmVerificationSas = vi.fn().mockResolvedValue(undefined);
      const deleteOwnDevices = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const bootstrapOwnDeviceVerification = vi.fn().mockResolvedValue({
        crossSigning: {
          published: true,
        },
        success: true,
        verification: {
          backupVersion: "backup-v1",
          crossSigningVerified: true,
          recoveryKeyStored: true,
          signedByOwner: true,
          verified: true,
        },
      });
      const baseSummary = {
        canAccept: false,
        chosenMethod: "m.sas.v1",
        completed: false,
        createdAt: "2026-04-22T12:00:00.000Z",
        error: undefined,
        hasReciprocateQr: false,
        methods: ["m.sas.v1"],
        otherDeviceId: "CLIDEVICE",
        otherUserId: "@driver:matrix-qa.test",
        pending: true,
        phase: 2,
        phaseName: "ready",
        roomId: undefined,
        transactionId: "tx-cli-self",
        updatedAt: "2026-04-22T12:00:00.000Z",
      };
      const listVerifications = vi
        .fn()
        .mockResolvedValueOnce([
          {
            ...baseSummary,
            canAccept: true,
            hasSas: false,
            id: "owner-request",
            initiatedByMe: false,
            isSelfVerification: true,
            phaseName: "requested",
          },
        ])
        .mockResolvedValueOnce([
          {
            ...baseSummary,
            hasSas: true,
            id: "owner-request",
            initiatedByMe: false,
            isSelfVerification: true,
            sas: {
              emoji: [["🐶", "Dog"]],
            },
          },
        ])
        .mockResolvedValueOnce([
          {
            ...baseSummary,
            completed: true,
            hasSas: true,
            id: "owner-request",
            initiatedByMe: false,
            isSelfVerification: true,
            pending: false,
            phaseName: "done",
            sas: {
              emoji: [["🐶", "Dog"]],
            },
          },
        ]);
      createMatrixQaClient.mockReturnValue({
        loginWithPassword: vi.fn().mockResolvedValue({
          accessToken: "cli-token",
          deviceId: "CLIDEVICE",
          password: "driver-password",
          userId: "@driver:matrix-qa.test",
        }),
      });
      createMatrixQaE2eeScenarioClient.mockResolvedValueOnce({
        acceptVerification,
        bootstrapOwnDeviceVerification,
        confirmVerificationSas,
        deleteOwnDevices,
        getRecoveryKey: vi.fn().mockResolvedValue({
          encodedPrivateKey: "encoded-recovery-key",
          keyId: "SSSS",
        }),
        listVerifications,
        stop,
      });
      const waitForOutput = vi
        .fn()
        .mockResolvedValueOnce({
          stderr: "",
          stdout:
            "Verification id: verification-1\nTransaction id: tx-cli-self\nAccept this verification request in another Matrix client.\n",
          text: "Verification id: verification-1\nTransaction id: tx-cli-self\nAccept this verification request in another Matrix client.\n",
        })
        .mockResolvedValueOnce({
          stderr: "",
          stdout: "Verification id: verification-1\nSAS emoji: 🐶 Dog\n",
          text: "Verification id: verification-1\nSAS emoji: 🐶 Dog\n",
        });
      const writeStdin = vi.fn().mockResolvedValue(undefined);
      const wait = vi.fn().mockResolvedValue({
        args: ["matrix", "verify", "self", "--account", "cli"],
        exitCode: 0,
        stderr: "",
        stdout:
          "Verification id: verification-1\nCompleted: yes\nDevice verified by owner: yes\nCross-signing verified: yes\n",
      });
      const kill = vi.fn();
      startMatrixQaOpenClawCli.mockReturnValue({
        args: ["matrix", "verify", "self", "--account", "cli"],
        kill,
        output: vi.fn(() => ({ stderr: "", stdout: "" })),
        wait,
        waitForOutput,
        writeStdin,
      });
      let cliAccountConfigDuringRun: Record<string, unknown> | null = null;
      runMatrixQaOpenClawCli.mockImplementation(async ({ args, env }) => {
        if (!cliAccountConfigDuringRun && env.OPENCLAW_CONFIG_PATH) {
          const cliConfig = JSON.parse(
            await readFile(String(env.OPENCLAW_CONFIG_PATH), "utf8"),
          ) as {
            channels?: {
              matrix?: {
                accounts?: Record<string, Record<string, unknown>>;
              };
            };
          };
          cliAccountConfigDuringRun = cliConfig.channels?.matrix?.accounts?.cli ?? null;
        }
        const joined = args.join(" ");
        if (joined === "matrix verify status --account cli --json") {
          return {
            args,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              backup: {
                decryptionKeyCached: true,
                keyLoadError: null,
                matchesDecryptionKey: true,
                trusted: true,
              },
              crossSigningVerified: true,
              deviceId: "CLIDEVICE",
              signedByOwner: true,
              userId: "@driver:matrix-qa.test",
              verified: true,
            }),
          };
        }
        if (
          joined ===
          "matrix verify backup restore --account cli --recovery-key encoded-recovery-key --json"
        ) {
          return {
            args,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              backup: {
                decryptionKeyCached: true,
                keyLoadError: null,
                matchesDecryptionKey: true,
                trusted: false,
              },
              success: true,
            }),
          };
        }
        throw new Error(`unexpected CLI command: ${joined}`);
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-self-verification",
      );
      expect(scenario).toBeDefined();

      await expect(
        runMatrixQaScenario(scenario!, {
          ...matrixQaScenarioContext(),
          driverDeviceId: "DRIVERDEVICE",
          driverPassword: "driver-password",
          gatewayRuntimeEnv: {
            OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
            OPENCLAW_STATE_DIR: "/tmp/gateway-state",
            PATH: process.env.PATH,
          },
          outputDir,
        }),
      ).resolves.toMatchObject({
        artifacts: {
          completedVerificationIds: ["verification-1", "owner-request"],
          currentDeviceId: "CLIDEVICE",
          sasEmoji: ["🐶 Dog"],
          secondaryDeviceId: "CLIDEVICE",
        },
      });

      expect(startMatrixQaOpenClawCli).toHaveBeenCalledTimes(1);
      expect(startMatrixQaOpenClawCli.mock.calls[0]?.[0].args).toEqual([
        "matrix",
        "verify",
        "self",
        "--account",
        "cli",
      ]);
      expect(waitForOutput).toHaveBeenCalledTimes(2);
      expect(writeStdin).toHaveBeenCalledWith("yes\n");
      expect(wait).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(runMatrixQaOpenClawCli).toHaveBeenCalledTimes(2);
      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        [
          "matrix",
          "verify",
          "backup",
          "restore",
          "--account",
          "cli",
          "--recovery-key",
          "encoded-recovery-key",
          "--json",
        ],
        ["matrix", "verify", "status", "--account", "cli", "--json"],
      ]);
      const cliEnv = startMatrixQaOpenClawCli.mock.calls[0]?.[0].env;
      expect(cliEnv?.OPENCLAW_STATE_DIR).toContain("openclaw-matrix-cli-qa-");
      expect(cliEnv?.OPENCLAW_CONFIG_PATH).toContain("openclaw-matrix-cli-qa-");
      const configPath = String(cliEnv?.OPENCLAW_CONFIG_PATH);
      expect(cliAccountConfigDuringRun).toMatchObject({
        accessToken: "cli-token",
        deviceId: "CLIDEVICE",
        encryption: true,
        homeserver: "http://127.0.0.1:28008/",
        startupVerification: "off",
        userId: "@driver:matrix-qa.test",
      });
      await expect(readFile(configPath, "utf8")).rejects.toThrow();
      await expect(readdir(String(cliEnv?.OPENCLAW_STATE_DIR))).rejects.toThrow();
      expect(acceptVerification).toHaveBeenCalledWith("owner-request");
      expect(confirmVerificationSas).toHaveBeenCalledWith("owner-request");
      expect(deleteOwnDevices).toHaveBeenCalledWith(["CLIDEVICE"]);
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-self-verification"));
      const cliArtifactDir = path.join(outputDir, "cli-self-verification", cliRunDir ?? "");
      await expect(stat(cliArtifactDir)).resolves.toMatchObject({ mode: expect.any(Number) });
      expect((await stat(cliArtifactDir)).mode & 0o777).toBe(0o700);
      await expect(
        readFile(path.join(cliArtifactDir, "verify-backup-restore.stdout.txt"), "utf8"),
      ).resolves.toContain('"success":true');
      expect(
        (await stat(path.join(cliArtifactDir, "verify-backup-restore.stdout.txt"))).mode & 0o777,
      ).toBe(0o600);
      await expect(
        readFile(path.join(cliArtifactDir, "verify-self.stdout.txt"), "utf8"),
      ).resolves.toContain("Device verified by owner: yes");
      await expect(
        readFile(path.join(cliArtifactDir, "verify-self.stdout.txt"), "utf8"),
      ).resolves.toContain("Cross-signing verified: yes");
      await expect(
        readFile(path.join(cliArtifactDir, "verify-status.stdout.txt"), "utf8"),
      ).resolves.toContain('"verified":true');
      await expect(
        readFile(path.join(cliArtifactDir, "verify-status.stdout.txt"), "utf8"),
      ).resolves.toContain('"crossSigningVerified":true');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix E2EE bootstrap failure through a real faulted homeserver endpoint", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const hits = vi.fn().mockReturnValue([
      {
        method: "GET",
        path: "/_matrix/client/v3/room_keys/version",
        ruleId: "room-key-backup-version-unavailable",
      },
    ]);
    startMatrixQaFaultProxy.mockResolvedValue({
      baseUrl: "http://127.0.0.1:39876",
      hits,
      stop,
    });
    runMatrixQaE2eeBootstrap.mockResolvedValue({
      crossSigning: {
        masterKeyPublished: true,
        published: true,
        selfSigningKeyPublished: true,
        userId: "@driver:matrix-qa.test",
        userSigningKeyPublished: true,
      },
      cryptoBootstrap: null,
      error: "Matrix room key backup is still missing after bootstrap",
      pendingVerifications: 0,
      success: false,
      verification: {
        backup: {
          activeVersion: null,
          enabled: false,
          keyCached: false,
          trusted: false,
        },
        deviceId: "DRIVERDEVICE",
        userId: "@driver:matrix-qa.test",
        verified: true,
      },
    });

    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-e2ee-key-bootstrap-failure",
    );
    expect(scenario).toBeDefined();

    await expect(
      runMatrixQaScenario(scenario!, {
        baseUrl: "http://127.0.0.1:28008/",
        canary: undefined,
        driverAccessToken: "driver-token",
        driverDeviceId: "DRIVERDEVICE",
        driverUserId: "@driver:matrix-qa.test",
        observedEvents: [],
        observerAccessToken: "observer-token",
        observerUserId: "@observer:matrix-qa.test",
        outputDir: "/tmp/matrix-qa",
        roomId: "!main:matrix-qa.test",
        restartGateway: undefined,
        syncState: {},
        sutAccessToken: "sut-token",
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        topology: {
          defaultRoomId: "!main:matrix-qa.test",
          defaultRoomKey: "main",
          rooms: [
            {
              key: matrixQaE2eeRoomKey("matrix-e2ee-key-bootstrap-failure"),
              kind: "group",
              memberRoles: ["driver", "observer", "sut"],
              memberUserIds: [
                "@driver:matrix-qa.test",
                "@observer:matrix-qa.test",
                "@sut:matrix-qa.test",
              ],
              name: "E2EE",
              requireMention: true,
              roomId: "!e2ee:matrix-qa.test",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      artifacts: {
        bootstrapActor: "driver",
        bootstrapSuccess: false,
        faultedEndpoint: "/_matrix/client/v3/room_keys/version",
        faultHitCount: 1,
        faultRuleId: "room-key-backup-version-unavailable",
      },
    });

    const proxyArgs = startMatrixQaFaultProxy.mock.calls[0]?.[0];
    expect(proxyArgs).toBeDefined();
    if (!proxyArgs) {
      throw new Error("expected Matrix QA fault proxy to start");
    }
    const [faultRule] = proxyArgs.rules;
    expect(faultRule).toBeDefined();
    if (!faultRule) {
      throw new Error("expected Matrix QA fault proxy rule");
    }
    expect(proxyArgs.targetBaseUrl).toBe("http://127.0.0.1:28008/");
    expect(
      faultRule.match({
        bearerToken: "driver-token",
        headers: {},
        method: "GET",
        path: "/_matrix/client/v3/room_keys/version",
        search: "",
      }),
    ).toBe(true);
    expect(runMatrixQaE2eeBootstrap).toHaveBeenCalledWith({
      accessToken: "driver-token",
      actorId: "driver",
      baseUrl: "http://127.0.0.1:39876",
      deviceId: "DRIVERDEVICE",
      outputDir: "/tmp/matrix-qa",
      scenarioId: "matrix-e2ee-key-bootstrap-failure",
      timeoutMs: 8_000,
      userId: "@driver:matrix-qa.test",
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
