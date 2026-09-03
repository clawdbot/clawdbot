import { afterEach, describe, expect, it, vi } from "vitest";

const advanceMatrixQaActorCursor = vi.hoisted(() => vi.fn());
const primeMatrixQaActorCursor = vi.hoisted(() => vi.fn());

vi.mock("./scenario-runtime-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-shared.js")>()),
  advanceMatrixQaActorCursor,
  primeMatrixQaActorCursor,
}));

import { runGeneratedImageDeliveryScenario, testing } from "./scenario-runtime-media.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

describe("Matrix voice preflight reply matching", () => {
  it("accepts punctuation differences in the transcribed marker", () => {
    expect(
      testing.hasMatrixQaVoicePreflightReply(
        '📝 "C3PLQA reply with only these words Matrix QA voice pre-flight OK."',
      ),
    ).toBe(true);
  });
});

const roomId = "!media:matrix-qa.test";

function createGeneratedImageContext(
  observedEvents: MatrixQaScenarioContext["observedEvents"] = [],
): MatrixQaScenarioContext {
  return {
    baseUrl: "http://127.0.0.1:28008",
    driverAccessToken: "driver-token",
    driverUserId: "@driver:matrix-qa.test",
    observedEvents,
    observerAccessToken: "observer-token",
    observerUserId: "@observer:matrix-qa.test",
    roomId,
    sutAccessToken: "sut-token",
    sutUserId: "@sut:matrix-qa.test",
    syncState: {},
    timeoutMs: 180_000,
    topology: {
      defaultRoomId: roomId,
      defaultRoomKey: "media",
      rooms: [
        {
          encrypted: false,
          key: "media",
          kind: "group",
          memberRoles: ["driver", "observer", "sut"],
          memberUserIds: [
            "@driver:matrix-qa.test",
            "@observer:matrix-qa.test",
            "@sut:matrix-qa.test",
          ],
          name: "Matrix QA Media Room",
          requireMention: true,
          roomId,
        },
      ],
    },
  };
}

describe("Matrix generated image delivery", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends one trigger and accepts one fresh top-level image", async () => {
    const sendTextMessage = vi.fn(async () => "$driver-trigger");
    const waitForOptionalRoomEvent = vi.fn(async ({ predicate }) => {
      const event = {
        attachment: { filename: "generated.png", kind: "image" as const },
        eventId: "$generated-image",
        kind: "message" as const,
        msgtype: "m.image",
        originServerTs: Date.now() + 1,
        roomId,
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
      };
      expect(predicate(event)).toBe(true);
      return { event, matched: true as const, since: "next" };
    });
    primeMatrixQaActorCursor.mockResolvedValue({
      client: { sendTextMessage, waitForOptionalRoomEvent },
      startSince: "start",
    });

    const result = await runGeneratedImageDeliveryScenario(createGeneratedImageContext());

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(1);
    expect(result.artifacts?.driverEventId).toBe("$driver-trigger");
    expect(result.artifacts?.attachmentEventId).toBe("$generated-image");
  });

  it("bounds timeout diagnostics to the last eight room events", async () => {
    const observedEvents = Array.from({ length: 10 }, (_, index) => ({
      body: `event body ${index + 1}`,
      eventId: `$event-${index + 1}`,
      kind: "message" as const,
      roomId,
      sender: "@sut:matrix-qa.test",
      type: "m.room.message",
    }));
    observedEvents.push({
      body: "other room",
      eventId: "$other-room",
      kind: "message",
      roomId: "!other:matrix-qa.test",
      sender: "@sut:matrix-qa.test",
      type: "m.room.message",
    });
    const sendTextMessage = vi.fn(async () => "$driver-trigger");
    primeMatrixQaActorCursor.mockResolvedValue({
      client: {
        sendTextMessage,
        waitForOptionalRoomEvent: vi.fn(async () => ({
          matched: false as const,
          since: "next",
        })),
      },
      startSince: "start",
    });

    const error = await runGeneratedImageDeliveryScenario(
      createGeneratedImageContext(observedEvents),
    ).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(message).toContain("$event-3");
    expect(message).toContain("$event-10");
    expect(message).not.toContain('$event-1"');
    expect(message).not.toContain('$event-2"');
    expect(message).not.toContain("$other-room");
  });
});
