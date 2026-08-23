// Covers TCP port parsing boundaries.
import { describe, expect, it } from "vitest";
import { parseTcpPort, parseTcpPortFromArgs } from "./tcp-port.js";

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

describe("parseTcpPortFromArgs", () => {
  it("uses the last valid port flag from repeated CLI arguments", () => {
    expect(parseTcpPortFromArgs(["gateway", "--port", "18789", "--port", "19001"])).toBe(19001);
    expect(parseTcpPortFromArgs(["gateway", "--port=18789", "--port=19002"])).toBe(19002);
    expect(parseTcpPortFromArgs(["gateway", "--port", "18789", "--port=19003"])).toBe(19003);
  });

  it("keeps best-effort parsing when repeated flags contain invalid values", () => {
    expect(parseTcpPortFromArgs(["gateway", "--port=invalid", "--port", "19004"])).toBe(19004);
    expect(parseTcpPortFromArgs(["gateway", "--port", "19005", "--port=invalid"])).toBe(19005);
  });

  it("does not reinterpret a consumed port value as another flag", () => {
    expect(parseTcpPortFromArgs(["gateway", "--port", "--port=19006"])).toBeNull();
  });
});
