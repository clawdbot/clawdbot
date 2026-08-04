// Doubao realtime dialogue binary framing helpers.
import { gunzipSync, gzipSync } from "node:zlib";

export const DOUBAO_CLIENT_EVENT = {
  StartConnection: 1,
  FinishConnection: 2,
  StartSession: 100,
  FinishSession: 102,
  TaskRequest: 200,
  SayHello: 300,
  ChatTTSText: 500,
} as const;

export const DOUBAO_SERVER_EVENT = {
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSEnded: 359,
  ASRInfo: 450,
  ASRResponse: 451,
  ASREnded: 459,
  ChatResponse: 550,
  ChatEnded: 559,
  ChatFailed: 599,
} as const;

type DoubaoSerialization = "json" | "raw";

type EncodeDoubaoFrameParams = {
  messageType: number;
  event: number;
  sessionId?: string;
  serialization: DoubaoSerialization;
  payload: unknown;
};

export type DecodedDoubaoFrame = {
  messageType: number;
  flags: number;
  event?: number;
  sessionId?: string;
  errorCode?: number;
  jsonPayload?: unknown;
  binaryPayload?: Buffer;
};

const PROTOCOL_VERSION_AND_HEADER_SIZE = 0x11;
const EVENT_FLAG = 0x04;
const JSON_SERIALIZATION = 0x01;
const GZIP_COMPRESSION = 0x01;
const ERROR_MESSAGE_TYPE = 0x0f;

function encodePayload(serialization: DoubaoSerialization, payload: unknown): Buffer {
  if (serialization === "raw") {
    return Buffer.isBuffer(payload) ? payload : Buffer.from(payload as Uint8Array);
  }
  return Buffer.from(JSON.stringify(payload ?? {}), "utf8");
}

function writeLengthPrefixed(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.byteLength, 0);
  return Buffer.concat([length, value]);
}

export function encodeDoubaoFrame(params: EncodeDoubaoFrameParams): Buffer {
  const serialized = encodePayload(params.serialization, params.payload);
  const compressed = gzipSync(serialized);
  const header = Buffer.from([
    PROTOCOL_VERSION_AND_HEADER_SIZE,
    ((params.messageType & 0x0f) << 4) | EVENT_FLAG,
    ((params.serialization === "json" ? JSON_SERIALIZATION : 0) << 4) | GZIP_COMPRESSION,
    0,
  ]);
  const event = Buffer.allocUnsafe(4);
  event.writeUInt32BE(params.event, 0);
  const session = params.sessionId
    ? writeLengthPrefixed(Buffer.from(params.sessionId, "utf8"))
    : Buffer.alloc(0);
  return Buffer.concat([header, event, session, writeLengthPrefixed(compressed)]);
}

function readUInt32(buffer: Buffer, offset: number): number | undefined {
  return offset + 4 <= buffer.byteLength ? buffer.readUInt32BE(offset) : undefined;
}

function readPayloadAndSession(
  buffer: Buffer,
  offset: number,
): { payload: Buffer; sessionId?: string } | undefined {
  const firstLength = readUInt32(buffer, offset);
  if (firstLength === undefined) {
    return undefined;
  }
  const firstStart = offset + 4;

  // Session-scoped frames encode session-id length + session-id before payload length.
  const payloadLengthOffset = firstStart + firstLength;
  const nestedPayloadLength = readUInt32(buffer, payloadLengthOffset);
  if (
    firstLength > 0 &&
    firstLength <= 128 &&
    nestedPayloadLength !== undefined &&
    payloadLengthOffset + 4 + nestedPayloadLength === buffer.byteLength
  ) {
    const sessionBytes = buffer.subarray(firstStart, payloadLengthOffset);
    const sessionId = sessionBytes.toString("utf8");
    if (/^[\x20-\x7e]+$/u.test(sessionId)) {
      return {
        sessionId,
        payload: buffer.subarray(payloadLengthOffset + 4),
      };
    }
  }

  if (firstStart + firstLength !== buffer.byteLength) {
    return undefined;
  }
  return { payload: buffer.subarray(firstStart) };
}

export function decodeDoubaoFrame(input: Buffer): DecodedDoubaoFrame | undefined {
  if (input.byteLength < 8) {
    return undefined;
  }
  const headerWords = input[0]! & 0x0f;
  if (input[0]! >> 4 !== 1 || headerWords < 1) {
    return undefined;
  }
  let offset = headerWords * 4;
  const messageType = input[1]! >> 4;
  const flags = input[1]! & 0x0f;
  const serializationCode = input[2]! >> 4;
  const compressionCode = input[2]! & 0x0f;
  let event: number | undefined;
  if ((flags & EVENT_FLAG) !== 0) {
    event = readUInt32(input, offset);
    if (event === undefined) {
      return undefined;
    }
    offset += 4;
  }

  let errorCode: number | undefined;
  if (messageType === ERROR_MESSAGE_TYPE) {
    errorCode = readUInt32(input, offset);
    if (errorCode === undefined) {
      return undefined;
    }
    offset += 4;
  }

  const scopedPayload = readPayloadAndSession(input, offset);
  if (!scopedPayload) {
    return undefined;
  }
  let payload = scopedPayload.payload;
  if (compressionCode === GZIP_COMPRESSION) {
    try {
      payload = gunzipSync(payload);
    } catch {
      return undefined;
    }
  }

  const decoded: DecodedDoubaoFrame = {
    messageType,
    flags,
    event,
    sessionId: scopedPayload.sessionId,
    errorCode,
  };
  if (serializationCode === JSON_SERIALIZATION) {
    try {
      decoded.jsonPayload = JSON.parse(payload.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  } else {
    decoded.binaryPayload = payload;
  }
  return decoded;
}
