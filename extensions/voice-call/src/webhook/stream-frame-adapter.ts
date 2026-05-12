export type StreamFrame =
  | { kind: "start"; streamId: string; providerCallId: string }
  | {
      kind: "media";
      payloadBase64: string;
      timestampMs?: number;
      track?: string;
    }
  | { kind: "mark"; name?: string }
  | { kind: "stop" }
  | { kind: "error"; code?: string; title?: string; detail?: string }
  | { kind: "ignored" };

export interface StreamFrameAdapter {
  readonly providerName: "twilio" | "telnyx";
  parseInbound(rawMessage: string): StreamFrame;
  serializeMedia(payloadBase64: string): string;
  serializeClear(): string;
  serializeMark(name: string): string;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function tryParseJson(rawMessage: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawMessage) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export class TwilioStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "twilio" as const;
  private streamSid = "";

  parseInbound(rawMessage: string): StreamFrame {
    const msg = tryParseJson(rawMessage);
    if (!msg) {
      return { kind: "ignored" };
    }
    const event = msg.event;
    if (event === "start") {
      const startData =
        typeof msg.start === "object" && msg.start !== null
          ? (msg.start as Record<string, unknown>)
          : undefined;
      const streamSid = typeof startData?.streamSid === "string" ? startData.streamSid : "";
      const callSid = typeof startData?.callSid === "string" ? startData.callSid : "";
      if (!streamSid || !callSid) {
        return { kind: "ignored" };
      }
      this.streamSid = streamSid;
      return { kind: "start", streamId: streamSid, providerCallId: callSid };
    }
    if (event === "media") {
      const mediaData =
        typeof msg.media === "object" && msg.media !== null
          ? (msg.media as Record<string, unknown>)
          : undefined;
      const payload = typeof mediaData?.payload === "string" ? mediaData.payload : undefined;
      if (!payload) {
        return { kind: "ignored" };
      }
      return {
        kind: "media",
        payloadBase64: payload,
        timestampMs: parseTimestampMs(mediaData?.timestamp),
        track: typeof mediaData?.track === "string" ? mediaData.track : undefined,
      };
    }
    if (event === "mark") {
      const markData =
        typeof msg.mark === "object" && msg.mark !== null
          ? (msg.mark as Record<string, unknown>)
          : undefined;
      const name = typeof markData?.name === "string" ? markData.name : undefined;
      return { kind: "mark", name };
    }
    if (event === "stop") {
      return { kind: "stop" };
    }
    return { kind: "ignored" };
  }

  serializeMedia(payloadBase64: string): string {
    return JSON.stringify({
      event: "media",
      streamSid: this.streamSid,
      media: { payload: payloadBase64 },
    });
  }

  serializeClear(): string {
    return JSON.stringify({ event: "clear", streamSid: this.streamSid });
  }

  serializeMark(name: string): string {
    return JSON.stringify({
      event: "mark",
      streamSid: this.streamSid,
      mark: { name },
    });
  }
}

export class TelnyxStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "telnyx" as const;

  parseInbound(rawMessage: string): StreamFrame {
    const msg = tryParseJson(rawMessage);
    if (!msg) {
      return { kind: "ignored" };
    }
    const event = msg.event;
    const topLevelStreamId =
      typeof msg.stream_id === "string" && msg.stream_id ? msg.stream_id : undefined;
    if (event === "start") {
      const startData =
        typeof msg.start === "object" && msg.start !== null
          ? (msg.start as Record<string, unknown>)
          : undefined;
      const providerCallId =
        typeof startData?.call_control_id === "string" && startData.call_control_id
          ? startData.call_control_id
          : undefined;
      if (!topLevelStreamId || !providerCallId) {
        return { kind: "ignored" };
      }
      return {
        kind: "start",
        streamId: topLevelStreamId,
        providerCallId,
      };
    }
    if (event === "media") {
      const mediaData =
        typeof msg.media === "object" && msg.media !== null
          ? (msg.media as Record<string, unknown>)
          : undefined;
      const payload = typeof mediaData?.payload === "string" ? mediaData.payload : undefined;
      if (!payload) {
        return { kind: "ignored" };
      }
      return {
        kind: "media",
        payloadBase64: payload,
        timestampMs: parseTimestampMs(mediaData?.timestamp),
        track: typeof mediaData?.track === "string" ? mediaData.track : undefined,
      };
    }
    if (event === "mark") {
      const markData =
        typeof msg.mark === "object" && msg.mark !== null
          ? (msg.mark as Record<string, unknown>)
          : undefined;
      const name = typeof markData?.name === "string" ? markData.name : undefined;
      return { kind: "mark", name };
    }
    if (event === "stop") {
      return { kind: "stop" };
    }
    if (event === "error") {
      const errorData =
        typeof msg.payload === "object" && msg.payload !== null
          ? (msg.payload as Record<string, unknown>)
          : undefined;
      return {
        kind: "error",
        code:
          typeof errorData?.code === "string" || typeof errorData?.code === "number"
            ? String(errorData.code)
            : undefined,
        title: typeof errorData?.title === "string" ? errorData.title : undefined,
        detail: typeof errorData?.detail === "string" ? errorData.detail : undefined,
      };
    }
    return { kind: "ignored" };
  }

  serializeMedia(payloadBase64: string): string {
    return JSON.stringify({
      event: "media",
      media: { payload: payloadBase64 },
    });
  }

  serializeClear(): string {
    return JSON.stringify({ event: "clear" });
  }

  serializeMark(name: string): string {
    return JSON.stringify({
      event: "mark",
      mark: { name },
    });
  }
}
