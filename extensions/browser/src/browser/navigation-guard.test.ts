// Browser tests cover navigation guard plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError, type LookupFn } from "../infra/net/ssrf.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  redactBrowserNavigationUrl,
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

  it("allows explicitly trusted hostnames that resolve to private addresses", async () => {
    const lookupFn = createLookupFn("10.0.0.1");
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
          allowedHostnames: ["*.example.com"],
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
          allowedHostnames: ["*.example.com"],
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
          allowedHostnames: ["*.example.com"],
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

  it("blocks network URLs with embedded credentials before lookup", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    const result = assertBrowserNavigationAllowed({
      url: "https://user:secret@example.com/private",
      lookupFn,
    });
    await expect(result).rejects.toThrow("URL-embedded credentials are not supported");
    await expect(result).rejects.toThrow("openclaw browser set credentials");
    await expect(result).rejects.not.toThrow("secret");
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("allows OAuth authorization codes while redacting them from output", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://auth.example/callback?code=raw-oauth-code-123456",
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("auth.example", { all: true });
    const redacted = redactBrowserNavigationUrl(
      "https://auth.example/callback?code=raw-oauth-code-123456",
    );
    expect(redacted).toBe("https://auth.example/callback?code=REDACTED");
    expect(redacted).not.toContain("raw-oauth-code-123456");
  });

  it("allows ordinary code query parameters", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://shop.example/redeem?code=SUMMER",
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("shop.example", { all: true });
  });

  it("preserves opaque hash routes while redacting hash-route OAuth codes", () => {
    expect(redactBrowserNavigationUrl("https://app.example/#section")).toBe(
      "https://app.example/#section",
    );
    expect(redactBrowserNavigationUrl("https://app.example/#/dashboard")).toBe(
      "https://app.example/#/dashboard",
    );
    expect(
      redactBrowserNavigationUrl("https://app.example/#/callback?code=raw-oauth-code-123456"),
    ).toBe("https://app.example/#/callback?code=REDACTED");
    expect(
      redactBrowserNavigationUrl(
        "https://app.example/#access_token=raw-fragment-token-123456&id_token=raw-id-token",
      ),
    ).toBe("https://app.example/#access_token=REDACTED&id_token=REDACTED");
  });

  it("redacts signed URLs and opaque bearer paths from output", () => {
    const signedUrl = redactBrowserNavigationUrl(
      "https://storage.example/blob.txt?sv=2024-01-01&sig=raw-signature-123456",
    );
    expect(signedUrl).toBe("https://storage.example/blob.txt?sv=REDACTED&sig=REDACTED");
    expect(signedUrl).not.toContain("raw-signature-123456");

    const opaquePath = redactBrowserNavigationUrl(
      "https://accounts.example/password-reset/raw-reset-token-123456/confirm",
    );
    expect(opaquePath).toBe("https://accounts.example/password-reset/REDACTED/confirm");
    expect(opaquePath).not.toContain("raw-reset-token-123456");

    const opaqueHashRoute = redactBrowserNavigationUrl(
      "https://app.example/#/magic-login/raw-magic-token-123456",
    );
    expect(opaqueHashRoute).toBe("https://app.example/#/magic-login/REDACTED");
    expect(opaqueHashRoute).not.toContain("raw-magic-token-123456");
  });

  it("redacts every opaque bearer path in a URL", () => {
    const redacted = redactBrowserNavigationUrl(
      "https://accounts.example/password-reset/raw-reset-token-123456/invite/raw-invite-token-654321/confirm",
    );
    expect(redacted).toBe(
      "https://accounts.example/password-reset/REDACTED/invite/REDACTED/confirm",
    );
    expect(redacted).not.toContain("raw-reset-token-123456");
    expect(redacted).not.toContain("raw-invite-token-654321");
  });

  it.each([
    ["token", "raw-token-123456"],
    ["password", "raw-password-123456"],
    ["api_key", "raw-api-key-123456"],
    ["authorization", "raw-authorization-123456"],
    ["cookie", "raw-cookie-123456"],
  ])("redacts generic credential query key %s", (key, rawValue) => {
    const redacted = redactBrowserNavigationUrl(
      `https://example.test/callback?${key}=${rawValue}&next=keep`,
    );
    expect(redacted).toBe(`https://example.test/callback?${key}=REDACTED&next=keep`);
    expect(redacted).not.toContain(rawValue);
  });

  it.each(["token", "password", "api_key", "authorization", "cookie"])(
    "blocks generic credential query key %s before lookup",
    async (key) => {
      const lookupFn = createLookupFn("93.184.216.34");
      const rawValue = `raw-${key}-123456`;
      const result = assertBrowserNavigationAllowed({
        url: `https://example.test/redeem?${key}=${rawValue}`,
        lookupFn,
      });
      await expect(result).rejects.toThrow("URL-embedded credentials are not supported");
      await expect(result).rejects.not.toThrow(rawValue);
      expect(lookupFn).not.toHaveBeenCalled();
    },
  );

  it.each(["page_token", "continuation_token", "wallet"])(
    "allows ordinary non-credential query key %s",
    async (key) => {
      const lookupFn = createLookupFn("93.184.216.34");
      await expect(
        assertBrowserNavigationAllowed({
          url: `https://example.test/redeem?${key}=public-value`,
          lookupFn,
        }),
      ).resolves.toBeUndefined();
      expect(lookupFn).toHaveBeenCalledWith("example.test", { all: true });
      expect(redactBrowserNavigationUrl(`https://example.test/redeem?${key}=public-value`)).toBe(
        `https://example.test/redeem?${key}=public-value`,
      );
    },
  );

  it("blocks OAuth bearer tokens in URL fragments before lookup", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    const result = assertBrowserNavigationAllowed({
      url: "https://app.example/callback#access_token=raw-fragment-token-123456&id_token=raw-id-token",
      lookupFn,
    });
    await expect(result).rejects.toThrow("URL-embedded credentials are not supported");
    await expect(result).rejects.not.toThrow("raw-fragment-token-123456");
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("redacts malformed credential-bearing URLs from diagnostics", async () => {
    const result = assertBrowserNavigationAllowed({
      url: "https://user:secret@",
    });
    await expect(result).rejects.toThrow("Invalid URL: [redacted credential-bearing URL]");
    await expect(result).rejects.not.toThrow("secret");
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
});
