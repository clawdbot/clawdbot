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
    registrationToken: "registration-token",
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

function mockMatrixQaCliAccount(params: {
  accessToken: string;
  deviceId: string;
  localpart?: string;
  password?: string;
  userId?: string;
}) {
  const password = params.password ?? "cli-password";
  const userId = params.userId ?? "@cli:matrix-qa.test";
  const account = {
    accessToken: params.accessToken,
    deviceId: params.deviceId,
    localpart: params.localpart ?? "qa-cli-test",
    password,
    userId,
  };
  const registerWithToken = vi.fn().mockResolvedValue(account);
  const loginWithPassword = vi.fn().mockResolvedValue(account);
  const inviteUserToRoom = vi.fn().mockResolvedValue({ eventId: "$invite" });
  const joinRoom = vi.fn().mockResolvedValue({ roomId: "!joined:matrix-qa.test" });
  createMatrixQaClient.mockReturnValue({
    inviteUserToRoom,
    joinRoom,
    loginWithPassword,
    registerWithToken,
  });
  return {
    account,
    inviteUserToRoom,
    joinRoom,
    loginWithPassword,
    registerWithToken,
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
      "matrix-e2ee-cli-account-add-enable-e2ee",
      "matrix-e2ee-cli-encryption-setup",
      "matrix-e2ee-cli-encryption-setup-idempotent",
      "matrix-e2ee-cli-encryption-setup-bootstrap-failure",
      "matrix-e2ee-cli-recovery-key-setup",
      "matrix-e2ee-cli-recovery-key-invalid",
      "matrix-e2ee-cli-encryption-setup-multi-account",
      "matrix-e2ee-cli-setup-then-gateway-reply",
      "matrix-e2ee-cli-self-verification",
      "matrix-e2ee-state-loss-external-recovery-key",
      "matrix-e2ee-state-loss-stored-recovery-key",
      "matrix-e2ee-state-loss-no-recovery-key",
      "matrix-e2ee-stale-recovery-key-after-backup-reset",
      "matrix-e2ee-server-backup-deleted-local-state-intact",
      "matrix-e2ee-server-backup-deleted-local-reupload-restores",
      "matrix-e2ee-corrupt-crypto-idb-snapshot",
      "matrix-e2ee-server-device-deleted-local-state-intact",
      "matrix-e2ee-server-device-deleted-relogin-recovers",
      "matrix-e2ee-sync-state-loss-crypto-intact",
      "matrix-e2ee-history-exists-backup-empty",
      "matrix-e2ee-device-sas-verification",
      "matrix-e2ee-qr-verification",
      "matrix-e2ee-stale-device-hygiene",
      "matrix-e2ee-dm-sas-verification",
      "matrix-e2ee-restart-resume",
      "matrix-e2ee-verification-notice-no-trigger",
      "matrix-e2ee-artifact-redaction",
      "matrix-e2ee-media-image",
      "matrix-e2ee-key-bootstrap-failure",
      "matrix-e2ee-wrong-account-recovery-key",
    ]);
  });

  it("keeps account-mutating E2EE negative coverage at the suite tail", () => {
    const scenarioIds = scenarioTesting.findMatrixQaScenarios().map((scenario) => scenario.id);
    const destructiveScenarioId = "matrix-e2ee-wrong-account-recovery-key";
    const destructiveIndex = scenarioIds.indexOf(destructiveScenarioId);

    expect(scenarioIds.at(-1)).toBe(destructiveScenarioId);
    const protectedScenarioIds = [
      "matrix-e2ee-state-loss-external-recovery-key",
      "matrix-e2ee-state-loss-stored-recovery-key",
      "matrix-e2ee-device-sas-verification",
      "matrix-e2ee-qr-verification",
      "matrix-e2ee-dm-sas-verification",
      "matrix-e2ee-media-image",
    ] satisfies (typeof scenarioIds)[number][];
    for (const scenarioId of protectedScenarioIds) {
      expect(destructiveIndex).toBeGreaterThan(scenarioIds.indexOf(scenarioId));
    }
  });

  it("keeps the Matrix CLI default profile on the full catalog", () => {
    const allIds = scenarioTesting.findMatrixQaScenarios().map((scenario) => scenario.id);

    expect(
      scenarioTesting.findMatrixQaScenarios(undefined, "all").map((scenario) => scenario.id),
    ).toEqual(allIds);
  });

  it("selects the fast release-critical Matrix profile without media or deep E2EE inventory", () => {
    expect(
      scenarioTesting.findMatrixQaScenarios(undefined, "fast").map((scenario) => scenario.id),
    ).toEqual([
      "matrix-thread-follow-up",
      "matrix-thread-isolation",
      "matrix-top-level-reply-shape",
      "matrix-reaction-notification",
      "matrix-restart-resume",
      "matrix-mention-gating",
      "matrix-allowlist-block",
      "matrix-e2ee-basic-reply",
    ]);
  });

  it("keeps the full Matrix shard profiles exhaustive and disjoint", () => {
    const allIds = scenarioTesting.findMatrixQaScenarios().map((scenario) => scenario.id);
    const shardIds = ["transport", "media", "e2ee-smoke", "e2ee-deep", "e2ee-cli"].flatMap(
      (profile) =>
        scenarioTesting.findMatrixQaScenarios(undefined, profile).map((scenario) => scenario.id),
    );

    expect(new Set(shardIds).size).toBe(shardIds.length);
    expect(shardIds.toSorted()).toEqual(allIds.toSorted());
  });

  it("lets explicit Matrix scenario ids override the selected profile", () => {
    expect(
      scenarioTesting
        .findMatrixQaScenarios(["matrix-room-generated-image-delivery"], "fast")
        .map((scenario) => scenario.id),
    ).toEqual(["matrix-room-generated-image-delivery"]);
  });

  it("fails when the Matrix profile is unknown", () => {
    expect(() => scenarioTesting.findMatrixQaScenarios(undefined, "speedy")).toThrow(
      'unknown Matrix QA profile "speedy"',
    );
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
    expect(scenarios.get("matrix-room-block-streaming")?.timeoutMs).toBeGreaterThanOrEqual(75_000);
    expect(scenarios.get("matrix-e2ee-restart-resume")?.timeoutMs).toBeGreaterThanOrEqual(150_000);
    expect(scenarios.get("matrix-e2ee-artifact-redaction")?.timeoutMs).toBeGreaterThanOrEqual(
      150_000,
    );
    expect(scenarios.get("matrix-e2ee-media-image")?.timeoutMs).toBeGreaterThanOrEqual(180_000);
    expect(
      scenarios.get("matrix-e2ee-cli-account-add-enable-e2ee")?.timeoutMs,
    ).toBeGreaterThanOrEqual(120_000);
    expect(scenarios.get("matrix-e2ee-cli-encryption-setup")?.timeoutMs).toBeGreaterThanOrEqual(
      120_000,
    );
    expect(
      scenarios.get("matrix-e2ee-cli-encryption-setup-idempotent")?.timeoutMs,
    ).toBeGreaterThanOrEqual(120_000);
    expect(
      scenarios.get("matrix-e2ee-cli-encryption-setup-bootstrap-failure")?.timeoutMs,
    ).toBeGreaterThanOrEqual(120_000);
    expect(scenarios.get("matrix-e2ee-cli-recovery-key-setup")?.timeoutMs).toBeGreaterThanOrEqual(
      120_000,
    );
    expect(scenarios.get("matrix-e2ee-cli-recovery-key-invalid")?.timeoutMs).toBeGreaterThanOrEqual(
      120_000,
    );
    expect(
      scenarios.get("matrix-e2ee-cli-encryption-setup-multi-account")?.timeoutMs,
    ).toBeGreaterThanOrEqual(120_000);
    expect(
      scenarios.get("matrix-e2ee-cli-setup-then-gateway-reply")?.timeoutMs,
    ).toBeGreaterThanOrEqual(180_000);
  });

  it("keeps the Matrix subagent room policy compatible with leaf child sessions", () => {
    const scenario = MATRIX_QA_SCENARIOS.find(
      (entry) => entry.id === "matrix-subagent-thread-spawn",
    );

    expect(scenario?.configOverrides?.groupsByKey?.main?.tools?.allow).toEqual([
      "sessions_spawn",
      "sessions_yield",
    ]);
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

  it("configures a fresh encrypted room before sync-state-loss recovery", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "matrix-sync-loss-"));
    try {
      const callOrder: string[] = [];
      const gatewayConfigPath = path.join(stateRoot, "gateway-config.json");
      const originalGroups = {
        "!previous:matrix-qa.test": {
          enabled: true,
          requireMention: true,
        },
      };
      const accountDir = path.join(
        stateRoot,
        "matrix",
        "accounts",
        "sync-state-loss-gateway",
        "server",
        "token",
      );
      const syncStorePath = path.join(accountDir, "bot-storage.json");
      await mkdir(accountDir, { recursive: true });
      await writeTestJsonFile(gatewayConfigPath, {
        channels: {
          matrix: {
            accounts: {
              sut: {
                accessToken: "sut-token",
                deviceId: "SUT",
                enabled: true,
                groups: originalGroups,
                homeserver: "http://127.0.0.1:28008/",
                password: "sut-password",
                userId: "@sut:matrix-qa.test",
              },
            },
            defaultAccount: "sut",
          },
        },
      });
      await writeTestJsonFile(path.join(accountDir, "storage-meta.json"), {
        accountId: "sync-state-loss-gateway",
        userId: "@sync-gateway:matrix-qa.test",
      });
      await writeTestJsonFile(syncStorePath, matrixSyncStoreFixture("sut-sync-before-loss"));

      const registerWithToken = vi.fn().mockResolvedValue({
        accessToken: "sync-gateway-token",
        deviceId: "SYNCGATEWAY",
        localpart: "qa-destructive-sync-state-loss",
        password: "sync-gateway-password",
        userId: "@sync-gateway:matrix-qa.test",
      });
      const createPrivateRoom = vi.fn(async () => {
        callOrder.push("create-room");
        return "!recovery:matrix-qa.test";
      });
      const primeRoom = vi.fn().mockResolvedValue("raw-driver-sync-start");
      const rawWaitForRoomEvent = vi.fn().mockResolvedValue({
        event: {
          eventId: "$sut-encrypted-reply",
          roomId: "!recovery:matrix-qa.test",
          sender: "@sync-gateway:matrix-qa.test",
          type: "m.room.encrypted",
        },
        since: "raw-driver-sync-after-reply",
      });
      const observerJoinRoom = vi.fn(async () => {
        callOrder.push("observer-join");
        return "!recovery:matrix-qa.test";
      });
      const sutJoinRoom = vi.fn(async () => {
        callOrder.push("sut-join");
        return "!recovery:matrix-qa.test";
      });
      createMatrixQaClient
        .mockReturnValueOnce({ registerWithToken })
        .mockReturnValueOnce({
          createPrivateRoom,
          primeRoom,
          waitForRoomEvent: rawWaitForRoomEvent,
        })
        .mockReturnValueOnce({ joinRoom: observerJoinRoom })
        .mockReturnValueOnce({ joinRoom: sutJoinRoom });

      const sendTextMessage = vi.fn().mockResolvedValue("$driver-trigger");
      const waitForRoomEvent = vi.fn().mockImplementation(async () => {
        const token = String(sendTextMessage.mock.calls[0]?.[0]?.body).replace(
          "@sync-gateway:matrix-qa.test reply with only this exact marker: ",
          "",
        );
        return {
          event: {
            body: token,
            eventId: "$sut-decrypted-reply",
            kind: "message",
            roomId: "!recovery:matrix-qa.test",
            sender: "@sync-gateway:matrix-qa.test",
            type: "m.room.message",
          },
        };
      });
      const stop = vi.fn().mockResolvedValue(undefined);
      createMatrixQaE2eeScenarioClient.mockResolvedValue({
        prime: vi.fn().mockResolvedValue("e2ee-driver-sync-start"),
        sendTextMessage,
        stop,
        waitForRoomEvent,
      });
      const hardRestartAccounts: Array<{
        accounts: Record<string, { groups?: Record<string, unknown>; userId?: string }>;
        defaultAccount?: string;
      }> = [];
      const waitGatewayAccountReady = vi.fn().mockResolvedValue(undefined);

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-sync-state-loss-crypto-intact",
      );
      expect(scenario).toBeDefined();

      await expect(
        runMatrixQaScenario(scenario!, {
          ...matrixQaScenarioContext(),
          driverDeviceId: "DRIVER",
          gatewayRuntimeEnv: {
            OPENCLAW_CONFIG_PATH: gatewayConfigPath,
            PATH: process.env.PATH,
          },
          gatewayStateDir: stateRoot,
          observerDeviceId: "OBSERVER",
          outputDir: stateRoot,
          restartGatewayAfterStateMutation: async (mutateState) => {
            callOrder.push("hard-restart");
            await mutateState({ stateDir: stateRoot });
            const config = JSON.parse(await readFile(gatewayConfigPath, "utf8")) as {
              channels: {
                matrix: {
                  accounts: Record<string, { groups?: Record<string, unknown>; userId?: string }>;
                  defaultAccount?: string;
                };
              };
            };
            hardRestartAccounts.push({
              accounts: config.channels.matrix.accounts,
              defaultAccount: config.channels.matrix.defaultAccount,
            });
          },
          sutAccountId: "sut",
          sutDeviceId: "SUT",
          waitGatewayAccountReady,
        }),
      ).resolves.toMatchObject({
        artifacts: {
          deletedSyncStorePath: syncStorePath,
          driverEventId: "$driver-trigger",
          replyEventId: "$sut-decrypted-reply",
          roomKey: "e2ee-sync-state-loss-crypto-intact-recovery",
        },
      });

      await expect(stat(syncStorePath)).rejects.toThrow();
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          registrationToken: "registration-token",
        }),
      );
      expect(createPrivateRoom).toHaveBeenCalledWith({
        encrypted: true,
        inviteUserIds: ["@observer:matrix-qa.test", "@sync-gateway:matrix-qa.test"],
        name: "Matrix QA E2EE Sync State Loss Recovery Room",
      });
      expect(observerJoinRoom).toHaveBeenCalledWith("!recovery:matrix-qa.test");
      expect(sutJoinRoom).toHaveBeenCalledWith("!recovery:matrix-qa.test");
      expect(hardRestartAccounts).toEqual([
        {
          accounts: {
            "sync-state-loss-gateway": expect.objectContaining({
              groups: {
                "!recovery:matrix-qa.test": {
                  enabled: true,
                  requireMention: true,
                },
              },
              userId: "@sync-gateway:matrix-qa.test",
            }),
          },
          defaultAccount: "sync-state-loss-gateway",
        },
        {
          accounts: {
            "sync-state-loss-gateway": expect.objectContaining({
              groups: {
                "!recovery:matrix-qa.test": {
                  enabled: true,
                  requireMention: true,
                },
              },
              userId: "@sync-gateway:matrix-qa.test",
            }),
          },
          defaultAccount: "sync-state-loss-gateway",
        },
        {
          accounts: {
            sut: expect.objectContaining({
              groups: originalGroups,
              userId: "@sut:matrix-qa.test",
            }),
          },
          defaultAccount: "sut",
        },
      ]);
      expect(callOrder).toEqual([
        "create-room",
        "observer-join",
        "sut-join",
        "hard-restart",
        "hard-restart",
        "hard-restart",
      ]);
      expect(waitGatewayAccountReady).toHaveBeenCalledWith("sync-state-loss-gateway", {
        timeoutMs: 8_000,
      });
      expect(sendTextMessage).toHaveBeenCalledWith({
        body: expect.stringContaining(
          "@sync-gateway:matrix-qa.test reply with only this exact marker:",
        ),
        mentionUserIds: ["@sync-gateway:matrix-qa.test"],
        roomId: "!recovery:matrix-qa.test",
      });
      expect(rawWaitForRoomEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: "!recovery:matrix-qa.test",
          since: "raw-driver-sync-start",
        }),
      );
      const finalConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8")) as {
        channels: {
          matrix: {
            accounts: Record<string, { groups?: Record<string, unknown> }>;
            defaultAccount?: string;
          };
        };
      };
      expect(finalConfig.channels.matrix.defaultAccount).toBe("sut");
      expect(Object.keys(finalConfig.channels.matrix.accounts)).toEqual(["sut"]);
      expect(finalConfig.channels.matrix.accounts.sut?.groups).toEqual(originalGroups);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("isolates E2EE restart-resume gateway groups and restores them after the scenario", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-e2ee-restart-isolation-"));
    try {
      const gatewayConfigPath = path.join(outputDir, "gateway-config.json");
      const originalGroups = {
        "!artifact:matrix-qa.test": {
          enabled: true,
          requireMention: true,
        },
        "!dynamic-recovery:matrix-qa.test": {
          enabled: true,
          requireMention: true,
        },
        "!main:matrix-qa.test": {
          enabled: true,
          requireMention: true,
        },
        "!restart:matrix-qa.test": {
          enabled: true,
          requireMention: true,
        },
      };
      await writeTestJsonFile(gatewayConfigPath, {
        channels: {
          matrix: {
            accounts: {
              sut: {
                groupAllowFrom: ["@driver:matrix-qa.test"],
                groupPolicy: "allowlist",
                groups: originalGroups,
              },
            },
          },
        },
      });

      const callOrder: string[] = [];
      const registerWithToken = vi.fn().mockResolvedValue({
        accessToken: "isolated-driver-token",
        deviceId: "ISOLATEDDRIVER",
        localpart: "qa-e2ee-driver-restart",
        password: "isolated-driver-password",
        userId: "@isolated-driver:matrix-qa.test",
      });
      const createPrivateRoom = vi.fn(async () => {
        callOrder.push("create-room");
        return "!isolated-restart:matrix-qa.test";
      });
      const observerJoinRoom = vi.fn(async () => {
        callOrder.push("observer-join");
        return "!isolated-restart:matrix-qa.test";
      });
      const sutJoinRoom = vi.fn(async () => {
        callOrder.push("sut-join");
        return "!isolated-restart:matrix-qa.test";
      });
      createMatrixQaClient
        .mockReturnValueOnce({ registerWithToken })
        .mockReturnValueOnce({ createPrivateRoom })
        .mockReturnValueOnce({ joinRoom: observerJoinRoom })
        .mockReturnValueOnce({ joinRoom: sutJoinRoom });

      const sendTextMessage = vi.fn().mockImplementation(async ({ body }) => {
        if (String(body).includes("MATRIX_QA_E2EE_BEFORE_RESTART")) {
          const isolatedConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8")) as {
            channels: {
              matrix: {
                accounts: {
                  sut: {
                    groupAllowFrom: string[];
                    groupPolicy: string;
                    groups: Record<string, unknown>;
                  };
                };
              };
            };
          };
          expect(Object.keys(isolatedConfig.channels.matrix.accounts.sut.groups)).toEqual([
            "!isolated-restart:matrix-qa.test",
          ]);
          expect(isolatedConfig.channels.matrix.accounts.sut.groupAllowFrom).toEqual([
            "@isolated-driver:matrix-qa.test",
          ]);
          expect(isolatedConfig.channels.matrix.accounts.sut.groupPolicy).toBe("allowlist");
          callOrder.push("send:before");
          return "$before-trigger";
        }
        callOrder.push("send:after");
        return "$after-trigger";
      });
      const waitForRoomEvent = vi.fn().mockImplementation(async (params) => {
        const body = String(sendTextMessage.mock.calls.at(-1)?.[0]?.body ?? "");
        const token = body.replace("@sut:matrix-qa.test reply with only this exact marker: ", "");
        return {
          event: {
            body: token,
            eventId: token.includes("BEFORE") ? "$before-reply" : "$after-reply",
            kind: "message",
            roomId: params.roomId,
            sender: "@sut:matrix-qa.test",
            type: "m.room.message",
          },
          since: `${params.roomId}:reply`,
        };
      });
      const stop = vi.fn().mockResolvedValue(undefined);
      createMatrixQaE2eeScenarioClient.mockResolvedValue({
        prime: vi.fn().mockResolvedValue("driver-sync-start"),
        sendTextMessage,
        stop,
        waitForJoinedMember: vi.fn().mockResolvedValue(undefined),
        waitForRoomEvent,
      });
      const restartGateway = vi.fn(async () => {
        callOrder.push("restart");
      });
      const restartGatewayAfterStateMutation = vi.fn(async (mutateState) => {
        callOrder.push("hard-restart");
        await mutateState({ stateDir: outputDir });
      });
      const waitGatewayAccountReady = vi.fn().mockResolvedValue(undefined);

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-restart-resume",
      );
      expect(scenario).toBeDefined();

      await expect(
        runMatrixQaScenario(scenario!, {
          ...matrixQaScenarioContext(),
          gatewayRuntimeEnv: {
            OPENCLAW_CONFIG_PATH: gatewayConfigPath,
            PATH: process.env.PATH,
          },
          outputDir,
          restartGateway,
          restartGatewayAfterStateMutation,
          sutAccountId: "sut",
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
                encrypted: true,
                key: matrixQaE2eeRoomKey("matrix-e2ee-restart-resume"),
                kind: "group",
                memberRoles: ["driver", "observer", "sut"],
                memberUserIds: [
                  "@driver:matrix-qa.test",
                  "@observer:matrix-qa.test",
                  "@sut:matrix-qa.test",
                ],
                name: "Restart",
                requireMention: true,
                roomId: "!restart:matrix-qa.test",
              },
            ],
          },
          waitGatewayAccountReady,
        }),
      ).resolves.toMatchObject({
        artifacts: {
          driverUserId: "@isolated-driver:matrix-qa.test",
          firstDriverEventId: "$before-trigger",
          recoveredDriverEventId: "$after-trigger",
          roomId: "!isolated-restart:matrix-qa.test",
        },
      });

      const restoredConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8")) as {
        channels: {
          matrix: {
            accounts: {
              sut: {
                groupAllowFrom: string[];
                groupPolicy: string;
                groups: Record<string, unknown>;
              };
            };
          };
        };
      };
      expect(restoredConfig.channels.matrix.accounts.sut.groups).toEqual(originalGroups);
      expect(restoredConfig.channels.matrix.accounts.sut.groupAllowFrom).toEqual([
        "@driver:matrix-qa.test",
      ]);
      expect(restoredConfig.channels.matrix.accounts.sut.groupPolicy).toBe("allowlist");
      expect(callOrder).toEqual([
        "create-room",
        "observer-join",
        "sut-join",
        "hard-restart",
        "send:before",
        "restart",
        "send:after",
        "hard-restart",
      ]);
      expect(restartGatewayAfterStateMutation).toHaveBeenCalledTimes(2);
      expect(restartGatewayAfterStateMutation).toHaveBeenNthCalledWith(1, expect.any(Function), {
        timeoutMs: 8_000,
        waitAccountId: "sut",
      });
      expect(restartGatewayAfterStateMutation).toHaveBeenNthCalledWith(2, expect.any(Function), {
        timeoutMs: 8_000,
        waitAccountId: "sut",
      });
      expect(waitGatewayAccountReady).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(createPrivateRoom).toHaveBeenCalledWith({
        encrypted: true,
        inviteUserIds: ["@observer:matrix-qa.test", "@sut:matrix-qa.test"],
        name: "Matrix QA matrix-e2ee-restart-resume Isolated E2EE Room",
      });
      expect(observerJoinRoom).toHaveBeenCalledWith("!isolated-restart:matrix-qa.test");
      expect(sutJoinRoom).toHaveBeenCalledWith("!isolated-restart:matrix-qa.test");
      expect(createMatrixQaE2eeScenarioClient).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "isolated-driver-token",
          actorId: "driver-restart-resume",
          deviceId: "ISOLATEDDRIVER",
          password: "isolated-driver-password",
          userId: "@isolated-driver:matrix-qa.test",
        }),
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
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
          /task="Finish with exactly ([^".]+)\./.exec(
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

  it("fails the subagent thread spawn scenario on surfaced tool errors", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$subagent-spawn-trigger");
    const waitForRoomEvent = vi.fn().mockImplementationOnce(async (options) => {
      const event = {
        kind: "message",
        roomId: "!main:matrix-qa.test",
        eventId: "$sessions-spawn-error",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: "Protocol note: sessions_spawn failed: Matrix thread bind failed: no adapter",
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
      "sessions_spawn failed",
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
    const readBlockText = (label: "ONE" | "TWO") =>
      String(sendTextMessage.mock.calls[0]?.[0]?.body)
        .split("\n")
        .find((line) => line.startsWith(`MATRIX_QA_BLOCK_${label}_`)) ??
      `MATRIX_QA_BLOCK_${label}_FIXED`;
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => ({
        event: {
          kind: "notice",
          roomId: "!main:matrix-qa.test",
          eventId: "$block-one",
          sender: "@sut:matrix-qa.test",
          type: "m.room.message",
          body: readBlockText("ONE"),
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
          body: readBlockText("TWO"),
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
    const body = String(sendTextMessage.mock.calls[0]?.[0]?.body);
    expect(body).toMatch(
      /reply with exactly this two-line body and no extra text:\nMATRIX_QA_BLOCK_ONE_[A-F0-9]{8}\nMATRIX_QA_BLOCK_TWO_[A-F0-9]{8}$/,
    );
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
    const ownerBootstrapOwnDeviceVerification = vi.fn().mockResolvedValue({
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
        bootstrapOwnDeviceVerification: ownerBootstrapOwnDeviceVerification,
        deleteOwnDevices: vi.fn().mockResolvedValue(undefined),
        getRecoveryKey: vi.fn().mockResolvedValue({
          encodedPrivateKey: "encoded-recovery-key",
          keyId: "SSSS",
        }),
        sendTextMessage: vi.fn().mockResolvedValue("$seeded-event"),
        stop: driverStop,
      })
      .mockResolvedValueOnce({
        getRecoveryKey: vi.fn().mockResolvedValue({
          encodedPrivateKey: "encoded-recovery-key",
          keyId: "SSSS",
        }),
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

    expect(ownerBootstrapOwnDeviceVerification).toHaveBeenCalledWith({
      allowAutomaticCrossSigningReset: false,
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
    const ownerBootstrapOwnDeviceVerification = vi.fn().mockResolvedValue({
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
        bootstrapOwnDeviceVerification: ownerBootstrapOwnDeviceVerification,
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
    expect(ownerBootstrapOwnDeviceVerification).toHaveBeenCalledWith({
      allowAutomaticCrossSigningReset: false,
    });
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
      const cliOwnerAccount = {
        accessToken: "cli-owner-token",
        deviceId: "OWNERDEVICE",
        localpart: "qa-cli-self-verification",
        password: "cli-owner-password",
        userId: "@cli-owner:matrix-qa.test",
      };
      const registerWithToken = vi.fn().mockResolvedValue(cliOwnerAccount);
      const loginWithPassword = vi.fn().mockResolvedValue({
        accessToken: "cli-token",
        deviceId: "CLIDEVICE",
        password: "cli-owner-password",
        userId: "@cli-owner:matrix-qa.test",
      });
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
        otherUserId: "@cli-owner:matrix-qa.test",
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
        loginWithPassword,
        registerWithToken,
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
      const endStdin = vi.fn();
      startMatrixQaOpenClawCli.mockReturnValue({
        args: ["matrix", "verify", "self", "--account", "cli"],
        endStdin,
        kill,
        output: vi.fn(() => ({ stderr: "", stdout: "" })),
        wait,
        waitForOutput,
        writeStdin,
      });
      let cliAccountConfigDuringRun: Record<string, unknown> | null = null;
      runMatrixQaOpenClawCli.mockImplementation(async ({ args, env, stdin }) => {
        if (!cliAccountConfigDuringRun && env.OPENCLAW_CONFIG_PATH) {
          const cliConfig = JSON.parse(
            await readFile(String(env.OPENCLAW_CONFIG_PATH), "utf8"),
          ) as {
            channels?: {
              matrix?: {
                accounts?: Record<string, Record<string, unknown>>;
              };
            };
            plugins?: {
              allow?: string[];
              entries?: Record<string, { enabled?: boolean }>;
            };
          };
          cliAccountConfigDuringRun = {
            ...cliConfig.channels?.matrix?.accounts?.cli,
            pluginAllow: cliConfig.plugins?.allow,
            pluginEnabled: cliConfig.plugins?.entries?.matrix?.enabled,
          };
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
              userId: "@cli-owner:matrix-qa.test",
              verified: true,
            }),
          };
        }
        if (joined === "matrix verify backup restore --account cli --recovery-key-stdin --json") {
          expect(stdin).toBe("encoded-recovery-key\n");
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
        "--timeout-ms",
        "8000",
      ]);
      expect(startMatrixQaOpenClawCli.mock.calls[0]?.[0].timeoutMs).toBe(16_000);
      expect(waitForOutput).toHaveBeenCalledTimes(2);
      expect(writeStdin).toHaveBeenCalledWith("yes\n");
      expect(endStdin).toHaveBeenCalledTimes(1);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(registerWithToken).toHaveBeenCalledWith({
        deviceName: "OpenClaw Matrix QA CLI Self Verification Owner",
        localpart: expect.stringMatching(/^qa-cli-self-verification-[a-f0-9]{8}$/),
        password: expect.stringMatching(/^matrix-qa-/),
        registrationToken: "registration-token",
      });
      expect(loginWithPassword).toHaveBeenCalledWith({
        deviceName: "OpenClaw Matrix QA CLI Self Verification Device",
        password: "cli-owner-password",
        userId: "@cli-owner:matrix-qa.test",
      });
      expect(createMatrixQaE2eeScenarioClient).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "cli-owner-token",
          deviceId: "OWNERDEVICE",
          password: "cli-owner-password",
          scenarioId: "matrix-e2ee-cli-self-verification",
          userId: "@cli-owner:matrix-qa.test",
        }),
      );
      expect(runMatrixQaOpenClawCli).toHaveBeenCalledTimes(2);
      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        [
          "matrix",
          "verify",
          "backup",
          "restore",
          "--account",
          "cli",
          "--recovery-key-stdin",
          "--json",
        ],
        ["matrix", "verify", "status", "--account", "cli", "--json"],
      ]);
      expect(runMatrixQaOpenClawCli.mock.calls[0]?.[0].stdin).toBe("encoded-recovery-key\n");
      const cliEnv = startMatrixQaOpenClawCli.mock.calls[0]?.[0].env;
      expect(cliEnv?.OPENCLAW_STATE_DIR).toContain("openclaw-matrix-cli-qa-");
      expect(cliEnv?.OPENCLAW_CONFIG_PATH).toContain("openclaw-matrix-cli-qa-");
      const configPath = String(cliEnv?.OPENCLAW_CONFIG_PATH);
      expect(cliAccountConfigDuringRun).toMatchObject({
        accessToken: "cli-token",
        deviceId: "CLIDEVICE",
        encryption: true,
        homeserver: "http://127.0.0.1:28008/",
        pluginAllow: expect.arrayContaining(["matrix"]),
        pluginEnabled: true,
        startupVerification: "off",
        userId: "@cli-owner:matrix-qa.test",
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
      expect(bootstrapOwnDeviceVerification).toHaveBeenCalledWith({
        allowAutomaticCrossSigningReset: false,
      });
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix account add --enable-e2ee through the CLI QA scenario", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-cli-account-add-e2ee-"));
    try {
      const { registerWithToken } = mockMatrixQaCliAccount({
        accessToken: "cli-add-owner-token",
        deviceId: "CLIADDOWNER",
        password: "cli-add-password",
        userId: "@cli-add:matrix-qa.test",
      });
      runMatrixQaOpenClawCli.mockImplementation(async ({ args, env }) => {
        if (env.OPENCLAW_CONFIG_PATH) {
          const initialConfig = JSON.parse(
            await readFile(String(env.OPENCLAW_CONFIG_PATH), "utf8"),
          ) as {
            channels?: { matrix?: { enabled?: boolean; accounts?: Record<string, unknown> } };
            plugins?: { allow?: string[]; entries?: { matrix?: unknown } };
          };
          expect(initialConfig.channels?.matrix?.enabled).toBe(true);
          expect(initialConfig.channels?.matrix?.accounts).toEqual({});
          expect(initialConfig.plugins?.allow).toContain("matrix");
          expect(initialConfig.plugins?.entries?.matrix).toEqual({ enabled: true });
        }
        const joined = args.join(" ");
        if (joined.includes("matrix account add")) {
          return {
            args,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              accountId: "cli-add-e2ee",
              encryptionEnabled: true,
              verificationBootstrap: {
                attempted: true,
                backupVersion: "backup-v1",
                success: true,
              },
            }),
          };
        }
        if (joined === "matrix verify status --account cli-add-e2ee --json") {
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
              deviceId: "CLIADDDEVICE",
              signedByOwner: true,
              userId: "@driver:matrix-qa.test",
              verified: true,
            }),
          };
        }
        throw new Error(`unexpected CLI command: ${joined}`);
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-account-add-enable-e2ee",
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
          accountId: "cli-add-e2ee",
          backupVersion: "backup-v1",
          cliDeviceId: "CLIADDDEVICE",
          encryptionEnabled: true,
          verificationBootstrapAttempted: true,
          verificationBootstrapSuccess: true,
        },
      });

      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        [
          "matrix",
          "account",
          "add",
          "--account",
          "cli-add-e2ee",
          "--name",
          "Matrix QA CLI Account Add E2EE",
          "--homeserver",
          "http://127.0.0.1:28008/",
          "--user-id",
          "@cli-add:matrix-qa.test",
          "--password",
          "cli-add-password",
          "--device-name",
          "OpenClaw Matrix QA CLI Account Add E2EE",
          "--allow-private-network",
          "--enable-e2ee",
          "--json",
        ],
        ["matrix", "verify", "status", "--account", "cli-add-e2ee", "--json"],
      ]);
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Account Add Owner",
          registrationToken: "registration-token",
        }),
      );
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-account-add-enable-e2ee"));
      const cliArtifactDir = path.join(outputDir, "cli-account-add-enable-e2ee", cliRunDir ?? "");
      await expect(
        readFile(path.join(cliArtifactDir, "account-add-enable-e2ee.stdout.txt"), "utf8"),
      ).resolves.toContain('"encryptionEnabled":true');
      await expect(
        readFile(path.join(cliArtifactDir, "verify-status.stdout.txt"), "utf8"),
      ).resolves.toContain('"verified":true');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix encryption setup through the CLI QA scenario", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-cli-encryption-setup-"));
    try {
      const { loginWithPassword, registerWithToken } = mockMatrixQaCliAccount({
        accessToken: "cli-setup-token",
        deviceId: "CLISETUPDEVICE",
        password: "cli-setup-password",
        userId: "@cli-setup:matrix-qa.test",
      });
      let initialAccountConfig: Record<string, unknown> | null = null;
      runMatrixQaOpenClawCli.mockImplementation(async ({ args, env }) => {
        if (!initialAccountConfig && env.OPENCLAW_CONFIG_PATH) {
          const initialConfig = JSON.parse(
            await readFile(String(env.OPENCLAW_CONFIG_PATH), "utf8"),
          ) as {
            channels?: {
              matrix?: {
                accounts?: Record<string, Record<string, unknown>>;
              };
            };
          };
          initialAccountConfig =
            initialConfig.channels?.matrix?.accounts?.["cli-encryption-setup"] ?? null;
        }
        const joined = args.join(" ");
        if (joined === "matrix encryption setup --account cli-encryption-setup --json") {
          return {
            args,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              accountId: "cli-encryption-setup",
              bootstrap: {
                success: true,
              },
              encryptionChanged: true,
              status: {
                backup: {
                  decryptionKeyCached: true,
                  keyLoadError: null,
                  matchesDecryptionKey: true,
                  trusted: true,
                },
                crossSigningVerified: true,
                deviceId: "CLISETUPDEVICE",
                signedByOwner: true,
                userId: "@driver:matrix-qa.test",
                verified: true,
              },
              success: true,
            }),
          };
        }
        if (joined === "matrix verify status --account cli-encryption-setup --json") {
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
              deviceId: "CLISETUPDEVICE",
              signedByOwner: true,
              userId: "@driver:matrix-qa.test",
              verified: true,
            }),
          };
        }
        throw new Error(`unexpected CLI command: ${joined}`);
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-encryption-setup",
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
          accountId: "cli-encryption-setup",
          cliDeviceId: "CLISETUPDEVICE",
          encryptionChanged: true,
          setupSuccess: true,
          verificationBootstrapSuccess: true,
        },
      });

      expect(initialAccountConfig).toMatchObject({
        accessToken: "cli-setup-token",
        deviceId: "CLISETUPDEVICE",
        encryption: false,
        homeserver: "http://127.0.0.1:28008/",
        password: "cli-setup-password",
        startupVerification: "off",
        userId: "@cli-setup:matrix-qa.test",
      });
      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        ["matrix", "encryption", "setup", "--account", "cli-encryption-setup", "--json"],
        ["matrix", "verify", "status", "--account", "cli-encryption-setup", "--json"],
      ]);
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Encryption Setup Owner",
          registrationToken: "registration-token",
        }),
      );
      expect(loginWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({
          password: "cli-setup-password",
          userId: "@cli-setup:matrix-qa.test",
        }),
      );
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-encryption-setup"));
      const cliArtifactDir = path.join(outputDir, "cli-encryption-setup", cliRunDir ?? "");
      await expect(
        readFile(path.join(cliArtifactDir, "encryption-setup.stdout.txt"), "utf8"),
      ).resolves.toContain('"encryptionChanged":true');
      await expect(
        readFile(path.join(cliArtifactDir, "verify-status.stdout.txt"), "utf8"),
      ).resolves.toContain('"verified":true');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix encryption setup idempotency through the CLI QA scenario", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "matrix-cli-encryption-setup-idempotent-"),
    );
    try {
      const { loginWithPassword, registerWithToken } = mockMatrixQaCliAccount({
        accessToken: "cli-idempotent-token",
        deviceId: "CLIIDEMPOTENTDEVICE",
        password: "cli-idempotent-password",
        userId: "@cli-idempotent:matrix-qa.test",
      });
      let initialAccountConfig: Record<string, unknown> | null = null;
      runMatrixQaOpenClawCli.mockImplementation(async ({ args, env }) => {
        if (!initialAccountConfig && env.OPENCLAW_CONFIG_PATH) {
          const initialConfig = JSON.parse(
            await readFile(String(env.OPENCLAW_CONFIG_PATH), "utf8"),
          ) as {
            channels?: {
              matrix?: {
                accounts?: Record<string, Record<string, unknown>>;
              };
            };
          };
          initialAccountConfig =
            initialConfig.channels?.matrix?.accounts?.["cli-encryption-idempotent"] ?? null;
        }
        const joined = args.join(" ");
        if (joined === "matrix encryption setup --account cli-encryption-idempotent --json") {
          return {
            args,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              accountId: "cli-encryption-idempotent",
              bootstrap: {
                success: true,
              },
              encryptionChanged: false,
              status: {
                backup: {
                  decryptionKeyCached: true,
                  keyLoadError: null,
                  matchesDecryptionKey: true,
                  trusted: true,
                },
                crossSigningVerified: true,
                deviceId: "CLIIDEMPOTENTDEVICE",
                signedByOwner: true,
                userId: "@driver:matrix-qa.test",
                verified: true,
              },
              success: true,
            }),
          };
        }
        throw new Error(`unexpected CLI command: ${joined}`);
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-encryption-setup-idempotent",
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
          accountId: "cli-encryption-idempotent",
          cliDeviceId: "CLIIDEMPOTENTDEVICE",
          firstEncryptionChanged: false,
          secondEncryptionChanged: false,
          setupSuccess: true,
          verificationBootstrapSuccess: true,
        },
      });

      expect(initialAccountConfig).toMatchObject({
        accessToken: "cli-idempotent-token",
        deviceId: "CLIIDEMPOTENTDEVICE",
        encryption: true,
        homeserver: "http://127.0.0.1:28008/",
        password: "cli-idempotent-password",
        startupVerification: "off",
        userId: "@cli-idempotent:matrix-qa.test",
      });
      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        ["matrix", "encryption", "setup", "--account", "cli-encryption-idempotent", "--json"],
        ["matrix", "encryption", "setup", "--account", "cli-encryption-idempotent", "--json"],
      ]);
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Encryption Idempotent Owner",
          registrationToken: "registration-token",
        }),
      );
      expect(loginWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({
          password: "cli-idempotent-password",
          userId: "@cli-idempotent:matrix-qa.test",
        }),
      );
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-encryption-setup-idempotent"));
      const cliArtifactDir = path.join(
        outputDir,
        "cli-encryption-setup-idempotent",
        cliRunDir ?? "",
      );
      await expect(
        readFile(path.join(cliArtifactDir, "encryption-setup-first.stdout.txt"), "utf8"),
      ).resolves.toContain('"encryptionChanged":false');
      await expect(
        readFile(path.join(cliArtifactDir, "encryption-setup-second.stdout.txt"), "utf8"),
      ).resolves.toContain('"verified":true');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix encryption setup bootstrap failure through the CLI QA scenario", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "matrix-cli-encryption-setup-bootstrap-failure-"),
    );
    try {
      const proxyStop = vi.fn().mockResolvedValue(undefined);
      const hits = vi.fn().mockReturnValue([
        {
          bearerToken: "cli-failure-token",
          method: "GET",
          path: "/_matrix/client/v3/room_keys/version",
          ruleId: "room-key-backup-version-unavailable",
        },
      ]);
      const { loginWithPassword, registerWithToken } = mockMatrixQaCliAccount({
        accessToken: "cli-failure-token",
        deviceId: "CLIFAILUREDEVICE",
        password: "cli-failure-password",
        userId: "@cli-failure:matrix-qa.test",
      });
      startMatrixQaFaultProxy.mockResolvedValue({
        baseUrl: "http://127.0.0.1:39878",
        hits,
        stop: proxyStop,
      });
      const output = vi.fn(() => ({
        stderr: "",
        stdout: JSON.stringify({
          accountId: "cli-encryption-failure",
          bootstrap: {
            error: "Matrix room key backup is still missing after bootstrap",
            success: false,
          },
          encryptionChanged: true,
          success: false,
        }),
      }));
      const wait = vi
        .fn()
        .mockRejectedValue(new Error("openclaw matrix encryption setup exited 1"));
      const kill = vi.fn();
      startMatrixQaOpenClawCli.mockReturnValue({
        args: ["matrix", "encryption", "setup", "--account", "cli-encryption-failure", "--json"],
        kill,
        output,
        wait,
        waitForOutput: vi.fn(),
        writeStdin: vi.fn(),
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-encryption-setup-bootstrap-failure",
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
          accountId: "cli-encryption-failure",
          bootstrapSuccess: false,
          cliDeviceId: "CLIFAILUREDEVICE",
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
          bearerToken: "cli-failure-token",
          headers: {},
          method: "GET",
          path: "/_matrix/client/v3/room_keys/version",
          search: "",
        }),
      ).toBe(true);
      expect(startMatrixQaOpenClawCli.mock.calls[0]?.[0].args).toEqual([
        "matrix",
        "encryption",
        "setup",
        "--account",
        "cli-encryption-failure",
        "--json",
      ]);
      expect(startMatrixQaOpenClawCli.mock.calls[0]?.[0].env.OPENCLAW_CONFIG_PATH).toContain(
        "openclaw-matrix-e2ee-setup-qa-",
      );
      expect(output).toHaveBeenCalledTimes(1);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Encryption Failure Owner",
          registrationToken: "registration-token",
        }),
      );
      expect(loginWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({
          password: "cli-failure-password",
          userId: "@cli-failure:matrix-qa.test",
        }),
      );
      expect(proxyStop).toHaveBeenCalledTimes(1);
      const [cliRunDir] = await readdir(
        path.join(outputDir, "cli-encryption-setup-bootstrap-failure"),
      );
      const cliArtifactDir = path.join(
        outputDir,
        "cli-encryption-setup-bootstrap-failure",
        cliRunDir ?? "",
      );
      await expect(
        readFile(
          path.join(cliArtifactDir, "encryption-setup-bootstrap-failure.stdout.txt"),
          "utf8",
        ),
      ).resolves.toContain('"success":false');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix recovery-key setup through the CLI QA scenario", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-cli-recovery-key-setup-"));
    try {
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
          recoveryKeyId: "SSSS",
          recoveryKeyStored: true,
          signedByOwner: true,
          verified: true,
        },
      });
      createMatrixQaE2eeScenarioClient.mockResolvedValueOnce({
        bootstrapOwnDeviceVerification,
        deleteOwnDevices,
        getRecoveryKey: vi.fn().mockResolvedValue({
          encodedPrivateKey: "encoded-recovery-key",
          keyId: "SSSS",
        }),
        stop,
      });
      const { loginWithPassword, registerWithToken } = mockMatrixQaCliAccount({
        accessToken: "cli-recovery-token",
        deviceId: "CLIRECOVERYDEVICE",
        password: "cli-recovery-password",
        userId: "@cli-recovery:matrix-qa.test",
      });
      let initialAccountConfig: Record<string, unknown> | null = null;
      runMatrixQaOpenClawCli.mockImplementation(async ({ args, env }) => {
        if (!initialAccountConfig && env.OPENCLAW_CONFIG_PATH) {
          const initialConfig = JSON.parse(
            await readFile(String(env.OPENCLAW_CONFIG_PATH), "utf8"),
          ) as {
            channels?: {
              matrix?: {
                accounts?: Record<string, Record<string, unknown>>;
              };
            };
          };
          initialAccountConfig =
            initialConfig.channels?.matrix?.accounts?.["cli-recovery-key-setup"] ?? null;
        }
        const joined = args.join(" ");
        if (
          joined ===
          "matrix encryption setup --account cli-recovery-key-setup --recovery-key encoded-recovery-key --json"
        ) {
          return {
            args,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              accountId: "cli-recovery-key-setup",
              bootstrap: {
                success: true,
              },
              encryptionChanged: true,
              status: {
                backup: {
                  decryptionKeyCached: true,
                  keyLoadError: null,
                  matchesDecryptionKey: true,
                  trusted: true,
                },
                backupVersion: "backup-v1",
                crossSigningVerified: true,
                deviceId: "CLIRECOVERYDEVICE",
                signedByOwner: true,
                userId: "@driver:matrix-qa.test",
                verified: true,
              },
              success: true,
            }),
          };
        }
        throw new Error(`unexpected CLI command: ${joined}`);
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-recovery-key-setup",
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
          accountId: "cli-recovery-key-setup",
          backupVersion: "backup-v1",
          cliDeviceId: "CLIRECOVERYDEVICE",
          encryptionChanged: true,
          recoveryKeyId: "SSSS",
          recoveryKeyStored: true,
          setupSuccess: true,
          verificationBootstrapSuccess: true,
        },
      });

      expect(initialAccountConfig).toMatchObject({
        accessToken: "cli-recovery-token",
        deviceId: "CLIRECOVERYDEVICE",
        encryption: false,
        homeserver: "http://127.0.0.1:28008/",
        password: "cli-recovery-password",
        startupVerification: "off",
        userId: "@cli-recovery:matrix-qa.test",
      });
      expect(bootstrapOwnDeviceVerification).toHaveBeenCalledWith({
        allowAutomaticCrossSigningReset: false,
      });
      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        [
          "matrix",
          "encryption",
          "setup",
          "--account",
          "cli-recovery-key-setup",
          "--recovery-key",
          "encoded-recovery-key",
          "--json",
        ],
      ]);
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Recovery Key Owner",
          registrationToken: "registration-token",
        }),
      );
      expect(loginWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({
          password: "cli-recovery-password",
          userId: "@cli-recovery:matrix-qa.test",
        }),
      );
      expect(deleteOwnDevices).toHaveBeenCalledWith(["CLIRECOVERYDEVICE"]);
      expect(stop).toHaveBeenCalledTimes(1);
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-recovery-key-setup"));
      const cliArtifactDir = path.join(outputDir, "cli-recovery-key-setup", cliRunDir ?? "");
      await expect(
        readFile(path.join(cliArtifactDir, "recovery-key-setup.stdout.txt"), "utf8"),
      ).resolves.toContain('"backupVersion":"backup-v1"');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix invalid recovery-key setup through the CLI QA scenario", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-cli-recovery-key-invalid-"));
    try {
      const deleteOwnDevices = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const { loginWithPassword, registerWithToken } = mockMatrixQaCliAccount({
        accessToken: "cli-invalid-token",
        deviceId: "CLIINVALIDDEVICE",
        password: "cli-invalid-password",
        userId: "@cli-invalid:matrix-qa.test",
      });
      createMatrixQaE2eeScenarioClient.mockResolvedValueOnce({
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
        deleteOwnDevices,
        getRecoveryKey: vi.fn().mockResolvedValue({
          encodedPrivateKey: "valid-recovery-key",
          keyId: "SSSS",
        }),
        stop,
      });
      const output = vi.fn(() => ({
        stderr: "",
        stdout: JSON.stringify({
          accountId: "cli-invalid-recovery-key",
          bootstrap: {
            error: "Matrix recovery key could not unlock secret storage",
            success: false,
          },
          encryptionChanged: true,
          success: false,
        }),
      }));
      const wait = vi
        .fn()
        .mockRejectedValue(new Error("openclaw matrix encryption setup exited 1"));
      const kill = vi.fn();
      startMatrixQaOpenClawCli.mockReturnValue({
        args: [
          "matrix",
          "encryption",
          "setup",
          "--account",
          "cli-invalid-recovery-key",
          "--recovery-key",
          "not-a-valid-matrix-recovery-key",
          "--json",
        ],
        kill,
        output,
        wait,
        waitForOutput: vi.fn(),
        writeStdin: vi.fn(),
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-recovery-key-invalid",
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
          accountId: "cli-invalid-recovery-key",
          bootstrapSuccess: false,
          cliDeviceId: "CLIINVALIDDEVICE",
          encryptionChanged: true,
          recoveryKeyAccepted: false,
          recoveryKeyRejected: true,
          setupSuccess: false,
        },
      });

      expect(startMatrixQaOpenClawCli.mock.calls[0]?.[0].args).toEqual([
        "matrix",
        "encryption",
        "setup",
        "--account",
        "cli-invalid-recovery-key",
        "--recovery-key",
        "not-a-valid-matrix-recovery-key",
        "--json",
      ]);
      expect(output).toHaveBeenCalledTimes(1);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Invalid Recovery Key Owner",
          registrationToken: "registration-token",
        }),
      );
      expect(loginWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({
          password: "cli-invalid-password",
          userId: "@cli-invalid:matrix-qa.test",
        }),
      );
      expect(deleteOwnDevices).toHaveBeenCalledWith(["CLIINVALIDDEVICE"]);
      expect(stop).toHaveBeenCalledTimes(1);
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-recovery-key-invalid"));
      const cliArtifactDir = path.join(outputDir, "cli-recovery-key-invalid", cliRunDir ?? "");
      await expect(
        readFile(path.join(cliArtifactDir, "recovery-key-invalid.stdout.txt"), "utf8"),
      ).resolves.not.toContain("not-a-valid-matrix-recovery-key");
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix multi-account encryption setup through the CLI QA scenario", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "matrix-cli-encryption-setup-multi-account-"),
    );
    try {
      const { loginWithPassword, registerWithToken } = mockMatrixQaCliAccount({
        accessToken: "cli-multi-token",
        deviceId: "CLIMULTIDEVICE",
        password: "cli-multi-password",
        userId: "@cli-multi:matrix-qa.test",
      });
      runMatrixQaOpenClawCli.mockImplementation(async ({ args, env }) => {
        const configPath = String(env.OPENCLAW_CONFIG_PATH);
        const config = JSON.parse(await readFile(configPath, "utf8")) as {
          channels: {
            matrix: {
              accounts: Record<string, Record<string, unknown>>;
              defaultAccount: string;
            };
          };
        };
        expect(config.channels.matrix.defaultAccount).toBe("cli-multi-decoy");
        expect(config.channels.matrix.accounts["cli-multi-decoy"]?.encryption).toBe(false);
        config.channels.matrix.accounts["cli-multi-target"] = {
          ...config.channels.matrix.accounts["cli-multi-target"],
          encryption: true,
        };
        await writeTestJsonFile(configPath, config);
        const joined = args.join(" ");
        if (joined === "matrix encryption setup --account cli-multi-target --json") {
          return {
            args,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              accountId: "cli-multi-target",
              bootstrap: {
                success: true,
              },
              encryptionChanged: true,
              status: {
                backup: {
                  decryptionKeyCached: true,
                  keyLoadError: null,
                  matchesDecryptionKey: true,
                  trusted: true,
                },
                crossSigningVerified: true,
                deviceId: "CLIMULTIDEVICE",
                signedByOwner: true,
                userId: "@driver:matrix-qa.test",
                verified: true,
              },
              success: true,
            }),
          };
        }
        throw new Error(`unexpected CLI command: ${joined}`);
      });

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-encryption-setup-multi-account",
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
          accountId: "cli-multi-target",
          cliDeviceId: "CLIMULTIDEVICE",
          decoyAccountPreserved: true,
          defaultAccountPreserved: true,
          encryptionChanged: true,
          setupSuccess: true,
          verificationBootstrapSuccess: true,
        },
      });

      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        ["matrix", "encryption", "setup", "--account", "cli-multi-target", "--json"],
      ]);
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Multi Account Owner",
          registrationToken: "registration-token",
        }),
      );
      expect(loginWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({
          password: "cli-multi-password",
          userId: "@cli-multi:matrix-qa.test",
        }),
      );
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-encryption-setup-multi-account"));
      const cliArtifactDir = path.join(
        outputDir,
        "cli-encryption-setup-multi-account",
        cliRunDir ?? "",
      );
      await expect(
        readFile(path.join(cliArtifactDir, "encryption-setup-multi-account.stdout.txt"), "utf8"),
      ).resolves.toContain('"accountId":"cli-multi-target"');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("runs Matrix CLI setup then gateway encrypted reply through the QA scenario", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-cli-setup-gateway-reply-"));
    const gatewayConfigPath = path.join(outputDir, "gateway-config.json");
    try {
      await writeTestJsonFile(gatewayConfigPath, {
        channels: {
          matrix: {
            defaultAccount: "sut",
            accounts: {
              sut: {
                accessToken: "sut-token",
                enabled: true,
                homeserver: "http://127.0.0.1:28008",
                userId: "@sut:matrix-qa.test",
              },
            },
          },
        },
      });
      const gatewayAccount = {
        accessToken: "cli-gateway-token",
        deviceId: "CLIGATEWAYDEVICE",
        localpart: "qa-cli-gateway",
        password: "cli-gateway-password",
        userId: "@cli-gateway:matrix-qa.test",
      };
      const driverAccount = {
        accessToken: "cli-driver-token",
        deviceId: "CLIDRIVERDEVICE",
        localpart: "qa-cli-driver",
        password: "cli-driver-password",
        userId: "@cli-driver:matrix-qa.test",
      };
      const registerWithToken = vi
        .fn()
        .mockResolvedValueOnce(gatewayAccount)
        .mockResolvedValueOnce(driverAccount);
      const createPrivateRoom = vi.fn().mockResolvedValue("!isolated-e2ee:matrix-qa.test");
      const joinRoom = vi.fn().mockResolvedValue({ roomId: "!isolated-e2ee:matrix-qa.test" });
      createMatrixQaClient.mockImplementation(({ accessToken } = {}) => {
        if (!accessToken) {
          return { registerWithToken };
        }
        if (accessToken === gatewayAccount.accessToken) {
          return { joinRoom };
        }
        if (accessToken === driverAccount.accessToken) {
          return { createPrivateRoom };
        }
        throw new Error(`unexpected Matrix QA client token: ${String(accessToken)}`);
      });
      let replyToken = "";
      const driverStop = vi.fn().mockResolvedValue(undefined);
      const driverClient = {
        bootstrapOwnDeviceVerification: vi.fn().mockResolvedValue({
          crossSigning: { published: true },
          success: true,
          verification: {
            backupVersion: "1",
            crossSigningVerified: true,
            recoveryKeyStored: true,
            signedByOwner: true,
            verified: true,
          },
        }),
        getRecoveryKey: vi.fn().mockResolvedValue({
          encodedPrivateKey: "driver-recovery-key",
          keyId: "driver-recovery-key-id",
        }),
        prime: vi.fn().mockResolvedValue("s1"),
        resetRoomKeyBackup: vi.fn().mockResolvedValue({ success: true }),
        sendTextMessage: vi.fn(async ({ body }) => {
          replyToken = String(body).match(/MATRIX_QA_E2EE_CLI_GATEWAY_[A-Z0-9]+/)?.[0] ?? "";
          return "$driver-event";
        }),
        stop: driverStop,
        waitForJoinedMember: vi.fn().mockResolvedValue(undefined),
        waitForRoomEvent: vi.fn(async ({ predicate }) => {
          const event = {
            body: replyToken,
            eventId: "$gateway-reply",
            kind: "message",
            roomId: "!isolated-e2ee:matrix-qa.test",
            sender: "@cli-gateway:matrix-qa.test",
            type: "m.room.message",
          };
          expect(predicate(event)).toBe(true);
          return { event, since: "s2" };
        }),
      };
      createMatrixQaE2eeScenarioClient.mockResolvedValueOnce(driverClient);
      runMatrixQaOpenClawCli.mockImplementation(async ({ args, env }) => {
        const joined = args.join(" ");
        if (joined === "matrix encryption setup --account cli-setup-gateway --json") {
          const configPath = String(env.OPENCLAW_CONFIG_PATH);
          const config = JSON.parse(await readFile(configPath, "utf8")) as {
            channels: {
              matrix: {
                accounts: Record<string, Record<string, unknown>>;
                defaultAccount: string;
              };
            };
          };
          expect(config.channels.matrix.defaultAccount).toBe("cli-setup-gateway");
          expect(config.channels.matrix.accounts["cli-setup-gateway"]?.encryption).toBe(false);
          config.channels.matrix.accounts["cli-setup-gateway"] = {
            ...config.channels.matrix.accounts["cli-setup-gateway"],
            encryption: true,
            setupBootstrapMarker: "preserved",
          };
          await writeTestJsonFile(configPath, config);
          return {
            args,
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              accountId: "cli-setup-gateway",
              bootstrap: {
                success: true,
              },
              encryptionChanged: false,
              status: {
                backup: {
                  decryptionKeyCached: true,
                  keyLoadError: null,
                  matchesDecryptionKey: true,
                  trusted: true,
                },
                crossSigningVerified: true,
                deviceId: "CLIGATEWAYDEVICE",
                signedByOwner: true,
                userId: "@cli-gateway:matrix-qa.test",
                verified: true,
              },
              success: true,
            }),
          };
        }
        throw new Error(`unexpected CLI command: ${joined}`);
      });
      const patchGatewayConfig = vi.fn().mockResolvedValue(undefined);
      const restartGatewayAfterStateMutation = vi.fn(async (mutateState) => {
        await mutateState({ stateDir: path.join(outputDir, "state") });
      });
      const waitGatewayAccountReady = vi.fn().mockResolvedValue(undefined);

      const scenario = MATRIX_QA_SCENARIOS.find(
        (entry) => entry.id === "matrix-e2ee-cli-setup-then-gateway-reply",
      );
      expect(scenario).toBeDefined();

      await expect(
        runMatrixQaScenario(scenario!, {
          ...matrixQaScenarioContext(),
          driverDeviceId: "DRIVERDEVICE",
          driverPassword: "driver-password",
          gatewayRuntimeEnv: {
            OPENCLAW_CONFIG_PATH: gatewayConfigPath,
            OPENCLAW_STATE_DIR: "/tmp/gateway-state",
            PATH: process.env.PATH,
          },
          outputDir,
          patchGatewayConfig,
          restartGatewayAfterStateMutation,
          waitGatewayAccountReady,
          sutAccountId: "sut",
          sutDeviceId: "SUTDEVICE",
          sutPassword: "sut-password",
          topology: {
            defaultRoomId: "!main:matrix-qa.test",
            defaultRoomKey: "main",
            rooms: [
              {
                encrypted: true,
                key: matrixQaE2eeRoomKey("matrix-e2ee-cli-setup-then-gateway-reply"),
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
          accountId: "cli-setup-gateway",
          cliDeviceId: "CLIGATEWAYDEVICE",
          driverUserId: "@cli-driver:matrix-qa.test",
          gatewayReply: {
            eventId: "$gateway-reply",
            tokenMatched: true,
          },
          gatewayUserId: "@cli-gateway:matrix-qa.test",
          roomId: "!isolated-e2ee:matrix-qa.test",
          setupSuccess: true,
          verificationBootstrapSuccess: true,
        },
      });
      const finalGatewayConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8")) as {
        channels: {
          matrix: {
            accounts: Record<string, Record<string, unknown>>;
            defaultAccount: string;
          };
        };
      };
      expect(finalGatewayConfig.channels.matrix.defaultAccount).toBe("cli-setup-gateway");
      expect(Object.keys(finalGatewayConfig.channels.matrix.accounts)).toEqual([
        "cli-setup-gateway",
      ]);
      expect(finalGatewayConfig.channels.matrix.accounts["cli-setup-gateway"]).toMatchObject({
        encryption: true,
        setupBootstrapMarker: "preserved",
      });

      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        ["matrix", "encryption", "setup", "--account", "cli-setup-gateway", "--json"],
      ]);
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Setup Gateway",
          registrationToken: "registration-token",
        }),
      );
      expect(registerWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: "OpenClaw Matrix QA CLI Setup Driver",
          registrationToken: "registration-token",
        }),
      );
      expect(createPrivateRoom).toHaveBeenCalledWith({
        encrypted: true,
        inviteUserIds: ["@cli-gateway:matrix-qa.test"],
        name: "Matrix QA CLI Setup Gateway E2EE",
      });
      expect(joinRoom).toHaveBeenCalledWith("!isolated-e2ee:matrix-qa.test");
      expect(patchGatewayConfig).not.toHaveBeenCalled();
      expect(restartGatewayAfterStateMutation).toHaveBeenCalledTimes(2);
      expect(driverClient.sendTextMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          mentionUserIds: ["@cli-gateway:matrix-qa.test"],
          roomId: "!isolated-e2ee:matrix-qa.test",
        }),
      );
      expect(driverClient.waitForJoinedMember).toHaveBeenCalledWith({
        roomId: "!isolated-e2ee:matrix-qa.test",
        timeoutMs: 8_000,
        userId: "@cli-gateway:matrix-qa.test",
      });
      expect(createMatrixQaE2eeScenarioClient).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "cli-driver-token",
          deviceId: "CLIDRIVERDEVICE",
          userId: "@cli-driver:matrix-qa.test",
        }),
      );
      expect(waitGatewayAccountReady).toHaveBeenCalledWith("cli-setup-gateway", {
        timeoutMs: 8_000,
      });
      expect(waitGatewayAccountReady).toHaveBeenCalledTimes(2);
      expect(driverStop).toHaveBeenCalledTimes(1);
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-setup-then-gateway-reply"));
      const cliArtifactDir = path.join(outputDir, "cli-setup-then-gateway-reply", cliRunDir ?? "");
      await expect(
        readFile(path.join(cliArtifactDir, "encryption-setup.stdout.txt"), "utf8"),
      ).resolves.toContain('"accountId":"cli-setup-gateway"');
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
