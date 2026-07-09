/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./overview-page.ts";

type OverviewRefreshScope = {
  context: ApplicationContext;
  gateway: ApplicationContext["gateway"];
  epoch: number;
  client: GatewayBrowserClient;
};

type TestOverviewPage = HTMLElement & {
  context: ApplicationContext;
  usageResult: unknown;
  overviewLogLines: string[];
  showGatewayToken: boolean;
  showGatewayPassword: boolean;
  refreshPromise: Promise<void> | null;
  captureRefreshScope: () => OverviewRefreshScope | null;
  loadLogs: (scope: OverviewRefreshScope) => Promise<void>;
  refreshOverview: (force: boolean) => Promise<void>;
  render: () => unknown;
  requestUpdate: () => void;
  readonly updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function contextWithGateway(
  client: GatewayBrowserClient,
  connected: boolean,
): { context: ApplicationContext; snapshot: ApplicationGatewaySnapshot } {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  const context = {
    gateway: {
      snapshot,
      connection: { gatewayUrl: "ws://gateway", token: "token", password: "password" },
      eventLog: [],
      subscribe,
      subscribeEventLog: subscribe,
    },
    channels: {
      state: { channelsSnapshot: null, channelsLastSuccess: null },
      refresh: vi.fn(async () => undefined),
      subscribe,
    },
    sessions: {
      state: { result: null },
      refresh: vi.fn(async () => undefined),
      subscribe,
    },
  } as unknown as ApplicationContext;
  return { context, snapshot };
}

function createPage(context: ApplicationContext): TestOverviewPage {
  const page = document.createElement("openclaw-overview-page") as TestOverviewPage;
  page.context = context;
  page.render = () => nothing;
  return page;
}

async function replaceContext(page: TestOverviewPage, context: ApplicationContext) {
  page.context = context;
  page.requestUpdate();
  await page.updateComplete;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("OverviewPage gateway lifecycle", () => {
  it("clears provider data and secret reveals when the gateway source changes", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, false).context);
    document.body.append(page);
    await page.updateComplete;
    page.usageResult = { sessions: [{ key: "old" }] };
    page.overviewLogLines = ["old provider"];
    page.showGatewayToken = true;
    page.showGatewayPassword = true;

    await replaceContext(page, contextWithGateway(client, false).context);

    expect(page.usageResult).toBeNull();
    expect(page.overviewLogLines).toEqual([]);
    expect(page.showGatewayToken).toBe(false);
    expect(page.showGatewayPassword).toBe(false);

    page.showGatewayToken = true;
    page.showGatewayPassword = true;
    page.remove();

    expect(page.showGatewayToken).toBe(false);
    expect(page.showGatewayPassword).toBe(false);
  });

  it("discards a log response from a replaced gateway source", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const first = contextWithGateway(client, false);
    const page = createPage(first.context);
    document.body.append(page);
    await page.updateComplete;
    first.snapshot.connected = true;
    const scope = page.captureRefreshScope();
    expect(scope).not.toBeNull();

    const load = page.loadLogs(scope as OverviewRefreshScope);
    await replaceContext(page, contextWithGateway(client, false).context);
    pending.resolve({ cursor: 10, lines: ["stale"], reset: true });
    await load;

    expect(page.overviewLogLines).toEqual([]);
  });

  it("does not let a stale refresh finally clear the replacement refresh", async () => {
    const logs = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const request = vi.fn((method: string) => {
      if (method === "logs.tail") {
        return logs.promise;
      }
      if (method === "cron.list") {
        return Promise.resolve({ jobs: [] });
      }
      if (method === "models.authStatus") {
        return Promise.resolve({ ts: 0, providers: [] });
      }
      if (method === "skills.status") {
        return Promise.resolve({ skills: [] });
      }
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const first = contextWithGateway(client, false);
    const page = createPage(first.context);
    document.body.append(page);
    await page.updateComplete;
    first.snapshot.connected = true;

    const staleRefresh = page.refreshOverview(false);
    expect(page.refreshPromise).not.toBeNull();
    await replaceContext(page, contextWithGateway(client, false).context);
    const replacementRefresh = deferred<void>().promise;
    page.refreshPromise = replacementRefresh;
    logs.resolve({ cursor: 10, lines: ["stale"], reset: true });
    await staleRefresh;

    expect(page.refreshPromise).toBe(replacementRefresh);
  });
});
