import type { LookupAddress } from "node:dns";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as undici from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const lookup = vi.hoisted(() => vi.fn<() => Promise<LookupAddress[]>>());
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

const publicAddress = [{ address: "93.184.216.34", family: 4 }];
const privateAddress = [{ address: "10.20.30.40", family: 4 }];
const payload = { web: { results: [] }, grounding: { generic: [] }, sources: [] };
const fetchNetwork = vi.fn<typeof fetch>();
let queryId = 0;

function createTool(mode: "web" | "llm-context", baseUrl: string) {
  const tool = createBraveWebSearchProvider().createTool({
    config: {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "brave-preflight-test-key",
                mode,
                baseUrl,
              },
            },
          },
        },
      },
    },
    searchConfig: { timeoutSeconds: 1 },
  });
  if (!tool) {
    throw new Error("Expected Brave tool");
  }
  return tool;
}

function observe<T>(promise: Promise<T>) {
  let outcome: { value: T } | { error: unknown } | undefined;
  const settled = promise.then(
    (value) => {
      outcome = { value };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  return { settled, outcome: () => outcome };
}

beforeEach(() => {
  lookup.mockReset().mockResolvedValue(publicAddress);
  fetchNetwork.mockReset().mockImplementation(async (_input, init) => {
    init?.signal?.throwIfAborted();
    return Response.json(payload);
  });
  // A plain fetch adapter keeps the guard's real DNS/pinning path active. Only
  // the final network call is replaced; real dispatchers are created and released.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fetchNetwork(input, init),
  );
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: fetchNetwork });
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("node:dns/promises");
  vi.resetModules();
});

