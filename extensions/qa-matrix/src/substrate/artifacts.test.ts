import { describe, expect, it } from "vitest";
import { buildMatrixQaObservedEventsArtifact } from "./artifacts.js";

describe("matrix observed event artifacts", () => {
  it("redacts Matrix observed event content by default in artifacts", () => {
    expect(
      buildMatrixQaObservedEventsArtifact({
        includeContent: false,
        observedEvents: [
          {
            kind: "message",
            roomId: "!room:matrix-qa.test",
            eventId: "$event",
            sender: "@sut:matrix-qa.test",
            type: "m.room.message",
            body: "secret",
            formattedBody: "<p>secret</p>",
            msgtype: "m.text",
            originServerTs: 1_700_000_000_000,
            relatesTo: {
              relType: "m.thread",
              eventId: "$root",
              inReplyToId: "$driver",
              isFallingBack: true,
            },
          },
        ],
      }),
    ).toEqual([
      {
        kind: "message",
        roomId: "!room:matrix-qa.test",
        eventId: "$event",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        msgtype: "m.text",
        originServerTs: 1_700_000_000_000,
        relatesTo: {
          relType: "m.thread",
          eventId: "$root",
          inReplyToId: "$driver",
          isFallingBack: true,
        },
      },
    ]);
  });

  it("keeps reaction metadata in redacted Matrix observed-event artifacts", () => {
    expect(
      buildMatrixQaObservedEventsArtifact({
        includeContent: false,
        observedEvents: [
          {
            kind: "reaction",
            roomId: "!room:matrix-qa.test",
            eventId: "$reaction",
            sender: "@driver:matrix-qa.test",
            type: "m.reaction",
            reaction: {
              eventId: "$reply",
              key: "👍",
            },
            relatesTo: {
              relType: "m.annotation",
              eventId: "$reply",
            },
          },
        ],
      }),
    ).toEqual([
      {
        kind: "reaction",
        roomId: "!room:matrix-qa.test",
        eventId: "$reaction",
        sender: "@driver:matrix-qa.test",
        type: "m.reaction",
        originServerTs: undefined,
        msgtype: undefined,
        membership: undefined,
        relatesTo: {
          relType: "m.annotation",
          eventId: "$reply",
        },
        mentions: undefined,
        reaction: {
          eventId: "$reply",
          key: "👍",
        },
      },
    ]);
  });
});
