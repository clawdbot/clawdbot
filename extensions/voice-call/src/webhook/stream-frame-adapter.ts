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
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
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

function readRecordField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

function isValidBase64Payload(value: string): boolean {
  const buffer = Buffer.from(value, "base64");
  return normalizeBase64ForCompare(buffer.toString("base64")) === normalizeBase64ForCompare(value);
}

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

function withOptionalStreamSid(streamSid: string | undefined): Partial<{ streamSid: string }> {
  return streamSid === undefined ? {} : { streamSid };
}

function serializeMediaFrame(payloadBase64: string, streamSid?: string): string {
  return JSON.stringify({
    event: "media",
    ...withOptionalStreamSid(streamSid),
    media: { payload: payloadBase64 },
  });
}

function serializeClearFrame(streamSid?: string): string {
  return JSON.stringify({ event: "clear", ...withOptionalStreamSid(streamSid) });
}

function serializeMarkFrame(name: string, streamSid?: string): string {
  return JSON.stringify({
    event: "mark",
    ...withOptionalStreamSid(streamSid),
    mark: { name },
  });
}

export class TwilioStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "twilio" as const;
  private streamSid = "";

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

  serializeMedia(payloadBase64: string): string {
    return serializeMediaFrame(payloadBase64, this.streamSid);
  }

  serializeClear(): string {
    return serializeClearFrame(this.streamSid);
  }

  serializeMark(name: string): string {
    return serializeMarkFrame(name, this.streamSid);
  }
}

export class TelnyxStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "telnyx" as const;

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

  serializeMedia(payloadBase64: string): string {
    return serializeMediaFrame(payloadBase64);
  }

  serializeClear(): string {
    return serializeClearFrame();
  }

  serializeMark(name: string): string {
    return serializeMarkFrame(name);
  }
}
