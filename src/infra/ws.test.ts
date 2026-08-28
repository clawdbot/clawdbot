// Covers WebSocket raw payload sizing.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { rawDataByteLength } from "./ws.js";

describe("rawDataByteLength", () => {
  it.each([
    ["Buffer", Buffer.from("hello")],
    ["Buffer[]", [Buffer.from("he"), Buffer.from("llo")]],
    ["ArrayBuffer", Uint8Array.from([104, 101, 108, 108, 111]).buffer],
  ])("handles %s", (_name, data) => {
    expect(rawDataByteLength(data)).toBe(5);
  });
});
