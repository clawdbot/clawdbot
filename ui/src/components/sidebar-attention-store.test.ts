/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { CronJobsListResult, CronStatus, ModelAuthStatusResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  client as mockClient,
  createGatewayHarness,
  deferred,
} from "../app/overlays-access.test-support.ts";
import {
  createSidebarAttentionStore,
  type SidebarAttentionStore,
} from "../app/sidebar-attention-store.ts";
import { hiddenScopeUpgradeCapability } from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { dismissSidebarAttention, loadDismissals } from "./sidebar-attention-dismissals.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";

function cronPage(id?: string): CronJobsListResult {
  const jobs = id
    ? [
        {
          id,
          name: id,
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "every" as const, everyMs: 60_000 },
          sessionTarget: "isolated" as const,
          wakeMode: "now" as const,
          payload: { kind: "agentTurn" as const, message: "test" },
          state: { lastRunStatus: "error" as const },
        },
      ]
    : [];
  return {
    jobs,
    snapshotRevision: id ?? "empty",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

describe("sidebar attention source publication", () => {
  let store: SidebarAttentionStore | undefined;

  afterEach(() => {
    store?.dispose();
    store = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createStore(gateway: ApplicationContext["gateway"]) {
    const agentSelection = {
      state: { selectedId: "main", scopeId: null },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agentSelection"];
    return createSidebarAttentionStore({
      gateway,
      agentSelection,
      agents: {
        state: { agentsList: null },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["agents"],
      overlays: {
        snapshot: { approvalQueue: [] },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["overlays"],
      scopeUpgrade: hiddenScopeUpgradeCapability,
    });
  }

  it.each(["list", "status"] as const)(
    "coalesces cron bursts until the whole inventory pair settles (%s first)",
    async (first) => {
      const pendingList = deferred<CronJobsListResult>();
      const pendingStatus = deferred<CronStatus>();
      const pendingAuth = deferred<ModelAuthStatusResult>();
      const cronStatus = { enabled: true, triggersEnabled: true, jobs: 1 };
      let listCalls = 0;
      let statusCalls = 0;
      const request = vi.fn((method: string) => {
        if (method === "cron.list") {
          return ++listCalls === 1 ? pendingList.promise : Promise.resolve(cronPage("latest"));
        }
        if (method === "cron.status") {
          return ++statusCalls === 1 ? pendingStatus.promise : Promise.resolve(cronStatus);
        }
        if (method === "models.authStatus") {
          return pendingAuth.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const harness = createGatewayHarness(mockClient(request));
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);

      try {
        for (let index = 0; index < 20; index++) {
          harness.emitEvent("cron", {});
        }
        expect(listCalls).toBe(1);
        expect(statusCalls).toBe(1);
        expect(
          request.mock.calls.filter(([method]) => method === "models.authStatus"),
        ).toHaveLength(1);

        if (first === "list") {
          pendingList.resolve(cronPage("stale"));
          await pendingList.promise;
        } else {
          pendingStatus.resolve(cronStatus);
          await pendingStatus.promise;
        }
        await Promise.resolve();
        expect(listCalls).toBe(1);
        expect(statusCalls).toBe(1);

        pendingList.resolve(cronPage("stale"));
        pendingStatus.resolve(cronStatus);
        await waitForFast(() =>
          expect(store?.entries).toMatchObject([
            { type: "attention", kind: "cronFailed", label: "latest" },
          ]),
        );
        expect(listCalls).toBe(2);
        expect(statusCalls).toBe(2);
      } finally {
        store?.dispose();
        store = undefined;
        pendingList.resolve(cronPage());
        pendingStatus.resolve(cronStatus);
        pendingAuth.resolve({ ts: 1, providers: [] });
      }
    },
  );

  it.each(["settled", "pending"] as const)(
    "defers hidden cron inventory and catches up once after a %s visible read",
    async (initial) => {
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      vi.spyOn(Date, "now").mockReturnValue(120_000);
      const pendingList = deferred<CronJobsListResult>();
      let listCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "cron.list") {
          listCalls += 1;
          return initial === "pending" && listCalls === 1
            ? pendingList.promise
            : cronPage(listCalls === 1 ? "previous" : "current");
        }
        return method === "cron.status"
          ? { enabled: true, triggersEnabled: true, jobs: 1 }
          : { ts: 120_000, providers: [] };
      });
      const harness = createGatewayHarness(mockClient(request));
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);
      if (initial === "settled") {
        await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "previous" }]));
      } else {
        // A visible invalidation queued behind the pending pair also retires on hide.
        harness.emitEvent("cron", {});
      }
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 20; index++) {
        harness.emitEvent("cron", {});
      }
      pendingList.resolve(cronPage("previous"));
      await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "previous" }]));
      for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(1);
      }

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "current" }]));
      for (const method of ["cron.list", "cron.status"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
      }
      expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(
        1,
      );
    },
  );

  it("preserves another tab's dismissal when a hidden event invalidates a pending inventory", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(Date, "now").mockReturnValue(120_000);
    const pendingList = deferred<CronJobsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return ++listCalls === 1 ? pendingList.promise : cronPage("newer-job");
      }
      return method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: 1 }
        : { ts: 120_000, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    dismissSidebarAttention(harness.gateway.connection.gatewayUrl, {
      kind: "cronFailed",
      signature: "newer-job",
    });
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    // The first invalidation arrives only after hiding, with no visible queued refresh.
    harness.emitEvent("cron", {});
    pendingList.resolve(cronPage("previous"));
    await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "previous" }]));
    expect(listCalls).toBe(1);
    expect(loadDismissals(harness.gateway.connection.gatewayUrl)).toEqual({
      cronFailed: ["newer-job"],
    });

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForFast(() => expect(store?.entries).toEqual([]));
    expect(listCalls).toBe(2);
    expect(loadDismissals(harness.gateway.connection.gatewayUrl)).toEqual({
      cronFailed: ["newer-job"],
    });
  });

  it("publishes progress but retires dismissals only after a fresh complete inventory", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const pages = Array.from({ length: 5 }, () => deferred<CronJobsListResult>());
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return pages[listCalls++]!.promise;
      }
      if (method === "cron.status") {
        return { enabled: true, triggersEnabled: true, jobs: 1 };
      }
      return { ts: 1, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    pages[0]!.resolve(cronPage("dismissed"));
    await waitForFast(() => expect(store?.entries).toHaveLength(1));
    store.dismiss({ kind: "cronFailed", signature: "dismissed" });

    try {
      harness.emitEvent("cron", {});
      for (const index of [1, 2]) {
        await waitForFast(() => expect(listCalls).toBe(index + 1));
        harness.emitEvent("cron", {});
        pages[index]!.resolve(cronPage(`current-${index}`));
        await waitForFast(() =>
          expect(store?.entries).toMatchObject([{ label: `current-${index}` }]),
        );
        expect(loadDismissals(harness.gateway.connection.gatewayUrl)).toEqual({
          cronFailed: ["dismissed"],
        });
      }
      pages[3]!.resolve({ ...cronPage("partial"), hasMore: true, total: 2, nextOffset: 1 });
      await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "partial" }]));
      expect(loadDismissals(harness.gateway.connection.gatewayUrl)).toEqual({
        cronFailed: ["dismissed"],
      });
      harness.emitEvent("cron", {});
      pages[4]!.resolve(cronPage("fresh"));
      await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "fresh" }]));
      expect(loadDismissals(harness.gateway.connection.gatewayUrl)).toEqual({});
    } finally {
      store.dispose();
      for (const page of pages) {
        page.resolve(cronPage());
      }
    }
  });

  it("queues explicit auth freshness while publishing progress during repeated refreshes", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let now = 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const auth = Array.from({ length: 3 }, () => deferred<ModelAuthStatusResult>());
    let authCalls = 0;
    const harness = createGatewayHarness(
      mockClient(async (method) => {
        if (method === "cron.list") {
          return cronPage("failed-cron");
        }
        if (method === "cron.status") {
          return { enabled: true, triggersEnabled: true, jobs: 1 };
        }
        return auth[authCalls++]!.promise;
      }),
    );
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toHaveLength(1));

    try {
      for (const index of [0, 1]) {
        now += 60_001;
        for (let event = 0; event < 20; event++) {
          document.dispatchEvent(new Event("visibilitychange"));
        }
        expect(authCalls).toBe(index + 1);
        auth[index]!.resolve({
          ts: now,
          providers: [
            {
              provider: "openai",
              displayName: `Current ${index}`,
              status: "missing",
              profiles: [],
            },
          ],
        });
        await waitForFast(() => expect(authCalls).toBe(index + 2));
        expect(store.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ label: `Current ${index}` })]),
        );
      }
      for (let event = 0; event < 20; event++) {
        harness.emitEvent("cron", {});
      }
      auth[2]!.resolve({ ts: now, providers: [] });
      await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "failed-cron" }]));
      expect(authCalls).toBe(3);
    } finally {
      store.dispose();
      for (const pending of auth) {
        pending.resolve({ ts: now, providers: [] });
      }
    }
  });

  it("does not let current cron inventory postpone stale auth", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let now = 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let authCalls = 0;
    const harness = createGatewayHarness(
      mockClient(async (method) => {
        if (method === "cron.list") {
          return cronPage(`cron-${now}`);
        }
        if (method === "cron.status") {
          return { enabled: true, triggersEnabled: true, jobs: 1 };
        }
        authCalls += 1;
        return {
          ts: now,
          providers:
            authCalls === 1
              ? [{ provider: "openai", displayName: "OpenAI", status: "missing", profiles: [] }]
              : [],
        };
      }),
    );
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toHaveLength(2));
    for (let index = 0; index < 2; index++) {
      now += 30_001;
      harness.emitEvent("cron", {});
      await waitForFast(() =>
        expect(store?.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ label: `cron-${now}` })]),
        ),
      );
      expect(authCalls).toBe(1);
    }
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForFast(() => expect(store?.entries).toMatchObject([{ label: `cron-${now}` }]));
    expect(authCalls).toBe(2);
  });

  it("preserves loaded attention and dismissals when cron.list fails", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const page = cronPage("overdue");
    page.jobs[0]!.state = { lastRunStatus: "ok", nextRunAtMs: 1 };
    let failing = false;
    const request = vi.fn(async (method: string) => {
      if (failing && method === "cron.list") {
        throw new Error("temporarily unavailable");
      }
      if (method === "cron.list") {
        return page;
      }
      if (method === "cron.status") {
        return { enabled: true, triggersEnabled: true, jobs: 1 };
      }
      return { ts: 1, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toHaveLength(1));

    failing = true;
    harness.emitEvent("cron", {});
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(store.entries).toMatchObject([{ label: "overdue" }]);
    store.dismiss({ kind: "cronOverdue", signature: "overdue@1" });
    harness.emitEvent("cron", {});
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(loadDismissals(harness.gateway.connection.gatewayUrl)).toEqual({
      cronOverdue: ["overdue@1"],
    });

    failing = false;
    harness.emitEvent("cron", {});
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(store.entries).toEqual([]);
  });

  it("preserves disabled scheduler attention when cron.status fails", async () => {
    const page = cronPage("overdue");
    page.jobs[0]!.state = { lastRunStatus: "ok", nextRunAtMs: 1 };
    let failing = false;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.status") {
        if (failing) {
          throw new Error("temporarily unavailable");
        }
        return { enabled: false, triggersEnabled: true, jobs: 1 };
      }
      return method === "cron.list" ? page : { ts: 1, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(store.entries).toEqual([]);

    failing = true;
    harness.emitEvent("cron", {});
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(store.entries).toEqual([]);
  });

  it.each(["disconnect", "replace", "dispose"] as const)(
    "retires queued inventory and auth refreshes on %s",
    async (boundary) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const pendingList = deferred<CronJobsListResult>();
      const pendingStatus = deferred<CronStatus>();
      const pendingAuth = deferred<ModelAuthStatusResult>();
      const cronStatus = { enabled: true, triggersEnabled: true, jobs: 1 };
      const request = vi.fn((method: string) => {
        if (method === "cron.list") {
          return pendingList.promise;
        }
        if (method === "cron.status") {
          return pendingStatus.promise;
        }
        if (method === "models.authStatus") {
          return pendingAuth.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const harness = createGatewayHarness(mockClient(request));
      store = createStore(harness.gateway);
      const publish = vi.fn();
      store.subscribe(publish);
      store.activate(SidebarAttentionStoreController);
      harness.emitEvent("cron", {});
      document.dispatchEvent(new Event("visibilitychange"));

      try {
        if (boundary === "disconnect") {
          harness.update({ phase: "reconnecting" });
        } else if (boundary === "replace") {
          harness.update({
            client: mockClient(async (method) =>
              method === "cron.list"
                ? cronPage("replacement")
                : method === "cron.status"
                  ? cronStatus
                  : { ts: 1, providers: [] },
            ),
          });
          await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "replacement" }]));
        } else {
          store.dispose();
        }
        publish.mockClear();
        pendingList.resolve(cronPage("retired"));
        pendingStatus.resolve(cronStatus);
        pendingAuth.resolve({ ts: 1, providers: [] });
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 0);
        });

        expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(1);
        expect(request.mock.calls.filter(([method]) => method === "cron.status")).toHaveLength(1);
        expect(
          request.mock.calls.filter(([method]) => method === "models.authStatus"),
        ).toHaveLength(1);
        expect(publish).not.toHaveBeenCalled();
      } finally {
        pendingList.resolve(cronPage());
        pendingStatus.resolve(cronStatus);
        pendingAuth.resolve({ ts: 1, providers: [] });
      }
    },
  );

  it("publishes cron attention while model auth is still pending", async () => {
    let resolveModelAuth!: (status: ModelAuthStatusResult) => void;
    const modelAuth = new Promise<ModelAuthStatusResult>((resolve) => {
      resolveModelAuth = resolve;
    });
    const request = vi.fn((method: string) => {
      if (method === "cron.list") {
        return Promise.resolve(cronPage("failed-cron"));
      }
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 1 });
      }
      if (method === "models.authStatus") {
        return modelAuth;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const gateway = createGatewayHarness(mockClient(request)).gateway;
    store = createStore(gateway);
    const publishedCounts: number[] = [];
    store.subscribe(() => publishedCounts.push(store?.entries.length ?? 0));
    store.activate(SidebarAttentionStoreController);

    try {
      await waitForFast(() => expect(publishedCounts).toContain(1));
    } finally {
      resolveModelAuth({ ts: 1, providers: [] });
    }
  });

  it("creates one mention owner on activation, retains it without listeners, and disposes it", async () => {
    const mention: MentionInboxItem = {
      id: "mention-first",
      senderProfileId: "alice",
      senderLabel: "Alice",
      sessionKey: "agent:writer:review",
      agentId: "writer",
      sessionTitle: "Review",
      messageId: "message-first",
      createdAt: 1_000,
      expiresAt: 10_000,
    };
    let result = { gatewayInstanceId: "boot-a", revision: 1, items: [mention] };
    const responses: Record<string, unknown> = {
      "cron.list": {
        jobs: [],
        snapshotRevision: "lifecycle",
        total: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },
      "cron.status": { enabled: true, triggersEnabled: true, jobs: 0 },
      "models.authStatus": { ts: 1, providers: [] },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "mentions.list") {
        return result;
      }
      if (method in responses) {
        return responses[method];
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({
      hello: {
        type: "hello-ok",
        protocol: 1,
        server: { bootId: "boot-a", connId: "connection-a" },
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["mentions.list", "mentions.dismiss"] },
      },
      selfUser: { id: "bob", identity: { type: "profile", id: "bob" }, name: "Bob" },
    });
    store = createStore(harness.gateway);
    expect(request).not.toHaveBeenCalled();
    const publish = vi.fn();
    const stop = store.subscribe(publish);
    const mentions = store.activate(SidebarAttentionStoreController);
    expect(store.activate(SidebarAttentionStoreController)).toBe(mentions);
    await waitForFast(() => expect(mentions.snapshot.items).toEqual([mention]));
    expect(request.mock.calls.filter(([method]) => method === "mentions.list")).toHaveLength(1);

    stop();
    publish.mockClear();
    result = { ...result, revision: 2, items: [{ ...mention, id: "mention-second" }] };
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 2 });
    await waitForFast(() =>
      expect(store?.entries.filter((entry) => entry.type === "mention")).toMatchObject([
        { mention: { id: "mention-second" } },
      ]),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(store.activate(SidebarAttentionStoreController)).toBe(mentions);

    store.dispose();
    store = undefined;
    request.mockClear();
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 3 });
    await mentions.refresh();
    expect(request).not.toHaveBeenCalled();
  });
});
