// Covers TCP port parsing boundaries.
import { describe, expect, it } from "vitest";
import { parseTcpPort } from "./tcp-port.js";

describe("parseTcpPort", () => {
  it("accepts valid TCP port values", () => {
    expect(parseTcpPort(1)).toBe(1);
    expect(parseTcpPort("8080")).toBe(8080);
    expect(parseTcpPort(" 65535 ")).toBe(65_535);
  });

  it("rejects invalid TCP port values", () => {
    expect(parseTcpPort(undefined)).toBeNull();
    expect(parseTcpPort(null)).toBeNull();
    expect(parseTcpPort(0)).toBeNull();
    expect(parseTcpPort(-1)).toBeNull();
    expect(parseTcpPort(65_536)).toBeNull();
    expect(parseTcpPort("100000")).toBeNull();
    expect(parseTcpPort("8080ms")).toBeNull();
    expect(parseTcpPort("1.5")).toBeNull();
  });
});
