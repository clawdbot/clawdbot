import type { ConversationListItem } from "@openclaw/gateway-protocol";
import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { CronState } from "../../lib/cron/index.ts";
import "./cron-page.ts";

type CronTestPage = HTMLElement & {
  context: ApplicationContext;
  routeSearch: string;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  render: () => typeof nothing;
  cron: CronState;
  cronModelSuggestions: string[];
  deliveryConversations: ConversationListItem[];
  deliveryConversationsError: string | null;
  patchForm: (patch: Partial<CronState["cronForm"]>) => void;
  closePanel: () => void;
  submitForm: () => void;
};

function waitForCronPage(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

type TestGateway = ApplicationContext["gateway"] & {
  emitSnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  emitRetiredEvent: (event: Parameters<GatewayEventListener>[0]) => void;
};

function createGateway(client: GatewayBrowserClient, connected: boolean): TestGateway {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const snapshotListeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const allEventListeners: GatewayEventListener[] = [];
  return {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      allEventListeners.push(listener);
      return () => eventListeners.delete(listener);
    },
    emitSnapshot(patch: Partial<ApplicationGatewaySnapshot>) {
      Object.assign(snapshot, patch);
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
    emitRetiredEvent(event: Parameters<GatewayEventListener>[0]) {
      for (const listener of allEventListeners) {
        listener(event);
      }
    },
  } as unknown as TestGateway;
}

function operatorHello(scopes: string[]): NonNullable<ApplicationGatewaySnapshot["hello"]> {
  return {
    type: "hello-ok",
    protocol: 4,
    auth: { role: "operator", scopes },
  };
}

function createContext(
  gateway: TestGateway,
  scopeId: string | null = "main",
  selectedId: string | null = scopeId,
): ApplicationContext {
  const subscribe = () => () => undefined;
  let selectionState = { selectedId, scopeId };
  const selectionListeners = new Set<(state: typeof selectionState) => void>();
  return {
    basePath: "",
    gateway,
    agents: {
      state: {
        agentsList: { defaultId: "main", agents: [{ id: "main" }] },
        agentsLoading: false,
        agentsError: null,
      },
      ensureList: vi.fn(async () => undefined),
      subscribe,
    },
    channels: {
      state: {
        channelsSnapshot: null,
      },
      refresh: vi.fn(async () => undefined),
      subscribe,
    },
    runtimeConfig: {
      state: { configSnapshot: null },
      subscribe,
    },
    agentSelection: {
      get state() {
        return selectionState;
      },
      set(agentId: string | null) {
        selectionState = { selectedId: agentId, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      setScope(agentId: string | null) {
        selectionState = { ...selectionState, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      subscribe(listener: (state: typeof selectionState) => void) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

function createPage(context: ApplicationContext, options: { render?: boolean } = {}): CronTestPage {
  const page = document.createElement("openclaw-cron-page") as CronTestPage;
  page.context = context;
  if (!options.render) {
    page.render = () => nothing;
  }
  document.body.append(page);
  return page;
}

function cronListResponse(jobs: CronJob[]): CronJobsListResult {
  return {
    jobs: jobs.map((job) => ({
      configRevision: job.configRevision ?? `config-revision-${job.id}`,
      ...job,
    })),
    snapshotRevision: "cron-page-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function createRequest(
  cronStatus: { enabled: boolean; jobs: number; triggersEnabled: boolean } = {
    enabled: true,
    jobs: 0,
    triggersEnabled: true,
  },
) {
  return vi.fn(async (method: string) => {
    if (method === "cron.status") {
      return { ...cronStatus };
    }
    if (method === "cron.list") {
      return cronListResponse([]);
    }
    if (method === "cron.runs") {
      return { entries: [], total: 0, offset: 0, hasMore: false };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    return {};
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage lifecycle", () => {
  it("loads configured conversation targets for the selected announce channel", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "conversations.list") {
        return {
          conversations: [
            {
              conversationRef: "conv_telegram_configured_group",
              channel: "telegram",
              accountId: "default",
              kind: "group",
              target: "-1009876543210",
              label: "Configured group",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });

    await waitForCronPage(() => expect(page.deliveryConversations).toHaveLength(1));
    expect(request).toHaveBeenCalledWith("conversations.list", {
      agentId: "writer",
      channel: "telegram",
      limit: 100,
    });
    expect(page.deliveryConversations.map((entry) => entry.target)).toEqual(["-1009876543210"]);
  });

  it("rejects conversation targets from an earlier channel selection", async () => {
    const telegram = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "conversations.list") {
        const channel = (params as { channel: string }).channel;
        if (channel === "telegram") {
          return telegram.promise;
        }
        return {
          conversations: [
            {
              conversationRef: "conv_discord_current",
              channel: "discord",
              accountId: "default",
              kind: "channel",
              target: "channel:current",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    page.patchForm({ deliveryChannel: "discord" });
    await waitForCronPage(() =>
      expect(page.deliveryConversations.map((entry) => entry.target)).toEqual(["channel:current"]),
    );

    telegram.resolve({
      conversations: [
        {
          conversationRef: "conv_telegram_stale",
          channel: "telegram",
          accountId: "default",
          kind: "group",
          target: "-100stale",
          firstSeenAt: 0,
          lastSeenAt: 0,
        },
      ],
    });
    await Promise.resolve();
    expect(page.deliveryConversations.map((entry) => entry.target)).toEqual(["channel:current"]);
  });

  it("filters a cached directory locally when the account changes", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return {
          conversations: [
            {
              conversationRef: "conv_telegram_personal",
              channel: "telegram",
              accountId: "personal",
              kind: "group",
              target: "-100personal",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
            {
              conversationRef: "conv_telegram_work",
              channel: "telegram",
              accountId: "work",
              kind: "group",
              target: "-100work",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryConversations).toHaveLength(2));

    page.patchForm({ deliveryAccountId: "work" });
    await page.updateComplete;

    expect(request.mock.calls.filter(([method]) => method === "conversations.list")).toHaveLength(
      1,
    );
    expect(page.deliveryConversations).toHaveLength(2);
    expect(page.cron.cronForm.deliveryAccountId).toBe("work");
  });

  it("drops an in-flight directory response after administrator access is lost", async () => {
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return pending.promise;
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
    pending.resolve({
      conversations: [
        {
          conversationRef: "conv_telegram_private",
          channel: "telegram",
          accountId: "private",
          kind: "group",
          target: "-100private",
          firstSeenAt: 0,
          lastSeenAt: 0,
        },
      ],
    });
    await Promise.resolve();

    expect(page.deliveryConversations).toEqual([]);
  });

  it("keeps an explicit suggestion account without inferring topic routing", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return {
          conversations: [
            {
              conversationRef: "conv_telegram_bound_topic",
              channel: "telegram",
              accountId: "bound-account",
              kind: "group",
              target: "-1009876543210",
              threadId: "42",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryConversations).toHaveLength(1));

    page.patchForm({ deliveryAccountId: "bound-account" });
    page.patchForm({ deliveryTo: "-1009876543210" });

    expect(page.cron.cronForm.deliveryAccountId).toBe("bound-account");
    expect(page.cron.cronForm.deliveryThreadId).toBeUndefined();
  });

  it("clears stale topic metadata when an explicitly authored target changes", async () => {
    const page = createPage(
      createContext(
        createGateway({ request: createRequest() } as unknown as GatewayBrowserClient, true),
        "writer",
      ),
    );

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({
      deliveryMode: "announce",
      deliveryChannel: "telegram",
      deliveryAccountId: "operator-account",
      deliveryTo: "-100old",
      deliveryThreadId: "42",
    });
    page.patchForm({ deliveryTo: "-100new" });

    expect(page.cron.cronForm.deliveryAccountId).toBe("operator-account");
    expect(page.cron.cronForm.deliveryThreadId).toBeUndefined();
  });

  it("drops an in-flight directory failure after the editor closes", async () => {
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return pending.promise;
      }
      return fallbackRequest(method);
    });
    const page = createPage(
      createContext(createGateway({ request } as unknown as GatewayBrowserClient, true), "writer"),
    );

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    page.closePanel();
    pending.reject(new Error("late directory failure"));
    await Promise.resolve();

    expect(page.deliveryConversations).toEqual([]);
    expect(page.deliveryConversationsError).toBeNull();
  });

  it("drops an in-flight directory failure after a successful save", async () => {
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return pending.promise;
      }
      return fallbackRequest(method);
    });
    const page = createPage(
      createContext(createGateway({ request } as unknown as GatewayBrowserClient, true), "writer"),
    );

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.cron.cronCreateOpen = true;
    page.patchForm({
      name: "Saved task",
      payloadText: "Send the digest",
      deliveryMode: "announce",
      deliveryChannel: "telegram",
      deliveryTo: "-100saved",
    });
    page.submitForm();
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("cron.add", expect.anything()),
    );
    await waitForCronPage(() => expect(page.cron.cronCreateOpen).toBe(false));

    pending.reject(new Error("late directory failure"));
    await Promise.resolve();

    expect(page.deliveryConversations).toEqual([]);
    expect(page.deliveryConversationsError).toBeNull();
  });

  it("clears a recipient directory error after a successful retry", async () => {
    let calls = 0;
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary directory failure");
        }
        return {
          conversations: [
            {
              conversationRef: "conv_telegram_recovered",
              channel: "telegram",
              accountId: "work",
              kind: "group",
              target: "-100recovered",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryConversationsError).toContain("temporary"));

    page.patchForm({ deliveryChannel: "discord" });
    page.patchForm({ deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryConversations).toHaveLength(1));

    expect(page.deliveryConversationsError).toBeNull();
  });

  it("keeps scheduler errors visible over recipient directory errors", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        throw new Error("temporary directory failure");
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"), { render: true });

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryConversationsError).toContain("temporary"));
    page.cron = { ...page.cron, cronError: "scheduler save failed" };
    page.requestUpdate();
    await page.updateComplete;

    expect(page.textContent).toContain("scheduler save failed");
    expect(page.textContent).not.toContain("temporary directory failure");
  });

  it("registers idempotently when the module is evaluated again", async () => {
    const registered = customElements.get("openclaw-cron-page");
    expect(registered).toBeDefined();

    const freshModulePath = "./cron-page.ts?custom-element-idempotence";
    await expect(import(/* @vite-ignore */ freshModulePath)).resolves.toBeDefined();

    expect(customElements.get("openclaw-cron-page")).toBe(registered);
  });

  it("replaces all mutable page state on each connection epoch", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway));
    await page.updateComplete;
    const connectedState = page.cron;
    page.cron = {
      ...connectedState,
      cronStatus: { enabled: true, triggersEnabled: true, jobs: 1 },
      cronJobs: [{ id: "old" } as never],
      cronCreateOpen: true,
    };
    page.cronModelSuggestions = ["old/model"];

    gateway.emitSnapshot({ phase: "stopped" });
    const disconnectedState = page.cron;

    expect(disconnectedState).not.toBe(connectedState);
    expect(disconnectedState.cronStatus).toBeNull();
    expect(disconnectedState.cronJobs).toEqual([]);
    expect(page.cronModelSuggestions).toEqual([]);
    expect(disconnectedState.cronCreateOpen).toBe(false);

    gateway.emitSnapshot({ phase: "connected" });
    expect(page.cron).not.toBe(disconnectedState);
  });

  it("refreshes trigger authoring from scheduler status after reconnect", async () => {
    const schedulerStatus = { enabled: true, jobs: 0, triggersEnabled: true };
    const request = createRequest(schedulerStatus);
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const context = createContext(gateway);
    Object.assign(context.runtimeConfig.state, {
      configForm: { cron: { triggers: { enabled: true } } },
      configNeedsApply: true,
    });
    const page = createPage(context, { render: true });

    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: true }),
    );
    schedulerStatus.triggersEnabled = false;
    gateway.emitSnapshot({ phase: "stopped" });
    expect(page.cron.cronStatus).toBeNull();
    gateway.emitSnapshot({ phase: "connected" });

    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: false }),
    );
    expect(request.mock.calls.filter(([method]) => method === "cron.status")).toHaveLength(2);
    (page.querySelector('[data-test-id="cron-new-task"]') as HTMLButtonElement).click();
    await waitForCronPage(() => expect(page.querySelector("fieldset.cron-editor")).not.toBeNull());

    const triggerToggle = Array.from(page.querySelectorAll("wa-switch.settings-toggle")).find(
      (toggle) => toggle.textContent?.includes("Condition trigger"),
    );
    expect(triggerToggle).toBeUndefined();
    expect(page.textContent).toContain("disabled by cron.triggers.enabled");
  });

  it("rejects model suggestions from an earlier connection epoch", async () => {
    const staleModels = createDeferred<{ models: Array<{ id: string }> }>();
    let modelRequestCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        modelRequestCount += 1;
        return modelRequestCount === 1 ? staleModels.promise : { models: [{ id: "fresh/model" }] };
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, false);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(modelRequestCount).toBe(1));
    gateway.emitSnapshot({ phase: "stopped" });
    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["fresh/model"]));

    staleModels.resolve({ models: [{ id: "stale/model" }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(page.cronModelSuggestions).toEqual(["fresh/model"]);
  });

  it("ignores a cron event callback retained by a replaced gateway source", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const firstGateway = createGateway(client, true);
    const secondGateway = createGateway(client, true);
    const firstContext = createContext(firstGateway);
    const secondContext = createContext(secondGateway);
    const page = createPage(firstContext);
    await waitForCronPage(() => expect(request).toHaveBeenCalled());

    page.context = secondContext;
    page.requestUpdate();
    await page.updateComplete;
    await waitForCronPage(() => expect(page.cron.client).toBe(client));
    request.mockClear();
    vi.mocked(secondContext.channels.refresh).mockClear();

    firstGateway.emitRetiredEvent({ event: "cron" } as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    expect(secondContext.channels.refresh).not.toHaveBeenCalled();
  });
});
