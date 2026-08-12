import { describe, expect, it } from "vitest";
import { classifyRfbSecurity, parseRfbSecurityTypes, parseRfbVersionBanner } from "./rfb-probe.js";

describe("RFB handshake parsing", () => {
  it.each([
    ["macOS", "RFB 003.889\n", Buffer.from([1, 30]), [30]],
    ["TigerVNC", "RFB 003.008\n", Buffer.from([1, 2]), [2]],
    ["wayvnc", "RFB 003.008\n", Buffer.from([1, 1]), [1]],
    ["VeNCrypt", "RFB 003.008\n", Buffer.from([1, 19]), [19]],
  ])("parses %s version and security vectors", (_name, banner, security, expected) => {
    const version = parseRfbVersionBanner(Buffer.from(banner, "ascii"));
    expect(version.kind).toBe("rfb");
    if (version.kind !== "rfb") {
      return;
    }
    expect(version.reply.toString("ascii")).toBe("RFB 003.008\n");
    expect(parseRfbSecurityTypes(security, version.minor)).toEqual({
      kind: "complete",
      securityTypes: expected,
      bytesConsumed: 2,
    });
  });

  it("rejects non-RFB and truncated banners without reading past the buffer", () => {
    expect(parseRfbVersionBanner(Buffer.from("HTTP/1.1 200", "ascii"))).toEqual({
      kind: "not-rfb",
      banner: "HTTP/1.1 200",
    });
    expect(parseRfbVersionBanner(Buffer.from("RFB 003", "ascii"))).toEqual({
      kind: "not-rfb",
      banner: "RFB 003",
    });
  });

  it("classifies supported security with password auth preferred over ARD", () => {
    expect(classifyRfbSecurity([1])).toBe("none");
    expect(classifyRfbSecurity([30])).toBe("ard-account");
    expect(classifyRfbSecurity([19])).toBe("unsupported");
    expect(classifyRfbSecurity([30, 2])).toBe("vnc-password");
  });
});
