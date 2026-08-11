import os from "node:os";
import { asRecord } from "../record-shared.js";

const BROWSER_NATIVE_REQUEST_MAX_BYTES = 4 * 1024;
const BROWSER_NATIVE_RESPONSE_MAX_BYTES = 1024 * 1024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;

type BrowserNativeFailureCode =
  | "invalid_frame"
  | "invalid_utf8"
  | "invalid_request"
  | "origin_forbidden"
  | "manifest_invalid"
  | "manual_required"
  | "pairing_unavailable";
type BrowserNativeBootstrapRequest = { v: 1; op: "bootstrap"; nonce: string };
export type BrowserNativeBootstrapResponse =
  | { v: 1; ok: true; nonce: string; pairingString: string }
  | { v: 1; ok: false; code: BrowserNativeFailureCode };

function readNativeUint32(buffer: Buffer, offset = 0): number {
  return os.endianness() === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function writeNativeUint32(buffer: Buffer, value: number, offset = 0): void {
  if (os.endianness() === "LE") {
    buffer.writeUInt32LE(value, offset);
  } else {
    buffer.writeUInt32BE(value, offset);
  }
}

function rootJsonKeys(raw: string): string[] | null {
  const keys: string[] = [];
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(raw[index] ?? "")) {
      index += 1;
    }
  };
  const readString = (): string | null => {
    if (raw[index] !== '"') {
      return null;
    }
    const start = index++;
    while (index < raw.length) {
      const char = raw[index++];
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        try {
          return JSON.parse(raw.slice(start, index)) as string;
        } catch {
          return null;
        }
      }
    }
    return null;
  };
  const skipValue = (): boolean => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index];
      if (inString) {
        index += 1;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        index += 1;
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === "]") {
        if (depth === 0) {
          return true;
        }
        depth -= 1;
      } else if (char === "," && depth === 0) {
        return true;
      }
      index += 1;
    }
    return true;
  };

  skipWhitespace();
  if (raw[index++] !== "{") {
    return null;
  }
  for (;;) {
    skipWhitespace();
    if (raw[index] === "}") {
      return keys;
    }
    const key = readString();
    if (key === null) {
      return null;
    }
    keys.push(key);
    skipWhitespace();
    if (raw[index++] !== ":") {
      return null;
    }
    skipWhitespace();
    if (!skipValue()) {
      return null;
    }
    skipWhitespace();
    if (raw[index] === ",") {
      index += 1;
      continue;
    }
    return raw[index] === "}" ? keys : null;
  }
}

function isCanonicalNonce(value: unknown): value is string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, "base64url");
  return bytes.length >= 16 && bytes.length <= 32 && bytes.toString("base64url") === value;
}

/** Strictly validate one decoded native bootstrap request. */
function parseBrowserNativeRequest(raw: string): BrowserNativeBootstrapRequest | null {
  const keys = rootJsonKeys(raw);
  if (!keys || new Set(keys).size !== keys.length) {
    return null;
  }
  const expected = ["v", "op", "nonce"];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  return record?.v === 1 && record.op === "bootstrap" && isCanonicalNonce(record.nonce)
    ? { v: 1, op: "bootstrap", nonce: record.nonce }
    : null;
}

export function decodeBrowserNativeFrame(
  frame: Buffer,
):
  | { ok: true; request: BrowserNativeBootstrapRequest }
  | { ok: false; code: BrowserNativeFailureCode } {
  if (frame.length < 4) {
    return { ok: false, code: "invalid_frame" };
  }
  const length = readNativeUint32(frame);
  if (length === 0 || length > BROWSER_NATIVE_REQUEST_MAX_BYTES || frame.length !== length + 4) {
    return { ok: false, code: "invalid_frame" };
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4));
  } catch {
    return { ok: false, code: "invalid_utf8" };
  }
  const request = parseBrowserNativeRequest(raw);
  return request ? { ok: true, request } : { ok: false, code: "invalid_request" };
}

/** Read exactly one small frame without allocating from an untrusted length. */
export async function readBrowserNativeFrame(input: AsyncIterable<Buffer>): Promise<Buffer> {
  let buffered = Buffer.alloc(0);
  let expected = 4;
  for await (const chunk of input) {
    if (buffered.length + chunk.length > BROWSER_NATIVE_REQUEST_MAX_BYTES + 4) {
      throw new Error("invalid_frame");
    }
    buffered = Buffer.concat([buffered, chunk], buffered.length + chunk.length);
    if (expected === 4 && buffered.length >= 4) {
      const length = readNativeUint32(buffered);
      if (length === 0 || length > BROWSER_NATIVE_REQUEST_MAX_BYTES) {
        throw new Error("invalid_frame");
      }
      expected = length + 4;
    }
    if (buffered.length >= expected) {
      if (buffered.length !== expected) {
        throw new Error("invalid_frame");
      }
      return buffered;
    }
  }
  throw new Error("invalid_frame");
}

export function encodeBrowserNativeResponse(response: BrowserNativeBootstrapResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(response), "utf8");
  if (payload.length >= BROWSER_NATIVE_RESPONSE_MAX_BYTES) {
    throw new Error("native response exceeds Chrome's 1 MiB limit");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  writeNativeUint32(frame, payload.length);
  payload.copy(frame, 4);
  return frame;
}
