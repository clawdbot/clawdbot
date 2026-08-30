// @vitest-environment node
// Control UI tests cover tool-title request eligibility and the title store.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  configureToolTitleFetcher,
  getToolCallTitle,
  getToolTitlesVersion,
  subscribeToolTitleChanges,
} from "./tool-titles.ts";

afterEach(() => {
  configureToolTitleFetcher({ client: null, sessionKey: null });
  vi.unstubAllGlobals();
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
    });
    const args = { command: "pnpm run build --filter ui --mode production" };
    expect(getToolCallTitle("bash", args)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getToolCallTitle("bash", args)).toBe("Build the Control UI");
  });

  it("evicts least-recently-used successful titles once retention is full", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_method: string, params: unknown) => {
      const items = (params as { items: Array<{ id: string; input: string }> }).items;
      return { titles: Object.fromEntries(items.map((item) => [item.id, item.input])) };
    });
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    const commands = Array.from(
      { length: 240 },
      (_, index) => `printf 'successful-title-${index}'`,
    );
    for (const command of commands) {
      getToolCallTitle("bash", { command });
      await vi.advanceTimersByTimeAsync(300);
    }

    const retained = commands.map((command) => getToolCallTitle("bash", { command }));
    expect(retained[0]).toBeUndefined();
    expect(retained.at(-1)).toBe(commands.at(-1));
    expect(retained.filter((title) => title !== undefined).length).toBeLessThan(commands.length);
  });

  it("continues admitting later titles after earlier successes are evicted", async () => {
    vi.useFakeTimers();
    const requestedIds = new Set<string>();
    const request = vi.fn(async (_method: string, params: unknown) => {
      const items = (params as { items: Array<{ id: string; input: string }> }).items;
      for (const item of items) {
        requestedIds.add(item.id);
      }
      return { titles: Object.fromEntries(items.map((item) => [item.id, item.input])) };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const commands = Array.from(
      { length: 240 },
      (_, index) => `printf 'progressive-title-${index}'`,
    );
    const renderTranscript = () => {
      configureToolTitleFetcher({ client, sessionKey: "main" });
      for (const command of commands) {
        getToolCallTitle("bash", { command });
      }
    };

    renderTranscript();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestedIds.size).toBe(48);

    for (let retry = 0; retry < 4; retry++) {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      renderTranscript();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(requestedIds.size).toBe(commands.length);
  });

  it("resumes when transcript retention removes the saturation cursor", async () => {
    vi.useFakeTimers();
    const requestedIds = new Set<string>();
    const request = vi.fn(async (_method: string, params: unknown) => {
      const items = (params as { items: Array<{ id: string; input: string }> }).items;
      for (const item of items) {
        requestedIds.add(item.id);
      }
      return { titles: Object.fromEntries(items.map((item) => [item.id, item.input])) };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const commands = Array.from({ length: 120 }, (_, index) => `printf 'retained-title-${index}'`);
    const renderTranscript = (visibleCommands: string[]) => {
      configureToolTitleFetcher({ client, sessionKey: "main" });
      for (const command of visibleCommands) {
        getToolCallTitle("bash", { command });
      }
    };

    renderTranscript(commands);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestedIds.size).toBe(48);

    const retainedCommands = commands.filter((_, index) => index !== 47);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    renderTranscript(retainedCommands);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestedIds.size).toBe(48);

    renderTranscript(retainedCommands);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestedIds.size).toBe(96);
  });

  it("evicts least-recently-used failures once retention is full", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ titles: {} }));
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    const commands = Array.from({ length: 240 }, (_, index) => `printf 'failed-title-${index}'`);
    for (const command of commands) {
      getToolCallTitle("bash", { command });
      await vi.advanceTimersByTimeAsync(300);
    }

    getToolCallTitle("bash", { command: commands[0] });
    getToolCallTitle("bash", { command: commands.at(-1) });
    await vi.advanceTimersByTimeAsync(300);

    expect(request).toHaveBeenCalledTimes(commands.length + 1);
  });

  it("retries gateway failures after the failure suppression window expires", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => {
      throw new Error("utility model unavailable");
    });
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    const args = { command: "pnpm test ui/src/pages/chat --reporter verbose" };
    getToolCallTitle("bash", args);
    await vi.advanceTimersByTimeAsync(300);
    getToolCallTitle("bash", args);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    getToolCallTitle("bash", args);
    await vi.advanceTimersByTimeAsync(300);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds a 240-item session backlog and keeps one request in flight", async () => {
    vi.useFakeTimers();
    let resolveRequest: ((value: { titles: Record<string, string> }) => void) | undefined;
    let requestedIds: string[] = [];
    const request = vi.fn(
      async (_method: string, params: unknown) =>
        await new Promise<{ titles: Record<string, string> }>((resolve) => {
          requestedIds = (params as { items: Array<{ id: string }> }).items.map((item) => item.id);
          resolveRequest = resolve;
        }),
    );
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    const commands = Array.from({ length: 240 }, (_, index) => `printf 'queued-title-${index}'`);
    for (const command of commands.slice(0, 24)) {
      getToolCallTitle("bash", { command });
    }
    await vi.advanceTimersByTimeAsync(300);
    for (const command of commands.slice(24)) {
      getToolCallTitle("bash", { command });
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);

    resolveRequest?.({
      titles: Object.fromEntries(requestedIds.map((id) => [id, "Generated title"])),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const requestedItems = request.mock.calls.reduce(
      (count, call) => count + ((call[1] as { items: unknown[] }).items.length ?? 0),
      0,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.every((call) => (call[1] as { items: unknown[] }).items.length <= 24),
    ).toBe(true);
    expect(requestedItems).toBe(48);

    for (const command of commands) {
      getToolCallTitle("bash", { command });
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds global admission across sessions", async () => {
    vi.useFakeTimers();
    const requestedInputs: string[] = [];
    const request = vi.fn(async (_method: string, params: unknown) => {
      const items = (params as { items: Array<{ id: string; input: string }> }).items;
      requestedInputs.push(...items.map((item) => item.input));
      return { titles: Object.fromEntries(items.map((item) => [item.id, item.input])) };
    });
    const client = { request } as unknown as GatewayBrowserClient;

    for (let sessionIndex = 0; sessionIndex < 3; sessionIndex++) {
      configureToolTitleFetcher({ client, sessionKey: `session-${sessionIndex}` });
      for (let itemIndex = 0; itemIndex < 32; itemIndex++) {
        getToolCallTitle("bash", {
          command: `printf 'global-title-${sessionIndex}-${itemIndex}'`,
        });
      }
    }
    configureToolTitleFetcher({ client, sessionKey: "overflow-session" });
    getToolCallTitle("bash", { command: "printf 'global-title-overflow'" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      request.mock.calls.every((call) => (call[1] as { items: unknown[] }).items.length <= 24),
    ).toBe(true);
    expect(requestedInputs).toHaveLength(96);
    expect(requestedInputs).not.toContain("printf 'global-title-overflow'");
  });

  it("emits one title-change event when a batch stores generated titles", async () => {
    vi.useFakeTimers();
    const events = new EventTarget();
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    vi.stubGlobal("dispatchEvent", events.dispatchEvent.bind(events));
    const listener = vi.fn();
    const unsubscribe = subscribeToolTitleChanges(listener);
    const request = vi.fn(async (_method: string, params: unknown) => {
      const [item] = (params as { items: Array<{ id: string }> }).items;
      return { titles: item ? { [item.id]: "Generated title" } : {} };
    });
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat --reporter verbose" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("retires in-flight work when the fetcher lifecycle changes", async () => {
    vi.useFakeTimers();
    const dispatchEvent = vi.fn((_event: Event) => true);
    vi.stubGlobal("dispatchEvent", dispatchEvent);
    for (const transition of ["replace", "disconnect"] as const) {
      let resolveRequest:
        | ((value: { titles: Record<string, string>; disabled?: boolean }) => void)
        | undefined;
      let requestedId = "";
      const replacementRequest = vi.fn(async () => ({ titles: {} }));
      const request = vi.fn(
        async (_method: string, params: unknown) =>
          await new Promise<{ titles: Record<string, string>; disabled?: boolean }>((resolve) => {
            requestedId = (params as { items: Array<{ id: string }> }).items[0]?.id ?? "";
            resolveRequest = resolve;
          }),
      );
      const args = { command: `pnpm test ui/src/pages/chat --mode ${transition}` };
      configureToolTitleFetcher({
        client: { request } as unknown as GatewayBrowserClient,
        sessionKey: "main",
      });
      getToolCallTitle("bash", args);
      await vi.advanceTimersByTimeAsync(300);

      configureToolTitleFetcher({
        client:
          transition === "replace"
            ? ({ request: replacementRequest } as unknown as GatewayBrowserClient)
            : null,
        sessionKey: transition === "replace" ? "replacement" : null,
      });
      resolveRequest?.({ titles: { [requestedId]: "Stale generated title" } });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      if (transition === "replace") {
        getToolCallTitle("bash", args);
        await vi.advanceTimersByTimeAsync(300);
        expect(replacementRequest).toHaveBeenCalledOnce();
      }
      configureToolTitleFetcher({ client: null, sessionKey: null });
    }
  });

  it("invalidates cached titles when the gateway client is replaced", async () => {
    vi.useFakeTimers();
    const dispatchEvent = vi.fn((_event: Event) => true);
    vi.stubGlobal("dispatchEvent", dispatchEvent);
    const firstRequest = vi.fn(async (_method: string, params: unknown) => {
      const [item] = (params as { items: Array<{ id: string }> }).items;
      return { titles: item ? { [item.id]: "First gateway title" } : {} };
    });
    const replacementRequest = vi.fn(async (_method: string, params: unknown) => {
      const [item] = (params as { items: Array<{ id: string }> }).items;
      return { titles: item ? { [item.id]: "Replacement gateway title" } : {} };
    });
    const args = { command: "pnpm test ui/src/pages/chat --reporter verbose" };

    configureToolTitleFetcher({
      client: { request: firstRequest } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    expect(getToolCallTitle("bash", args)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getToolCallTitle("bash", args)).toBe("First gateway title");
    const firstVersion = getToolTitlesVersion();
    dispatchEvent.mockClear();

    configureToolTitleFetcher({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    expect(getToolTitlesVersion()).toBe(firstVersion + 1);
    expect(getToolCallTitle("bash", args)).toBeUndefined();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(replacementRequest).toHaveBeenCalledOnce();
    expect(getToolCallTitle("bash", args)).toBe("Replacement gateway title");
  });

  it("stops requesting once a disabled response settles queued backlog", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ titles: {}, disabled: true }));
    const client = { request } as unknown as GatewayBrowserClient;

    configureToolTitleFetcher({
      client,
      sessionKey: "agent:a:main",
      agentId: "a",
    });
    for (let index = 0; index < 25; index++) {
      getToolCallTitle("bash", {
        command: `pnpm run build --filter ui --mode production-${index}`,
      });
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(0);
    // A different eligible call after the disabled response must not schedule.
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat --runInBand" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("settles unusable title responses without discarding another session", async () => {
    vi.useFakeTimers();
    const responses: unknown[] = [
      undefined,
      { titles: null },
      { titles: {} },
      new Error("gateway unavailable"),
    ];
    for (const [caseIndex, response] of responses.entries()) {
      const request = vi.fn(async (_method: string, params: unknown) => {
        const requestParams = params as {
          sessionKey: string;
          items: Array<{ id: string }>;
        };
        if (requestParams.sessionKey === "agent:a:main") {
          if (response instanceof Error) {
            throw response;
          }
          return response;
        }
        return {
          titles: Object.fromEntries(
            requestParams.items.map((item) => [item.id, "Other session title"]),
          ),
        };
      });
      const client = { request } as unknown as GatewayBrowserClient;
      configureToolTitleFetcher({
        client,
        sessionKey: "agent:a:main",
      });
      for (let itemIndex = 0; itemIndex < 24; itemIndex++) {
        getToolCallTitle("bash", {
          command: `pnpm test ui/src/pages/chat --unusable-${caseIndex}-${itemIndex}`,
        });
      }
      configureToolTitleFetcher({
        client,
        sessionKey: "agent:b:main",
      });
      const otherSessionArgs = {
        command: `pnpm test ui/src/pages/chat --unusable-${caseIndex}-other-session`,
      };
      getToolCallTitle("bash", otherSessionArgs);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        request.mock.calls.map((call) => (call[1] as { sessionKey: string }).sessionKey),
      ).toEqual(["agent:a:main", "agent:b:main"]);
      expect(getToolCallTitle("bash", otherSessionArgs)).toBe("Other session title");
      expect(vi.getTimerCount()).toBe(0);
      expect(request).toHaveBeenCalledTimes(2);
      configureToolTitleFetcher({ client: null, sessionKey: null });
    }
  });

  it("sends queued items with the session and agent captured at schedule time", async () => {
    vi.useFakeTimers();
    const requests: Array<{ sessionKey: string; agentId?: string }> = [];
    const client = {
      request: vi.fn(async (_method: string, params: unknown) => {
        requests.push(params as { sessionKey: string; agentId?: string });
        const items = (params as { items: Array<{ id: string }> }).items;
        return { titles: Object.fromEntries(items.map((item) => [item.id, "Generated title"])) };
      }),
    } as unknown as GatewayBrowserClient;

    // Pane A schedules, then pane B re-renders (and reconfigures) before the
    // debounce fires; the request must keep pane A's session and agent.
    configureToolTitleFetcher({
      client,
      sessionKey: "global",
      agentId: "alice",
    });
    getToolCallTitle("bash", { command: "pnpm run build --filter ui --mode development" });
    configureToolTitleFetcher({
      client,
      sessionKey: "agent:b:main",
      agentId: "b",
    });
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat --sequence.concurrent" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(requests).toEqual([
      expect.objectContaining({ sessionKey: "global", agentId: "alice" }),
      expect.objectContaining({ sessionKey: "agent:b:main", agentId: "b" }),
    ]);
  });
});
