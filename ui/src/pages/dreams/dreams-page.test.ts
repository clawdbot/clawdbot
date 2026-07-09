/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createDreamingState, type DreamingState } from "./dreaming.ts";
import type { DreamsRouteData } from "./dreams-page.ts";
import type { DreamingViewState } from "./view.ts";
import "./dreams-page.ts";

type TestDreamsPage = HTMLElement & {
  context: ApplicationContext;
  routeData?: DreamsRouteData;
  dreaming: DreamingState;
  viewState: DreamingViewState;
  restartConfirmOpen: boolean;
  restartConfirmLoading: boolean;
  pendingEnabled: boolean | null;
  applyRouteData: () => void;
  applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
  loadAll: () => Promise<void>;
  openWikiPage: (lookup: string) => Promise<unknown>;
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

function contextWithGateway(client: GatewayBrowserClient, connected: boolean): ApplicationContext {
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
  return {
    gateway: { snapshot, subscribe },
    agents: {
      state: { agentsList: null },
      subscribe,
    },
    runtimeConfig: {
      state: { configSnapshot: null },
      refresh: vi.fn(async () => undefined),
      subscribe,
    },
  } as unknown as ApplicationContext;
}

function createPage(context: ApplicationContext): TestDreamsPage {
  const page = document.createElement("openclaw-dreams-page") as TestDreamsPage;
  page.context = context;
  page.render = () => nothing;
  return page;
}

async function replaceContext(page: TestDreamsPage, context: ApplicationContext) {
  page.context = context;
  page.requestUpdate();
  await page.updateComplete;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("DreamsPage gateway lifecycle", () => {
  it("preserves matching route data on the first gateway bind", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithGateway(client, true);
    const status = { enabled: true } as DreamingState["dreamingStatus"];
    const state = createDreamingState({ client, connected: true });
    state.dreamingStatus = status;
    const page = createPage(context);
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      state,
    };
    page.applyRouteData();

    document.body.append(page);
    await page.updateComplete;

    expect(page.dreaming.dreamingStatus).toBe(status);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects preloaded data after a same-client gateway epoch change", async () => {
    const client = {} as GatewayBrowserClient;
    const context = contextWithGateway(client, true);
    const staleState = createDreamingState({ client, connected: true });
    staleState.dreamDiaryContent = "stale";
    const page = createPage(context);
    page.loadAll = vi.fn(async () => undefined);
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: { ...context.gateway.snapshot },
      state: staleState,
    };

    document.body.append(page);
    await page.updateComplete;

    expect(page.dreaming).not.toBe(staleState);
    expect(page.dreaming.dreamDiaryContent).toBeNull();
    expect(page.loadAll).toHaveBeenCalledOnce();
  });

  it("resets provider and modal state when the gateway source changes", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, false));
    document.body.append(page);
    await page.updateComplete;
    const previousState = page.dreaming;
    previousState.dreamDiaryContent = "old provider";
    page.viewState.wikiPreviewOpen = true;
    page.viewState.wikiPreviewLoading = true;
    page.viewState.wikiPreviewTitle = "Old page";
    page.viewState.wikiPreviewContent = "old wiki";
    page.restartConfirmOpen = true;
    page.restartConfirmLoading = true;
    page.pendingEnabled = true;

    await replaceContext(page, contextWithGateway(client, false));

    expect(page.dreaming).not.toBe(previousState);
    expect(page.dreaming.dreamDiaryContent).toBeNull();
    expect(page.viewState.wikiPreviewOpen).toBe(false);
    expect(page.viewState.wikiPreviewLoading).toBe(false);
    expect(page.viewState.wikiPreviewTitle).toBe("");
    expect(page.viewState.wikiPreviewContent).toBe("");
    expect(page.restartConfirmOpen).toBe(false);
    expect(page.restartConfirmLoading).toBe(false);
    expect(page.pendingEnabled).toBeNull();

    page.viewState.wikiPreviewOpen = true;
    page.restartConfirmOpen = true;
    page.restartConfirmLoading = true;
    page.pendingEnabled = false;
    page.remove();

    expect(page.viewState.wikiPreviewOpen).toBe(false);
    expect(page.restartConfirmOpen).toBe(false);
    expect(page.restartConfirmLoading).toBe(false);
    expect(page.pendingEnabled).toBeNull();
  });

  it("discards a wiki response from a replaced gateway source", async () => {
    const pending = deferred<unknown>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    document.body.append(page);
    await page.updateComplete;

    const preview = page.openWikiPage("old.md");
    await replaceContext(page, contextWithGateway(client, false));
    pending.resolve({ title: "Old", path: "old.md", content: "stale" });

    await expect(preview).resolves.toBeNull();
  });

  it("discards a wiki response across a same-client reconnect", async () => {
    const pending = deferred<unknown>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    document.body.append(page);
    await page.updateComplete;

    const previousState = page.dreaming;
    const preview = page.openWikiPage("old.md");
    page.applyGatewaySnapshot({ client, connected: false } as ApplicationGatewaySnapshot);
    page.applyGatewaySnapshot({ client, connected: true } as ApplicationGatewaySnapshot);
    pending.resolve({ title: "Old", path: "old.md", content: "stale" });

    await expect(preview).resolves.toBeNull();
    expect(page.dreaming).not.toBe(previousState);
    expect(page.viewState.wikiPreviewContent).toBe("");
  });
});
