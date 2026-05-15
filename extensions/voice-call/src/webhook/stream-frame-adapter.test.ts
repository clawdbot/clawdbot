import { describe, expect, it } from "vitest";
import { TelnyxStreamFrameAdapter, TwilioStreamFrameAdapter } from "./stream-frame-adapter.js";

describe("TwilioStreamFrameAdapter", () => {
  it("parses Twilio start, media, mark, stop, and ignores junk", () => {
    const adapter = new TwilioStreamFrameAdapter();

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-stream", callSid: "CA-call" },
        }),
      ),
    ).toEqual({ kind: "start", streamId: "MZ-stream", providerCallId: "CA-call" });

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "media",
          media: { payload: "AAA=", timestamp: "20", track: "inbound" },
        }),
      ),
    ).toEqual({
      kind: "media",
      payloadBase64: "AAA=",
      timestampMs: 20,
      track: "inbound",
    });

    expect(
      adapter.parseInbound(JSON.stringify({ event: "mark", mark: { name: "audio-1" } })),
    ).toEqual({ kind: "mark", name: "audio-1" });

    expect(adapter.parseInbound(JSON.stringify({ event: "stop" }))).toEqual({ kind: "stop" });

    expect(adapter.parseInbound("not json")).toEqual({ kind: "ignored" });
    expect(adapter.parseInbound(JSON.stringify({ event: "media" }))).toEqual({ kind: "ignored" });
    expect(
      adapter.parseInbound(JSON.stringify({ event: "start", start: { streamSid: "MZ-only" } })),
    ).toEqual({ kind: "ignored" });
    expect(
      adapter.parseInbound(JSON.stringify({ event: "media", media: { payload: "AAA@@@" } })),
    ).toEqual({ kind: "ignored" });
  });

  it("serializes outbound frames with the streamSid captured at start", () => {
    const adapter = new TwilioStreamFrameAdapter();
    adapter.parseInbound(
      JSON.stringify({
        event: "start",
        start: { streamSid: "MZ-stream", callSid: "CA-call" },
      }),
    );

    expect(JSON.parse(adapter.serializeMedia("payload-b64"))).toEqual({
      event: "media",
      streamSid: "MZ-stream",
      media: { payload: "payload-b64" },
    });
    expect(JSON.parse(adapter.serializeClear())).toEqual({
      event: "clear",
      streamSid: "MZ-stream",
    });
    expect(JSON.parse(adapter.serializeMark("audio-1"))).toEqual({
      event: "mark",
      streamSid: "MZ-stream",
      mark: { name: "audio-1" },
    });
  });
});

describe("TelnyxStreamFrameAdapter", () => {
  it("parses Telnyx start with top-level stream_id and start.call_control_id", () => {
    const adapter = new TelnyxStreamFrameAdapter();

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "start",
          sequence_number: "1",
          stream_id: "telnyx-stream-7",
          start: {
            call_control_id: "v3:carrier-call-id",
            call_session_id: "session-1",
            media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
          },
        }),
      ),
    ).toEqual({
      kind: "start",
      streamId: "telnyx-stream-7",
      providerCallId: "v3:carrier-call-id",
    });
  });

  it("ignores Telnyx start frames without stream_id or call_control_id", () => {
    const adapter = new TelnyxStreamFrameAdapter();

    expect(adapter.parseInbound(JSON.stringify({ event: "start", start: {} }))).toEqual({
      kind: "ignored",
    });
    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "start",
          stream_id: "telnyx-stream-7",
          start: {},
        }),
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("parses media, mark, and stop with no streamSid", () => {
    const adapter = new TelnyxStreamFrameAdapter();

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "media",
          stream_id: "telnyx-stream-7",
          media: { payload: "AAA=", timestamp: 40, track: "inbound_track" },
        }),
      ),
    ).toEqual({
      kind: "media",
      payloadBase64: "AAA=",
      timestampMs: 40,
      track: "inbound_track",
    });

    expect(
      adapter.parseInbound(JSON.stringify({ event: "mark", mark: { name: "audio-1" } })),
    ).toEqual({ kind: "mark", name: "audio-1" });

    expect(adapter.parseInbound(JSON.stringify({ event: "stop" }))).toEqual({ kind: "stop" });
  });

  it("surfaces Telnyx WS error frames so failures don't get swallowed", () => {
    const adapter = new TelnyxStreamFrameAdapter();

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "error",
          stream_id: "telnyx-stream-7",
          payload: {
            code: 100002,
            title: "WebSocket error",
            detail: "Unable to decode payload",
          },
        }),
      ),
    ).toEqual({
      kind: "error",
      code: "100002",
      title: "WebSocket error",
      detail: "Unable to decode payload",
    });
  });

  it("serializes outbound frames without streamSid", () => {
    const adapter = new TelnyxStreamFrameAdapter();

    expect(JSON.parse(adapter.serializeMedia("payload-b64"))).toEqual({
      event: "media",
      media: { payload: "payload-b64" },
    });
    expect(JSON.parse(adapter.serializeClear())).toEqual({ event: "clear" });
    expect(JSON.parse(adapter.serializeMark("audio-1"))).toEqual({
      event: "mark",
      mark: { name: "audio-1" },
    });
  });

  it("ignores junk and unknown events", () => {
    const adapter = new TelnyxStreamFrameAdapter();
    expect(adapter.parseInbound("not json")).toEqual({ kind: "ignored" });
    expect(adapter.parseInbound(JSON.stringify({ event: "media" }))).toEqual({ kind: "ignored" });
    expect(
      adapter.parseInbound(JSON.stringify({ event: "media", media: { payload: "AAA@@@" } })),
    ).toEqual({ kind: "ignored" });
    expect(adapter.parseInbound(JSON.stringify({ event: "something-else" }))).toEqual({
      kind: "ignored",
    });
  });
});
