import { describe, expect, it } from "vitest";
import {
  buildPromotedMatrixPreviewEvent,
  MATRIX_PREVIEW_PROTOCOL_KEY,
  parseMatrixOpenClawPreviewEvent,
  type MatrixOpenClawPreviewMarker,
} from "./preview-protocol.js";
import type { MatrixRawEvent } from "./sdk.js";

const marker: MatrixOpenClawPreviewMarker = {
  v: 1,
  responseId: "response-1",
  triggerEventId: "$trigger",
  state: "in-progress",
  revision: 0,
  kind: "answer",
  threadId: "$thread",
  replyToId: "$trigger",
};

function initialEvent(): MatrixRawEvent {
  return {
    event_id: "$preview",
    sender: "@alpha:example.org",
    type: "m.room.message",
    origin_server_ts: 100,
    content: {
      msgtype: "m.text",
      body: "partial",
      [MATRIX_PREVIEW_PROTOCOL_KEY]: marker,
      "org.matrix.msc4357.live": {},
    },
  };
}

describe("Matrix OpenClaw preview protocol", () => {
  it("parses an initial preview", () => {
    expect(parseMatrixOpenClawPreviewEvent(initialEvent())).toMatchObject({
      kind: "preview",
      envelope: { marker, bundled: false },
    });
  });

  it("requires identical markers in an edit and its m.new_content", () => {
    const finalMarker = { ...marker, state: "final" as const, revision: 2 };
    const event: MatrixRawEvent = {
      ...initialEvent(),
      event_id: "$edit",
      origin_server_ts: 200,
      content: {
        msgtype: "m.text",
        body: "* final",
        [MATRIX_PREVIEW_PROTOCOL_KEY]: finalMarker,
        "m.new_content": {
          msgtype: "m.text",
          body: "final",
          [MATRIX_PREVIEW_PROTOCOL_KEY]: { ...finalMarker, revision: 1 },
        },
        "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
      },
    };

    expect(parseMatrixOpenClawPreviewEvent(event)).toEqual({
      kind: "malformed",
      reason: "edit marker copies or target do not agree",
    });
  });

  it("rejects a progress-kind final edit", () => {
    const invalidFinal = {
      ...marker,
      state: "final" as const,
      revision: 1,
      kind: "progress" as const,
    };
    const event: MatrixRawEvent = {
      ...initialEvent(),
      event_id: "$progress-final",
      content: {
        msgtype: "m.text",
        body: "* status",
        [MATRIX_PREVIEW_PROTOCOL_KEY]: invalidFinal,
        "m.new_content": {
          msgtype: "m.text",
          body: "status",
          [MATRIX_PREVIEW_PROTOCOL_KEY]: invalidFinal,
        },
        "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
      },
    };

    expect(parseMatrixOpenClawPreviewEvent(event)).toEqual({
      kind: "malformed",
      reason: "invalid outer marker",
    });
  });

  it("promotes a final edit as one sanitized logical original event", () => {
    const finalMarker = { ...marker, state: "final" as const, revision: 2 };
    const event: MatrixRawEvent = {
      ...initialEvent(),
      event_id: "$edit",
      origin_server_ts: 200,
      content: {
        msgtype: "m.text",
        body: "* final",
        [MATRIX_PREVIEW_PROTOCOL_KEY]: finalMarker,
        "m.new_content": {
          msgtype: "m.text",
          body: "final",
          [MATRIX_PREVIEW_PROTOCOL_KEY]: finalMarker,
          "org.matrix.msc4357.live": {},
        },
        "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
      },
    };
    const parsed = parseMatrixOpenClawPreviewEvent(event);
    expect(parsed.kind).toBe("preview");
    if (parsed.kind !== "preview") {
      return;
    }

    expect(
      buildPromotedMatrixPreviewEvent({
        envelope: parsed.envelope,
        originalEventId: "$preview",
        senderId: "@alpha:example.org",
      }),
    ).toEqual({
      event_id: "$preview",
      sender: "@alpha:example.org",
      type: "m.room.message",
      origin_server_ts: 200,
      __openclawTrustedEnhancedFinal: true,
      content: {
        msgtype: "m.text",
        body: "final",
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$thread",
          "m.in_reply_to": { event_id: "$trigger" },
        },
      },
    });
  });

  it("recovers a final edit bundled onto the original event", () => {
    const finalMarker = { ...marker, state: "final" as const, revision: 1 };
    const event = initialEvent();
    event.unsigned = {
      "m.relations": {
        "m.replace": {
          event_id: "$edit",
          sender: event.sender,
          type: event.type,
          origin_server_ts: 200,
          content: {
            msgtype: "m.text",
            body: "* final",
            [MATRIX_PREVIEW_PROTOCOL_KEY]: finalMarker,
            "m.new_content": {
              msgtype: "m.text",
              body: "final",
              [MATRIX_PREVIEW_PROTOCOL_KEY]: finalMarker,
            },
            "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
          },
        },
      },
    };

    expect(parseMatrixOpenClawPreviewEvent(event)).toMatchObject({
      kind: "preview",
      envelope: { originalEventId: "$preview", bundled: true, marker: finalMarker },
    });
  });

  it("parses a bounded standalone multipart final and preserves its part identity", () => {
    const standaloneMarker: MatrixOpenClawPreviewMarker = {
      ...marker,
      state: "final",
      revision: 0,
      kind: "answer",
      partIndex: 1,
      partCount: 3,
    };
    const event: MatrixRawEvent = {
      ...initialEvent(),
      event_id: "$part-1",
      content: {
        msgtype: "m.text",
        body: "middle",
        [MATRIX_PREVIEW_PROTOCOL_KEY]: standaloneMarker,
      },
    };

    expect(parseMatrixOpenClawPreviewEvent(event)).toMatchObject({
      kind: "preview",
      envelope: { marker: standaloneMarker, bundled: false },
    });
  });

  it("rejects unbounded, incomplete, and conflicting standalone part metadata", () => {
    for (const badMarker of [
      { ...marker, state: "final", partIndex: 0 },
      { ...marker, state: "final", partIndex: 2, partCount: 2 },
      { ...marker, state: "final", partIndex: 0, partCount: 65 },
    ]) {
      const event = initialEvent();
      event.content = {
        msgtype: "m.text",
        body: "bad",
        [MATRIX_PREVIEW_PROTOCOL_KEY]: badMarker,
      };
      expect(parseMatrixOpenClawPreviewEvent(event).kind).toBe("malformed");
    }
  });

  it("recognizes authenticated ancillary roots without treating them as finals", () => {
    const ancillaryMarker: MatrixOpenClawPreviewMarker = {
      ...marker,
      state: "ancillary",
      revision: 0,
      kind: "progress",
    };
    const event = initialEvent();
    event.event_id = "$media";
    event.content = {
      msgtype: "m.file",
      body: "report.pdf",
      [MATRIX_PREVIEW_PROTOCOL_KEY]: ancillaryMarker,
    };
    expect(parseMatrixOpenClawPreviewEvent(event)).toMatchObject({
      kind: "preview",
      envelope: { marker: ancillaryMarker },
    });
  });

  it("rejects protocol markers on Matrix state events", () => {
    const event = initialEvent();
    event.state_key = "state";
    expect(parseMatrixOpenClawPreviewEvent(event)).toEqual({
      kind: "malformed",
      reason: "preview must be a non-state room message",
    });
  });
});
