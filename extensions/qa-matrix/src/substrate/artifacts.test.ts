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
            msgtype: "m.image",
            originServerTs: 1_700_000_000_000,
            attachment: {
              kind: "image",
              caption: "secret",
              filename: "qa-lighthouse.png",
            },
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
        msgtype: "m.image",
        originServerTs: 1_700_000_000_000,
        attachment: {
          kind: "image",
          filename: "qa-lighthouse.png",
        },
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

  it("keeps redaction metadata while still stripping Matrix event content", () => {
    expect(
      buildMatrixQaObservedEventsArtifact({
        includeContent: false,
        observedEvents: [
          {
            kind: "redaction",
            roomId: "!room:matrix-qa.test",
            eventId: "$redaction",
            sender: "@driver:matrix-qa.test",
            type: "m.room.redaction",
            originServerTs: 1_700_000_000_123,
          },
          {
            kind: "message",
            roomId: "!room:matrix-qa.test",
            eventId: "$message",
            sender: "@sut:matrix-qa.test",
            type: "m.room.message",
            body: "private body",
            formattedBody: "<p>private body</p>",
            msgtype: "m.text",
          },
        ],
      }),
    ).toEqual([
      {
        kind: "redaction",
        roomId: "!room:matrix-qa.test",
        eventId: "$redaction",
        sender: "@driver:matrix-qa.test",
        type: "m.room.redaction",
        originServerTs: 1_700_000_000_123,
        msgtype: undefined,
        membership: undefined,
        relatesTo: undefined,
        mentions: undefined,
        reaction: undefined,
      },
      {
        kind: "message",
        roomId: "!room:matrix-qa.test",
        eventId: "$message",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        originServerTs: undefined,
        msgtype: "m.text",
        membership: undefined,
        relatesTo: undefined,
        mentions: undefined,
        reaction: undefined,
      },
    ]);
  });
});
