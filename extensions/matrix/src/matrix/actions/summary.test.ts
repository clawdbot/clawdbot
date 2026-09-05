// Matrix tests cover summary plugin behavior.
import { describe, expect, it } from "vitest";
import { summarizeMatrixRawEvent } from "./summary.js";

describe("summarizeMatrixRawEvent", () => {
  it("replaces bare media filenames with a media marker", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$image",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
      },
    });

    expect(summary).toEqual({
      eventId: "$image",
      sender: "@gum:matrix.example.org",
      body: undefined,
      msgtype: "m.image",
      attachment: {
        kind: "image",
        filename: "photo.jpg",
      },
      timestamp: 123,
      relatesTo: undefined,
    });
  });

  it("preserves captions while marking media summaries", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$image",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: {
        msgtype: "m.image",
        body: "can you see this?",
        filename: "photo.jpg",
      },
    });

    expect(summary).toEqual({
      eventId: "$image",
      sender: "@gum:matrix.example.org",
      body: "can you see this?",
      msgtype: "m.image",
      attachment: {
        kind: "image",
        caption: "can you see this?",
        filename: "photo.jpg",
      },
      timestamp: 123,
      relatesTo: undefined,
    });
  });

  it("does not treat a sentence ending in a file extension as a bare filename", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$image",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: {
        msgtype: "m.image",
        body: "see image.png",
      },
    });

    expect(summary).toEqual({
      eventId: "$image",
      sender: "@gum:matrix.example.org",
      body: "see image.png",
      msgtype: "m.image",
      attachment: {
        kind: "image",
        caption: "see image.png",
      },
      timestamp: 123,
      relatesTo: undefined,
    });
  });

  it("leaves text messages unchanged", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$text",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    expect(summary.body).toBe("hello");
    expect(summary.attachment).toBeUndefined();
  });

  it("uses the authoritative new content when summarizing Matrix replacements", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$edit",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 456,
      content: {
        msgtype: "m.text",
        body: "* fallback edit",
        "m.new_content": { msgtype: "m.text", body: "authoritative edit" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
      },
    });

    expect(summary).toEqual({
      eventId: "$edit",
      sender: "@gum:matrix.example.org",
      body: "authoritative edit",
      msgtype: "m.text",
      attachment: undefined,
      timestamp: 456,
      relatesTo: { relType: "m.replace", eventId: "$original" },
    });
  });

  it("applies the homeserver's bundled replacement to an original event", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$original",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: { msgtype: "m.text", body: "original text" },
      unsigned: {
        "m.relations": {
          "m.replace": {
            event_id: "$edit",
            sender: "@gum:matrix.example.org",
            type: "m.room.message",
            origin_server_ts: 456,
            content: {
              msgtype: "m.text",
              body: "* fallback edit",
              "m.new_content": { msgtype: "m.text", body: "bundled final text" },
              "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
            },
          },
        },
      },
    });

    expect(summary).toMatchObject({
      eventId: "$original",
      sender: "@gum:matrix.example.org",
      body: "bundled final text",
      timestamp: 123,
    });
  });

  it("does not apply another sender's bundled replacement", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$original",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: { msgtype: "m.text", body: "original text" },
      unsigned: {
        "m.relations": {
          "m.replace": {
            event_id: "$forged",
            sender: "@mallory:matrix.example.org",
            type: "m.room.message",
            origin_server_ts: 456,
            content: {
              "m.new_content": { msgtype: "m.text", body: "forged text" },
              "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
            },
          },
        },
      },
    });

    expect(summary.body).toBe("original text");
  });

  it("does not apply a redacted bundled replacement", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$original",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: { msgtype: "m.text", body: "original text" },
      unsigned: {
        "m.relations": {
          "m.replace": {
            event_id: "$redacted-edit",
            sender: "@gum:matrix.example.org",
            type: "m.room.message",
            origin_server_ts: 456,
            unsigned: { redacted_because: {} },
            content: {
              "m.new_content": { msgtype: "m.text", body: "redacted text" },
              "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
            },
          },
        },
      },
    });

    expect(summary.body).toBe("original text");
  });
});
