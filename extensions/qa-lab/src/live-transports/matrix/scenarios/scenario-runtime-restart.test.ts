import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  advanceMatrixQaActorCursor: vi.fn(),
  assertTopLevelReplyArtifact: vi.fn(),
  buildMatrixReplyArtifact: vi.fn((event: { eventId: string }, token: string) => ({
    eventId: event.eventId,
    token,
    tokenMatched: true,
  })),
  buildMatrixReplyDetails: vi.fn((label: string) => [`${label} token matched: yes`]),
  buildMatrixQaToken: vi.fn((prefix: string) => `${prefix}_TOKEN`),
  buildMentionPrompt: vi.fn((_userId: string, token: string) => token),
  isMatrixQaExactMarkerReply: vi.fn(() => true),
  primeMatrixQaDriverScenarioClient: vi.fn(),
  resolveMatrixQaScenarioRoomId: vi.fn(() => "!restart:test"),
  runAssertedDriverTopLevelScenario: vi.fn(),
}));

vi.mock("./scenario-contract.js", () => ({
  MATRIX_QA_HOMESERVER_ROOM_KEY: "homeserver",
  MATRIX_QA_RESTART_ROOM_KEY: "restart",
  MATRIX_QA_STALE_SYNC_ROOM_KEY: "stale-sync",
  resolveMatrixQaScenarioRoomId: mocks.resolveMatrixQaScenarioRoomId,
}));

vi.mock("./scenario-runtime-shared.js", () => ({
  advanceMatrixQaActorCursor: mocks.advanceMatrixQaActorCursor,
  assertTopLevelReplyArtifact: mocks.assertTopLevelReplyArtifact,
  buildMatrixReplyArtifact: mocks.buildMatrixReplyArtifact,
  buildMatrixReplyDetails: mocks.buildMatrixReplyDetails,
  buildMatrixQaToken: mocks.buildMatrixQaToken,
  buildMentionPrompt: mocks.buildMentionPrompt,
  isMatrixQaExactMarkerReply: mocks.isMatrixQaExactMarkerReply,
  primeMatrixQaDriverScenarioClient: mocks.primeMatrixQaDriverScenarioClient,
  resolveMatrixQaNoReplyWindowMs: vi.fn(() => 1_000),
  runAssertedDriverTopLevelScenario: mocks.runAssertedDriverTopLevelScenario,
}));

import { runInitialCatchupThenIncrementalScenario } from "./scenario-runtime-restart.js";

describe("Matrix restart scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the initial catchup boundary as a SIGKILL restart", async () => {
    const sendTextMessage = vi.fn(async () => "$catchup-driver");
    const waitForRoomEvent = vi.fn(async () => ({
      event: { eventId: "$catchup-reply" },
      since: "s1",
    }));
    mocks.primeMatrixQaDriverScenarioClient.mockResolvedValue({
      client: { sendTextMessage, waitForRoomEvent },
      startSince: "s0",
    });
    mocks.runAssertedDriverTopLevelScenario.mockResolvedValue({
      driverEventId: "$incremental-driver",
      reply: { eventId: "$incremental-reply", tokenMatched: true },
      token: "MATRIX_QA_INCREMENTAL_TOKEN",
    });
    const restartGatewayWithQueuedMessage = vi.fn(async (queueMessage: () => Promise<void>) => {
      await queueMessage();
    });

    const result = await runInitialCatchupThenIncrementalScenario({
      observedEvents: [],
      restartGatewayWithQueuedMessage,
      sutUserId: "@sut:test",
      syncState: {},
      timeoutMs: 1_000,
      topology: { rooms: [] },
    } as never);

    expect(restartGatewayWithQueuedMessage).toHaveBeenCalledOnce();
    expect(result.artifacts).toMatchObject({
      catchupDriverEventId: "$catchup-driver",
      restartSignal: "SIGKILL",
    });
    expect(result.details).toContain("restart signal: SIGKILL");
  });
});
