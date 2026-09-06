import type { BrowserConfig, BrowserProfileConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  assertChromeMcpCdpTransportAllowed,
  resolveCdpReachabilityPolicy,
} from "./cdp-reachability-policy.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";

const blockedHttpEndpoint = "http://blocked.example:9222";
const blockedWsEndpoint = "ws://blocked.example:9222/devtools/browser/session";
const trustedHttpEndpoint = "http://trusted.example:9222";
const privateAccessWithBlocklist = {
  dangerouslyAllowPrivateNetwork: true,
  blockedHostnames: ["blocked.example"],
};

function assertConfiguredTransportAllowed(
  endpoint: Pick<BrowserProfileConfig, "cdpUrl" | "mcpArgs">,
  ssrfPolicy?: BrowserConfig["ssrfPolicy"],
): void {
  const config = resolveBrowserConfig({
    ssrfPolicy,
    profiles: { "chrome-mcp": { driver: "existing-session", ...endpoint } },
  });
  const profile = resolveProfile(config, "chrome-mcp");
  if (!profile) {
    throw new Error("Expected resolved Chrome MCP test profile");
  }
  assertChromeMcpCdpTransportAllowed(
    profile,
    resolveCdpReachabilityPolicy(profile, config.ssrfPolicy),
  );
}

describe("assertChromeMcpCdpTransportAllowed blocklist scoping", () => {
  it("keeps a trusted explicit CDP endpoint when the blocklist denies other hosts", () => {
    expect(() =>
      assertConfiguredTransportAllowed(
        { cdpUrl: "http://172.29.128.1:9222" },
        {
          dangerouslyAllowPrivateNetwork: true,
          blockedHostnames: ["tracker.example.com", "*.ads.example.com"],
        },
      ),
    ).not.toThrow();
  });

  it.each([["172.29.128.1"], ["*.29.128.1"]])(
    "requires pinned transport when the blocklist denies the CDP host via %s",
    (pattern) => {
      expect(() =>
        assertConfiguredTransportAllowed(
          { cdpUrl: "http://172.29.128.1:9222" },
          {
            dangerouslyAllowPrivateNetwork: true,
            blockedHostnames: [pattern],
          },
        ),
      ).toThrow(/cannot carry that pinned transport/i);
    },
  );

  describe.each([
    { name: "mcpArgs-only profile", cdpUrl: undefined },
    { name: "mcpArgs overriding a trusted cdpUrl", cdpUrl: trustedHttpEndpoint },
  ])("$name", ({ cdpUrl }) => {
    it.each(
      [
        { flag: "--browserUrl", url: blockedHttpEndpoint },
        { flag: "--browser-url", url: blockedHttpEndpoint },
        { flag: "-u", url: blockedHttpEndpoint },
        { flag: "--u", url: blockedHttpEndpoint },
        { flag: "--wsEndpoint", url: blockedWsEndpoint },
        { flag: "--ws-endpoint", url: blockedWsEndpoint },
        { flag: "-w", url: blockedWsEndpoint },
        { flag: "--w", url: blockedWsEndpoint },
      ].flatMap(({ flag, url }) => [
        { name: `${flag} split`, mcpArgs: [flag, url] },
        { name: `${flag} equals`, mcpArgs: [`${flag}=${url}`] },
      ]),
    )("rejects the blocklisted endpoint from $name", ({ mcpArgs }) => {
      expect(() =>
        assertConfiguredTransportAllowed({ cdpUrl, mcpArgs }, privateAccessWithBlocklist),
      ).toThrow(/cannot carry that pinned transport/i);
    });
  });

  it.each([
    { name: "grouped HTTP alias", mcpArgs: ["-xu", blockedHttpEndpoint] },
    { name: "grouped WebSocket alias", mcpArgs: ["-xw", blockedWsEndpoint] },
    { name: "grouped inline alias", mcpArgs: [`-xu=${blockedHttpEndpoint}`] },
    { name: "repeated dash expansion", mcpArgs: ["--browser--url", blockedHttpEndpoint] },
    { name: "mixed-case dash expansion", mcpArgs: ["--browser-Url", blockedHttpEndpoint] },
    { name: "profile-normalized whitespace", mcpArgs: [" --browserUrl ", blockedHttpEndpoint] },
  ])("does not let upstream $name escape endpoint policy", ({ mcpArgs }) => {
    expect(() => assertConfiguredTransportAllowed({ mcpArgs }, privateAccessWithBlocklist)).toThrow(
      /cannot carry that pinned transport|Chrome MCP.*(?:endpoint|argument)/i,
    );
  });

  it.each([
    {
      name: "auto-connect before HTTP endpoint",
      mcpArgs: ["--autoConnect", "--browserUrl", blockedHttpEndpoint],
    },
    {
      name: "auto-connect after WebSocket endpoint",
      mcpArgs: [`--wsEndpoint=${blockedWsEndpoint}`, "--auto-connect"],
    },
  ])("does not let $name hide a denial", ({ mcpArgs }) => {
    expect(() => assertConfiguredTransportAllowed({ mcpArgs }, privateAccessWithBlocklist)).toThrow(
      /cannot carry that pinned transport/i,
    );
  });

  it.each([
    { name: "HTTP", mcpArgs: ["--browserUrl", trustedHttpEndpoint] },
    {
      name: "WebSocket",
      mcpArgs: ["--ws-endpoint=ws://trusted.example:9222/devtools/browser/session"],
    },
  ])("allows a trusted $name mcpArgs endpoint to override a denied cdpUrl", ({ mcpArgs }) => {
    expect(() =>
      assertConfiguredTransportAllowed(
        { cdpUrl: blockedHttpEndpoint, mcpArgs },
        privateAccessWithBlocklist,
      ),
    ).not.toThrow();
  });

  it.each([
    { name: "default arguments", mcpArgs: undefined },
    { name: "camel-case auto-connect", mcpArgs: ["--autoConnect"] },
    { name: "kebab-case auto-connect", mcpArgs: ["--auto-connect"] },
  ])("preserves host-local attachment with $name", ({ mcpArgs }) => {
    expect(() =>
      assertConfiguredTransportAllowed(
        { mcpArgs },
        { dangerouslyAllowPrivateNetwork: false, blockedHostnames: ["blocked.example"] },
      ),
    ).not.toThrow();
  });

  it.each([
    { name: "default policy", ssrfPolicy: undefined },
    { name: "explicit strict policy", ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
  ])("keeps explicit endpoints guarded under $name", ({ ssrfPolicy }) => {
    expect(() =>
      assertConfiguredTransportAllowed(
        { mcpArgs: ["--browserUrl", trustedHttpEndpoint] },
        ssrfPolicy,
      ),
    ).toThrow(/cannot carry that pinned transport/i);
  });
});
