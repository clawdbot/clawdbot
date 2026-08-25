// @vitest-environment node
// Control UI tests cover tool-title request eligibility and the title store.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { configureToolTitleFetcher, getToolCallTitle } from "./tool-titles.ts";

afterEach(() => {
  configureToolTitleFetcher({ client: null, sessionKey: null, onTitlesChanged: null });
  vi.useRealTimers();
});

function requireFirstRequestParams(request: ReturnType<typeof vi.fn>): unknown {
  const call = request.mock.calls[0];
  if (!call) {
    throw new Error("expected tool title request");
  }
  return call[1];
}

describe("getToolCallTitle", () => {
  it("returns undefined for eligible calls without a stored title", () => {
    expect(getToolCallTitle("bash", { command: "git log --oneline -5" })).toBeUndefined();
  });
});

describe("title fetch batching", () => {
  it("requests only eligible shell and argument-heavy tool calls", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_method: string, params: unknown) => {
      const items = (params as { items: Array<{ id: string }> }).items;
      return { titles: Object.fromEntries(items.map((item) => [item.id, "Titled"])) };
    });
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: null,
    });

    getToolCallTitle("bash", { command: "short" });
    getToolCallTitle("bash", { command: "git log --oneline -5" });
    getToolCallTitle("demo__show", { value: "short" });
    getToolCallTitle("demo__show", { value: "x".repeat(150) });
    await vi.advanceTimersByTimeAsync(1_000);

    const items = (requireFirstRequestParams(request) as { items: unknown[] }).items;
    expect(items).toHaveLength(2);
  });

  it("enforces request boundaries and truncates inputs on UTF-16 boundaries", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_method: string, _params: unknown) => ({ titles: {} }));
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: null,
    });

    getToolCallTitle("bash", { command: "12345678901" });
    getToolCallTitle("bash", { command: "123456789012" });
    getToolCallTitle("read", { path: `/${"x".repeat(500)}` });
    getToolCallTitle("demo__show", "x".repeat(119));
    getToolCallTitle("demo__show", "y".repeat(120));
    getToolCallTitle("bash", { command: `${"z".repeat(1_999)}😀tail` });
    await vi.advanceTimersByTimeAsync(1_000);

    const items = (
      requireFirstRequestParams(request) as {
        items: Array<{ name: string; input: string }>;
      }
    ).items;
    expect(items.map((item) => item.input)).toEqual([
      "123456789012",
      "y".repeat(120),
      "z".repeat(1_999),
    ]);
    expect(items.every((item) => !item.input.endsWith("\ud83d"))).toBe(true);
  });

  it("deduplicates equal tool name and arguments into one request key", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_method: string, _params: unknown) => ({ titles: {} }));
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: null,
    });
    const args = { command: "pnpm test ui/src/pages/chat --reporter verbose" };
    getToolCallTitle("bash", args);
    getToolCallTitle("bash", { ...args });
    await vi.advanceTimersByTimeAsync(1_000);

    expect((requireFirstRequestParams(request) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("returns the stored title after the eligible request resolves", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_method: string, params: unknown) => {
      const [item] = (params as { items: Array<{ id: string }> }).items;
      return { titles: item ? { [item.id]: "Build the Control UI" } : {} };
    });
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: null,
    });
    const args = { command: "pnpm run build --filter ui --mode production" };
    expect(getToolCallTitle("bash", args)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getToolCallTitle("bash", args)).toBe("Build the Control UI");
  });

  it("notifies every pane that contributed rows to a title batch", async () => {
    vi.useFakeTimers();
    const client = {
      request: vi.fn(async (_method: string, params: unknown) => {
        const items = (params as { items: Array<{ id: string }> }).items;
        return { titles: Object.fromEntries(items.map((item) => [item.id, "Titled"])) };
      }),
    } as unknown as GatewayBrowserClient;
    const notifyA = vi.fn();
    const notifyB = vi.fn();

    // Two panes on the same session/agent enqueue into one batch.
    configureToolTitleFetcher({
      client,
      sessionKey: "agent:a:main",
      agentId: "a",
      onTitlesChanged: notifyA,
    });
    getToolCallTitle("bash", { command: "pnpm run build --filter ui --reporter append-only" });
    configureToolTitleFetcher({
      client,
      sessionKey: "agent:a:main",
      agentId: "a",
      onTitlesChanged: notifyB,
    });
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat --reporter verbose" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(notifyA).toHaveBeenCalled();
    expect(notifyB).toHaveBeenCalled();
  });

  it("stops requesting for the session once the gateway reports titles disabled", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ titles: {}, disabled: true }));
    const client = { request } as unknown as GatewayBrowserClient;

    configureToolTitleFetcher({
      client,
      sessionKey: "agent:a:main",
      agentId: "a",
      onTitlesChanged: null,
    });
    getToolCallTitle("bash", { command: "pnpm run build --filter ui --mode production" });
    await vi.advanceTimersByTimeAsync(1_000);
    // A different eligible call after the disabled response must not schedule.
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat --runInBand" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends queued items with the session and agent captured at schedule time", async () => {
    vi.useFakeTimers();
    const requests: Array<{ sessionKey: string; agentId?: string }> = [];
    const client = {
      request: vi.fn(async (_method: string, params: unknown) => {
        requests.push(params as { sessionKey: string; agentId?: string });
        return { titles: {} };
      }),
    } as unknown as GatewayBrowserClient;

    // Pane A schedules, then pane B re-renders (and reconfigures) before the
    // debounce fires; the request must keep pane A's session and agent.
    configureToolTitleFetcher({
      client,
      sessionKey: "global",
      agentId: "alice",
      onTitlesChanged: null,
    });
    getToolCallTitle("bash", { command: "pnpm run build --filter ui --mode development" });
    configureToolTitleFetcher({
      client,
      sessionKey: "agent:b:main",
      agentId: "b",
      onTitlesChanged: null,
    });
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat --sequence.concurrent" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(requests).toEqual([
      expect.objectContaining({ sessionKey: "global", agentId: "alice" }),
      expect.objectContaining({ sessionKey: "agent:b:main", agentId: "b" }),
    ]);
  });

  it("bounds one owner's queue and drains retained batches without another debounce", async () => {
    vi.useFakeTimers();
    const requestedInputs: string[] = [];
    const requestTimes: number[] = [];
    const request = vi.fn(async (_method: string, params: unknown) => {
      const items = (params as { items: Array<{ input: string }> }).items;
      requestedInputs.push(...items.map((item) => item.input));
      requestTimes.push(Date.now());
      return { titles: {} };
    });
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: null,
    });

    for (let index = 0; index < 240; index += 1) {
      getToolCallTitle("bash", { command: `printf retained-command-${index}` });
    }
    await vi.advanceTimersByTimeAsync(250);

    expect(request).toHaveBeenCalledTimes(4);
    expect(requestedInputs).toHaveLength(96);
    expect(requestedInputs[0]).toBe("printf retained-command-144");
    expect(requestedInputs.at(-1)).toBe("printf retained-command-239");
    expect(new Set(requestTimes).size).toBe(1);
  });

  it("bounds the queue across owners", async () => {
    vi.useFakeTimers();
    const requestedSessions: string[] = [];
    const client = {
      request: vi.fn(async (_method: string, params: unknown) => {
        requestedSessions.push((params as { sessionKey: string }).sessionKey);
        return { titles: {} };
      }),
    } as unknown as GatewayBrowserClient;

    for (const sessionKey of ["owner-a", "owner-b", "owner-c"]) {
      configureToolTitleFetcher({ client, sessionKey, onTitlesChanged: null });
      for (let index = 0; index < 96; index += 1) {
        getToolCallTitle("bash", { command: `printf ${sessionKey}-command-${index}` });
      }
    }
    await vi.advanceTimersByTimeAsync(250);

    expect(requestedSessions).toHaveLength(8);
    expect(requestedSessions).not.toContain("owner-a");
    expect(new Set(requestedSessions)).toEqual(new Set(["owner-b", "owner-c"]));
  });

  it("bounds retained failures even before their retry time", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ titles: {} }));
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: null,
    });
    const argsFor = (index: number) => ({ command: `printf failed-command-${index}` });

    for (let start = 0; start < 501; start += 96) {
      for (let index = start; index < Math.min(start + 96, 501); index += 1) {
        getToolCallTitle("bash", argsFor(index));
      }
      await vi.advanceTimersByTimeAsync(250);
    }
    getToolCallTitle("bash", argsFor(0));
    getToolCallTitle("bash", argsFor(500));
    await vi.advanceTimersByTimeAsync(250);

    expect(request).toHaveBeenCalledTimes(22);
  });

  it("retries transient failures after their bounded retention expires", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({ titles: {} });
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: null,
    });
    const args = { command: "pnpm test ui transient title retry" };

    getToolCallTitle("bash", args);
    await vi.advanceTimersByTimeAsync(250);
    getToolCallTitle("bash", args);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);

    getToolCallTitle("bash", args);
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not publish a title after its client lifecycle is cleared", async () => {
    vi.useFakeTimers();
    let resolveRequest: ((value: { titles: Record<string, string> }) => void) | undefined;
    const request = vi.fn(
      async () =>
        await new Promise<{ titles: Record<string, string> }>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const notify = vi.fn();
    const args = { command: "pnpm test ui stale title owner" };
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: notify,
    });

    getToolCallTitle("bash", args);
    await vi.advanceTimersByTimeAsync(250);
    const params = requireFirstRequestParams(request) as { items: Array<{ id: string }> };
    const id = params.items[0]?.id;
    if (!id || !resolveRequest) {
      throw new Error("expected pending tool title request");
    }
    const replacementRequest = vi.fn(async () => ({ titles: {} }));
    configureToolTitleFetcher({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
      sessionKey: "replacement-session",
      onTitlesChanged: null,
    });
    resolveRequest({ titles: { [id]: "Stale title" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(notify).not.toHaveBeenCalled();
    expect(getToolCallTitle("bash", args)).toBeUndefined();
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("times out a hung owner before continuing another owner", async () => {
    vi.useFakeTimers();
    const request = vi.fn(
      async (
        _method: string,
        params: unknown,
        options?: { timeoutMs?: number },
      ): Promise<{ titles: Record<string, string> }> => {
        if ((params as { sessionKey: string }).sessionKey === "new-session") {
          return { titles: {} };
        }
        return await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("request timed out")), options?.timeoutMs);
        });
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    configureToolTitleFetcher({
      client,
      sessionKey: "old-session",
      onTitlesChanged: null,
    });
    getToolCallTitle("bash", { command: "pnpm test ui obsolete title owner" });
    await vi.advanceTimersByTimeAsync(250);

    configureToolTitleFetcher({
      client,
      sessionKey: "new-session",
      onTitlesChanged: null,
    });
    getToolCallTitle("bash", { command: "pnpm test ui replacement title owner" });
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_750);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[2]).toEqual({ timeoutMs: 30_000 });
    expect(request.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ sessionKey: "new-session" }),
    );
  });

  it("evicts least-recently-used successful titles", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_method: string, params: unknown) => {
      const items = (params as { items: Array<{ id: string; input: string }> }).items;
      return { titles: Object.fromEntries(items.map((item) => [item.id, item.input])) };
    });
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
      onTitlesChanged: null,
    });
    const argsFor = (index: number) => ({ command: `printf cached-command-${index}` });

    for (let start = 0; start < 500; start += 96) {
      for (let index = start; index < Math.min(start + 96, 500); index += 1) {
        getToolCallTitle("bash", argsFor(index));
      }
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(getToolCallTitle("bash", argsFor(0))).toBe("printf cached-command-0");
    getToolCallTitle("bash", argsFor(500));
    await vi.advanceTimersByTimeAsync(250);

    expect(getToolCallTitle("bash", argsFor(0))).toBe("printf cached-command-0");
    expect(getToolCallTitle("bash", argsFor(1))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(23);
  });
});
