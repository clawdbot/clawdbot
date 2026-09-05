/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./logs-page.ts";

type TestLogsPage = HTMLElement & {
  context: ApplicationContext;
  logsAutoFollow: boolean;
  logsEntries: Array<{ raw: string }>;
  logsFile: string | null;
  logsStatus: { error: string | null; hasLoaded: boolean; stale: boolean };
  streamFollow: {
    atBottom: boolean;
    schedule: (force?: boolean) => void;
  };
  readonly updateComplete: Promise<boolean>;
  loadLogs: (opts?: { reset?: boolean; quiet?: boolean }) => Promise<boolean>;
  requestUpdate: () => void;
};

type TestGateway = ApplicationContext["gateway"] & {
  publish: (snapshot: ApplicationGatewaySnapshot) => void;
};

type TestApplicationContext = ApplicationContext & { gateway: TestGateway };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function contextWithClient(
  client: GatewayBrowserClient,
  connected = false,
): TestApplicationContext {
  let snapshot = {
    client,
    phase: connected ? "connected" : "stopped",
  } as ApplicationGatewaySnapshot;
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  return {
    basePath: "",
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish: (next: ApplicationGatewaySnapshot) => {
        snapshot = next;
        for (const listener of listeners) {
          listener(next);
        }
      },
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as TestApplicationContext;
}

describe("LogsPage lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([{ lines: [] }, { lines: ["initial log"] }])(
    "retains one initial request across snapshot updates with result $lines",
    async ({ lines }) => {
      const pending = deferred<{ cursor: number; file: string; lines: string[] }>();
      const request = vi.fn(
        (_method: string, _params: unknown, _options: { signal: AbortSignal }) => pending.promise,
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const page = document.createElement("openclaw-logs-page") as TestLogsPage;
      const context = contextWithClient(client);
      page.context = context;
      document.body.append(page);
      await page.updateComplete;

      context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
      expect(request).toHaveBeenCalledOnce();
      const signal = request.mock.calls[0]![2].signal;
      context.gateway.publish({ ...context.gateway.snapshot });
      expect(request).toHaveBeenCalledOnce();
      expect(signal.aborted).toBe(false);

      pending.resolve({ cursor: 100, file: "/tmp/initial.log", lines });
      await vi.waitFor(() => expect(page.logsStatus.hasLoaded).toBe(true));
      expect(page.logsEntries.map((entry) => entry.raw)).toEqual(lines);
      context.gateway.publish({ ...context.gateway.snapshot });
      expect(request).toHaveBeenCalledOnce();

      request.mockResolvedValueOnce({ cursor: 110, file: "/tmp/initial.log", lines: ["poll"] });
      await page.loadLogs({ quiet: true });
      expect(request.mock.calls[1]![1]).toMatchObject({ cursor: 100 });
      expect(page.logsEntries.map((entry) => entry.raw)).toEqual([...lines, "poll"]);

      request.mockResolvedValueOnce({ cursor: 120, file: "/tmp/initial.log", lines: ["manual"] });
      await page.updateComplete;
      page.querySelector<HTMLButtonElement>(".settings-section__actions button")!.click();
      await vi.waitFor(() =>
        expect(page.logsEntries.map((entry) => entry.raw)).toEqual(["manual"]),
      );
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2]![1]).toMatchObject({ cursor: undefined });
    },
  );

  it.each(["reconnect", "source replacement", "client replacement", "detach/reattach"])(
    "replaces an unfinished initial request on %s but not on a later snapshot",
    async (transition) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const replies: Array<ReturnType<typeof deferred<{ cursor: number; lines: string[] }>>> = [];
      const request = vi.fn(
        (_method: string, _params: unknown, _options: { signal: AbortSignal }) => {
          const reply = deferred<{ cursor: number; lines: string[] }>();
          replies.push(reply);
          return reply.promise;
        },
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const page = document.createElement("openclaw-logs-page") as TestLogsPage;
      let context = contextWithClient(client, true);
      page.context = context;
      document.body.append(page);
      await page.updateComplete;
      expect(request).toHaveBeenCalledOnce();
      const firstSignal = request.mock.calls[0]![2].signal;

      if (transition === "reconnect") {
        context.gateway.publish({ client, phase: "reconnecting" } as ApplicationGatewaySnapshot);
        context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
      } else if (transition === "client replacement") {
        context.gateway.publish({
          ...context.gateway.snapshot,
          client: { request } as unknown as GatewayBrowserClient,
        });
      } else if (transition === "detach/reattach") {
        page.remove();
        expect(firstSignal.aborted).toBe(true);
        document.body.append(page);
      } else {
        context = contextWithClient(client, true);
        page.context = context;
        page.requestUpdate();
      }
      await page.updateComplete;
      expect(firstSignal.aborted).toBe(true);
      expect(request).toHaveBeenCalledTimes(2);
      context.gateway.publish({ ...context.gateway.snapshot });
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]![2].signal.aborted).toBe(false);

      replies[1]!.resolve({ cursor: 2, lines: ["current"] });
      await vi.advanceTimersByTimeAsync(0);
      expect(page.logsEntries.map((entry) => entry.raw)).toEqual(["current"]);
      expect(page.querySelector(".log-message")?.textContent).toBe("current");
      const scheduleScroll = vi.spyOn(page.streamFollow, "schedule");
      replies[0]!.resolve({ cursor: 1, lines: ["stale"] });
      await vi.advanceTimersByTimeAsync(0);
      expect(page.logsEntries.map((entry) => entry.raw)).toEqual(["current"]);
      expect(page.querySelectorAll(".log-row")).toHaveLength(1);
      expect(page.querySelector(".log-message")?.textContent).toBe("current");
      expect(scheduleScroll).not.toHaveBeenCalled();
    },
  );

  it("keeps an initial error visible across snapshots until retry succeeds", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("logs unavailable"));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    const context = contextWithClient(client, true);
    page.context = context;
    document.body.append(page);
    await vi.waitFor(() => expect(page.logsStatus.error).toBe("logs unavailable"));
    await page.updateComplete;
    expect(page.textContent).not.toContain("No log entries.");

    context.gateway.publish({ ...context.gateway.snapshot });
    expect(request).toHaveBeenCalledOnce();
    expect(page.logsStatus.hasLoaded).toBe(false);
    request.mockResolvedValueOnce({ cursor: 1, file: "/tmp/retry.log", lines: ["recovered"] });
    page.querySelector<HTMLButtonElement>(".logs-refresh-status button")!.click();
    await vi.waitFor(() => expect(page.logsStatus.hasLoaded).toBe(true));
    expect(page.logsStatus.error).toBeNull();
    expect(page.logsEntries.map((entry) => entry.raw)).toEqual(["recovered"]);
  });

  it("does not schedule scroll work after disconnect", async () => {
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = {
      basePath: "",
      gateway: {
        snapshot: { client: null, phase: "stopped" },
        subscribe: () => () => undefined,
      },
      navigate: vi.fn(),
      preload: vi.fn(async () => undefined),
    } as unknown as ApplicationContext;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    document.body.append(page);
    await page.updateComplete;
    await Promise.resolve();
    requestFrame.mockClear();

    page.streamFollow.schedule();
    page.remove();
    await Promise.resolve();

    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("forces a scroll when auto-follow is re-enabled away from the bottom", async () => {
    const client = {
      request: vi.fn(
        () =>
          new Promise(() => {
            // Keep any incidental request pending; this test only exercises scroll state.
          }),
      ),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;

    page.logsAutoFollow = false;
    await page.updateComplete;
    const scheduleScroll = vi.spyOn(page.streamFollow, "schedule");
    page.streamFollow.atBottom = false;
    page.logsAutoFollow = true;
    await page.updateComplete;

    expect(scheduleScroll).toHaveBeenCalledOnce();
    expect(scheduleScroll).toHaveBeenCalledWith(true);
  });

  it("discards a log response from a replaced gateway source that reuses its client", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    const context = contextWithClient(client);
    page.context = context;
    page.logsEntries = [{ raw: "seed" }];
    document.body.append(page);
    await page.updateComplete;
    context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    page.logsEntries = [];

    const load = page.loadLogs({ reset: true });
    page.context = contextWithClient(client);
    page.requestUpdate();
    await page.updateComplete;
    pending.resolve({ cursor: 1, lines: ["stale"], reset: true });
    await load;

    expect(page.logsEntries).toEqual([]);
  });

  it("discards a log response that completes after disconnect", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    const context = contextWithClient(client);
    page.context = context;
    page.logsEntries = [{ raw: "seed" }];
    document.body.append(page);
    await page.updateComplete;
    context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    page.logsEntries = [];

    const load = page.loadLogs({ reset: true });
    page.remove();
    pending.resolve({ cursor: 1, lines: ["stale"], reset: true });
    await load;

    expect(page.logsEntries).toEqual([]);
  });

  it("discards a log response when the gateway disconnects with the same client", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    const context = contextWithClient(client);
    page.context = context;
    page.logsEntries = [{ raw: "seed" }];
    document.body.append(page);
    await page.updateComplete;
    context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    page.logsEntries = [];

    const load = page.loadLogs({ reset: true });
    context.gateway.publish({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
    pending.resolve({ cursor: 1, lines: ["stale"], reset: true });
    await load;

    expect(page.logsEntries).toEqual([]);
  });

  it("serializes quiet polls so an older cursor cannot overwrite a newer one", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const request = vi
      .fn(() => pending.promise)
      .mockResolvedValueOnce({
        cursor: 1,
        lines: ["seed"],
        reset: true,
      });
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    const context = contextWithClient(client, true);
    page.context = context;
    document.body.append(page);
    await vi.waitFor(() => expect(page.logsStatus.hasLoaded).toBe(true));

    const first = page.loadLogs({ quiet: true });
    const second = page.loadLogs({ quiet: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(await second).toBe(false);

    pending.resolve({ cursor: 2, lines: ["fresh"], reset: true });
    expect(await first).toBe(true);
    expect(page.logsEntries).toHaveLength(1);
  });

  it("reloads from the beginning when the gateway log file changes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 6, file: "/tmp/source-a.log", lines: ["A-one"] })
      .mockResolvedValueOnce({
        cursor: 18,
        file: "/tmp/source-b.log",
        lines: ["B-tail"],
        reset: false,
      })
      .mockResolvedValueOnce({
        cursor: 18,
        file: "/tmp/source-b.log",
        lines: ["B-one", "B-tail"],
      });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client, true);
    document.body.append(page);
    await vi.waitFor(() => expect(page.logsStatus.hasLoaded).toBe(true));

    await page.loadLogs();

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: 6 });
    expect(request.mock.calls[2]?.[1]).toMatchObject({ cursor: undefined });
    expect(page.logsFile).toBe("/tmp/source-b.log");
    expect(page.logsEntries.map((entry) => entry.raw)).toEqual(["B-one", "B-tail"]);
  });

  it("retains loaded logs as stale after failure and clears the marker on retry success", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 1, lines: ["old"], reset: true })
      .mockRejectedValueOnce(new Error("logs unavailable"))
      .mockResolvedValueOnce({ cursor: 2, lines: ["fresh"], reset: true });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    const context = contextWithClient(client);
    page.context = context;
    document.body.append(page);
    await page.updateComplete;
    context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    await vi.waitFor(() => expect(page.logsStatus.hasLoaded).toBe(true));

    await page.loadLogs({ reset: true });
    expect(page.logsEntries).toHaveLength(1);
    expect(page.logsStatus).toEqual({
      error: "logs unavailable",
      hasLoaded: true,
      stale: true,
    });

    await page.loadLogs({ reset: true });
    expect(page.logsStatus).toEqual({ error: null, hasLoaded: true, stale: false });
    expect(page.logsEntries).toHaveLength(1);
  });

  it("drops deferred scroll work after a same-client reconnect", async () => {
    const client = {
      request: vi.fn(
        () =>
          new Promise(() => {
            // Keep both connection-epoch requests pending while scroll ownership changes.
          }),
      ),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    const context = contextWithClient(client);
    page.context = context;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    document.body.append(page);
    await page.updateComplete;
    context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    requestFrame.mockClear();

    page.streamFollow.schedule();
    context.gateway.publish({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
    context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    await Promise.resolve();

    expect(requestFrame).not.toHaveBeenCalled();
  });
});
