/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "./api/gateway.ts";
import { createWorkboardCatalogRuntime } from "./catalog.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { getWorkboardState } from "./lib/workboard/runtime.ts";
type WorkboardCatalogSnapshot = Parameters<Parameters<typeof createWorkboardCatalogRuntime>[0]>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
  it("publishes board metadata and clears owned readiness on disposal", async () => {
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const request = vi.fn().mockResolvedValue({
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
    const first = deferred<{ boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ boards: [board("ops")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const runtime = createWorkboardCatalogRuntime(
      (snapshot) => snapshots.push(snapshot),
      createHost(),
    );
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    runtime.handleGatewayEvent("plugin.workboard.changed");
    first.resolve({ boards: [board("default")] });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.dispose();
  });

  it("does not let an old client repopulate a replacement catalog", async () => {
    const first = deferred<{ boards: ReturnType<typeof board>[] }>();
    const second = deferred<{ boards: ReturnType<typeof board>[] }>();
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
    first.resolve({ boards: [board("stale")] });
    second.resolve({ boards: [board("current")] });

    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("current"));
    expect(firstRequest).toHaveBeenCalledOnce();
    expect(secondRequest).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("preserves the cached catalog when an in-flight refresh resolves after disconnect", async () => {
    const pending = deferred<{ boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ boards: [board("ops")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ boards: [board("platform")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const host = createHost();
    const runtime = createWorkboardCatalogRuntime((snapshot) => snapshots.push(snapshot), host);
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.handleGatewayEvent("plugin.workboard.changed");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    runtime.sync(client, false);
    pending.resolve({ boards: [board("stale")] });
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
    const pending = deferred<{ boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ boards: [board("ops")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ boards: [board("platform")] });
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

    pending.resolve({ boards: [board("stale")] });
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
      .mockResolvedValueOnce({ boards: [board("ops")] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ boards: [board("platform")] });
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
      .mockResolvedValueOnce({ boards: [board("ops")] })
      .mockResolvedValueOnce({ boards: [board("platform")] });
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
