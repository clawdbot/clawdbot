// @vitest-environment node
// Control UI tests cover tool-title request eligibility and the title store.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  configureToolTitleFetcher,
  getToolCallTitle,
  getToolTitlesVersion,
  scheduleToolTitlesForTranscript,
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

function renderToolTitle(name: string, args: unknown): string | undefined {
  scheduleToolTitlesForTranscript([{ name, args }]);
  return getToolCallTitle(name, args);
}

describe("getToolCallTitle", () => {
  it("returns undefined for eligible calls without a stored title", () => {
    expect(renderToolTitle("bash", { command: "git log --oneline -5" })).toBeUndefined();
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

    renderToolTitle("bash", { command: "short" });
    renderToolTitle("bash", { command: "git log --oneline -5" });
    renderToolTitle("demo__show", { value: "short" });
    renderToolTitle("demo__show", { value: "x".repeat(150) });
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

    renderToolTitle("bash", { command: "12345678901" });
    renderToolTitle("bash", { command: "123456789012" });
    renderToolTitle("read", { path: `/${"x".repeat(500)}` });
    renderToolTitle("demo__show", "x".repeat(119));
    renderToolTitle("demo__show", "y".repeat(120));
    renderToolTitle("bash", { command: `${"z".repeat(1_999)}😀tail` });
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
    renderToolTitle("bash", args);
    renderToolTitle("bash", { ...args });
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
    expect(renderToolTitle("bash", args)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renderToolTitle("bash", args)).toBe("Build the Control UI");
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
      renderToolTitle("bash", { command });
      await vi.advanceTimersByTimeAsync(300);
    }

    const retained = commands.map((command) => renderToolTitle("bash", { command }));
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
      scheduleToolTitlesForTranscript(
        commands.map((command) => ({ name: "bash", args: { command } })),
      );
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

  it.each(["new-version", "new-owner"] as const)(
    "resumes when transcript retention removes the saturation cursor on %s",
    async (transition) => {
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
        { length: 120 },
        (_, index) => `printf 'retained-title-${index}'`,
      );
      const firstHistoryOwner = {};
      const secondHistoryOwner = {};
      let historyVersion = 0;
      const renderTranscript = (
        visibleCommands: string[],
        owner = firstHistoryOwner,
        version = ++historyVersion,
      ) => {
        configureToolTitleFetcher({
          client,
          sessionKey: "main",
          historyOwner: owner,
          historyVersion: version,
        });
        scheduleToolTitlesForTranscript(
          visibleCommands.map((command) => ({ name: "bash", args: { command } })),
        );
      };

      renderTranscript(commands);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestedIds.size).toBe(48);

      const retainedCommands = commands.filter((_, index) => index !== 47);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const retainedHistoryVersion = ++historyVersion;
      renderTranscript(retainedCommands, firstHistoryOwner, retainedHistoryVersion);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestedIds.size).toBe(48);

      renderTranscript(retainedCommands, firstHistoryOwner, retainedHistoryVersion);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestedIds.size).toBe(48);

      renderTranscript(
        retainedCommands,
        transition === "new-owner" ? secondHistoryOwner : firstHistoryOwner,
        transition === "new-owner" ? retainedHistoryVersion : ++historyVersion,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestedIds.size).toBe(96);
    },
  );

  it("evicts least-recently-used failures once retention is full", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ titles: {} }));
    configureToolTitleFetcher({
      client: { request } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    const commands = Array.from({ length: 240 }, (_, index) => `printf 'failed-title-${index}'`);
    for (const command of commands) {
      renderToolTitle("bash", { command });
      await vi.advanceTimersByTimeAsync(300);
    }

    renderToolTitle("bash", { command: commands[0] });
    renderToolTitle("bash", { command: commands.at(-1) });
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
    renderToolTitle("bash", args);
    await vi.advanceTimersByTimeAsync(300);
    renderToolTitle("bash", args);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    renderToolTitle("bash", args);
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
      renderToolTitle("bash", { command });
    }
    await vi.advanceTimersByTimeAsync(300);
    for (const command of commands.slice(24)) {
      renderToolTitle("bash", { command });
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
      renderToolTitle("bash", { command });
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

    for (let sessionIndex = 0; sessionIndex < 2; sessionIndex++) {
      configureToolTitleFetcher({ client, sessionKey: `session-${sessionIndex}` });
      for (let itemIndex = 0; itemIndex < 48; itemIndex++) {
        renderToolTitle("bash", {
          command: `printf 'global-title-${sessionIndex}-${itemIndex}'`,
        });
      }
    }
    configureToolTitleFetcher({ client, sessionKey: "overflow-session" });
    renderToolTitle("bash", { command: "printf 'global-title-overflow'" });
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
    renderToolTitle("bash", { command: "pnpm test ui/src/pages/chat --reporter verbose" });
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
      renderToolTitle("bash", args);
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
        renderToolTitle("bash", args);
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
    expect(renderToolTitle("bash", args)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renderToolTitle("bash", args)).toBe("First gateway title");
    const firstVersion = getToolTitlesVersion();
    dispatchEvent.mockClear();

    configureToolTitleFetcher({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
      sessionKey: "main",
    });
    expect(getToolTitlesVersion()).toBe(firstVersion + 1);
    expect(renderToolTitle("bash", args)).toBeUndefined();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(replacementRequest).toHaveBeenCalledOnce();
    expect(renderToolTitle("bash", args)).toBe("Replacement gateway title");
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
      renderToolTitle("bash", {
        command: `pnpm run build --filter ui --mode production-${index}`,
      });
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(0);
    // A different eligible call after the disabled response must not schedule.
    renderToolTitle("bash", { command: "pnpm test ui/src/pages/chat --runInBand" });
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
        renderToolTitle("bash", {
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
      renderToolTitle("bash", otherSessionArgs);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        request.mock.calls.map((call) => (call[1] as { sessionKey: string }).sessionKey),
      ).toEqual(["agent:a:main", "agent:b:main"]);
      expect(renderToolTitle("bash", otherSessionArgs)).toBe("Other session title");
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
    renderToolTitle("bash", { command: "pnpm run build --filter ui --mode development" });
    configureToolTitleFetcher({
      client,
      sessionKey: "agent:b:main",
      agentId: "b",
    });
    renderToolTitle("bash", { command: "pnpm test ui/src/pages/chat --sequence.concurrent" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(requests).toEqual([
      expect.objectContaining({ sessionKey: "global", agentId: "alice" }),
      expect.objectContaining({ sessionKey: "agent:b:main", agentId: "b" }),
    ]);
  });
});
