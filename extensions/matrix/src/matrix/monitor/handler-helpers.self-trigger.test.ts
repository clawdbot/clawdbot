import { describe, expect, it } from "vitest";
import { readSelfTriggerMarker } from "./handler-helpers.js";
import type { MatrixRawEvent } from "./types.js";

function makeEvent(content: Record<string, unknown>): MatrixRawEvent {
  return {
    event_id: "$event1:matrix.org",
    sender: "@bot:matrix.org",
    type: "m.room.message",
    origin_server_ts: 1700000000000,
    content,
  };
}

const ROOM_ID = "!task-room:matrix.org";

const VALID_MARKER = {
  kind: "self_cross_session",
  type: "project_requested",
  sourceSession: "matrix:!admin-dm:matrix.org",
  targetRoomId: ROOM_ID,
  targetSession: `matrix:${ROOM_ID}`,
  replyRoute: { channel: "matrix", targetSession: `matrix:!admin-dm:matrix.org` },
};

describe("readSelfTriggerMarker", () => {
  it("returns the marker when valid", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "PROJECT_REQUESTED: build the API",
      "com.openclaw.self_trigger": VALID_MARKER,
    });
    const result = readSelfTriggerMarker(event, ROOM_ID);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("self_cross_session");
    expect(result?.type).toBe("project_requested");
  });

  it("returns null when the marker is absent", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "hello world",
    });
    expect(readSelfTriggerMarker(event, ROOM_ID)).toBeNull();
  });

  it("returns null when the marker is not an object", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "hello",
      "com.openclaw.self_trigger": "not-an-object",
    });
    expect(readSelfTriggerMarker(event, ROOM_ID)).toBeNull();
  });

  it("returns null when kind is not self_cross_session", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "PROJECT_REQUESTED",
      "com.openclaw.self_trigger": { ...VALID_MARKER, kind: "other_kind" },
    });
    expect(readSelfTriggerMarker(event, ROOM_ID)).toBeNull();
  });

  it("returns null when type is not in the allowlist", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "TASK_COMPLETED",
      "com.openclaw.self_trigger": { ...VALID_MARKER, type: "task_completed" },
    });
    expect(readSelfTriggerMarker(event, ROOM_ID)).toBeNull();
  });

  it("returns null when targetRoomId does not match roomId", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "PROJECT_REQUESTED",
      "com.openclaw.self_trigger": {
        ...VALID_MARKER,
        targetRoomId: "!other-room:matrix.org",
        targetSession: "matrix:!other-room:matrix.org",
      },
    });
    expect(readSelfTriggerMarker(event, ROOM_ID)).toBeNull();
  });

  it("matches when targetSession (without matrix: prefix) equals roomId", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "PROJECT_REQUESTED",
      "com.openclaw.self_trigger": {
        ...VALID_MARKER,
        targetRoomId: "",
        targetSession: ROOM_ID,
      },
    });
    expect(readSelfTriggerMarker(event, ROOM_ID)).not.toBeNull();
  });

  it("matches when targetSession has room: prefix", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "PROJECT_REQUESTED",
      "com.openclaw.self_trigger": {
        ...VALID_MARKER,
        targetRoomId: "",
        targetSession: `room:${ROOM_ID}`,
      },
    });
    expect(readSelfTriggerMarker(event, ROOM_ID)).not.toBeNull();
  });

  it("returns null when event content is not an object", () => {
    const event = makeEvent("not-an-object" as unknown as Record<string, unknown>);
    expect(readSelfTriggerMarker(event, ROOM_ID)).toBeNull();
  });

  it("returns null when targetRoomId and targetSession are both empty", () => {
    const event = makeEvent({
      msgtype: "m.text",
      body: "PROJECT_REQUESTED",
      "com.openclaw.self_trigger": {
        ...VALID_MARKER,
        targetRoomId: "",
        targetSession: "",
      },
    });
    expect(readSelfTriggerMarker(event, ROOM_ID)).toBeNull();
  });
});
