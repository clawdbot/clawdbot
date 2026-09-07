/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  catalogErrorPage,
  catalogPage,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.ts";

const page = (number: number, label = "Original", nextCursor = `page-${number + 1}`) =>
  catalogPage([{ threadId: `thread-${number}`, name: `${label} ${number}` }], nextCursor);

async function settle(sidebar: SidebarLifecycleState) {
  await vi.advanceTimersByTimeAsync(0);
  await sidebar.updateComplete;
}

async function loadMore(sidebar: SidebarLifecycleState) {
  const button = sidebar.querySelector<HTMLButtonElement>(
    '[data-session-catalog-load-more="codex"]',
  );
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(false);
  button?.click();
  await settle(sidebar);
}

async function mountExpanded(request: ReturnType<typeof vi.fn>) {
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: {
      features: { methods: ["sessions.catalog.list"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const mounted = await mountSidebar(gateway.gateway, createSessions("main", ["agent:main:main"]));
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  await settle(mounted.sidebar);
  await loadMore(mounted.sidebar);
  await loadMore(mounted.sidebar);
  expect(request).toHaveBeenCalledTimes(3);
  expect(mounted.sidebar.textContent).toContain("Original 3");
  return { ...mounted, gateway };
}

describe("AppSidebar expanded catalog refresh visibility", () => {
  let visibility: DocumentVisibilityState;
  let restoreVisibility: () => void;

  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    restoreVisibility = () => spy.mockRestore();
  });

  afterEach(() => {
    restoreVisibility();
    vi.useRealTimers();
  });

  it.each(["base", "expanded"] as const)(
    "stops new automatic pages after hiding during the %s response and catches up once",
    async (heldStage) => {
      const pending = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(page(1))
        .mockResolvedValueOnce(page(2))
        .mockResolvedValueOnce(page(3));
      if (heldStage === "base") {
        request.mockReturnValueOnce(pending.promise);
      } else {
        request.mockResolvedValueOnce(page(1, "Refreshed"));
        request.mockReturnValueOnce(pending.promise);
      }
      request.mockImplementation((_method, params: { cursors?: Record<string, string> }) => {
        const cursor = params.cursors?.["gateway:local"];
        return Promise.resolve(
          page(cursor === "page-2" ? 2 : cursor === "page-3" ? 3 : 1, "Refreshed"),
        );
      });
      const { sidebar } = await mountExpanded(request);
      await vi.advanceTimersByTimeAsync(30_000);
      const issuedBeforeHide = heldStage === "base" ? 4 : 5;
      expect(request).toHaveBeenCalledTimes(issuedBeforeHide);

      setVisibility("hidden");
      pending.resolve(page(heldStage === "base" ? 1 : 2, "Refreshed"));
      await settle(sidebar);
      await vi.advanceTimersByTimeAsync(60_000);
      expect.soft(request).toHaveBeenCalledTimes(issuedBeforeHide);
      const host = sidebar.sessionData.sessionCatalogs[0]?.hosts[0];
      expect(host?.sessions.map((row) => row.threadId)).toEqual([
        "thread-1",
        "thread-2",
        "thread-3",
      ]);
      expect(host?.nextCursor).toBe("page-4");

      const baseCallsBeforeShow = request.mock.calls.filter(([, params]) => !params.cursors).length;
      const callsBeforeShow = request.mock.calls.length;
      setVisibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(50);
      await settle(sidebar);
      expect(request.mock.calls.filter(([, params]) => !params.cursors)).toHaveLength(
        baseCallsBeforeShow + 1,
      );
      expect(request).toHaveBeenCalledTimes(callsBeforeShow + 3);
      expect(sidebar.textContent).toContain("Refreshed 1");
      expect(sidebar.textContent).toContain("Refreshed 2");
      expect(sidebar.textContent).toContain("Refreshed 3");
    },
  );

  it("replays every loaded page while visible", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2))
      .mockResolvedValueOnce(page(3))
      .mockResolvedValueOnce(page(1, "Refreshed"))
      .mockResolvedValueOnce(page(2, "Refreshed"))
      .mockResolvedValueOnce(page(3, "Refreshed"));
    const { sidebar } = await mountExpanded(request);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(sidebar);
    expect(request).toHaveBeenCalledTimes(6);
    expect(sidebar.textContent).toContain("Refreshed 3");
    expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("page-4");
  });

  it.each(["success", "error"] as const)(
    "accepts an already-issued manual Load More %s while hidden",
    async (outcome) => {
      const pending = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(page(1))
        .mockResolvedValueOnce(page(2))
        .mockResolvedValueOnce(page(3))
        .mockReturnValueOnce(pending.promise);
      const { sidebar } = await mountExpanded(request);
      await loadMore(sidebar);
      expect(request).toHaveBeenCalledTimes(4);
      setVisibility("hidden");
      pending.resolve(
        outcome === "success" ? page(4, "Manual", "") : catalogErrorPage("Page failed"),
      );
      await settle(sidebar);
      expect(sidebar.sessionData.loadingMoreSessionCatalogIds.size).toBe(0);
      expect(request).toHaveBeenCalledTimes(4);
      expect(sidebar.textContent).toContain("Original 3");
      const host = sidebar.sessionData.sessionCatalogs[0]?.hosts[0];
      if (outcome === "success") {
        expect(sidebar.textContent).toContain("Manual 4");
        expect(host?.nextCursor).toBeUndefined();
      } else {
        expect(host?.error?.message).toBe("Page failed");
        expect(host?.nextCursor).toBe("page-4");
      }
    },
  );

  it("does not fetch another page after the sidebar unmounts", async () => {
    const pending = deferred<SessionsCatalogListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2))
      .mockResolvedValueOnce(page(3))
      .mockReturnValueOnce(pending.promise);
    const { sidebar, provider } = await mountExpanded(request);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(4);
    provider.remove();
    pending.resolve(page(1, "Retired"));
    await settle(sidebar);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("keeps resources retired during a detached update and resumes on reconnect", async () => {
    const observed = new Set<Element>();
    const observe = vi.fn((target: Element) => observed.add(target));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private targets = new Set<Element>();
        observe(target: Element) {
          this.targets.add(target);
          observe(target);
        }
        disconnect() {
          for (const target of this.targets) {
            observed.delete(target);
          }
          this.targets.clear();
        }
        unobserve(target: Element) {
          this.targets.delete(target);
          observed.delete(target);
        }
      },
    );
    let mounted: Awaited<ReturnType<typeof mountExpanded>> | undefined;
    try {
      const request = vi.fn((_method, params: { cursors?: Record<string, string> }) => {
        const cursor = params.cursors?.["gateway:local"];
        return Promise.resolve(page(cursor === "page-2" ? 2 : cursor === "page-3" ? 3 : 1));
      });
      mounted = await mountExpanded(request);
      const { sidebar, provider } = mounted;
      const scrollBody = sidebar.querySelector(".sidebar-shell__body");
      expect(scrollBody).not.toBeNull();
      expect(observed.has(scrollBody!)).toBe(true);

      sidebar.requestUpdate();
      provider.remove();
      expect(observed.has(scrollBody!)).toBe(false);
      const timersAfterDetach = vi.getTimerCount();
      const observationsAfterDetach = observe.mock.calls.length;
      await sidebar.updateComplete;
      expect.soft(vi.getTimerCount()).toBe(timersAfterDetach);
      expect.soft(observe).toHaveBeenCalledTimes(observationsAfterDetach);
      expect.soft(observed.has(scrollBody!)).toBe(false);

      document.body.append(provider);
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      await settle(sidebar);
      expect(observed.has(sidebar.querySelector(".sidebar-shell__body")!)).toBe(true);
      expect(request).toHaveBeenCalledTimes(4);
      expect(sidebar.textContent).toContain("Original 1");
    } finally {
      mounted?.provider.remove();
      await mounted?.sidebar.updateComplete;
      // A red lifecycle assertion must not leave its retired resources in the next test.
      vi.clearAllTimers();
      vi.unstubAllGlobals();
    }
  });

  it("accepts a complete exhausted first page while hidden", async () => {
    const pending = deferred<SessionsCatalogListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2))
      .mockResolvedValueOnce(page(3))
      .mockReturnValueOnce(pending.promise);
    const { sidebar } = await mountExpanded(request);
    await vi.advanceTimersByTimeAsync(30_000);
    setVisibility("hidden");
    pending.resolve(page(1, "Only remaining", ""));
    await settle(sidebar);
    expect(request).toHaveBeenCalledTimes(4);
    expect(sidebar.textContent).toContain("Only remaining 1");
    expect(sidebar.textContent).not.toContain("Original 3");
    expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBeUndefined();
  });
});
