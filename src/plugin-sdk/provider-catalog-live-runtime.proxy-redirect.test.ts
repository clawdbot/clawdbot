import { afterEach, describe, expect, it, vi } from "vitest";
import { withTrustedEnvProxyGuardedFetchMode } from "./fetch-runtime.js";
import { fetchLiveProviderModelRows } from "./provider-catalog-live-runtime.js";
import {
  fetchWithSsrFGuard,
  type LookupFn,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "./ssrf-runtime.js";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
const originalProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    const value = originalProxyEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("live provider catalog redirect proxy policy", () => {
  it("keeps redirected-origin pagination on strict DNS-pinned routing", async () => {
    for (const key of PROXY_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.HTTPS_PROXY = "http://proxy.example:8080";

    const calls: Array<{ dispatcher?: string; url: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const dispatcher = (
        init as RequestInit & { dispatcher?: { constructor?: { name?: string } } }
      )?.dispatcher;
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ dispatcher: dispatcher?.constructor?.name, url });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://redirected.example/models" },
        });
      }
      return calls.length === 2
        ? Response.json({ data: [], next: "?page=2" })
        : Response.json({ data: [] });
    });
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]) as unknown as LookupFn;

    await fetchLiveProviderModelRows({
      providerId: "provider",
      endpoint: "https://canonical.vendor.example/models",
      fetchGuard: (params) =>
        fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({ ...params, fetchImpl, lookupFn })),
      // SSRF trust may legitimately contain more than one origin. Catalog
      // transport provenance is narrower: only the original endpoint may use
      // the environment proxy, even when a redirect target is SSRF-allowed.
      policy: {
        ...ssrfPolicyFromHttpBaseUrlAllowedHostname("https://canonical.vendor.example"),
        allowedOrigins: ["https://canonical.vendor.example", "https://redirected.example"],
      },
      requireHttps: true,
    });

    expect(calls).toEqual([
      {
        dispatcher: "EnvHttpProxyAgent",
        url: "https://canonical.vendor.example/models",
      },
      { dispatcher: "Agent", url: "https://redirected.example/models" },
      { dispatcher: "Agent", url: "https://redirected.example/models?page=2" },
    ]);
    expect(lookupFn).toHaveBeenCalledTimes(2);
    expect(lookupFn).toHaveBeenCalledWith("redirected.example", { all: true });
  });

  it("preserves caller-supplied strict SSRF policy precedence", async () => {
    for (const key of PROXY_ENV_KEYS) {
      delete process.env[key];
    }

    const fetchImpl = vi.fn(async () => Response.json({ data: [] }));
    const lookupFn = vi.fn(async () => [
      { address: "10.0.0.5", family: 4 as const },
    ]) as unknown as LookupFn;

    await expect(
      fetchLiveProviderModelRows({
        providerId: "strict-provider",
        endpoint: "https://catalog.example/models",
        policy: { hostnameAllowlist: ["catalog.example"] },
        fetchGuard: (params) => fetchWithSsrFGuard({ ...params, fetchImpl, lookupFn }),
      }),
    ).rejects.toThrow("Blocked: resolves to private/internal/special-use IP address");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves strict private-host trust across redirects to another port", async () => {
    for (const key of PROXY_ENV_KEYS) {
      delete process.env[key];
    }

    const calls: Array<{ dispatcher?: string; url: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const dispatcher = (
        init as RequestInit & { dispatcher?: { constructor?: { name?: string } } }
      )?.dispatcher;
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ dispatcher: dispatcher?.constructor?.name, url });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://10.0.0.5:4443/v1/models" },
          })
        : Response.json({ data: [] });
    });
    const lookupFn = vi.fn(async () => [
      { address: "10.0.0.5", family: 4 as const },
    ]) as unknown as LookupFn;

    await fetchLiveProviderModelRows({
      providerId: "custom",
      endpoint: "http://10.0.0.5:4000/v1/models",
      fetchGuard: (params) => fetchWithSsrFGuard({ ...params, fetchImpl, lookupFn }),
    });

    expect(calls).toEqual([
      { dispatcher: "Agent", url: "http://10.0.0.5:4000/v1/models" },
      { dispatcher: "Agent", url: "https://10.0.0.5:4443/v1/models" },
    ]);
    expect(lookupFn).toHaveBeenCalledTimes(2);
  });
});
