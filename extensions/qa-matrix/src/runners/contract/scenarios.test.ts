import { describe, expect, it, beforeEach, vi } from "vitest";
const { createMatrixQaClient } = vi.hoisted(() => ({
  createMatrixQaClient: vi.fn(),
}));

vi.mock("../../substrate/client.js", () => ({
  createMatrixQaClient,
}));

import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  findMissingLiveTransportStandardScenarios,
} from "../../shared/live-transport-scenarios.js";
import {
  __testing as scenarioTesting,
  MATRIX_QA_SCENARIOS,
  runMatrixQaScenario,
} from "./scenarios.js";

describe("matrix live qa scenarios", () => {
  beforeEach(() => {
    createMatrixQaClient.mockReset();
  });

  it("ships the Matrix live QA scenario set by default", () => {
    expect(scenarioTesting.findMatrixQaScenarios().map((scenario) => scenario.id)).toEqual([
      "matrix-thread-follow-up",
      "matrix-thread-root-preservation",
      "matrix-thread-nested-reply-shape",
      "matrix-thread-isolation",
      "matrix-top-level-reply-shape",
      "matrix-room-thread-reply-override",
      "matrix-room-quiet-streaming-preview",
      "matrix-room-block-streaming",
      "matrix-room-image-understanding-attachment",
      "matrix-room-generated-image-delivery",
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
      "matrix-restart-resume",
      "matrix-room-membership-loss",
      "matrix-homeserver-restart-resume",
      "matrix-mention-gating",
      "matrix-observer-allowlist-override",
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
        body: "observer sender accepted",
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
          tokenMatched: false,
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
      body: expect.stringContaining("Matrix quiet streaming QA check"),
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
      body: expect.stringContaining("Matrix block streaming QA check"),
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
    const waitForRoomEvent = vi.fn().mockResolvedValue({
      event: {
        kind: "message",
        roomId: "!media:matrix-qa.test",
        eventId: "$sut-image-reply",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.",
      },
      since: "driver-sync-next",
    });

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
        contentType: "image/png",
        fileName: "red-top-blue-bottom.png",
        kind: "image",
        mentionUserIds: ["@sut:matrix-qa.test"],
        roomId: "!media:matrix-qa.test",
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
});
