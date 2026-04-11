import { describe, expect, it, beforeEach, vi } from "vitest";
const { createMatrixQaClient } = vi.hoisted(() => ({
  createMatrixQaClient: vi.fn(),
}));

vi.mock("./matrix-driver-client.js", () => ({
  createMatrixQaClient,
}));

import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  findMissingLiveTransportStandardScenarios,
} from "../shared/live-transport-scenarios.js";
import {
  __testing as scenarioTesting,
  MATRIX_QA_SCENARIOS,
  runMatrixQaScenario,
} from "./matrix-live-scenarios.js";

describe("matrix live qa scenarios", () => {
  beforeEach(() => {
    createMatrixQaClient.mockReset();
  });

  it("ships the Matrix live QA scenario set by default", () => {
    expect(scenarioTesting.findMatrixQaScenarios().map((scenario) => scenario.id)).toEqual([
      "matrix-thread-follow-up",
      "matrix-thread-isolation",
      "matrix-top-level-reply-shape",
      "matrix-reaction-notification",
      "matrix-restart-resume",
      "matrix-mention-gating",
      "matrix-allowlist-block",
    ]);
  });

  it("uses the repo-wide exact marker prompt shape for Matrix mentions", () => {
    expect(
      scenarioTesting.buildMentionPrompt("@sut:matrix-qa.test", "MATRIX_QA_CANARY_TOKEN"),
    ).toBe("@sut:matrix-qa.test reply with only this exact marker: MATRIX_QA_CANARY_TOKEN");
  });

  it("requires Matrix replies to match the exact marker body", () => {
    expect(
      scenarioTesting.buildMatrixReplyArtifact(
        {
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
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
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
});
