import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaModels } from "./provider-models.js";

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

describe("Ollama hosted catalog redirect proxy policy", () => {
  it("returns cross-origin HTTPS redirects to strict DNS-pinned routing", async () => {
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
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://ollama.com:8443/api/tags" },
          })
        : Response.json({ models: [] });
    });
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]) as unknown as LookupFn;

    await expect(
      fetchOllamaModels("https://ollama.com", undefined, { fetchImpl, lookupFn }),
    ).resolves.toEqual({ reachable: true, models: [] });

    expect(calls).toEqual([
      { dispatcher: "EnvHttpProxyAgent", url: "https://ollama.com/api/tags" },
      { dispatcher: "Agent", url: "https://ollama.com:8443/api/tags" },
    ]);
    expect(lookupFn).toHaveBeenCalledOnce();
    expect(lookupFn).toHaveBeenCalledWith("ollama.com", { all: true });
  });
});
