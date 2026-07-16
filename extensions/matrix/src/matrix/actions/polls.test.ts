import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { voteMatrixPoll } from "./polls.js";

function createPollClient(pollContent?: Record<string, unknown>) {
  const getEvent = vi.fn(async () => ({
    type: "m.poll.start",
    content: pollContent ?? {
      "m.poll.start": {
        question: { "m.text": "Favorite fruit?" },
        max_selections: 1,
        answers: [
          { id: "apple", "m.text": "Apple" },
          { id: "berry", "m.text": "Berry" },
        ],
      },
    },
  }));
  const sendEvent = vi.fn(async () => "$vote1");

  return {
    client: {
      getEvent,
      sendEvent,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    getEvent,
    sendEvent,
  };
}

describe("matrix poll actions", () => {
  it("votes by option index against the resolved room id", async () => {
    const { client, getEvent, sendEvent } = createPollClient();

    const result = await voteMatrixPoll("room:!room:example.org", "$poll", {
      client,
      optionIndex: 2,
    });

    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$poll");
    expect(sendEvent).toHaveBeenCalledWith(
      "!room:example.org",
      "m.poll.response",
      expect.objectContaining({
        "m.poll.response": { answers: ["berry"] },
      }),
    );
    expect(result).toEqual({
      eventId: "$vote1",
      roomId: "!room:example.org",
      pollId: "$poll",
      answerIds: ["berry"],
      labels: ["Berry"],
      maxSelections: 1,
    });
  });

  it("rejects option indexes that are outside the poll range", async () => {
    const { client, sendEvent } = createPollClient();

    await expect(
      voteMatrixPoll("room:!room:example.org", "$poll", {
        client,
        optionIndex: 3,
      }),
    ).rejects.toThrow("out of range");

    expect(sendEvent).not.toHaveBeenCalled();
  });
});
