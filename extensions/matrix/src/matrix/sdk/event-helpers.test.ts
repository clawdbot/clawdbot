// Matrix tests cover event helpers plugin behavior.
import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { describe, expect, it, vi } from "vitest";
import { buildHttpError, matrixEventToRaw, parseMxc } from "./event-helpers.js";

const makeEditedMessageEvent = (): MatrixEvent => {
  const event = new MatrixEvent({
    event_id: "$root",
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: 1000,
    content: { body: "original", msgtype: "m.text" },
    unsigned: {
      "m.relations": {
        "m.replace": { event_id: "$edit" },
      },
    },
  });
  event.makeReplaced(
    new MatrixEvent({
      type: "m.room.message",
      content: {
        "m.new_content": {
          body: "@bot edited",
          "m.mentions": { user_ids: ["@bot:example.org"] },
          msgtype: "m.text",
        },
      },
    }),
  );
  return event;
};

describe("event-helpers", () => {
  it("parses mxc URIs", () => {
    expect(parseMxc("mxc://server.example/media-id")).toEqual({
      server: "server.example",
      mediaId: "media-id",
    });
    expect(parseMxc("not-mxc")).toBeNull();
  });

  it("builds HTTP errors from JSON and plain text payloads", () => {
    const fromJson = buildHttpError(403, JSON.stringify({ error: "forbidden" }));
    expect(fromJson.message).toBe("forbidden");
    expect(fromJson.statusCode).toBe(403);

    const fromText = buildHttpError(500, "internal failure");
    expect(fromText.message).toBe("internal failure");
    expect(fromText.statusCode).toBe(500);
  });

  it("keeps truncated HTTP error bodies UTF-16 safe", () => {
    const parsedPrefix = `{"detail":"${"a".repeat(488)}`;
    const invalidPrefix = `not-json ${"b".repeat(490)}`;

    expect(buildHttpError(500, `${parsedPrefix}😀"}`).message).toBe(parsedPrefix);
    expect(buildHttpError(502, `${invalidPrefix}🎉tail`).message).toBe(invalidPrefix);
  });

  it("serializes native Matrix state events", () => {
    const event = new MatrixEvent({
      event_id: "$1",
      sender: "@alice:example.org",
      type: "m.room.member",
      origin_server_ts: 1000,
      content: { membership: "join" },
      unsigned: { age: 1 },
      state_key: "@alice:example.org",
    });

    expect(matrixEventToRaw(event)).toEqual({
      event_id: "$1",
      sender: "@alice:example.org",
      type: "m.room.member",
      origin_server_ts: 1000,
      content: { membership: "join" },
      unsigned: { age: 1 },
      state_key: "@alice:example.org",
    });
  });

  it("serializes current content by default for read APIs", () => {
    expect(matrixEventToRaw(makeEditedMessageEvent())).toEqual({
      event_id: "$root",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: {
        body: "@bot edited",
        "m.mentions": { user_ids: ["@bot:example.org"] },
        msgtype: "m.text",
      },
      unsigned: {
        "m.relations": {
          "m.replace": { event_id: "$edit" },
        },
      },
    });
  });

  it("preserves original thread relation when serializing edited current content", () => {
    const event = new MatrixEvent({
      event_id: "$root",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: {
        body: "original",
        msgtype: "m.text",
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$thread",
        },
      },
    });
    event.makeReplaced(
      new MatrixEvent({
        type: "m.room.message",
        content: {
          "m.new_content": {
            body: "@bot edited",
            "m.mentions": { user_ids: ["@bot:example.org"] },
            msgtype: "m.text",
          },
        },
      }),
    );

    expect(matrixEventToRaw(event).content["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$thread",
    });
  });

  it("preserves reply-only wire relations for encrypted events with clear content", () => {
    const event = new MatrixEvent({
      event_id: "$encrypted",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: {
        body: "decrypted reply",
        msgtype: "m.text",
      },
    });
    event.makeEncrypted(
      "m.room.encrypted",
      {
        algorithm: "m.megolm.v1.aes-sha2",
        "m.relates_to": {
          "m.in_reply_to": { event_id: "$parent" },
        },
      },
      "curve-key",
      "ed-key",
    );

    expect(matrixEventToRaw(event).content["m.relates_to"]).toEqual({
      "m.in_reply_to": { event_id: "$parent" },
    });
  });

  it("preserves packed wire state keys when clear state is unavailable", () => {
    const event = new MatrixEvent({
      event_id: "$encrypted-state",
      sender: "@alice:example.org",
      type: "m.room.member",
      state_key: "@alice:example.org",
      content: { membership: "join" },
    });
    event.makeEncrypted(
      "m.room.encrypted",
      { algorithm: "m.megolm.v1.aes-sha2" },
      "curve-key",
      "ed-key",
    );
    vi.spyOn(event, "getStateKey").mockReturnValue(undefined);

    expect(matrixEventToRaw(event).state_key).toBe("m.room.member:@alice:example.org");
  });

  it("can serialize original content for inbound trigger filtering", () => {
    expect(matrixEventToRaw(makeEditedMessageEvent(), { contentMode: "original" })).toEqual({
      event_id: "$root",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: { body: "original", msgtype: "m.text" },
      unsigned: {
        "m.relations": {
          "m.replace": { event_id: "$edit" },
        },
      },
    });
  });
});
