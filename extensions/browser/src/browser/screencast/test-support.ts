import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { BrowserScreencastTokenParams } from "./tokens.js";

export function screencastParams(
  overrides: Partial<BrowserScreencastTokenParams> = {},
): BrowserScreencastTokenParams {
  return {
    profileName: "openclaw",
    targetId: "target-1",
    cdpUrl: "http://127.0.0.1:9222",
    maxWidth: 1280,
    maxHeight: 1280,
    quality: 70,
    lifecycleGeneration: 0,
    lifecycleSignal: new AbortController().signal,
    assertCurrent: () => {},
    checkNavigationAllowed: async () => {},
    ...overrides,
  };
}

export class ScreencastViewer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn<(data: string | Buffer, callback?: (error?: Error) => void) => void>(
    (_data, callback) => callback?.(),
  );
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3;
    this.emit("close", code, reason);
  });
  terminate = vi.fn(() => this.close());

  frames(): Buffer[] {
    return this.send.mock.calls.flatMap(([data]) => (Buffer.isBuffer(data) ? [data] : []));
  }

  messages(): unknown[] {
    return this.send.mock.calls.flatMap(([data]) =>
      typeof data === "string" ? [JSON.parse(data)] : [],
    );
  }
}

export type ScreencastFrameHeader = {
  url: string;
  cssWidth: number;
  cssHeight: number;
  scrollX: number;
  scrollY: number;
  ts: number | undefined;
};

function readHeaderNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`screencast header ${key} is not a number`);
  }
  return value;
}

export function parseScreencastFrame(wire: Buffer): {
  header: ScreencastFrameHeader;
  jpeg: Buffer;
} {
  const length = wire.readUInt32BE(0);
  const record: Record<string, unknown> = JSON.parse(wire.toString("utf8", 4, 4 + length));
  const ts = record.ts;
  return {
    header: {
      url: typeof record.url === "string" ? record.url : "",
      cssWidth: readHeaderNumber(record, "cssWidth"),
      cssHeight: readHeaderNumber(record, "cssHeight"),
      scrollX: readHeaderNumber(record, "scrollX"),
      scrollY: readHeaderNumber(record, "scrollY"),
      ts: typeof ts === "number" ? ts : undefined,
    },
    jpeg: wire.subarray(4 + length),
  };
}
