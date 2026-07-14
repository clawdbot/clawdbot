/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./logs-page.ts";

type TestLogsPage = HTMLElement & {
  context: ApplicationContext;
  connected: boolean;
  logsAtBottom: boolean;
  logsAutoFollow: boolean;
  logsEntries: unknown[];
  scheduleScroll: (force?: boolean) => void;
  readonly updateComplete: Promise<boolean>;
  applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
  loadLogs: (opts?: { reset?: boolean; quiet?: boolean }) => Promise<boolean>;
  requestUpdate: () => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function contextWithClient(client: GatewayBrowserClient): ApplicationContext {
  return {
    basePath: "",
    gateway: {
      snapshot: { client, connected: false },
      subscribe: () => () => undefined,
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

describe("LogsPage lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("does not schedule scroll work after disconnect", async () => {
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = {
      basePath: "",
      gateway: {
        snapshot: { client: null, connected: false },
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

    page.scheduleScroll();
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
    const scheduleScroll = vi.spyOn(page, "scheduleScroll");
    page.logsAtBottom = false;
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
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

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
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

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
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

    const load = page.loadLogs({ reset: true });
    page.applyGatewaySnapshot({ client, connected: false } as ApplicationGatewaySnapshot);
    pending.resolve({ cursor: 1, lines: ["stale"], reset: true });
    await load;

    expect(page.logsEntries).toEqual([]);
  });

  it("serializes quiet polls so an older cursor cannot overwrite a newer one", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const request = vi.fn(() => pending.promise);
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

    const first = page.loadLogs({ quiet: true });
    const second = page.loadLogs({ quiet: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await second).toBe(false);

    pending.resolve({ cursor: 2, lines: ["fresh"], reset: true });
    expect(await first).toBe(true);
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
    page.context = contextWithClient(client);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    document.body.append(page);
    await page.updateComplete;
    page.applyGatewaySnapshot({ client, connected: true } as ApplicationGatewaySnapshot);
    requestFrame.mockClear();

    page.scheduleScroll();
    page.applyGatewaySnapshot({ client, connected: false } as ApplicationGatewaySnapshot);
    page.applyGatewaySnapshot({ client, connected: true } as ApplicationGatewaySnapshot);
    await Promise.resolve();

    expect(requestFrame).not.toHaveBeenCalled();
  });
});
