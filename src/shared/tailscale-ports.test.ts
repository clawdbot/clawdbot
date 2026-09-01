// Authority formatting decides the endpoint clients dial, so the port and the
// IPv6 bracketing rules are covered directly.
import { describe, expect, it } from "vitest";
import { formatTailscaleAuthority, TAILSCALE_DEFAULT_ROUTE_PORT } from "./tailscale-ports.js";

describe("formatTailscaleAuthority", () => {
  it("leaves the default port implicit", () => {
    expect(formatTailscaleAuthority("node.tailnet.ts.net", TAILSCALE_DEFAULT_ROUTE_PORT)).toBe(
      "node.tailnet.ts.net",
    );
    expect(formatTailscaleAuthority("node.tailnet.ts.net")).toBe("node.tailnet.ts.net");
  });

  it("keeps a non-default port visible", () => {
    expect(formatTailscaleAuthority("node.tailnet.ts.net", 8443)).toBe("node.tailnet.ts.net:8443");
  });

  it("brackets an IPv6 fallback host before appending a port", () => {
    // Unbracketed, `fd7a::1:8443` parses as a longer address, not host plus port.
    expect(formatTailscaleAuthority("fd7a:115c:a1e0::3734:8d3c", 8443)).toBe(
      "[fd7a:115c:a1e0::3734:8d3c]:8443",
    );
  });

  it("brackets an IPv6 fallback host even on the default port", () => {
    expect(formatTailscaleAuthority("fd7a:115c:a1e0::3734:8d3c")).toBe(
      "[fd7a:115c:a1e0::3734:8d3c]",
    );
  });

  it("does not double-bracket an already bracketed literal", () => {
    expect(formatTailscaleAuthority("[fd7a:115c:a1e0::3734:8d3c]", 8443)).toBe(
      "[fd7a:115c:a1e0::3734:8d3c]:8443",
    );
  });

  it("leaves an IPv4 fallback host untouched", () => {
    expect(formatTailscaleAuthority("100.99.141.60", 8443)).toBe("100.99.141.60:8443");
  });
});
