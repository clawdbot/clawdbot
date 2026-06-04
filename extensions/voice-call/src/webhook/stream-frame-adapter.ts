// Provider-specific media stream frame parsing and serialization.

/** Normalized inbound media stream frame. */
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

/** Adapter contract for provider media stream wire formats. */
export interface StreamFrameAdapter {
  readonly providerName: "twilio" | "telnyx";
  parseInbound(rawMessage: string): StreamFrame;
  serializeMedia(payloadBase64: string): string;
  serializeClear(): string;
  serializeMark(name: string): string;
}

/** Parse numeric timestamps sent as numbers or integer strings. */
function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Parse a JSON object frame, returning null for invalid or non-object payloads. */
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

/** Read an object-valued field from a parsed frame. */
function readRecordField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Normalize base64/base64url padding differences for validation. */
function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

/** Return true when a payload round-trips as base64. */
function isValidBase64Payload(value: string): boolean {
  const buffer = Buffer.from(value, "base64");
  return normalizeBase64ForCompare(buffer.toString("base64")) === normalizeBase64ForCompare(value);
}

/** Parse a common provider media frame. */
function parseMediaFrame(msg: Record<string, unknown>): StreamFrame {
  const mediaData = readRecordField(msg, "media");
  const payload = typeof mediaData?.payload === "string" ? mediaData.payload : undefined;
  if (!payload || !isValidBase64Payload(payload)) {
    return { kind: "ignored" };
  }
  return {
    kind: "media",
    payloadBase64: payload,
    timestampMs: parseTimestampMs(mediaData?.timestamp),
    track: typeof mediaData?.track === "string" ? mediaData.track : undefined,
  };
}

/** Parse a common provider mark frame. */
function parseMarkFrame(msg: Record<string, unknown>): StreamFrame {
  const markData = readRecordField(msg, "mark");
  const name = typeof markData?.name === "string" ? markData.name : undefined;
  return { kind: "mark", name };
}

type ProviderStartFrameParser = (msg: Record<string, unknown>) => StreamFrame | undefined;
type ProviderExtraFrameParser = (
  event: unknown,
  msg: Record<string, unknown>,
) => StreamFrame | undefined;

/** Parse common media, mark, and stop frames shared by supported providers. */
function parseCommonInboundFrame(
  event: unknown,
  msg: Record<string, unknown>,
): StreamFrame | undefined {
  if (event === "media") {
    return parseMediaFrame(msg);
  }
  if (event === "mark") {
    return parseMarkFrame(msg);
  }
  if (event === "stop") {
    return { kind: "stop" };
  }
  return undefined;
}

/** Parse one provider frame with provider-specific start/error hooks. */
function parseProviderInboundFrame(
  rawMessage: string,
  parseStartFrame: ProviderStartFrameParser,
  parseExtraFrame?: ProviderExtraFrameParser,
): StreamFrame {
  const msg = tryParseJson(rawMessage);
  if (!msg) {
    return { kind: "ignored" };
  }
  const event = msg.event;
  if (event === "start") {
    return parseStartFrame(msg) ?? { kind: "ignored" };
  }
  return (
    parseCommonInboundFrame(event, msg) ?? parseExtraFrame?.(event, msg) ?? { kind: "ignored" }
  );
}

/** Include streamSid only when Twilio has already supplied one. */
function withOptionalStreamSid(streamSid: string | undefined): Partial<{ streamSid: string }> {
  return streamSid === undefined ? {} : { streamSid };
}

/** Serialize a provider media frame. */
function serializeMediaFrame(payloadBase64: string, streamSid?: string): string {
  return JSON.stringify({
    event: "media",
    ...withOptionalStreamSid(streamSid),
    media: { payload: payloadBase64 },
  });
}

/** Serialize a provider clear frame. */
function serializeClearFrame(streamSid?: string): string {
  return JSON.stringify({ event: "clear", ...withOptionalStreamSid(streamSid) });
}

/** Serialize a provider mark frame. */
function serializeMarkFrame(name: string, streamSid?: string): string {
  return JSON.stringify({
    event: "mark",
    ...withOptionalStreamSid(streamSid),
    mark: { name },
  });
}

/** Twilio media stream adapter, retaining streamSid for outbound frames. */
export class TwilioStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "twilio" as const;
  private streamSid = "";

  /** Parse one Twilio websocket message into a normalized frame. */
  parseInbound(rawMessage: string): StreamFrame {
    return parseProviderInboundFrame(rawMessage, (msg) => {
      const startData = readRecordField(msg, "start");
      const streamSid = typeof startData?.streamSid === "string" ? startData.streamSid : "";
      const callSid = typeof startData?.callSid === "string" ? startData.callSid : "";
      if (!streamSid || !callSid) {
        return undefined;
      }
      this.streamSid = streamSid;
      return { kind: "start", streamId: streamSid, providerCallId: callSid };
    });
  }

  /** Serialize Twilio media with the active streamSid. */
  serializeMedia(payloadBase64: string): string {
    return serializeMediaFrame(payloadBase64, this.streamSid);
  }

  /** Serialize Twilio clear with the active streamSid. */
  serializeClear(): string {
    return serializeClearFrame(this.streamSid);
  }

  /** Serialize Twilio mark with the active streamSid. */
  serializeMark(name: string): string {
    return serializeMarkFrame(name, this.streamSid);
  }
}

/** Telnyx media stream adapter. */
export class TelnyxStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "telnyx" as const;

  /** Parse one Telnyx websocket message into a normalized frame. */
  parseInbound(rawMessage: string): StreamFrame {
    return parseProviderInboundFrame(
      rawMessage,
      (msg) => {
        const topLevelStreamId =
          typeof msg.stream_id === "string" && msg.stream_id ? msg.stream_id : undefined;
        const startData = readRecordField(msg, "start");
        const providerCallId =
          typeof startData?.call_control_id === "string" && startData.call_control_id
            ? startData.call_control_id
            : undefined;
        if (!topLevelStreamId || !providerCallId) {
          return undefined;
        }
        return {
          kind: "start",
          streamId: topLevelStreamId,
          providerCallId,
        };
      },
      (event, msg) => {
        if (event !== "error") {
          return undefined;
        }
        const errorData = readRecordField(msg, "payload");
        return {
          kind: "error",
          code:
            typeof errorData?.code === "string" || typeof errorData?.code === "number"
              ? String(errorData.code)
              : undefined,
          title: typeof errorData?.title === "string" ? errorData.title : undefined,
          detail: typeof errorData?.detail === "string" ? errorData.detail : undefined,
        };
      },
    );
  }

  /** Serialize Telnyx media. */
  serializeMedia(payloadBase64: string): string {
    return serializeMediaFrame(payloadBase64);
  }

  /** Serialize Telnyx clear. */
  serializeClear(): string {
    return serializeClearFrame();
  }

  /** Serialize Telnyx mark. */
  serializeMark(name: string): string {
    return serializeMarkFrame(name);
  }
}
