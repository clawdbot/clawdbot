// Exercise the real guard: its timeout owns DNS/proxy preflight as well as fetch.
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaModels } from "./provider-models.js";

const TAGS_TIMEOUT_MS = 5000;

describe("fetchOllamaModels preflight timeout", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("aborts at the configured deadline when preflight lookup stalls", async () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    let lookupCalls = 0;
    const stalledLookup: LookupFn = (() => {
      lookupCalls += 1;
      return new Promise<never>(() => {});
    }) as LookupFn;
    const fetchSpy = vi.fn(async () => new Response("should not run"));

    const started = Date.now();
    const result = await fetchOllamaModels("https://ollama.example.com", undefined, {
      fetchImpl: fetchSpy,
      lookupFn: stalledLookup,
    });
    const elapsedMs = Date.now() - started;

    expect(result).toEqual({ reachable: false, models: [] });
    // Preflight ran and never handed off to the socket.
    expect(lookupCalls).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Bounded by the guard-owned deadline, not left to hang.
    expect(elapsedMs).toBeGreaterThanOrEqual(TAGS_TIMEOUT_MS - 500);
    expect(elapsedMs).toBeLessThan(TAGS_TIMEOUT_MS * 3);
  });

  it("still dispatches the fetch when preflight lookup resolves", async () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    let lookupCalls = 0;
    const resolvingLookup: LookupFn = (async () => {
      lookupCalls += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    }) as unknown as LookupFn;
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ models: [{ name: "qwen3:32b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await fetchOllamaModels("https://ollama.example.com", undefined, {
      fetchImpl: fetchSpy,
      lookupFn: resolvingLookup,
    });

    expect(lookupCalls).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reachable: true, models: [{ name: "qwen3:32b" }] });
  });
});
