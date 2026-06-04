// Covers WebSocket raw payload decoding.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { rawDataToString } from "./ws.js";

describe("rawDataToString", () => {
  it("returns string input unchanged", () => {
    expect(rawDataToString("hello" as unknown as Parameters<typeof rawDataToString>[0])).toBe(
      "hello",
    );
  });

  it("decodes Buffer, Buffer[] and ArrayBuffer inputs", () => {
    expect(rawDataToString(Buffer.from("hello"))).toBe("hello");
    expect(rawDataToString([Buffer.from("he"), Buffer.from("llo")])).toBe("hello");
    expect(rawDataToString(Uint8Array.from([104, 101, 108, 108, 111]).buffer)).toBe("hello");
  });

  it("falls back to string coercion for other raw data shapes", () => {
    expect(rawDataToString(Uint8Array.from([1, 2, 3]) as never)).toBe("1,2,3");
  });
});
