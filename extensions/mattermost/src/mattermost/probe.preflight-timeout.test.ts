// Exercise the real guard: its timeout owns DNS/proxy preflight as well as fetch.
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMattermost } from "./probe.js";

describe("probeMattermost preflight timeout", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("times out when preflight lookup stalls before HTTP dispatch", async () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    const stalledLookup: LookupFn = (() => new Promise<never>(() => {})) as LookupFn;
    const fetchSpy = vi.fn(async () => new Response("should not run"));

    const started = Date.now();
    const result = await probeMattermost("https://mm.example.com", "bot-token", 80, false, {
      fetchImpl: fetchSpy,
      lookupFn: stalledLookup,
    });
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe("request timed out");
    expect(elapsedMs).toBeGreaterThanOrEqual(60);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
