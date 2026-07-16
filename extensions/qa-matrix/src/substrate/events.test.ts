import { describe, expect, it } from "vitest";
import { normalizeMatrixQaObservedEvent } from "./events.js";

describe("matrix observed event normalization", () => {
  it("normalizes message events with thread metadata", () => {
    expect(
      normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
        event_id: "$event",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        origin_server_ts: 1_700_000_000_000,
        content: {
          body: "hello",
          msgtype: "m.text",
          "m.mentions": {
            user_ids: ["@sut:matrix-qa.test"],
          },
          "m.relates_to": {
            rel_type: "m.thread",
            event_id: "$root",
            is_falling_back: true,
            "m.in_reply_to": {
              event_id: "$driver",
            },
          },
        },
      }),
    ).toEqual({
      kind: "message",
      roomId: "!room:matrix-qa.test",
      eventId: "$event",
      sender: "@sut:matrix-qa.test",
      type: "m.room.message",
      originServerTs: 1_700_000_000_000,
      body: "hello",
      msgtype: "m.text",
      relatesTo: {
        relType: "m.thread",
        eventId: "$root",
        inReplyToId: "$driver",
        isFallingBack: true,
      },
      mentions: {
        userIds: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("classifies Matrix notices separately from regular messages", () => {
    expect(
      normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
        event_id: "$notice",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        content: {
          body: "notice",
          msgtype: "m.notice",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "notice",
        eventId: "$notice",
        msgtype: "m.notice",
        type: "m.room.message",
      }),
    );
  });

  it("prefers m.new_content text for Matrix replacement events", () => {
    expect(
      normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
        event_id: "$replace",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        content: {
          body: "* finalized",
          msgtype: "m.text",
          "m.new_content": {
            body: "finalized",
            msgtype: "m.text",
          },
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: "$draft",
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "message",
        eventId: "$replace",
        body: "finalized",
        msgtype: "m.text",
        relatesTo: {
          eventId: "$draft",
          relType: "m.replace",
        },
      }),
    );
  });

  it("normalizes Matrix reaction events with target metadata", () => {
    expect(
      normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
        event_id: "$reaction",
        sender: "@driver:matrix-qa.test",
        type: "m.reaction",
        origin_server_ts: 1_700_000_000_000,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: "$msg",
            key: "👍",
          },
        },
      }),
    ).toEqual({
      kind: "reaction",
      roomId: "!room:matrix-qa.test",
      eventId: "$reaction",
      sender: "@driver:matrix-qa.test",
      type: "m.reaction",
      originServerTs: 1_700_000_000_000,
      relatesTo: {
        eventId: "$msg",
        relType: "m.annotation",
      },
      reaction: {
        eventId: "$msg",
        key: "👍",
      },
    });
  });

  it("normalizes membership events with explicit membership kind", () => {
    expect(
      normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
        event_id: "$membership",
        sender: "@driver:matrix-qa.test",
        state_key: "@sut:matrix-qa.test",
        type: "m.room.member",
        content: {
          membership: "leave",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "membership",
        eventId: "$membership",
        membership: "leave",
        stateKey: "@sut:matrix-qa.test",
        type: "m.room.member",
      }),
    );
  });

  it("classifies Matrix redactions without needing raw event inspection", () => {
    expect(
      normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
        event_id: "$redaction",
        sender: "@driver:matrix-qa.test",
        type: "m.room.redaction",
        content: {},
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "redaction",
        eventId: "$redaction",
        type: "m.room.redaction",
      }),
    );
  });
});
