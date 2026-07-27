/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createWorkboardCapability } from "../lib/workboard/capability.ts";
import { getWorkboardState } from "../lib/workboard/runtime.ts";
import {
  createSidebarWorkboardRuntime,
  renderSidebarWorkboardCustomize,
  renderSidebarWorkboardEntry,
} from "./app-sidebar-workboard.runtime.ts";
import type { SidebarWorkboardSnapshot } from "./app-sidebar-workboard.ts";

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

describe("sidebar Workboard runtime", () => {
  it("loads board metadata and renders entry and customize elements", async () => {
    const snapshots: SidebarWorkboardSnapshot[] = [];
    const request = vi.fn().mockResolvedValue({
      boards: [{ ...board("ops"), name: "Operations", icon: "⚙", color: "#22c55e" }],
    });
    const host = createHost();
    const runtime = createSidebarWorkboardRuntime((snapshot) => snapshots.push(snapshot), host);

    runtime.sync({ request } as unknown as GatewayBrowserClient, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.ready).toBe(true));
    const loaded = snapshots.at(-1)?.boards[0];
    expect(loaded).toEqual({ id: "ops", name: "Operations", icon: "⚙", color: "#22c55e" });
    expect(getWorkboardState(host).boards[0]?.id).toBe("ops");

    const container = document.createElement("div");
    render(
      renderSidebarWorkboardEntry({
        board: loaded!,
        basePath: "/control",
        active: true,
        onNavigate: () => undefined,
      }),
      container,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/control/workboard/ops");
    expect(container.textContent).toContain("Operations (ops)");
    expect(container.querySelector(".workboard-board-glyph")?.textContent?.trim()).toBe("⚙");

    render(
      html`<wa-dropdown>
        ${renderSidebarWorkboardCustomize(snapshots.at(-1)?.boards ?? [], ["workboard:ops"])}
      </wa-dropdown>`,
      container,
    );
    const dropdown = container.querySelector("wa-dropdown");
    expect(dropdown?.textContent).toContain("WorkBoard");
    expect(dropdown?.querySelector(':scope > [value="workboard:ops"]')).not.toBeNull();
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
    const snapshots: SidebarWorkboardSnapshot[] = [];
    const runtime = createSidebarWorkboardRuntime(
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
    const snapshots: SidebarWorkboardSnapshot[] = [];
    const runtime = createSidebarWorkboardRuntime(
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

  it("preserves catalog data and retries a malformed forced refresh", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ boards: [board("ops")] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ boards: [board("platform")] });
    const snapshots: SidebarWorkboardSnapshot[] = [];
    const runtime = createSidebarWorkboardRuntime(
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
    const snapshots: SidebarWorkboardSnapshot[] = [];
    const runtime = createSidebarWorkboardRuntime(
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
