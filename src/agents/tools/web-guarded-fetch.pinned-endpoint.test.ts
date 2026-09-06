// Pinned trusted-host endpoint tests run the real SSRF guard: trusted mode keeps
// refusing private hosts; exact-host trust honors the configured host as typed,
// including loopback, refuses cloud-metadata destinations in direct and env-proxy
// mode, and still rejects loopback, unspecified, link-local and metadata DNS
// answers for a configured name.
import { isIP } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../../infra/net/ssrf.js";
import {
  withPinnedTrustedHostWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "./web-guarded-fetch.js";

type LookupFn = NonNullable<Parameters<typeof withTrustedWebToolsEndpoint>[0]["lookupFn"]>;

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const CONFIGURED_HOST = "tavily.gateway.internal";
const PRIVATE_HOSTS = [
  "proxy.example.internal",
  "tavily.corp.local",
  "tavily.localhost",
  "10.0.0.5",
  "[fd00::1]",
] as const;
// The trusted fake-IP policy exempts fd00::/7 on purpose (see
// `allowIpv6UniqueLocalRange`), so loopback stands in for the IPv6 literal here.
const TRUSTED_BLOCKED_HOSTS = [
  "proxy.example.internal",
  "tavily.corp.local",
  "tavily.localhost",
  "10.0.0.5",
  "[::1]",
] as const;
const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost", "tavily.localhost"] as const;
// Metadata destinations in every encoding the guard classifies, plus the
// hostname the guard already blocks; none may gain exact-host trust.
const METADATA_HOSTS = [
  "169.254.169.254",
  "[::ffff:169.254.169.254]",
  "[fd00:ec2::254]",
  "100.100.100.200",
  "metadata.google.internal",
] as const;
const METADATA_ADDRESSES = ["169.254.169.254", "fd00:ec2::254", "100.100.100.200"] as const;

/** Resolves names to an RFC 1918 address and passes IP literals through, like a private DNS zone. */
function createPrivateLookup(): LookupFn {
  return vi.fn(async (hostname: string) => {
    const family = isIP(hostname);
    return family ? [{ address: hostname, family }] : [{ address: "10.0.0.5", family: 4 }];
  }) as unknown as LookupFn;
}

/** Resolves names to loopback and passes IP literals through, like a hosts-file entry. */
function createLoopbackLookup(): LookupFn {
  return vi.fn(async (hostname: string) => {
    const family = isIP(hostname);
    return family ? [{ address: hostname, family }] : [{ address: "127.0.0.1", family: 4 }];
  }) as unknown as LookupFn;
}

function createPublicLookup(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

function createFixedLookup(address: string): LookupFn {
  return vi.fn(async () => [{ address, family: isIP(address) }]) as unknown as LookupFn;
}

function okResponse(): Response {
  return new Response("ok", { status: 200 });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe("pinned trusted-host web tools endpoint", () => {
  beforeEach(() => {
    // Env proxy routing would skip local DNS pinning; keep both modes on the pinned path.
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("trusted mode reaches the hosted API host", async () => {
    const fetchImpl = vi.fn(async () => okResponse());

    const finalUrl = await withTrustedWebToolsEndpoint(
      { url: "https://api.tavily.com/search", fetchImpl, lookupFn: createPublicLookup() },
      async (result) => result.finalUrl,
    );

    expect(finalUrl).toBe("https://api.tavily.com/search");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(TRUSTED_BLOCKED_HOSTS)("trusted mode refuses %s before any request", async (host) => {
    const fetchImpl = vi.fn(async () => okResponse());

    await expect(
      withTrustedWebToolsEndpoint(
        { url: `https://${host}/search`, fetchImpl, lookupFn: createPrivateLookup() },
        async () => "reached",
      ),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([...PRIVATE_HOSTS, CONFIGURED_HOST])(
    "pinned trusted-host mode reaches the configured host %s",
    async (host) => {
      const fetchImpl = vi.fn(async () => okResponse());

      const finalUrl = await withPinnedTrustedHostWebToolsEndpoint(
        { url: `https://${host}/search`, fetchImpl, lookupFn: createPrivateLookup() },
        async (result) => result.finalUrl,
      );

      expect(finalUrl).toBe(`https://${host}/search`);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each(LOOPBACK_HOSTS)(
    "pinned trusted-host mode honors the operator-configured loopback endpoint %s",
    async (host) => {
      const fetchImpl = vi.fn(async () => okResponse());

      const finalUrl = await withPinnedTrustedHostWebToolsEndpoint(
        { url: `http://${host}:8080/search`, fetchImpl, lookupFn: createLoopbackLookup() },
        async (result) => result.finalUrl,
      );

      expect(finalUrl).toBe(`http://${host}:8080/search`);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each(METADATA_HOSTS)(
    "pinned trusted-host mode refuses the metadata destination %s before any lookup or request",
    async (host) => {
      const fetchImpl = vi.fn(async () => okResponse());
      const lookupFn = createPrivateLookup();

      await expect(
        withPinnedTrustedHostWebToolsEndpoint(
          { url: `http://${host}/search`, fetchImpl, lookupFn },
          async () => "reached",
        ),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      expect(lookupFn).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(METADATA_HOSTS)(
    "pinned trusted-host mode refuses the metadata destination %s under an env proxy",
    async (host) => {
      // The env proxy would resolve the name and perform no address check, so the
      // refusal has to happen before any dispatch.
      vi.stubEnv("http_proxy", "http://127.0.0.1:7890");
      vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
      vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
      vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
      const fetchImpl = vi.fn(async () => okResponse());
      const lookupFn = createPrivateLookup();

      await expect(
        withPinnedTrustedHostWebToolsEndpoint(
          { url: `http://${host}/search`, fetchImpl, lookupFn },
          async () => "reached",
        ),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      expect(lookupFn).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([...PRIVATE_HOSTS, "api.tavily.com"])(
    "pinned trusted-host mode refuses a redirect from the configured host to %s",
    async (host) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirectResponse(`https://${host}/search`))
        .mockResolvedValue(okResponse());

      await expect(
        withPinnedTrustedHostWebToolsEndpoint(
          { url: `https://${CONFIGURED_HOST}/search`, fetchImpl, lookupFn: createPrivateLookup() },
          async () => "reached",
        ),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("pinned trusted-host mode follows a redirect that stays on the configured host", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`https://${CONFIGURED_HOST}/v1/search`))
      .mockResolvedValue(okResponse());

    const finalUrl = await withPinnedTrustedHostWebToolsEndpoint(
      { url: `https://${CONFIGURED_HOST}/search`, fetchImpl, lookupFn: createPrivateLookup() },
      async (result) => result.finalUrl,
    );

    expect(finalUrl).toBe(`https://${CONFIGURED_HOST}/v1/search`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("trusted mode still refuses the hosted API host when DNS answers loopback", async () => {
    const fetchImpl = vi.fn(async () => okResponse());

    await expect(
      withTrustedWebToolsEndpoint(
        {
          url: "https://api.tavily.com/search",
          fetchImpl,
          lookupFn: createFixedLookup("127.0.0.1"),
        },
        async () => "reached",
      ),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "::1", "0.0.0.0", ...METADATA_ADDRESSES])(
    "pinned trusted-host mode refuses the configured name before any request when it resolves to %s",
    async (address) => {
      const fetchImpl = vi.fn(async () => okResponse());
      const lookupFn = createFixedLookup(address);

      await expect(
        withPinnedTrustedHostWebToolsEndpoint(
          { url: `https://${CONFIGURED_HOST}/search`, fetchImpl, lookupFn },
          async () => "reached",
        ),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      expect(lookupFn).toHaveBeenCalledTimes(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(["10.0.0.5", "192.168.1.20", "fd00::1"])(
    "pinned trusted-host mode reaches the configured name when it resolves to %s",
    async (address) => {
      const fetchImpl = vi.fn(async () => okResponse());

      const finalUrl = await withPinnedTrustedHostWebToolsEndpoint(
        {
          url: `https://${CONFIGURED_HOST}/search`,
          fetchImpl,
          lookupFn: createFixedLookup(address),
        },
        async (result) => result.finalUrl,
      );

      expect(finalUrl).toBe(`https://${CONFIGURED_HOST}/search`);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("pinned trusted-host mode reaches the configured name under an env proxy without local DNS", async () => {
    // With an env proxy the proxy resolves the name, as for every trusted call.
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createFixedLookup("10.0.0.5");
    const fetchImpl = vi.fn(async () => okResponse());

    const finalUrl = await withPinnedTrustedHostWebToolsEndpoint(
      { url: `https://${CONFIGURED_HOST}/search`, fetchImpl, lookupFn },
      async (result) => result.finalUrl,
    );

    expect(finalUrl).toBe(`https://${CONFIGURED_HOST}/search`);
    expect(lookupFn).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pinned trusted-host mode keeps the hostname rule under an env proxy", async () => {
    // With an env proxy the proxy resolves DNS, so the hostname allowlist is the
    // check that still applies to every hop.
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createFixedLookup("10.0.0.5");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://proxy.example.internal/search"))
      .mockResolvedValue(okResponse());

    await expect(
      withPinnedTrustedHostWebToolsEndpoint(
        { url: `https://${CONFIGURED_HOST}/search`, fetchImpl, lookupFn },
        async () => "reached",
      ),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(lookupFn).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pinned trusted-host mode still enforces the request timeout", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const reason: unknown = init.signal?.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    await expect(
      withPinnedTrustedHostWebToolsEndpoint(
        {
          url: `https://${CONFIGURED_HOST}/search`,
          timeoutMs: 20,
          fetchImpl,
          lookupFn: createPrivateLookup(),
        },
        async () => "reached",
      ),
    ).rejects.toThrow("request timed out");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
