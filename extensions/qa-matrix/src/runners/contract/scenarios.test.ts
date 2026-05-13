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

function requireMatrixQaScenario(id: string): (typeof MATRIX_QA_SCENARIOS)[number] {
  const scenario = MATRIX_QA_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Expected Matrix QA scenario "${id}"`);
  }
  return scenario;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await stat(targetPath);
    throw new Error(`Expected missing path: ${targetPath}`);
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe("ENOENT");
  }
}

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
  };
}

function matrixQaMessageEvent(
  overrides: Partial<MatrixQaObservedEvent> &
    Pick<MatrixQaObservedEvent, "body" | "eventId" | "kind">,
): MatrixQaObservedEvent {
  return {
    roomId: "!main:matrix-qa.test",
    sender: "@sut:matrix-qa.test",
    type: "m.room.message",
    ...overrides,
  };
}

function readMatrixQaReplyDirective(body: unknown, fallback: string) {
  return /reply exactly `([^`]+)`/.exec(String(body))?.[1] ?? fallback;
}

function mockMatrixQaRoomClient(params: {
  driverEventId: string;
  events: Array<{
    event:
      | MatrixQaObservedEvent
      | ((client: { sendTextMessage: ReturnType<typeof vi.fn> }) => MatrixQaObservedEvent);
    since: string;
  }>;
}) {
  const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
  const sendTextMessage = vi.fn().mockResolvedValue(params.driverEventId);
  const waitForRoomEvent = vi.fn();
  for (const entry of params.events) {
    waitForRoomEvent.mockImplementationOnce(async () => ({
      event: typeof entry.event === "function" ? entry.event({ sendTextMessage }) : entry.event,
      since: entry.since,
    }));
  }
  createMatrixQaClient.mockReturnValue({
    primeRoom,
    sendTextMessage,
    waitForRoomEvent,
  });
  return { primeRoom, sendTextMessage, waitForRoomEvent };
}

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function mockCall(source: MockCallSource, label: string, callIndex = 0) {
  const calls = source.mock.calls;
  const resolvedIndex = callIndex < 0 ? calls.length + callIndex : callIndex;
  const call = calls[resolvedIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call;
}

function mockObjectArg(source: MockCallSource, label: string, callIndex = 0, argIndex = 0) {
  const arg = mockCall(source, label, callIndex)[argIndex];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected ${label} object arg`);
  }
  return arg as Record<string, unknown>;
}

function lastMockObjectArg(source: MockCallSource, label: string, argIndex = 0) {
  return mockObjectArg(source, label, -1, argIndex);
}

function mockMessageBody(source: MockCallSource, label: string, callIndex = 0) {
  return String(mockObjectArg(source, label, callIndex).body);
}

function lastMockMessageBody(source: MockCallSource, label: string) {
  return mockMessageBody(source, label, -1);
}

function expectSentTextMessage(
  source: MockCallSource,
  expected: {
    bodyIncludes: string | string[];
    mentionUserIds?: string[];
    roomId: string;
    callIndex?: number;
  },
) {
  const params = mockObjectArg(source, "sendTextMessage", expected.callIndex);
  const body = String(params.body);
  for (const needle of Array.isArray(expected.bodyIncludes)
    ? expected.bodyIncludes
    : [expected.bodyIncludes]) {
    expect(body.includes(needle), needle).toBe(true);
  }
  expect(params.roomId).toBe(expected.roomId);
  if (expected.mentionUserIds) {
    expect(params.mentionUserIds).toEqual(expected.mentionUserIds);
  }
  return params;
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
      "matrix-room-partial-streaming-preview",
      "matrix-room-quiet-streaming-preview",
      "matrix-room-tool-progress-preview",
      "matrix-room-tool-progress-preview-opt-out",
      "matrix-room-tool-progress-error",
      "matrix-room-tool-progress-mention-safety",
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
      "matrix-approval-exec-metadata-single-event",
      "matrix-approval-exec-metadata-chunked",
      "matrix-approval-plugin-metadata-single-event",
      "matrix-approval-deny-reaction",
      "matrix-approval-thread-target",
      "matrix-approval-channel-target-both",
      "matrix-restart-resume",
      "matrix-post-restart-room-continue",
      "matrix-initial-catchup-then-incremental",
      "matrix-restart-replay-dedupe",
      "matrix-stale-sync-replay-dedupe",
      "matrix-room-membership-loss",
      "matrix-homeserver-restart-resume",
      "matrix-mention-gating",
      "matrix-allowbots-default-block",
      "matrix-allowbots-true-unmentioned-open-room",
      "matrix-allowbots-mentions-mentioned-room",
      "matrix-allowbots-mentions-unmentioned-open-room-block",
      "matrix-allowbots-mentions-dm-unmentioned",
      "matrix-allowbots-room-override-blocks-account-true",
      "matrix-allowbots-room-override-enables-account-off",
      "matrix-allowbots-self-sender-ignored",
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

  it("waits for Matrix SAS device trust after verification completes", async () => {
    const initiated = {
      id: "driver-request",
      transactionId: "tx-sas",
    };
    const incoming = {
      canAccept: true,
      id: "observer-request",
      initiatedByMe: false,
      pending: true,
      transactionId: "tx-sas",
    };
    const ready = {
      id: "driver-request",
      phaseName: "ready",
      transactionId: "tx-sas",
    };
    const sas = {
      emoji: [["🐶", "Dog"]],
    };
    const initiatorSas = {
      hasSas: true,
      id: "driver-request",
      sas,
      transactionId: "tx-sas",
    };
    const recipientSas = {
      hasSas: true,
      id: "observer-request",
      sas,
      transactionId: "tx-sas",
    };
    const completedInitiator = {
      completed: true,
      id: "driver-request",
      transactionId: "tx-sas",
    };
    const completedRecipient = {
      completed: true,
      id: "observer-request",
      transactionId: "tx-sas",
    };
    const driverGetDeviceVerificationStatus = vi
      .fn()
      .mockResolvedValueOnce({ verified: false })
      .mockResolvedValueOnce({ verified: true });
    const observerGetDeviceVerificationStatus = vi.fn().mockResolvedValue({ verified: true });
    const driverStop = vi.fn().mockResolvedValue(undefined);
    const observerStop = vi.fn().mockResolvedValue(undefined);

    createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce({
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
        confirmVerificationSas: vi.fn().mockResolvedValue(completedInitiator),
        getDeviceVerificationStatus: driverGetDeviceVerificationStatus,
        getRecoveryKey: vi.fn().mockResolvedValue({ encodedPrivateKey: "driver-key" }),
        listVerifications: vi
          .fn()
          .mockResolvedValueOnce([ready])
          .mockResolvedValueOnce([initiatorSas])
          .mockResolvedValueOnce([completedInitiator]),
        requestVerification: vi.fn().mockResolvedValue(initiated),
        resetRoomKeyBackup: vi.fn().mockResolvedValue({ success: true }),
        startVerification: vi.fn().mockResolvedValue(initiatorSas),
        stop: driverStop,
      })
      .mockResolvedValueOnce({
        acceptVerification: vi.fn().mockResolvedValue(ready),
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
        confirmVerificationSas: vi.fn().mockResolvedValue(completedRecipient),
        getDeviceVerificationStatus: observerGetDeviceVerificationStatus,
        getRecoveryKey: vi.fn().mockResolvedValue({ encodedPrivateKey: "observer-key" }),
        listVerifications: vi
          .fn()
          .mockResolvedValueOnce([incoming])
          .mockResolvedValueOnce([recipientSas])
          .mockResolvedValueOnce([completedRecipient]),
        resetRoomKeyBackup: vi.fn().mockResolvedValue({ success: true }),
        stop: observerStop,
      });

    const scenario = requireMatrixQaScenario("matrix-e2ee-device-sas-verification");

    const result = await runMatrixQaScenario(scenario, {
      ...matrixQaScenarioContext(),
      driverDeviceId: "DRIVERDEVICE",
      driverPassword: "driver-password",
      observerDeviceId: "OBSERVERDEVICE",
      observerPassword: "observer-password",
      outputDir: "/tmp/matrix-qa",
      timeoutMs: 80,
    });
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.driverTrustsObserverDevice).toBe(true);
    expect(artifacts.observerTrustsDriverDevice).toBe(true);

    expect(driverGetDeviceVerificationStatus).toHaveBeenCalledTimes(2);
    expect(driverStop).toHaveBeenCalledTimes(1);
    expect(observerStop).toHaveBeenCalledTimes(1);
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
      "matrix-approval-exec-metadata-single-event",
      "matrix-approval-exec-metadata-chunked",
      "matrix-restart-resume",
      "matrix-mention-gating",
      "matrix-allowbots-default-block",
      "matrix-allowbots-mentions-mentioned-room",
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

  it("waits for the driver Matrix approval reaction echo before awaiting the decision", async () => {
    const context = matrixQaScenarioContext();
    let approvalId = "";
    const gatewayCall = vi.fn().mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === "exec.approval.request") {
        const params = args.find(
          (arg): arg is { id?: unknown } => typeof arg === "object" && arg !== null && "id" in arg,
        );
        const payload =
          typeof params === "object" && params !== null ? (params as { id?: unknown }) : undefined;
        if (typeof payload?.id !== "string") {
          throw new Error("approval request missing id");
        }
        approvalId = payload.id;
        return { id: approvalId, status: "accepted" };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "allow-once", id: approvalId };
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
    context.gatewayCall = gatewayCall;
    const rootEventId = "$approval-thread-root";
    const approvalEventId = "$approval-thread-event";
    const sendReaction = vi.fn().mockResolvedValue("$driver-approval-reaction");
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => ({
        event: matrixQaMessageEvent({
          approval: {
            allowedDecisions: ["allow-once", "deny"],
            hasCommandText: true,
            id: approvalId,
            kind: "exec",
            state: "pending",
            type: "approval.request",
            version: 1,
          },
          body: "approval requested",
          eventId: approvalEventId,
          kind: "message",
          relatesTo: {
            eventId: rootEventId,
            inReplyToId: rootEventId,
            isFallingBack: true,
            relType: "m.thread",
          },
        }),
        since: "driver-sync-approval",
      }))
      .mockImplementationOnce(async () => ({
        event: {
          eventId: "$bot-approval-option",
          kind: "reaction",
          reaction: {
            eventId: approvalEventId,
            key: "✅",
          },
          roomId: "!main:matrix-qa.test",
          sender: "@sut:matrix-qa.test",
          type: "m.reaction",
        } satisfies MatrixQaObservedEvent,
        since: "driver-sync-option",
      }))
      .mockImplementationOnce(async () => ({
        event: {
          eventId: "$driver-approval-reaction",
          kind: "reaction",
          reaction: {
            eventId: approvalEventId,
            key: "✅",
          },
          roomId: "!main:matrix-qa.test",
          sender: "@driver:matrix-qa.test",
          type: "m.reaction",
        } satisfies MatrixQaObservedEvent,
        since: "driver-sync-driver-reaction",
      }));
    createMatrixQaClient.mockReturnValue({
      primeRoom: vi.fn().mockResolvedValue("driver-sync-start"),
      sendReaction,
      sendTextMessage: vi.fn().mockResolvedValue(rootEventId),
      waitForRoomEvent,
    });

    const scenario = requireMatrixQaScenario("matrix-approval-thread-target");

    const result = await runMatrixQaScenario(scenario, context);
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.reactionEventId).toBe("$driver-approval-reaction");
    expect(artifacts.reactionTargetEventId).toBe(approvalEventId);
    expect(waitForRoomEvent).toHaveBeenCalledTimes(3);
    expect(mockCall(gatewayCall, "gatewayCall", -1)[0]).toBe("exec.approval.waitDecision");
  });

  it("reuses observed Matrix approval events across channel and DM target=both waits", async () => {
    const context = matrixQaScenarioContext();
    context.topology.rooms.push(
      {
        key: scenarioTesting.MATRIX_QA_DRIVER_DM_ROOM_KEY,
        kind: "dm",
        memberRoles: ["driver", "sut"],
        memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
        name: "Driver DM",
        requireMention: false,
        roomId: "!driver-dm:matrix-qa.test",
      },
      {
        key: scenarioTesting.MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
        kind: "dm",
        memberRoles: ["driver", "sut"],
        memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
        name: "Driver shared DM",
        requireMention: false,
        roomId: "!driver-shared-dm:matrix-qa.test",
      },
    );
    let approvalId = "";
    const gatewayCall = vi.fn().mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === "exec.approval.request") {
        const payload = args.find(
          (arg): arg is { id?: string } => typeof arg === "object" && arg !== null && "id" in arg,
        );
        approvalId = payload?.id ?? "";
        return { id: approvalId, status: "accepted" };
      }
      if (method === "exec.approval.resolve") {
        return { ok: true };
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
    context.gatewayCall = gatewayCall;

    const buildApprovalEvent = (eventId: string, roomId: string) =>
      matrixQaMessageEvent({
        approval: {
          allowedDecisions: ["allow-once", "deny"],
          hasCommandText: true,
          id: approvalId,
          kind: "exec",
          state: "pending",
          type: "approval.request",
          version: 1,
        },
        body: "approval requested",
        eventId,
        kind: "message",
        roomId,
      });
    const waitForRoomEvent = vi.fn().mockImplementation(async () => {
      const channelApproval = buildApprovalEvent("$approval-both-channel", "!main:matrix-qa.test");
      const dmApproval = buildApprovalEvent(
        "$approval-both-dm",
        "!driver-shared-dm:matrix-qa.test",
      );
      context.observedEvents.push(channelApproval, dmApproval, {
        eventId: "$approval-both-option",
        kind: "reaction",
        reaction: {
          eventId: "$approval-both-channel",
          key: "✅",
        },
        roomId: "!main:matrix-qa.test",
        sender: "@sut:matrix-qa.test",
        type: "m.reaction",
      });
      return { event: channelApproval, since: "driver-sync-approval" };
    });
    const waitForOptionalRoomEvent = vi.fn().mockResolvedValue({
      matched: false,
      since: "driver-sync-late-window",
    });
    createMatrixQaClient
      .mockReturnValueOnce({
        primeRoom: vi.fn().mockResolvedValue("driver-sync-start"),
        waitForOptionalRoomEvent,
      })
      .mockReturnValueOnce({
        waitForRoomEvent,
      });

    const scenario = requireMatrixQaScenario("matrix-approval-channel-target-both");

    const result = await runMatrixQaScenario(scenario, context);
    const artifacts = result.artifacts as {
      approvals?: Array<{ eventId?: string; roomId?: string }>;
    };
    expect(artifacts.approvals?.[0]?.eventId).toBe("$approval-both-channel");
    expect(artifacts.approvals?.[0]?.roomId).toBe("!main:matrix-qa.test");
    expect(artifacts.approvals?.[1]?.eventId).toBe("$approval-both-dm");
    expect(artifacts.approvals?.[1]?.roomId).toBe("!driver-shared-dm:matrix-qa.test");

    expect(waitForRoomEvent).toHaveBeenCalledTimes(1);
    const finalGatewayCall = mockCall(gatewayCall, "gatewayCall", -1);
    expect(finalGatewayCall[0]).toBe("exec.approval.resolve");
    expect((finalGatewayCall[2] as { expectFinal?: unknown }).expectFinal).toBe(false);
    expect(createMatrixQaClient).toHaveBeenCalledTimes(3);
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
    ).toStrictEqual([]);
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
        requireMatrixQaScenario("matrix-e2ee-basic-reply"),
        requireMatrixQaScenario("matrix-e2ee-thread-follow-up"),
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

    const scenario = requireMatrixQaScenario("matrix-allowlist-block");

    const syncState = {
      driver: "driver-sync-next",
    };

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.actorUserId).toBe("@observer:matrix-qa.test");
    expect(artifacts.expectedNoReplyWindowMs).toBe(8_000);

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
        body: mockMessageBody(sendTextMessage, "sendTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-observer-allowlist-override");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      actorUserId?: unknown;
      driverEventId?: unknown;
      reply?: { tokenMatched?: unknown };
    };
    expect(artifacts.actorUserId).toBe("@observer:matrix-qa.test");
    expect(artifacts.driverEventId).toBe("$observer-allow-trigger");
    expect(artifacts.reply?.tokenMatched).toBe(true);

    expect(createMatrixQaClient).toHaveBeenCalledWith({
      accessToken: "observer-token",
      baseUrl: "http://127.0.0.1:28008/",
    });
    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "@sut:matrix-qa.test reply with only this exact marker:",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!room:matrix-qa.test",
    });
  });

  it("runs mentioned allowBots=mentions room traffic through the observer bot account", async () => {
    const primeRoom = vi.fn().mockResolvedValue("observer-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$observer-bot-trigger");
    const waitForRoomEvent = vi.fn().mockImplementation(async () => ({
      event: {
        kind: "message",
        roomId: "!main:matrix-qa.test",
        eventId: "$sut-bot-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: mockMessageBody(sendTextMessage, "sendTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-allowbots-mentions-mentioned-room");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      actorUserId?: unknown;
      driverEventId?: unknown;
      reply?: { tokenMatched?: unknown };
    };
    expect(artifacts.actorUserId).toBe("@observer:matrix-qa.test");
    expect(artifacts.driverEventId).toBe("$observer-bot-trigger");
    expect(artifacts.reply?.tokenMatched).toBe(true);

    expect(createMatrixQaClient).toHaveBeenCalledWith({
      accessToken: "observer-token",
      baseUrl: "http://127.0.0.1:28008/",
    });
    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "@sut:matrix-qa.test reply with only this exact marker:",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
  });

  it("blocks unmentioned allowBots=mentions room traffic even when the room is open", async () => {
    const primeRoom = vi.fn().mockResolvedValue("observer-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$observer-bot-unmentioned");
    const waitForOptionalRoomEvent = vi.fn().mockResolvedValue({
      matched: false,
      since: "observer-sync-next",
    });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForOptionalRoomEvent,
    });

    const scenario = requireMatrixQaScenario(
      "matrix-allowbots-mentions-unmentioned-open-room-block",
    );

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.actorUserId).toBe("@observer:matrix-qa.test");
    expect(artifacts.driverEventId).toBe("$observer-bot-unmentioned");

    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "reply with only this exact marker:",
      roomId: "!main:matrix-qa.test",
    });
  });

  it("uses the SUT account as the sender for the self-sender allowBots loop guard", async () => {
    const primeRoom = vi.fn().mockResolvedValue("observer-sync-start");
    const observerWaitForOptionalRoomEvent = vi.fn().mockResolvedValue({
      matched: false,
      since: "observer-sync-next",
    });
    const observerSendTextMessage = vi.fn();
    const sutSendTextMessage = vi.fn().mockResolvedValue("$sut-self-trigger");

    createMatrixQaClient
      .mockReturnValueOnce({
        sendTextMessage: sutSendTextMessage,
      })
      .mockReturnValueOnce({
        primeRoom,
        sendTextMessage: observerSendTextMessage,
        waitForOptionalRoomEvent: observerWaitForOptionalRoomEvent,
      });

    const scenario = requireMatrixQaScenario("matrix-allowbots-self-sender-ignored");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.actorUserId).toBe("@sut:matrix-qa.test");
    expect(artifacts.driverEventId).toBe("$sut-self-trigger");

    expect(createMatrixQaClient).toHaveBeenNthCalledWith(1, {
      accessToken: "sut-token",
      baseUrl: "http://127.0.0.1:28008/",
    });
    expect(createMatrixQaClient).toHaveBeenNthCalledWith(2, {
      accessToken: "observer-token",
      baseUrl: "http://127.0.0.1:28008/",
    });
    expect(observerSendTextMessage).not.toHaveBeenCalled();
    expectSentTextMessage(sutSendTextMessage, {
      bodyIncludes: "reply with only this exact marker:",
      roomId: "!main:matrix-qa.test",
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

    const scenario = requireMatrixQaScenario("matrix-mxid-prefixed-command-block");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.actorUserId).toBe("@observer:matrix-qa.test");
    expect(artifacts.driverEventId).toBe("$observer-command-trigger");

    expect(createMatrixQaClient).toHaveBeenCalledWith({
      accessToken: "observer-token",
      baseUrl: "http://127.0.0.1:28008/",
    });
    expect(sendTextMessage).toHaveBeenCalledWith({
      body: "@sut:matrix-qa.test /new",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
    expect(mockObjectArg(waitForOptionalRoomEvent, "waitForOptionalRoomEvent").roomId).toBe(
      "!main:matrix-qa.test",
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

    const scenario = requireMatrixQaScenario("matrix-mxid-prefixed-command-block");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.driverEventId).toBe("$observer-command-trigger");
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
      const sentBody = lastMockMessageBody(sendTextMessage, "sendTextMessage");
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

    const scenario = requireMatrixQaScenario("matrix-allowlist-hot-reload");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      firstReply?: { eventId?: unknown; tokenMatched?: unknown };
      secondDriverEventId?: unknown;
    };
    expect(artifacts.secondDriverEventId).toBe("$group-removed");
    expect(artifacts.firstReply?.eventId).toBe("$group-reply");
    expect(artifacts.firstReply?.tokenMatched).toBe(true);

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
    expect(mockObjectArg(sendTextMessage, "sendTextMessage").mentionUserIds).toEqual([
      "@sut:matrix-qa.test",
    ]);
    expect(mockObjectArg(sendTextMessage, "sendTextMessage").roomId).toBe("!main:matrix-qa.test");
    expect(mockObjectArg(sendTextMessage, "sendTextMessage", 1).mentionUserIds).toEqual([
      "@sut:matrix-qa.test",
    ]);
    expect(mockObjectArg(sendTextMessage, "sendTextMessage", 1).roomId).toBe(
      "!main:matrix-qa.test",
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
      const sentBody = lastMockMessageBody(sendTextMessage, "sendTextMessage");
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

    const scenario = requireMatrixQaScenario("matrix-initial-catchup-then-incremental");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      catchupDriverEventId?: unknown;
      catchupReply?: { eventId?: unknown; tokenMatched?: unknown };
      incrementalDriverEventId?: unknown;
      incrementalReply?: { eventId?: unknown; tokenMatched?: unknown };
    };
    expect(artifacts.catchupDriverEventId).toBe("$catchup-trigger");
    expect(artifacts.catchupReply?.eventId).toBe("$catchup-reply");
    expect(artifacts.catchupReply?.tokenMatched).toBe(true);
    expect(artifacts.incrementalDriverEventId).toBe("$incremental-trigger");
    expect(artifacts.incrementalReply?.eventId).toBe("$incremental-reply");
    expect(artifacts.incrementalReply?.tokenMatched).toBe(true);

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
      const sentBody = lastMockMessageBody(sendTextMessage, "sendTextMessage");
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

    const scenario = requireMatrixQaScenario("matrix-restart-replay-dedupe");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      duplicateWindowMs?: unknown;
      firstDriverEventId?: unknown;
      firstReply?: { eventId?: unknown; tokenMatched?: unknown };
      freshDriverEventId?: unknown;
      freshReply?: { eventId?: unknown; tokenMatched?: unknown };
    };
    expect(artifacts.duplicateWindowMs).toBe(8000);
    expect(artifacts.firstDriverEventId).toBe("$first-trigger");
    expect(artifacts.firstReply?.eventId).toBe("$first-reply");
    expect(artifacts.firstReply?.tokenMatched).toBe(true);
    expect(artifacts.freshDriverEventId).toBe("$fresh-trigger");
    expect(artifacts.freshReply?.eventId).toBe("$fresh-reply");
    expect(artifacts.freshReply?.tokenMatched).toBe(true);

    expect(callOrder).toEqual([
      "send:first",
      "wait:first",
      "restart",
      "wait:no-duplicate",
      "send:fresh",
      "wait:fresh",
    ]);
    const firstOptionalWait = mockObjectArg(waitForOptionalRoomEvent, "waitForOptionalRoomEvent");
    expect(firstOptionalWait.roomId).toBe("!restart:matrix-qa.test");
    expect(firstOptionalWait.timeoutMs).toBe(8000);
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
        const sentBody = lastMockMessageBody(sendTextMessage, "sendTextMessage");
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

      const scenario = requireMatrixQaScenario("matrix-stale-sync-replay-dedupe");

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        gatewayStateDir: stateRoot,
        restartGatewayAfterStateMutation: async (mutateState) => {
          callOrder.push("hard-restart");
          await writeTestJsonFile(syncStorePath, matrixSyncStoreFixture("driver-sync-after-first"));
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
      });
      const artifacts = result.artifacts as {
        dedupeCommitObserved?: unknown;
        duplicateWindowMs?: unknown;
        firstDriverEventId?: unknown;
        firstReply?: { eventId?: unknown; tokenMatched?: unknown };
        freshDriverEventId?: unknown;
        freshReply?: { eventId?: unknown; tokenMatched?: unknown };
        restartSignal?: unknown;
        staleSyncCursor?: unknown;
      };
      expect(artifacts.dedupeCommitObserved).toBe(true);
      expect(artifacts.duplicateWindowMs).toBe(8000);
      expect(artifacts.firstDriverEventId).toBe("$first-trigger");
      expect(artifacts.firstReply?.eventId).toBe("$first-reply");
      expect(artifacts.firstReply?.tokenMatched).toBe(true);
      expect(artifacts.freshDriverEventId).toBe("$fresh-trigger");
      expect(artifacts.freshReply?.eventId).toBe("$fresh-reply");
      expect(artifacts.freshReply?.tokenMatched).toBe(true);
      expect(artifacts.restartSignal).toBe("hard-restart");
      expect(artifacts.staleSyncCursor).toBe("driver-sync-start");

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
        const token = mockMessageBody(sendTextMessage, "sendTextMessage").replace(
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-sync-state-loss-crypto-intact");

      const result = await runMatrixQaScenario(scenario, {
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
      });
      const artifacts = result.artifacts as {
        deletedSyncStorePath?: unknown;
        driverEventId?: unknown;
        replyEventId?: unknown;
        roomKey?: unknown;
      };
      expect(artifacts.deletedSyncStorePath).toBe(syncStorePath);
      expect(artifacts.driverEventId).toBe("$driver-trigger");
      expect(artifacts.replyEventId).toBe("$sut-decrypted-reply");
      expect(artifacts.roomKey).toBe("e2ee-sync-state-loss-crypto-intact-recovery");

      await expectPathMissing(syncStorePath);
      expect(mockObjectArg(registerWithToken, "registerWithToken").registrationToken).toBe(
        "registration-token",
      );
      expect(createPrivateRoom).toHaveBeenCalledWith({
        encrypted: true,
        inviteUserIds: ["@observer:matrix-qa.test", "@sync-gateway:matrix-qa.test"],
        name: "Matrix QA E2EE Sync State Loss Recovery Room",
      });
      expect(observerJoinRoom).toHaveBeenCalledWith("!recovery:matrix-qa.test");
      expect(sutJoinRoom).toHaveBeenCalledWith("!recovery:matrix-qa.test");
      expect(hardRestartAccounts).toHaveLength(3);
      const recoveryGroup = {
        "!recovery:matrix-qa.test": {
          enabled: true,
          requireMention: true,
        },
      };
      expect(hardRestartAccounts[0]?.defaultAccount).toBe("sync-state-loss-gateway");
      expect(hardRestartAccounts[0]?.accounts["sync-state-loss-gateway"]?.groups).toEqual(
        recoveryGroup,
      );
      expect(hardRestartAccounts[0]?.accounts["sync-state-loss-gateway"]?.userId).toBe(
        "@sync-gateway:matrix-qa.test",
      );
      expect(hardRestartAccounts[1]?.defaultAccount).toBe("sync-state-loss-gateway");
      expect(hardRestartAccounts[1]?.accounts["sync-state-loss-gateway"]?.groups).toEqual(
        recoveryGroup,
      );
      expect(hardRestartAccounts[1]?.accounts["sync-state-loss-gateway"]?.userId).toBe(
        "@sync-gateway:matrix-qa.test",
      );
      expect(hardRestartAccounts[2]?.defaultAccount).toBe("sut");
      expect(hardRestartAccounts[2]?.accounts.sut?.groups).toEqual(originalGroups);
      expect(hardRestartAccounts[2]?.accounts.sut?.userId).toBe("@sut:matrix-qa.test");
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
      expectSentTextMessage(sendTextMessage, {
        bodyIncludes: "@sync-gateway:matrix-qa.test reply with only this exact marker:",
        mentionUserIds: ["@sync-gateway:matrix-qa.test"],
        roomId: "!recovery:matrix-qa.test",
      });
      const waitParams = mockObjectArg(rawWaitForRoomEvent, "rawWaitForRoomEvent");
      expect(waitParams.roomId).toBe("!recovery:matrix-qa.test");
      expect(waitParams.since).toBe("raw-driver-sync-start");
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
        const body = lastMockMessageBody(sendTextMessage, "sendTextMessage");
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-restart-resume");

      const result = await runMatrixQaScenario(scenario, {
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
      });
      const artifacts = result.artifacts as {
        driverUserId?: unknown;
        firstDriverEventId?: unknown;
        recoveredDriverEventId?: unknown;
        roomId?: unknown;
      };
      expect(artifacts.driverUserId).toBe("@isolated-driver:matrix-qa.test");
      expect(artifacts.firstDriverEventId).toBe("$before-trigger");
      expect(artifacts.recoveredDriverEventId).toBe("$after-trigger");
      expect(artifacts.roomId).toBe("!isolated-restart:matrix-qa.test");

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
      const restartCalls = restartGatewayAfterStateMutation.mock.calls as unknown as Array<
        [unknown, { timeoutMs: number; waitAccountId: string }]
      >;
      expect(typeof restartCalls[0]?.[0]).toBe("function");
      expect(restartCalls[0]?.[1]).toEqual({
        timeoutMs: 8_000,
        waitAccountId: "sut",
      });
      expect(typeof restartCalls[1]?.[0]).toBe("function");
      expect(restartCalls[1]?.[1]).toEqual({
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
      const clientOptions = mockObjectArg(
        createMatrixQaE2eeScenarioClient,
        "createMatrixQaE2eeScenarioClient",
      );
      expect(clientOptions.accessToken).toBe("isolated-driver-token");
      expect(clientOptions.actorId).toBe("driver-restart-resume");
      expect(clientOptions.deviceId).toBe("ISOLATEDDRIVER");
      expect(clientOptions.password).toBe("isolated-driver-password");
      expect(clientOptions.userId).toBe("@isolated-driver:matrix-qa.test");
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
        body: mockMessageBody(sendTextMessage, "sendTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-dm-reply-shape");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as { actorUserId?: unknown };
    expect(artifacts.actorUserId).toBe("@driver:matrix-qa.test");

    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "reply with only this exact marker:",
      roomId: "!dm:matrix-qa.test",
    });
    expect(mockObjectArg(waitForRoomEvent, "waitForRoomEvent").roomId).toBe("!dm:matrix-qa.test");
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
        body: mockMessageBody(sendTextMessage, "sendTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-room-thread-reply-override");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      reply?: {
        relatesTo?: {
          eventId?: unknown;
          relType?: unknown;
        };
      };
    };
    expect(artifacts.driverEventId).toBe("$room-thread-trigger");
    expect(artifacts.reply?.relatesTo?.relType).toBe("m.thread");
    expect(artifacts.reply?.relatesTo?.eventId).toBe("$room-thread-trigger");
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
            mockMessageBody(sendTextMessage, "sendTextMessage"),
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

    const scenario = requireMatrixQaScenario("matrix-subagent-thread-spawn");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      subagentCompletion?: {
        eventId?: unknown;
        relatesTo?: {
          eventId?: unknown;
          relType?: unknown;
        };
        tokenMatched?: unknown;
      };
      subagentIntro?: { eventId?: unknown };
      threadRootEventId?: unknown;
    };
    expect(artifacts.driverEventId).toBe("$subagent-spawn-trigger");
    expect(artifacts.subagentCompletion?.eventId).toBe("$subagent-completion");
    expect(artifacts.subagentCompletion?.relatesTo?.relType).toBe("m.thread");
    expect(artifacts.subagentCompletion?.relatesTo?.eventId).toBe("$subagent-thread-root");
    expect(artifacts.subagentCompletion?.tokenMatched).toBe(true);
    expect(artifacts.subagentIntro?.eventId).toBe("$subagent-thread-root");
    expect(artifacts.threadRootEventId).toBe("$subagent-thread-root");

    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: ["Call sessions_spawn now for this QA check", "runTimeoutSeconds=60"],
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
    expect(mockObjectArg(waitForRoomEvent, "waitForRoomEvent").since).toBe("driver-sync-start");
    const completionWaitOptions = mockObjectArg(waitForRoomEvent, "waitForRoomEvent", 1);
    expect(typeof completionWaitOptions?.predicate).toBe("function");
    expect(completionWaitOptions.since).toBe("driver-sync-intro");
    const introPredicate = mockObjectArg(waitForRoomEvent, "waitForRoomEvent").predicate as
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

    const scenario = requireMatrixQaScenario("matrix-subagent-thread-spawn");

    await expect(runMatrixQaScenario(scenario, matrixQaScenarioContext())).rejects.toThrow(
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

    const scenario = requireMatrixQaScenario("matrix-subagent-thread-spawn");

    await expect(runMatrixQaScenario(scenario, matrixQaScenarioContext())).rejects.toThrow(
      "sessions_spawn failed",
    );

    expect(waitForRoomEvent).toHaveBeenCalledTimes(1);
  });

  it("captures quiet preview notices before the finalized Matrix reply", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$quiet-stream-trigger");
    const readFinalText = () =>
      /reply exactly `([^`]+)`/.exec(mockMessageBody(sendTextMessage, "sendTextMessage"))?.[1] ??
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

    const scenario = requireMatrixQaScenario("matrix-room-quiet-streaming-preview");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      previewEventId?: unknown;
      reply?: { eventId?: unknown };
    };
    expect(artifacts.driverEventId).toBe("$quiet-stream-trigger");
    expect(artifacts.previewEventId).toBe("$quiet-preview");
    expect(artifacts.reply?.eventId).toBe("$quiet-final");

    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "Quiet streaming QA check",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
    expect(mockObjectArg(waitForRoomEvent, "waitForRoomEvent").since).toBe("driver-sync-start");
    const finalWaitOptions = mockObjectArg(waitForRoomEvent, "waitForRoomEvent", 1);
    expect(typeof finalWaitOptions?.predicate).toBe("function");
    expect(finalWaitOptions.since).toBe("driver-sync-preview");
  });

  it("captures partial preview text messages before the finalized Matrix reply", async () => {
    const previewEventId = "$partial-preview";
    const fallbackFinalText = "MATRIX_QA_PARTIAL_STREAM_PREVIEW_COMPLETE";
    const { sendTextMessage } = mockMatrixQaRoomClient({
      driverEventId: "$partial-stream-trigger",
      events: [
        {
          event: matrixQaMessageEvent({
            kind: "message",
            eventId: previewEventId,
            body: "partial preview",
          }),
          since: "driver-sync-preview",
        },
        {
          event: ({ sendTextMessage }) =>
            matrixQaMessageEvent({
              kind: "message",
              eventId: "$partial-final",
              body: readMatrixQaReplyDirective(
                mockMessageBody(sendTextMessage, "sendTextMessage"),
                fallbackFinalText,
              ),
              relatesTo: {
                relType: "m.replace",
                eventId: previewEventId,
              },
            }),
          since: "driver-sync-next",
        },
      ],
    });

    const scenario = requireMatrixQaScenario("matrix-room-partial-streaming-preview");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      previewEventId?: unknown;
      reply?: { eventId?: unknown };
    };
    expect(artifacts.driverEventId).toBe("$partial-stream-trigger");
    expect(artifacts.previewEventId).toBe("$partial-preview");
    expect(artifacts.reply?.eventId).toBe("$partial-final");

    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "Partial streaming QA check",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
  });

  it("captures Matrix tool progress inside the quiet preview before finalizing", async () => {
    const previewEventId = "$tool-progress-preview";
    const { sendTextMessage } = mockMatrixQaRoomClient({
      driverEventId: "$tool-progress-trigger",
      events: [
        {
          event: matrixQaMessageEvent({
            kind: "notice",
            eventId: previewEventId,
            body: "Barnacling...\n`📖 Read: from /tmp/qa/workspace/QA_KICKOFF_TASK.md`",
          }),
          since: "driver-sync-preview",
        },
        {
          event: ({ sendTextMessage }) =>
            matrixQaMessageEvent({
              kind: "notice",
              eventId: "$tool-progress-final",
              body: readMatrixQaReplyDirective(
                mockMessageBody(sendTextMessage, "sendTextMessage"),
                "MATRIX_QA_TOOL_PROGRESS_FIXED",
              ),
              relatesTo: {
                relType: "m.replace",
                eventId: previewEventId,
              },
            }),
          since: "driver-sync-next",
        },
      ],
    });

    const scenario = requireMatrixQaScenario("matrix-room-tool-progress-preview");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      previewBodyPreview?: unknown;
      previewEventId?: unknown;
      reply?: { eventId?: unknown };
    };
    expect(artifacts.driverEventId).toBe("$tool-progress-trigger");
    expect(artifacts.previewBodyPreview).toBe(
      "Barnacling...\n`📖 Read: from /tmp/qa/workspace/QA_KICKOFF_TASK.md`",
    );
    expect(artifacts.previewEventId).toBe("$tool-progress-preview");
    expect(artifacts.reply?.eventId).toBe("$tool-progress-final");
    const prompt = mockMessageBody(sendTextMessage, "sendTextMessage");
    expect(prompt).toContain("use the read tool exactly once on `QA_KICKOFF_TASK.md`");
    expect(prompt).toContain("Do not read `HEARTBEAT.md`");
    expect(prompt).toContain("reply with only this exact marker and no other text");
  });

  it("accepts non-read Matrix tool progress lines in quiet previews", async () => {
    const previewEventId = "$tool-progress-generic-preview";
    mockMatrixQaRoomClient({
      driverEventId: "$tool-progress-generic-trigger",
      events: [
        {
          event: matrixQaMessageEvent({
            kind: "notice",
            eventId: previewEventId,
            body: "One moment.",
          }),
          since: "driver-sync-preview",
        },
        {
          event: matrixQaMessageEvent({
            kind: "notice",
            eventId: "$tool-progress-generic-update",
            body: "- `tool: exec_command`",
            relatesTo: {
              relType: "m.replace",
              eventId: previewEventId,
            },
          }),
          since: "driver-sync-progress",
        },
        {
          event: ({ sendTextMessage }) =>
            matrixQaMessageEvent({
              kind: "notice",
              eventId: "$tool-progress-generic-final",
              body: readMatrixQaReplyDirective(
                mockMessageBody(sendTextMessage, "sendTextMessage"),
                "MATRIX_QA_TOOL_PROGRESS_FIXED",
              ),
              relatesTo: {
                relType: "m.replace",
                eventId: previewEventId,
              },
            }),
          since: "driver-sync-next",
        },
      ],
    });

    const scenario = requireMatrixQaScenario("matrix-room-tool-progress-preview");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      previewBodyPreview?: unknown;
      previewEventId?: unknown;
      reply?: { eventId?: unknown };
    };
    expect(artifacts.driverEventId).toBe("$tool-progress-generic-trigger");
    expect(artifacts.previewBodyPreview).toBe("- `tool: exec_command`");
    expect(artifacts.previewEventId).toBe("$tool-progress-generic-preview");
    expect(artifacts.reply?.eventId).toBe("$tool-progress-generic-final");
  });

  it("reports Matrix tool progress preview candidates when the progress wait times out", async () => {
    const previewEvent = matrixQaMessageEvent({
      kind: "notice",
      eventId: "$tool-progress-timeout-preview",
      body: "Working...",
    });
    const updateEvent = matrixQaMessageEvent({
      kind: "notice",
      eventId: "$tool-progress-timeout-update",
      body: "Working...\nstill deciding",
      relatesTo: {
        relType: "m.replace",
        eventId: previewEvent.eventId,
      },
    });
    const context = matrixQaScenarioContext();
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$tool-progress-timeout-trigger");
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => {
        context.observedEvents.push(previewEvent);
        return { event: previewEvent, since: "driver-sync-preview" };
      })
      .mockImplementationOnce(async () => {
        context.observedEvents.push(updateEvent);
        throw new Error("timed out after 8000ms waiting for Matrix room event");
      });
    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = requireMatrixQaScenario("matrix-room-tool-progress-preview");

    await expect(runMatrixQaScenario(scenario, context)).rejects.toThrow(
      /observed preview candidates:[\s\S]*\$tool-progress-timeout-update/,
    );
  });

  it("reports Matrix tool progress final candidates when finalization misses the token", async () => {
    const previewEvent = matrixQaMessageEvent({
      kind: "notice",
      eventId: "$tool-progress-final-timeout-preview",
      body: "Working...",
    });
    const progressEvent = matrixQaMessageEvent({
      kind: "notice",
      eventId: "$tool-progress-final-timeout-update",
      body: "Working...\n- `tool: read`",
      relatesTo: {
        relType: "m.replace",
        eventId: previewEvent.eventId,
      },
    });
    const finalCandidate = matrixQaMessageEvent({
      kind: "message",
      eventId: "$tool-progress-final-timeout-candidate",
      body: "I read the file, but missed the exact marker.",
      relatesTo: {
        relType: "m.replace",
        eventId: previewEvent.eventId,
      },
    });
    const context = matrixQaScenarioContext();
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$tool-progress-final-timeout-trigger");
    const waitForRoomEvent = vi
      .fn()
      .mockImplementationOnce(async () => {
        context.observedEvents.push(previewEvent);
        return { event: previewEvent, since: "driver-sync-preview" };
      })
      .mockImplementationOnce(async () => {
        context.observedEvents.push(progressEvent);
        return { event: progressEvent, since: "driver-sync-progress" };
      })
      .mockImplementationOnce(async () => {
        context.observedEvents.push(finalCandidate);
        throw new Error("timed out after 8000ms waiting for Matrix room event");
      });
    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForRoomEvent,
    });

    const scenario = requireMatrixQaScenario("matrix-room-tool-progress-preview");

    await expect(runMatrixQaScenario(scenario, context)).rejects.toThrow(
      /observed final candidates:[\s\S]*\$tool-progress-final-timeout-candidate/,
    );
  });

  it("keeps Matrix tool progress opt-out from creating Working previews", async () => {
    const { waitForRoomEvent } = mockMatrixQaRoomClient({
      driverEventId: "$tool-progress-optout-trigger",
      events: [
        {
          event: ({ sendTextMessage }) =>
            matrixQaMessageEvent({
              kind: "message",
              eventId: "$tool-progress-optout-final",
              body: readMatrixQaReplyDirective(
                mockMessageBody(sendTextMessage, "sendTextMessage"),
                "MATRIX_QA_TOOL_PROGRESS_OPTOUT_FIXED",
              ),
            }),
          since: "driver-sync-next",
        },
      ],
    });

    const scenario = requireMatrixQaScenario("matrix-room-tool-progress-preview-opt-out");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      reply?: { eventId?: unknown };
    };
    expect(artifacts.driverEventId).toBe("$tool-progress-optout-trigger");
    expect(artifacts.reply?.eventId).toBe("$tool-progress-optout-final");

    expect(waitForRoomEvent).toHaveBeenCalledTimes(1);
  });

  it("finalizes Matrix tool progress previews after tool errors", async () => {
    const previewEventId = "$tool-progress-error-preview";
    const progressEvent = matrixQaMessageEvent({
      kind: "notice",
      eventId: "$tool-progress-error-progress",
      body: "Pearling...\n`📖 Read: from /tmp/qa/workspace/missing-matrix-tool-progress-target.txt`",
      relatesTo: {
        relType: "m.replace",
        eventId: previewEventId,
      },
    });
    const { sendTextMessage, waitForRoomEvent } = mockMatrixQaRoomClient({
      driverEventId: "$tool-progress-error-trigger",
      events: [
        {
          event: progressEvent,
          since: "driver-sync-preview",
        },
        {
          event: ({ sendTextMessage }) =>
            matrixQaMessageEvent({
              kind: "notice",
              eventId: "$tool-progress-error-final",
              body: readMatrixQaReplyDirective(
                mockMessageBody(sendTextMessage, "sendTextMessage"),
                "MATRIX_QA_TOOL_PROGRESS_ERROR_FIXED",
              ),
              relatesTo: {
                relType: "m.replace",
                eventId: previewEventId,
              },
            }),
          since: "driver-sync-next",
        },
      ],
    });

    const scenario = requireMatrixQaScenario("matrix-room-tool-progress-error");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      previewBodyPreview?: unknown;
      previewEventId?: unknown;
      reply?: {
        eventId?: unknown;
        relatesTo?: {
          eventId?: unknown;
          relType?: unknown;
        };
      };
    };
    expect(artifacts.driverEventId).toBe("$tool-progress-error-trigger");
    expect(artifacts.previewBodyPreview).toBe(
      "Pearling...\n`📖 Read: from /tmp/qa/workspace/missing-matrix-tool-progress-target.txt`",
    );
    expect(artifacts.previewEventId).toBe("$tool-progress-error-preview");
    expect(artifacts.reply?.eventId).toBe("$tool-progress-error-final");
    expect(artifacts.reply?.relatesTo?.eventId).toBe("$tool-progress-error-preview");
    expect(artifacts.reply?.relatesTo?.relType).toBe("m.replace");

    const progressWait = mockObjectArg(waitForRoomEvent, "waitForRoomEvent");
    expect(
      (progressWait.predicate as (event: MatrixQaObservedEvent) => boolean)(progressEvent),
    ).toBe(true);
    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "Tool progress error QA check",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!main:matrix-qa.test",
    });
  });

  it("accepts shortened Matrix tool progress error preview lines", async () => {
    const previewEventId = "$tool-progress-error-short-preview";
    const previewEvent = matrixQaMessageEvent({
      kind: "notice",
      eventId: previewEventId,
      body: "Nautiling...\n`📖 Read: from…ng-matrix-tool-progress-target.txt`",
    });
    const { waitForRoomEvent } = mockMatrixQaRoomClient({
      driverEventId: "$tool-progress-error-short-trigger",
      events: [
        {
          event: previewEvent,
          since: "driver-sync-preview",
        },
        {
          event: ({ sendTextMessage }) =>
            matrixQaMessageEvent({
              kind: "notice",
              eventId: "$tool-progress-error-short-final",
              body: readMatrixQaReplyDirective(
                mockMessageBody(sendTextMessage, "sendTextMessage"),
                "MATRIX_QA_TOOL_PROGRESS_ERROR_SHORT_FIXED",
              ),
              relatesTo: {
                relType: "m.replace",
                eventId: previewEventId,
              },
            }),
          since: "driver-sync-next",
        },
      ],
    });

    const scenario = requireMatrixQaScenario("matrix-room-tool-progress-error");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      previewBodyPreview?: unknown;
      previewEventId?: unknown;
      reply?: {
        eventId?: unknown;
        relatesTo?: {
          eventId?: unknown;
          relType?: unknown;
        };
      };
    };
    expect(artifacts.previewBodyPreview).toBe(
      "Nautiling...\n`📖 Read: from…ng-matrix-tool-progress-target.txt`",
    );
    expect(artifacts.previewEventId).toBe(previewEventId);
    expect(artifacts.reply?.eventId).toBe("$tool-progress-error-short-final");
    expect(artifacts.reply?.relatesTo?.eventId).toBe(previewEventId);
    expect(artifacts.reply?.relatesTo?.relType).toBe("m.replace");

    expect(waitForRoomEvent).toHaveBeenCalledTimes(2);
  });

  it("keeps Matrix-looking tool progress mentions inert in partial previews", async () => {
    const previewEventId = "$tool-progress-mention-preview";
    mockMatrixQaRoomClient({
      driverEventId: "$tool-progress-mention-trigger",
      events: [
        {
          event: matrixQaMessageEvent({
            kind: "message",
            eventId: previewEventId,
            body: "Working...\n- `tool: read`",
          }),
          since: "driver-sync-preview",
        },
        {
          event: matrixQaMessageEvent({
            kind: "message",
            eventId: "$tool-progress-mention-edit",
            body: "Working...\n- `tool: read`\n- `read from matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt`",
            formattedBody:
              "Working...<br><ul><li><code>read from matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt</code></li></ul>",
            mentions: {},
            relatesTo: {
              relType: "m.replace",
              eventId: previewEventId,
            },
          }),
          since: "driver-sync-progress",
        },
        {
          event: ({ sendTextMessage }) =>
            matrixQaMessageEvent({
              kind: "message",
              eventId: "$tool-progress-mention-final",
              body: readMatrixQaReplyDirective(
                mockMessageBody(sendTextMessage, "sendTextMessage"),
                "MATRIX_QA_TOOL_PROGRESS_MENTION_SAFE_FIXED",
              ),
              relatesTo: {
                relType: "m.replace",
                eventId: previewEventId,
              },
            }),
          since: "driver-sync-next",
        },
      ],
    });

    const scenario = requireMatrixQaScenario("matrix-room-tool-progress-mention-safety");

    const result = await runMatrixQaScenario(scenario, matrixQaScenarioContext());
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      previewEventId?: unknown;
      previewMentions?: unknown;
      reply?: { eventId?: unknown };
    };
    expect(artifacts.driverEventId).toBe("$tool-progress-mention-trigger");
    expect(artifacts.previewEventId).toBe("$tool-progress-mention-preview");
    expect(artifacts.previewMentions).toEqual({});
    expect(artifacts.reply?.eventId).toBe("$tool-progress-mention-final");
  });

  it("preserves separate finalized block events when Matrix block streaming is enabled", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$block-stream-trigger");
    const readBlockText = (label: "ONE" | "TWO") =>
      mockMessageBody(sendTextMessage, "sendTextMessage")
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

    const scenario = requireMatrixQaScenario("matrix-room-block-streaming");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      blockEventIds?: unknown;
      driverEventId?: unknown;
    };
    expect(artifacts.blockEventIds).toEqual(["$block-one", "$block-two"]);
    expect(artifacts.driverEventId).toBe("$block-stream-trigger");

    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "Block streaming QA check",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!block:matrix-qa.test",
    });
    const body = mockMessageBody(sendTextMessage, "sendTextMessage");
    expect(body).toMatch(
      /reply with exactly this two-line body and no extra text:\nMATRIX_QA_BLOCK_ONE_[A-F0-9]{8}\nMATRIX_QA_BLOCK_TWO_[A-F0-9]{8}$/,
    );
    expect(mockObjectArg(waitForRoomEvent, "waitForRoomEvent", 1).since).toBe(
      "driver-sync-block-one",
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

    const scenario = requireMatrixQaScenario("matrix-room-image-understanding-attachment");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      attachmentFilename?: unknown;
      driverEventId?: unknown;
      reply?: { eventId?: unknown };
    };
    expect(artifacts.attachmentFilename).toBe("red-top-blue-bottom.png");
    expect(artifacts.driverEventId).toBe("$image-understanding-trigger");
    expect(artifacts.reply?.eventId).toBe("$sut-image-reply");

    const mediaMessage = mockObjectArg(sendMediaMessage, "sendMediaMessage");
    expect(String(mediaMessage.body)).toContain("Image understanding check");
    expect(mediaMessage.contentType).toBe("image/png");
    expect(mediaMessage.fileName).toBe("red-top-blue-bottom.png");
    expect(mediaMessage.kind).toBe("image");
    expect(mediaMessage.mentionUserIds).toEqual(["@sut:matrix-qa.test"]);
    expect(mediaMessage.roomId).toBe("!media:matrix-qa.test");
    expect(mockObjectArg(waitForRoomEvent, "waitForRoomEvent", 1).since).toBe(
      "driver-sync-attachment",
    );
  });

  it("waits for a real Matrix image attachment after image generation", async () => {
    const primeRoom = vi.fn().mockResolvedValue("driver-sync-start");
    const sendTextMessage = vi.fn().mockResolvedValue("$image-generate-trigger");
    const waitForOptionalRoomEvent = vi
      .fn()
      .mockResolvedValueOnce({
        matched: false,
        since: "driver-sync-start",
      })
      .mockResolvedValueOnce({
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
        matched: true,
        since: "driver-sync-next",
      });

    createMatrixQaClient.mockReturnValue({
      primeRoom,
      sendTextMessage,
      waitForOptionalRoomEvent,
    });

    const scenario = requireMatrixQaScenario("matrix-room-generated-image-delivery");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      attachmentEventId?: unknown;
      attachmentFilename?: unknown;
      attachmentKind?: unknown;
      attachmentMsgtype?: unknown;
      driverEventId?: unknown;
    };
    expect(artifacts.attachmentEventId).toBe("$sut-image");
    expect(artifacts.attachmentFilename).toBe("qa-lighthouse.png");
    expect(artifacts.attachmentKind).toBe("image");
    expect(artifacts.attachmentMsgtype).toBe("m.image");
    expect(artifacts.driverEventId).toBe("$image-generate-trigger");

    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "/tool image_generate action=generate",
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

    const scenario = requireMatrixQaScenario("matrix-media-type-coverage");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      attachments?: Array<{
        eventId?: unknown;
        filename?: unknown;
        kind?: unknown;
        msgtype?: unknown;
      }>;
      roomId?: unknown;
    };
    expect(artifacts.attachments).toHaveLength(mediaCases.length);
    for (const [index, mediaCase] of mediaCases.entries()) {
      expect(artifacts.attachments?.[index]?.eventId).toBe(mediaCase.eventId);
      expect(artifacts.attachments?.[index]?.filename).toBe(mediaCase.fileName);
      expect(artifacts.attachments?.[index]?.kind).toBe(mediaCase.expectedAttachmentKind);
      expect(artifacts.attachments?.[index]?.msgtype).toBe(mediaCase.expectedMsgtype);
    }
    expect(artifacts.roomId).toBe("!media:matrix-qa.test");

    expect(sendMediaMessage).toHaveBeenCalledTimes(mediaCases.length);
    for (const [index, mediaCase] of MATRIX_QA_MEDIA_TYPE_COVERAGE_CASES.entries()) {
      const mediaMessage = sendMediaMessage.mock.calls[index]?.[0];
      expect(mediaMessage?.contentType).toBe(mediaCase.contentType);
      expect(mediaMessage?.fileName).toBe(mediaCase.fileName);
      expect(mediaMessage?.kind).toBe(mediaCase.kind);
      expect(mediaMessage?.mentionUserIds).toEqual(["@sut:matrix-qa.test"]);
    }
    const firstReplyWait = mockObjectArg(waitForRoomEvent, "waitForRoomEvent", 1) as {
      predicate: (event: MatrixQaObservedEvent) => boolean;
    };
    const firstToken =
      mockMessageBody(sendMediaMessage, "sendMediaMessage").match(
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
        body: mockMessageBody(sendTextMessage, "sendTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-dm-thread-reply-override");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      driverEventId?: unknown;
      reply?: {
        relatesTo?: {
          eventId?: unknown;
          relType?: unknown;
        };
      };
    };
    expect(artifacts.driverEventId).toBe("$dm-thread-trigger");
    expect(artifacts.reply?.relatesTo?.relType).toBe("m.thread");
    expect(artifacts.reply?.relatesTo?.eventId).toBe("$dm-thread-trigger");
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
        body: mockMessageBody(sendPrimaryTextMessage, "sendPrimaryTextMessage").replace(
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
        body: mockMessageBody(sendSecondaryTextMessage, "sendSecondaryTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-dm-shared-session-notice");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      noticeEventId?: unknown;
      roomKey?: unknown;
    };
    expect(artifacts.noticeEventId).toBe("$shared-notice");
    expect(artifacts.roomKey).toBe(scenarioTesting.MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY);

    expectSentTextMessage(sendPrimaryTextMessage, {
      bodyIncludes: "reply with only this exact marker:",
      roomId: "!dm:matrix-qa.test",
    });
    expectSentTextMessage(sendSecondaryTextMessage, {
      bodyIncludes: "reply with only this exact marker:",
      roomId: "!dm-shared:matrix-qa.test",
    });
    expect(mockObjectArg(waitSecondaryNotice, "waitSecondaryNotice").roomId).toBe(
      "!dm-shared:matrix-qa.test",
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
        body: mockMessageBody(sendPrimaryTextMessage, "sendPrimaryTextMessage").replace(
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
        body: mockMessageBody(sendSecondaryTextMessage, "sendSecondaryTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-dm-per-room-session-override");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as { roomKey?: unknown };
    expect(artifacts.roomKey).toBe(scenarioTesting.MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY);

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
          body: mockMessageBody(sendTextMessage, "sendTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-room-autojoin-invite");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      joinedRoomId?: unknown;
      membershipJoinEventId?: unknown;
    };
    expect(artifacts.joinedRoomId).toBe("!autojoin:matrix-qa.test");
    expect(artifacts.membershipJoinEventId).toBe("$autojoin-join");

    const privateRoomParams = mockObjectArg(createPrivateRoom, "createPrivateRoom");
    expect(privateRoomParams.inviteUserIds).toEqual([
      "@observer:matrix-qa.test",
      "@sut:matrix-qa.test",
    ]);
    expect(String(privateRoomParams.name)).toContain("Matrix QA AutoJoin");
    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "@sut:matrix-qa.test reply with only this exact marker:",
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
        body: mockMessageBody(sendTextMessage, "sendTextMessage").replace(
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

    const scenario = requireMatrixQaScenario("matrix-secondary-room-reply");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as { actorUserId?: unknown };
    expect(artifacts.actorUserId).toBe("@driver:matrix-qa.test");

    expectSentTextMessage(sendTextMessage, {
      bodyIncludes: "@sut:matrix-qa.test",
      mentionUserIds: ["@sut:matrix-qa.test"],
      roomId: "!secondary:matrix-qa.test",
    });
    expect(mockObjectArg(waitForRoomEvent, "waitForRoomEvent").roomId).toBe(
      "!secondary:matrix-qa.test",
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

    const scenario = requireMatrixQaScenario("matrix-e2ee-verification-notice-no-trigger");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      noticeEventId?: unknown;
      roomId?: unknown;
    };
    expect(artifacts.noticeEventId).toBe("$verification-notice");
    expect(artifacts.roomId).toBe("!e2ee:matrix-qa.test");

    expect(noticeToken).toMatch(/^MATRIX_QA_E2EE_VERIFY_NOTICE_[A-Z0-9]+$/);
    expect(mockObjectArg(waitForOptionalRoomEvent, "waitForOptionalRoomEvent").roomId).toBe(
      "!e2ee:matrix-qa.test",
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

    const scenario = requireMatrixQaScenario("matrix-e2ee-recovery-key-lifecycle");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      backupRestored?: unknown;
      recoveryDeviceId?: unknown;
      recoveryKeyUsable?: unknown;
      recoveryVerified?: unknown;
      restoreImported?: unknown;
      restoreTotal?: unknown;
    };
    expect(artifacts.backupRestored).toBe(true);
    expect(artifacts.recoveryDeviceId).toBe("RECOVERYDEVICE");
    expect(artifacts.recoveryKeyUsable).toBe(true);
    expect(artifacts.recoveryVerified).toBe(true);
    expect(artifacts.restoreImported).toBe(1);
    expect(artifacts.restoreTotal).toBe(1);

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

    const scenario = requireMatrixQaScenario("matrix-e2ee-recovery-owner-verification-required");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      backupRestored?: unknown;
      backupUsable?: unknown;
      faultHitCount?: unknown;
      faultRuleId?: unknown;
      recoveryDeviceId?: unknown;
      recoveryKeyAccepted?: unknown;
      recoveryVerified?: unknown;
      restoreImported?: unknown;
      restoreTotal?: unknown;
      verificationSuccess?: unknown;
    };
    expect(artifacts.backupRestored).toBe(true);
    expect(artifacts.backupUsable).toBe(true);
    expect(artifacts.faultHitCount).toBe(1);
    expect(artifacts.faultRuleId).toBe("owner-signature-upload-blocked");
    expect(artifacts.recoveryDeviceId).toBe("RECOVERYDEVICE");
    expect(artifacts.recoveryKeyAccepted).toBe(true);
    expect(artifacts.recoveryVerified).toBe(false);
    expect(artifacts.restoreImported).toBe(1);
    expect(artifacts.restoreTotal).toBe(1);
    expect(artifacts.verificationSuccess).toBe(false);

    const proxyArgs = mockObjectArg(startMatrixQaFaultProxy, "startMatrixQaFaultProxy") as {
      rules: Array<{
        match: (params: {
          bearerToken?: string;
          headers: Record<string, string>;
          method: string;
          path: string;
          search: string;
        }) => boolean;
      }>;
      targetBaseUrl?: unknown;
    };
    const [faultRule] = proxyArgs.rules;
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
    const recoveryClientOptions = lastMockObjectArg(
      createMatrixQaE2eeScenarioClient,
      "createMatrixQaE2eeScenarioClient",
    );
    expect(recoveryClientOptions?.accessToken).toBe("recovery-token");
    expect(recoveryClientOptions?.baseUrl).toBe("http://127.0.0.1:39877");
    expect(recoveryClientOptions?.deviceId).toBe("RECOVERYDEVICE");
    expect(recoveryClientOptions?.scenarioId).toBe(
      "matrix-e2ee-recovery-owner-verification-required",
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-cli-self-verification");

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        gatewayRuntimeEnv: {
          OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
          OPENCLAW_STATE_DIR: "/tmp/gateway-state",
          PATH: process.env.PATH,
        },
        outputDir,
      });
      const artifacts = result.artifacts as {
        completedVerificationIds?: unknown;
        currentDeviceId?: unknown;
        sasEmoji?: unknown;
        secondaryDeviceId?: unknown;
      };
      expect(artifacts.completedVerificationIds).toEqual(["verification-1", "owner-request"]);
      expect(artifacts.currentDeviceId).toBe("CLIDEVICE");
      expect(artifacts.sasEmoji).toEqual(["🐶 Dog"]);
      expect(artifacts.secondaryDeviceId).toBe("CLIDEVICE");

      expect(startMatrixQaOpenClawCli).toHaveBeenCalledTimes(1);
      expect(mockObjectArg(startMatrixQaOpenClawCli, "startMatrixQaOpenClawCli").args).toEqual([
        "matrix",
        "verify",
        "self",
        "--account",
        "cli",
        "--timeout-ms",
        "8000",
      ]);
      expect(mockObjectArg(startMatrixQaOpenClawCli, "startMatrixQaOpenClawCli").timeoutMs).toBe(
        16_000,
      );
      expect(waitForOutput).toHaveBeenCalledTimes(2);
      expect(writeStdin).toHaveBeenCalledWith("yes\n");
      expect(endStdin).toHaveBeenCalledTimes(1);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
      const registrationRequest = mockObjectArg(registerWithToken, "registerWithToken");
      expect(registrationRequest?.deviceName).toBe(
        "OpenClaw Matrix QA CLI Self Verification Owner",
      );
      if (
        typeof registrationRequest.localpart !== "string" ||
        typeof registrationRequest.password !== "string"
      ) {
        throw new Error("expected registration request credentials");
      }
      const registrationLocalpart = registrationRequest.localpart;
      const registrationPassword = registrationRequest.password;
      expect(registrationLocalpart.startsWith("qa-cli-self-verification-")).toBe(true);
      expect(registrationLocalpart).toHaveLength("qa-cli-self-verification-".length + 8);
      expect(registrationPassword.startsWith("matrix-qa-")).toBe(true);
      expect(registrationRequest?.registrationToken).toBe("registration-token");
      expect(loginWithPassword).toHaveBeenCalledWith({
        deviceName: "OpenClaw Matrix QA CLI Self Verification Device",
        password: "cli-owner-password",
        userId: "@cli-owner:matrix-qa.test",
      });
      const e2eeClientOptions = mockObjectArg(
        createMatrixQaE2eeScenarioClient,
        "createMatrixQaE2eeScenarioClient",
      );
      expect(e2eeClientOptions.accessToken).toBe("cli-owner-token");
      expect(e2eeClientOptions.deviceId).toBe("OWNERDEVICE");
      expect(e2eeClientOptions.password).toBe("cli-owner-password");
      expect(e2eeClientOptions.scenarioId).toBe("matrix-e2ee-cli-self-verification");
      expect(e2eeClientOptions.userId).toBe("@cli-owner:matrix-qa.test");
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
      expect(mockObjectArg(runMatrixQaOpenClawCli, "runMatrixQaOpenClawCli").stdin).toBe(
        "encoded-recovery-key\n",
      );
      const cliEnv = mockObjectArg(startMatrixQaOpenClawCli, "startMatrixQaOpenClawCli")
        .env as Record<string, unknown>;
      expect(cliEnv?.OPENCLAW_STATE_DIR).toContain("openclaw-matrix-cli-qa-");
      expect(cliEnv?.OPENCLAW_CONFIG_PATH).toContain("openclaw-matrix-cli-qa-");
      const configPath = String(cliEnv?.OPENCLAW_CONFIG_PATH);
      if (!cliAccountConfigDuringRun) {
        throw new Error("expected CLI account config to be captured");
      }
      const cliAccountConfig = cliAccountConfigDuringRun as Record<string, unknown>;
      expect(cliAccountConfig.accessToken).toBe("cli-token");
      expect(cliAccountConfig.deviceId).toBe("CLIDEVICE");
      expect(cliAccountConfig.encryption).toBe(true);
      expect(cliAccountConfig.homeserver).toBe("http://127.0.0.1:28008/");
      expect(cliAccountConfig.pluginAllow).toContain("matrix");
      expect(cliAccountConfig.pluginEnabled).toBe(true);
      expect(cliAccountConfig.startupVerification).toBe("off");
      expect(cliAccountConfig.userId).toBe("@cli-owner:matrix-qa.test");
      await expectPathMissing(configPath);
      await expectPathMissing(String(cliEnv?.OPENCLAW_STATE_DIR));
      expect(acceptVerification).toHaveBeenCalledWith("owner-request");
      expect(confirmVerificationSas).toHaveBeenCalledWith("owner-request");
      expect(deleteOwnDevices).toHaveBeenCalledWith(["CLIDEVICE"]);
      const [cliRunDir] = await readdir(path.join(outputDir, "cli-self-verification"));
      const cliArtifactDir = path.join(outputDir, "cli-self-verification", cliRunDir ?? "");
      const cliArtifactMode = (await stat(cliArtifactDir)).mode;
      expect(typeof cliArtifactMode).toBe("number");
      expect(cliArtifactMode & 0o777).toBe(0o700);
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
          expect(initialConfig.channels?.matrix?.accounts).toStrictEqual({});
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-cli-account-add-enable-e2ee");

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        gatewayRuntimeEnv: {
          OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
          OPENCLAW_STATE_DIR: "/tmp/gateway-state",
          PATH: process.env.PATH,
        },
        outputDir,
      });
      const artifacts = result.artifacts as {
        accountId?: unknown;
        backupVersion?: unknown;
        cliDeviceId?: unknown;
        encryptionEnabled?: unknown;
        verificationBootstrapAttempted?: unknown;
        verificationBootstrapSuccess?: unknown;
      };
      expect(artifacts.accountId).toBe("cli-add-e2ee");
      expect(artifacts.backupVersion).toBe("backup-v1");
      expect(artifacts.cliDeviceId).toBe("CLIADDDEVICE");
      expect(artifacts.encryptionEnabled).toBe(true);
      expect(artifacts.verificationBootstrapAttempted).toBe(true);
      expect(artifacts.verificationBootstrapSuccess).toBe(true);

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
      expect(mockObjectArg(registerWithToken, "registerWithToken").deviceName).toBe(
        "OpenClaw Matrix QA CLI Account Add Owner",
      );
      expect(mockObjectArg(registerWithToken, "registerWithToken").registrationToken).toBe(
        "registration-token",
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-cli-encryption-setup");

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        gatewayRuntimeEnv: {
          OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
          OPENCLAW_STATE_DIR: "/tmp/gateway-state",
          PATH: process.env.PATH,
        },
        outputDir,
      });
      const artifacts = result.artifacts as {
        accountId?: unknown;
        cliDeviceId?: unknown;
        encryptionChanged?: unknown;
        setupSuccess?: unknown;
        verificationBootstrapSuccess?: unknown;
      };
      expect(artifacts.accountId).toBe("cli-encryption-setup");
      expect(artifacts.cliDeviceId).toBe("CLISETUPDEVICE");
      expect(artifacts.encryptionChanged).toBe(true);
      expect(artifacts.setupSuccess).toBe(true);
      expect(artifacts.verificationBootstrapSuccess).toBe(true);

      if (!initialAccountConfig) {
        throw new Error("expected initial CLI encryption setup account config");
      }
      const capturedInitialAccountConfig = initialAccountConfig as Record<string, unknown>;
      expect(capturedInitialAccountConfig.accessToken).toBe("cli-setup-token");
      expect(capturedInitialAccountConfig.deviceId).toBe("CLISETUPDEVICE");
      expect(capturedInitialAccountConfig.encryption).toBe(false);
      expect(capturedInitialAccountConfig.homeserver).toBe("http://127.0.0.1:28008/");
      expect(capturedInitialAccountConfig.password).toBe("cli-setup-password");
      expect(capturedInitialAccountConfig.startupVerification).toBe("off");
      expect(capturedInitialAccountConfig.userId).toBe("@cli-setup:matrix-qa.test");
      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        ["matrix", "encryption", "setup", "--account", "cli-encryption-setup", "--json"],
        ["matrix", "verify", "status", "--account", "cli-encryption-setup", "--json"],
      ]);
      expect(mockObjectArg(registerWithToken, "registerWithToken").deviceName).toBe(
        "OpenClaw Matrix QA CLI Encryption Setup Owner",
      );
      expect(mockObjectArg(registerWithToken, "registerWithToken").registrationToken).toBe(
        "registration-token",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").password).toBe(
        "cli-setup-password",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").userId).toBe(
        "@cli-setup:matrix-qa.test",
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-cli-encryption-setup-idempotent");

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        gatewayRuntimeEnv: {
          OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
          OPENCLAW_STATE_DIR: "/tmp/gateway-state",
          PATH: process.env.PATH,
        },
        outputDir,
      });
      const artifacts = result.artifacts as {
        accountId?: unknown;
        cliDeviceId?: unknown;
        firstEncryptionChanged?: unknown;
        secondEncryptionChanged?: unknown;
        setupSuccess?: unknown;
        verificationBootstrapSuccess?: unknown;
      };
      expect(artifacts.accountId).toBe("cli-encryption-idempotent");
      expect(artifacts.cliDeviceId).toBe("CLIIDEMPOTENTDEVICE");
      expect(artifacts.firstEncryptionChanged).toBe(false);
      expect(artifacts.secondEncryptionChanged).toBe(false);
      expect(artifacts.setupSuccess).toBe(true);
      expect(artifacts.verificationBootstrapSuccess).toBe(true);

      if (!initialAccountConfig) {
        throw new Error("expected initial CLI encryption idempotent account config");
      }
      const capturedInitialAccountConfig = initialAccountConfig as Record<string, unknown>;
      expect(capturedInitialAccountConfig.accessToken).toBe("cli-idempotent-token");
      expect(capturedInitialAccountConfig.deviceId).toBe("CLIIDEMPOTENTDEVICE");
      expect(capturedInitialAccountConfig.encryption).toBe(true);
      expect(capturedInitialAccountConfig.homeserver).toBe("http://127.0.0.1:28008/");
      expect(capturedInitialAccountConfig.password).toBe("cli-idempotent-password");
      expect(capturedInitialAccountConfig.startupVerification).toBe("off");
      expect(capturedInitialAccountConfig.userId).toBe("@cli-idempotent:matrix-qa.test");
      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        ["matrix", "encryption", "setup", "--account", "cli-encryption-idempotent", "--json"],
        ["matrix", "encryption", "setup", "--account", "cli-encryption-idempotent", "--json"],
      ]);
      expect(mockObjectArg(registerWithToken, "registerWithToken").deviceName).toBe(
        "OpenClaw Matrix QA CLI Encryption Idempotent Owner",
      );
      expect(mockObjectArg(registerWithToken, "registerWithToken").registrationToken).toBe(
        "registration-token",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").password).toBe(
        "cli-idempotent-password",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").userId).toBe(
        "@cli-idempotent:matrix-qa.test",
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

      const scenario = requireMatrixQaScenario(
        "matrix-e2ee-cli-encryption-setup-bootstrap-failure",
      );

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        gatewayRuntimeEnv: {
          OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
          OPENCLAW_STATE_DIR: "/tmp/gateway-state",
          PATH: process.env.PATH,
        },
        outputDir,
      });
      const artifacts = result.artifacts as {
        accountId?: unknown;
        bootstrapSuccess?: unknown;
        cliDeviceId?: unknown;
        faultedEndpoint?: unknown;
        faultHitCount?: unknown;
        faultRuleId?: unknown;
      };
      expect(artifacts.accountId).toBe("cli-encryption-failure");
      expect(artifacts.bootstrapSuccess).toBe(false);
      expect(artifacts.cliDeviceId).toBe("CLIFAILUREDEVICE");
      expect(artifacts.faultedEndpoint).toBe("/_matrix/client/v3/room_keys/version");
      expect(artifacts.faultHitCount).toBe(1);
      expect(artifacts.faultRuleId).toBe("room-key-backup-version-unavailable");

      const proxyArgs = mockObjectArg(startMatrixQaFaultProxy, "startMatrixQaFaultProxy") as {
        rules: Array<{
          match: (params: {
            bearerToken?: string;
            headers: Record<string, string>;
            method: string;
            path: string;
            search: string;
          }) => boolean;
        }>;
        targetBaseUrl?: unknown;
      };
      const [faultRule] = proxyArgs.rules;
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
      expect(mockObjectArg(startMatrixQaOpenClawCli, "startMatrixQaOpenClawCli").args).toEqual([
        "matrix",
        "encryption",
        "setup",
        "--account",
        "cli-encryption-failure",
        "--json",
      ]);
      expect(
        (
          mockObjectArg(startMatrixQaOpenClawCli, "startMatrixQaOpenClawCli").env as Record<
            string,
            unknown
          >
        ).OPENCLAW_CONFIG_PATH,
      ).toContain("openclaw-matrix-e2ee-setup-qa-");
      expect(output).toHaveBeenCalledTimes(1);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(mockObjectArg(registerWithToken, "registerWithToken").deviceName).toBe(
        "OpenClaw Matrix QA CLI Encryption Failure Owner",
      );
      expect(mockObjectArg(registerWithToken, "registerWithToken").registrationToken).toBe(
        "registration-token",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").password).toBe(
        "cli-failure-password",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").userId).toBe(
        "@cli-failure:matrix-qa.test",
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-cli-recovery-key-setup");

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        gatewayRuntimeEnv: {
          OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
          OPENCLAW_STATE_DIR: "/tmp/gateway-state",
          PATH: process.env.PATH,
        },
        outputDir,
      });
      const artifacts = result.artifacts as {
        accountId?: unknown;
        backupVersion?: unknown;
        cliDeviceId?: unknown;
        encryptionChanged?: unknown;
        recoveryKeyId?: unknown;
        recoveryKeyStored?: unknown;
        setupSuccess?: unknown;
        verificationBootstrapSuccess?: unknown;
      };
      expect(artifacts.accountId).toBe("cli-recovery-key-setup");
      expect(artifacts.backupVersion).toBe("backup-v1");
      expect(artifacts.cliDeviceId).toBe("CLIRECOVERYDEVICE");
      expect(artifacts.encryptionChanged).toBe(true);
      expect(artifacts.recoveryKeyId).toBe("SSSS");
      expect(artifacts.recoveryKeyStored).toBe(true);
      expect(artifacts.setupSuccess).toBe(true);
      expect(artifacts.verificationBootstrapSuccess).toBe(true);

      if (!initialAccountConfig) {
        throw new Error("expected initial CLI recovery key account config");
      }
      const capturedInitialAccountConfig = initialAccountConfig as Record<string, unknown>;
      expect(capturedInitialAccountConfig.accessToken).toBe("cli-recovery-token");
      expect(capturedInitialAccountConfig.deviceId).toBe("CLIRECOVERYDEVICE");
      expect(capturedInitialAccountConfig.encryption).toBe(false);
      expect(capturedInitialAccountConfig.homeserver).toBe("http://127.0.0.1:28008/");
      expect(capturedInitialAccountConfig.password).toBe("cli-recovery-password");
      expect(capturedInitialAccountConfig.startupVerification).toBe("off");
      expect(capturedInitialAccountConfig.userId).toBe("@cli-recovery:matrix-qa.test");
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
      expect(mockObjectArg(registerWithToken, "registerWithToken").deviceName).toBe(
        "OpenClaw Matrix QA CLI Recovery Key Owner",
      );
      expect(mockObjectArg(registerWithToken, "registerWithToken").registrationToken).toBe(
        "registration-token",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").password).toBe(
        "cli-recovery-password",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").userId).toBe(
        "@cli-recovery:matrix-qa.test",
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-cli-recovery-key-invalid");

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        gatewayRuntimeEnv: {
          OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
          OPENCLAW_STATE_DIR: "/tmp/gateway-state",
          PATH: process.env.PATH,
        },
        outputDir,
      });
      const artifacts = result.artifacts as {
        accountId?: unknown;
        bootstrapSuccess?: unknown;
        cliDeviceId?: unknown;
        encryptionChanged?: unknown;
        recoveryKeyAccepted?: unknown;
        recoveryKeyRejected?: unknown;
        setupSuccess?: unknown;
      };
      expect(artifacts.accountId).toBe("cli-invalid-recovery-key");
      expect(artifacts.bootstrapSuccess).toBe(false);
      expect(artifacts.cliDeviceId).toBe("CLIINVALIDDEVICE");
      expect(artifacts.encryptionChanged).toBe(true);
      expect(artifacts.recoveryKeyAccepted).toBe(false);
      expect(artifacts.recoveryKeyRejected).toBe(true);
      expect(artifacts.setupSuccess).toBe(false);

      expect(mockObjectArg(startMatrixQaOpenClawCli, "startMatrixQaOpenClawCli").args).toEqual([
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
      expect(mockObjectArg(registerWithToken, "registerWithToken").deviceName).toBe(
        "OpenClaw Matrix QA CLI Invalid Recovery Key Owner",
      );
      expect(mockObjectArg(registerWithToken, "registerWithToken").registrationToken).toBe(
        "registration-token",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").password).toBe(
        "cli-invalid-password",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").userId).toBe(
        "@cli-invalid:matrix-qa.test",
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-cli-encryption-setup-multi-account");

      const result = await runMatrixQaScenario(scenario, {
        ...matrixQaScenarioContext(),
        driverDeviceId: "DRIVERDEVICE",
        driverPassword: "driver-password",
        gatewayRuntimeEnv: {
          OPENCLAW_CONFIG_PATH: "/tmp/gateway-config.json",
          OPENCLAW_STATE_DIR: "/tmp/gateway-state",
          PATH: process.env.PATH,
        },
        outputDir,
      });
      const artifacts = result.artifacts as {
        accountId?: unknown;
        cliDeviceId?: unknown;
        decoyAccountPreserved?: unknown;
        defaultAccountPreserved?: unknown;
        encryptionChanged?: unknown;
        setupSuccess?: unknown;
        verificationBootstrapSuccess?: unknown;
      };
      expect(artifacts.accountId).toBe("cli-multi-target");
      expect(artifacts.cliDeviceId).toBe("CLIMULTIDEVICE");
      expect(artifacts.decoyAccountPreserved).toBe(true);
      expect(artifacts.defaultAccountPreserved).toBe(true);
      expect(artifacts.encryptionChanged).toBe(true);
      expect(artifacts.setupSuccess).toBe(true);
      expect(artifacts.verificationBootstrapSuccess).toBe(true);

      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        ["matrix", "encryption", "setup", "--account", "cli-multi-target", "--json"],
      ]);
      expect(mockObjectArg(registerWithToken, "registerWithToken").deviceName).toBe(
        "OpenClaw Matrix QA CLI Multi Account Owner",
      );
      expect(mockObjectArg(registerWithToken, "registerWithToken").registrationToken).toBe(
        "registration-token",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").password).toBe(
        "cli-multi-password",
      );
      expect(mockObjectArg(loginWithPassword, "loginWithPassword").userId).toBe(
        "@cli-multi:matrix-qa.test",
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

      const scenario = requireMatrixQaScenario("matrix-e2ee-cli-setup-then-gateway-reply");

      const result = await runMatrixQaScenario(scenario, {
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
      });
      const artifacts = result.artifacts as {
        accountId?: unknown;
        cliDeviceId?: unknown;
        driverUserId?: unknown;
        gatewayReply?: { eventId?: unknown; tokenMatched?: unknown };
        gatewayUserId?: unknown;
        roomId?: unknown;
        setupSuccess?: unknown;
        verificationBootstrapSuccess?: unknown;
      };
      expect(artifacts.accountId).toBe("cli-setup-gateway");
      expect(artifacts.cliDeviceId).toBe("CLIGATEWAYDEVICE");
      expect(artifacts.driverUserId).toBe("@cli-driver:matrix-qa.test");
      expect(artifacts.gatewayReply?.eventId).toBe("$gateway-reply");
      expect(artifacts.gatewayReply?.tokenMatched).toBe(true);
      expect(artifacts.gatewayUserId).toBe("@cli-gateway:matrix-qa.test");
      expect(artifacts.roomId).toBe("!isolated-e2ee:matrix-qa.test");
      expect(artifacts.setupSuccess).toBe(true);
      expect(artifacts.verificationBootstrapSuccess).toBe(true);
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
      const finalGatewayAccount = finalGatewayConfig.channels.matrix.accounts["cli-setup-gateway"];
      expect(finalGatewayAccount?.encryption).toBe(true);
      expect(finalGatewayAccount?.setupBootstrapMarker).toBe("preserved");

      expect(runMatrixQaOpenClawCli.mock.calls.map(([params]) => params.args)).toEqual([
        ["matrix", "encryption", "setup", "--account", "cli-setup-gateway", "--json"],
      ]);
      const registrationRequests = registerWithToken.mock.calls.map(([request]) => request);
      expect(
        registrationRequests.some(
          (request) =>
            request.deviceName === "OpenClaw Matrix QA CLI Setup Gateway" &&
            request.registrationToken === "registration-token",
        ),
      ).toBe(true);
      expect(
        registrationRequests.some(
          (request) =>
            request.deviceName === "OpenClaw Matrix QA CLI Setup Driver" &&
            request.registrationToken === "registration-token",
        ),
      ).toBe(true);
      expect(createPrivateRoom).toHaveBeenCalledWith({
        encrypted: true,
        inviteUserIds: ["@cli-gateway:matrix-qa.test"],
        name: "Matrix QA CLI Setup Gateway E2EE",
      });
      expect(joinRoom).toHaveBeenCalledWith("!isolated-e2ee:matrix-qa.test");
      expect(patchGatewayConfig).not.toHaveBeenCalled();
      expect(restartGatewayAfterStateMutation).toHaveBeenCalledTimes(2);
      const driverMessage = mockObjectArg(driverClient.sendTextMessage, "sendTextMessage");
      expect(driverMessage.mentionUserIds).toEqual(["@cli-gateway:matrix-qa.test"]);
      expect(driverMessage.roomId).toBe("!isolated-e2ee:matrix-qa.test");
      expect(driverClient.waitForJoinedMember).toHaveBeenCalledWith({
        roomId: "!isolated-e2ee:matrix-qa.test",
        timeoutMs: 8_000,
        userId: "@cli-gateway:matrix-qa.test",
      });
      const e2eeClientOptions = mockObjectArg(
        createMatrixQaE2eeScenarioClient,
        "createMatrixQaE2eeScenarioClient",
      );
      expect(e2eeClientOptions.accessToken).toBe("cli-driver-token");
      expect(e2eeClientOptions.deviceId).toBe("CLIDRIVERDEVICE");
      expect(e2eeClientOptions.userId).toBe("@cli-driver:matrix-qa.test");
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

    const scenario = requireMatrixQaScenario("matrix-e2ee-key-bootstrap-failure");

    const result = await runMatrixQaScenario(scenario, {
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
    });
    const artifacts = result.artifacts as {
      bootstrapActor?: unknown;
      bootstrapSuccess?: unknown;
      faultedEndpoint?: unknown;
      faultHitCount?: unknown;
      faultRuleId?: unknown;
    };
    expect(artifacts.bootstrapActor).toBe("driver");
    expect(artifacts.bootstrapSuccess).toBe(false);
    expect(artifacts.faultedEndpoint).toBe("/_matrix/client/v3/room_keys/version");
    expect(artifacts.faultHitCount).toBe(1);
    expect(artifacts.faultRuleId).toBe("room-key-backup-version-unavailable");

    const proxyArgs = mockObjectArg(startMatrixQaFaultProxy, "startMatrixQaFaultProxy") as {
      rules: Array<{
        match: (params: {
          bearerToken?: string;
          headers: Record<string, string>;
          method: string;
          path: string;
          search: string;
        }) => boolean;
      }>;
      targetBaseUrl?: unknown;
    };
    const [faultRule] = proxyArgs.rules;
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
