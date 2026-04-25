import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError, type LookupFn } from "../infra/net/ssrf.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  requiresInspectableBrowserNavigationRedirects,
} from "./navigation-guard.js";

function createLookupFn(address: string): LookupFn {
  const family = address.includes(":") ? 6 : 4;
  return vi.fn(async () => [{ address, family }]) as unknown as LookupFn;
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

describe("browser navigation guard", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks private loopback URLs by default", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://127.0.0.1:8080",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows about:blank", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "about:blank",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks file URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks data URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "data:text/html,<h1>owned</h1>",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks javascript URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "javascript:alert(1)",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks non-blank about URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "about:srcdoc",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("allows blocked hostnames when explicitly allowed", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://agent.internal:3000",
        ssrfPolicy: {
          allowedHostnames: ["agent.internal"],
        },
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("agent.internal", { all: true });
  });

  it("blocks hostnames that resolve to private addresses by default", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows hostnames that resolve to public addresses", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("blocks hostname navigation when strict SSRF policy is explicitly configured", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toThrow(/dns rebinding protections are unavailable/i);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("allows hostname navigation when the default strict policy object is present", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        ssrfPolicy: {},
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("allows explicitly allowed hostnames in strict mode", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://agent.internal",
        lookupFn,
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["agent.internal"],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("allows wildcard-allowlisted hostnames in strict mode", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://sub.example.com",
        lookupFn,
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false,
          hostnameAllowlist: ["*.example.com"],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not treat the bare suffix as matching a wildcard allowlist entry", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false,
          hostnameAllowlist: ["*.example.com"],
        },
      }),
    ).rejects.toThrow(/dns rebinding protections are unavailable/i);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("does not match sibling domains against wildcard allowlist entries", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://evil-example.com",
        lookupFn,
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false,
          hostnameAllowlist: ["*.example.com"],
        },
      }),
    ).rejects.toThrow(/dns rebinding protections are unavailable/i);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("treats bracketed IPv6 URL hostnames as IP literals in strict mode", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://[2606:4700:4700::1111]/",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).resolves.toBeUndefined();
  });

  it("allows public navigation when only Gateway env proxy is configured", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("blocks explicit browser proxy routing in strict SSRF mode", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        browserProxyMode: "explicit-browser-proxy",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("allows explicit browser proxy routing when private-network mode is enabled", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        browserProxyMode: "explicit-browser-proxy",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "not a url",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("validates final network URLs after navigation", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationResultAllowed({
        url: "http://private.test",
        lookupFn,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("ignores non-network browser-internal final URLs", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({
        url: "chrome-error://chromewebdata/",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks final hostname URLs in strict mode after navigation", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({
        url: "https://example.com/final",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks private intermediate redirect hops", async () => {
    const publicLookup = createLookupFn("93.184.216.34");
    const privateLookup = createLookupFn("127.0.0.1");
    const finalRequest = {
      url: () => "https://public.example/final",
      redirectedFrom: () => ({
        url: () => "http://private.example/internal",
        redirectedFrom: () => ({
          url: () => "https://public.example/start",
          redirectedFrom: () => null,
        }),
      }),
    };

    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        request: finalRequest,
        lookupFn: vi.fn(async (hostname: string) =>
          hostname === "private.example"
            ? privateLookup(hostname, { all: true })
            : publicLookup(hostname, { all: true }),
        ) as unknown as LookupFn,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows redirect chains when every hop is public", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    const finalRequest = {
      url: () => "https://public.example/final",
      redirectedFrom: () => ({
        url: () => "https://public.example/middle",
        redirectedFrom: () => ({
          url: () => "https://public.example/start",
          redirectedFrom: () => null,
        }),
      }),
    };

    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        request: finalRequest,
        lookupFn,
      }),
    ).resolves.toBeUndefined();
  });

  it("requires redirect-hop inspection only in explicit strict mode", () => {
    expect(requiresInspectableBrowserNavigationRedirects()).toBe(false);
    expect(
      requiresInspectableBrowserNavigationRedirects({ dangerouslyAllowPrivateNetwork: false }),
    ).toBe(true);
    expect(requiresInspectableBrowserNavigationRedirects({ allowPrivateNetwork: true })).toBe(
      false,
    );
  });
});