describe.each(["web", "llm-context"] as const)("Brave %s preflight lifetime", (mode) => {
  it.each(["http", "https"] as const)(
    "rejects cancellation during the %s DNS-to-validator handoff before a cache hit",
    async (protocol) => {
      lookup.mockResolvedValue(privateAddress);
      const tool = createTool(mode, `${protocol}://search.example.test`);
      const args = { query: `handoff-${++queryId}` };
      await tool.execute(args);
      fetchNetwork.mockClear();
      const dns = createDeferred<LookupAddress[]>();
      const entered = createDeferred<void>();
      const caller = new AbortController();
      const reason = new Error("canceled after DNS settled");
      lookup.mockImplementationOnce(() => {
        entered.resolve();
        return dns.promise;
      });
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
        // Cancel on DNS settlement, before the request's async continuation can publish a result.
        void dns.promise.then(() => caller.abort(reason));
        dns.resolve(privateAddress);
        await operation.settled;
        expect(operation.outcome()).toEqual({ error: reason });
        expect(fetchNetwork).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        caller.abort(reason);
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each(["http", "https"] as const)(
    "preserves %s DNS failure behavior and releases its deadline",
    async (protocol) => {
      const reason = new Error("synthetic DNS failure");
      lookup.mockRejectedValueOnce(reason);
      const result = createTool(mode, `${protocol}://search.example.test`).execute({
        query: `dns-failure-${++queryId}`,
      });
      if (protocol === "http") {
        await expect(result).rejects.toBe(reason);
        expect(fetchNetwork).not.toHaveBeenCalled();
      } else {
        // HTTPS classification failures still fall back to strict, revalidated transport.
        await expect(result).resolves.toMatchObject({ provider: "brave" });
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(fetchNetwork).toHaveBeenCalledOnce();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(
    (["http", "https"] as const).flatMap((protocol) =>
      (["cancel", "deadline"] as const).flatMap((stop) =>
        [false, true].map((warmCache) => ({ protocol, stop, warmCache })),
      ),
    ),
  )(
    "rejects $stop during held $protocol DNS (warm cache: $warmCache)",
    async ({ protocol, stop, warmCache }) => {
      lookup.mockResolvedValue(privateAddress);
      const tool = createTool(mode, `${protocol}://search.example.test`);
      const args = { query: `preflight-${++queryId}` };
      if (warmCache) {
        await expect(tool.execute(args)).resolves.toMatchObject({ provider: "brave" });
        await expect(tool.execute(args)).resolves.toMatchObject({ cached: true });
        expect(fetchNetwork).toHaveBeenCalledOnce();
        fetchNetwork.mockClear();
      }
      const entered = createDeferred<void>();
      const dns = createDeferred<LookupAddress[]>();
      lookup.mockImplementationOnce(() => {
        entered.resolve();
        return dns.promise;
      });
      const caller = new AbortController();
      const reason = new Error("caller stopped during DNS");
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
        if (stop === "cancel") {
          caller.abort(reason);
        }
        await vi.advanceTimersByTimeAsync(stop === "deadline" ? 1_000 : 0);
        expect(operation.outcome()).toEqual({
          error: stop === "cancel" ? reason : expect.objectContaining({ name: "TimeoutError" }),
        });
        expect(fetchNetwork).not.toHaveBeenCalled();
        dns.resolve(privateAddress);
        await operation.settled;
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchNetwork).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await expect(tool.execute(args)).resolves.toMatchObject(
          warmCache ? { cached: true } : { provider: "brave" },
        );
        expect(fetchNetwork).toHaveBeenCalledTimes(warmCache ? 0 : 1);
      } finally {
        caller.abort(reason);
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each(
    (["http", "https"] as const).flatMap((protocol) =>
      (["fetch", "body"] as const).map((phase) => ({ protocol, phase })),
    ),
  )(
    "keeps the original budget through $protocol $phase consumption",
    async ({ protocol, phase }) => {
      lookup.mockResolvedValue(privateAddress);
      const dns = createDeferred<LookupAddress[]>();
      const entered = createDeferred<void>();
      const dispatched = createDeferred<void>();
      lookup.mockImplementationOnce(() => {
        entered.resolve();
        return dns.promise;
      });
      fetchNetwork.mockImplementationOnce(async (_input, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("missing request signal");
        }
        signal.throwIfAborted();
        if (phase === "fetch") {
          return await new Promise<Response>((_resolve, reject) => {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Fetch preserves AbortSignal reasons, including non-Error values.
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            dispatched.resolve();
          });
        }
        return new Response(
          new ReadableStream({
            start(stream) {
              signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
              dispatched.resolve();
            },
          }),
        );
      });
      const caller = new AbortController();
      const tool = createTool(mode, `${protocol}://search.example.test`);
      const args = { query: `budget-${++queryId}` };
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(600);
        dns.resolve(privateAddress);
        await dispatched.promise;
        await vi.advanceTimersByTimeAsync(399);
        expect(operation.outcome()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(operation.outcome()).toEqual({
          error: expect.objectContaining({ name: "TimeoutError" }),
        });
        await operation.settled;
        expect(vi.getTimerCount()).toBe(0);
        await tool.execute(args);
        expect(fetchNetwork).toHaveBeenCalledTimes(2);
      } finally {
        caller.abort();
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each([
    {
      name: "private HTTP",
      baseUrl: "http://search.example.test",
      first: privateAddress,
      next: privateAddress,
      allowed: true,
    },
    {
      name: "private HTTPS",
      baseUrl: "https://search.example.test",
      first: privateAddress,
      next: privateAddress,
      allowed: true,
    },
    {
      name: "public HTTP",
      baseUrl: "http://search.example.test",
      first: publicAddress,
      next: publicAddress,
      allowed: false,
    },
    {
      name: "public HTTPS",
      baseUrl: "https://search.example.test",
      first: publicAddress,
      next: publicAddress,
      allowed: true,
    },
    {
      name: "rebound public HTTPS",
      baseUrl: "https://search.example.test",
      first: publicAddress,
      next: privateAddress,
      allowed: false,
    },
    {
      name: "public HTTPS fake IPv4",
      baseUrl: "https://search.example.test",
      first: publicAddress,
      next: [{ address: "198.18.0.1", family: 4 }],
      allowed: true,
    },
    {
      name: "public HTTPS fake IPv6",
      baseUrl: "https://search.example.test",
      first: publicAddress,
      next: [{ address: "fc00::1", family: 6 }],
      allowed: true,
    },
    {
      name: "public HTTPS redirect hostname",
      baseUrl: "https://search.example.test",
      first: publicAddress,
      next: publicAddress,
      allowed: false,
      redirect: true,
    },
  ])("preserves endpoint policy: $name", async ({ baseUrl, first, next, allowed, redirect }) => {
    lookup.mockResolvedValueOnce(first).mockResolvedValue(next);
    if (redirect) {
      fetchNetwork.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
      );
    }
    const result = createTool(mode, baseUrl).execute({ query: `policy-${++queryId}` });
    if (allowed) {
      await expect(result).resolves.toMatchObject({ provider: "brave" });
      expect(fetchNetwork).toHaveBeenCalledOnce();
      expect(lookup).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toThrow(redirect ? /allowlist/ : /private|loopback/);
      expect(fetchNetwork).toHaveBeenCalledTimes(redirect ? 1 : 0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
