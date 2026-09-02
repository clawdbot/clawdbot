import { describe, expect, it } from "vitest";
import { assertChromeMcpCdpTransportAllowed } from "./cdp-reachability-policy.js";
import type { ResolvedBrowserProfile } from "./config.js";

function createExplicitCdpProfile(): ResolvedBrowserProfile {
  return {
    name: "chrome-mcp",
    cdpPort: 9222,
    cdpUrl: "http://172.29.128.1:9222",
    cdpHost: "172.29.128.1",
    cdpIsLoopback: false,
    color: "#123456",
    driver: "existing-session",
    attachOnly: false,
    headless: false,
  };
}

describe("assertChromeMcpCdpTransportAllowed blocklist scoping", () => {
  it("keeps a trusted explicit CDP endpoint when the blocklist denies other hosts", () => {
    expect(() =>
      assertChromeMcpCdpTransportAllowed(createExplicitCdpProfile(), {
        dangerouslyAllowPrivateNetwork: true,
        blockedHostnames: ["tracker.example.com", "*.ads.example.com"],
      }),
    ).not.toThrow();
  });

  it.each([["172.29.128.1"], ["*.29.128.1"]])(
    "requires pinned transport when the blocklist denies the CDP host via %s",
    (pattern) => {
      expect(() =>
        assertChromeMcpCdpTransportAllowed(createExplicitCdpProfile(), {
          dangerouslyAllowPrivateNetwork: true,
          blockedHostnames: [pattern],
        }),
      ).toThrow(/cannot carry that pinned transport/i);
    },
  );
});
