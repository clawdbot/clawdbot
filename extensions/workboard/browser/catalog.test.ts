/* @vitest-environment jsdom */

import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "./api/gateway.ts";
import { createWorkboardCatalogRuntime } from "./catalog.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { loadWorkboard } from "./lib/workboard/loading.ts";
import { moveWorkboardCard } from "./lib/workboard/mutations.ts";
import { getWorkboardState } from "./lib/workboard/runtime.ts";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
type WorkboardCatalogSnapshot = Parameters<Parameters<typeof createWorkboardCatalogRuntime>[0]>[0];

const board = (id: string) => ({
  id,
  total: 0,
  active: 0,
  archived: 0,
  byStatus: {},
});

const createHost = () => createWorkboardCapability();

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Workboard catalog", () => {
  it("hydrates shared cards without completing task readiness or clearing recovery state", async () => {
    const card = createWorkboardCard({ sessionKey: "agent:writer:captured" });
    const request = vi.fn().mockResolvedValue({ cards: [card], boards: [board("ops")] });
    const host = createHost();
    const runtime = createWorkboardCatalogRuntime(() => {}, host);
    const client = { request } as unknown as GatewayBrowserClient;
    try {
      runtime.sync(client, true);
      await vi.waitFor(() => expect(host.boardsReady).toBe(true));
      expect(host.state.cards).toEqual([card]);
      expect(host.state.loaded).toBe(false);
      expect(host.state.loadAttempted).toBe(false);

      Object.assign(host.state, {
        loaded: true,
        loadAttempted: true,
        lifecycleTasksPrepared: true,
        mutationReadiness: "canonical_reload_required",
        error: "Recover the previous save",
        lastRefreshError: "Task refresh unavailable",
      });
      request.mockResolvedValueOnce({
        cards: [{ ...card, title: "Updated title" }],
        boards: [board("ops")],
      });
      runtime.handleGatewayEvent("plugin.workboard.changed");
      await vi.waitFor(() => expect(host.state.cards[0]?.title).toBe("Updated title"));
      expect(host.state).toMatchObject({
        loaded: true,
        loadAttempted: true,
        lifecycleTasksPrepared: true,
        mutationReadiness: "canonical_reload_required",
        error: "Recover the previous save",
        lastRefreshError: "Task refresh unavailable",
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "workboard.cards.list",
        "workboard.cards.list",
      ]);
    } finally {
      runtime.dispose();
      host.dispose();
    }
  });

  it("does not satisfy a full page load with pending catalog hydration", async () => {
    const pending = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ cards: [] });
    const host = createHost();
    const runtime = createWorkboardCatalogRuntime(() => {}, host);
    const client = { request } as unknown as GatewayBrowserClient;
    try {
      runtime.sync(client, true);
      const fullLoad = loadWorkboard({ host, client });
      pending.resolve({ cards: [], boards: [board("ops")] });
      await expect(fullLoad).resolves.toBe(true);
      expect(request).toHaveBeenCalledTimes(2);
      expect(host.state.loaded).toBe(true);
      expect(host.state.loadAttempted).toBe(true);
    } finally {
      runtime.dispose();
      host.dispose();
    }
  });

  it("does not overwrite a completed mutation with an older catalog response", async () => {
    const card = createWorkboardCard();
    const moved = { ...card, status: "review" as const, updatedAt: 2 };
    const pending = createDeferred<unknown>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [card], boards: [board("ops")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ card: moved });
    const host = createHost();
    const runtime = createWorkboardCatalogRuntime(() => {}, host);
    const client = { request } as unknown as GatewayBrowserClient;
    try {
      runtime.sync(client, true);
      await vi.waitFor(() => expect(host.boardsReady).toBe(true));
      runtime.handleGatewayEvent("plugin.workboard.changed");
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await moveWorkboardCard({ host, client, cardId: card.id, status: "review", position: 1000 });
      pending.resolve({ cards: [card], boards: [board("ops")] });
      await pending.promise;
      expect(host.state.cards).toEqual([moved]);
    } finally {
      runtime.dispose();
      host.dispose();
    }
  });

  it("publishes board metadata and clears owned readiness on disposal", async () => {
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const request = vi.fn().mockResolvedValue({
      cards: [],
      boards: [{ ...board("ops"), name: "Operations", icon: "⚙", color: "#22c55e" }],
    });
    const host = createHost();
    const runtime = createWorkboardCatalogRuntime((snapshot) => snapshots.push(snapshot), host);

    runtime.sync({ request } as unknown as GatewayBrowserClient, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.ready).toBe(true));
    const loaded = snapshots.at(-1)?.boards[0];
    expect(loaded).toEqual({ id: "ops", name: "Operations", icon: "⚙", color: "#22c55e" });
    expect(getWorkboardState(host).boards[0]?.id).toBe("ops");

    runtime.dispose();
    expect(getWorkboardState(host).boards).toEqual([]);
    expect(host.boardsReady).toBe(false);
  });

  it("queues a forced refresh behind the current client load", async () => {
    const first = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const runtime = createWorkboardCatalogRuntime(
      (snapshot) => snapshots.push(snapshot),
      createHost(),
    );
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    runtime.handleGatewayEvent("plugin.workboard.changed");
    first.resolve({ cards: [], boards: [board("default")] });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.dispose();
  });

  it("does not let an old client repopulate a replacement catalog", async () => {
    const first = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const second = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const firstRequest = vi.fn(() => first.promise);
    const secondRequest = vi.fn(() => second.promise);
    const firstClient = { request: firstRequest } as unknown as GatewayBrowserClient;
    const secondClient = { request: secondRequest } as unknown as GatewayBrowserClient;
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const runtime = createWorkboardCatalogRuntime(
      (snapshot) => snapshots.push(snapshot),
      createHost(),
    );

    runtime.sync(firstClient, true);
    runtime.handleGatewayEvent("plugin.workboard.changed");
    runtime.sync(secondClient, true);
    first.resolve({ cards: [], boards: [board("stale")] });
    second.resolve({ cards: [], boards: [board("current")] });

    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("current"));
    expect(firstRequest).toHaveBeenCalledOnce();
    expect(secondRequest).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("preserves the cached catalog when an in-flight refresh resolves after disconnect", async () => {
    const pending = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ cards: [], boards: [board("platform")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const host = createHost();
    const runtime = createWorkboardCatalogRuntime((snapshot) => snapshots.push(snapshot), host);
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.handleGatewayEvent("plugin.workboard.changed");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    runtime.sync(client, false);
    pending.resolve({ cards: [], boards: [board("stale")] });
    await pending.promise;

    expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops");
    expect(getWorkboardState(host).boards[0]?.id).toBe("ops");
    expect(host.boardsReady).toBe(true);

    runtime.sync(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform"));
    expect(getWorkboardState(host).boards[0]?.id).toBe("platform");
    runtime.dispose();
  });

  it("does not let a pre-disconnect response overwrite a reconnected catalog", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ cards: [], boards: [board("platform")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const host = createHost();
    const runtime = createWorkboardCatalogRuntime((snapshot) => snapshots.push(snapshot), host);
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.handleGatewayEvent("plugin.workboard.changed");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    runtime.sync(client, false);
    runtime.sync(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform"));

    pending.resolve({ cards: [], boards: [board("stale")] });
    await pending.promise;

    await vi.advanceTimersByTimeAsync(2_000);

    expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform");
    expect(getWorkboardState(host).boards[0]?.id).toBe("platform");
    expect(host.boardsReady).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });

  it("preserves catalog data and retries a malformed forced refresh", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ cards: [], boards: [board("platform")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const runtime = createWorkboardCatalogRuntime(
      (snapshot) => snapshots.push(snapshot),
      createHost(),
    );
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.handleGatewayEvent("plugin.workboard.changed");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    runtime.sync(client, true);
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform"));
    runtime.dispose();
  });

  it("forces a catalog refresh after reconnect", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] })
      .mockResolvedValueOnce({ cards: [], boards: [board("platform")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const runtime = createWorkboardCatalogRuntime(
      (snapshot) => snapshots.push(snapshot),
      createHost(),
    );
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    runtime.sync(client, false);
    runtime.sync(client, true);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform"));
    runtime.dispose();
  });
});
