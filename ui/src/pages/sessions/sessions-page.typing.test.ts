/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import {
  createSessionCapabilityHarness,
  sessionChangedEvent,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createContext, createGateway, createRenderedPage } from "./sessions-page.test-support.ts";

function result(key: string): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key, kind: "direct", updatedAt: 1 }],
  };
}

async function mountTypingPage(initialResult = result("agent:main:initial")) {
  const pending: Array<ReturnType<typeof createDeferred<SessionsListResult>>> = [];
  const requests: unknown[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true, list: result("agent:main:sidebar") };
    }
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    requests.push(params);
    if (requests.length === 1) {
      return initialResult;
    }
    const task = createDeferred<SessionsListResult>();
    pending.push(task);
    return task.promise;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const connection = createGateway(client);
  const sessions = createSessionCapability(connection.gateway);
  const context = createContext(connection.gateway, sessions);
  let notifyScope: Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0] = () =>
    undefined;
  context.agentSelection.subscribe = (listener) => {
    notifyScope = listener;
    return () => undefined;
  };
  const page = await createRenderedPage(context, initialResult);
  const input = () => page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
  const edit = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
  };
  const type = async (value: string) => {
    for (let length = 1; length <= value.length; length += 1) {
      await edit(value.slice(0, length));
      await vi.advanceTimersByTimeAsync(40);
    }
  };
  return {
    page,
    requests,
    pending,
    input,
    edit,
    type,
    client,
    connection,
    context,
    setScope(this: void, scopeId: string | null) {
      context.agentSelection.state.scopeId = scopeId;
      notifyScope(context.agentSelection.state);
    },
    async cleanup(this: void) {
      page.remove();
      sessions.dispose();
      pending.forEach((task) => task.resolve(result("cleanup")));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Sessions page typing ownership", () => {
  it.each(
    ["queued", "timer", "unsubscribed"]
      .flatMap((timing) =>
        [false, true].map((resubscribe) => ({ timing, resubscribe, hidden: false })),
      )
      .concat({ timing: "unsubscribed", resubscribe: true, hidden: true }),
  )(
    "retires $timing event work while unobserved and catches up on resubscribe=$resubscribe hidden=$hidden",
    async ({ timing, resubscribe, hidden }) => {
      vi.useFakeTimers();
      const visibility = vi.spyOn(document, "visibilityState", "get");
      const active = createDeferred<SessionsListResult>();
      let filteredCalls = 0;
      const request = vi.fn(async (method: string, params?: { search?: string }) => {
        expect(method).toBe("sessions.list");
        if (params?.search === "retired") {
          filteredCalls += 1;
          return filteredCalls === 1 ? active.promise : result("agent:main:updated");
        }
        return result("agent:main:sidebar");
      });
      const { sessions, emitEvent } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const query = { search: "retired", includeDerivedTitles: false };
      let unsubscribe = sessions.subscribeList(query, vi.fn());
      const loading = sessions.refreshList(query);
      try {
        if (timing !== "unsubscribed") {
          emitEvent(sessionChangedEvent("agent:main:changed"));
          if (timing === "queued") {
            await vi.advanceTimersByTimeAsync(200);
          }
        }
        unsubscribe();
        if (timing === "unsubscribed") {
          emitEvent(sessionChangedEvent("agent:main:changed"));
        }
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(200);
        expect(filteredCalls).toBe(1);
        if (hidden) {
          visibility.mockReturnValue("hidden");
          document.dispatchEvent(new Event("visibilitychange"));
        }
        if (resubscribe) {
          unsubscribe = sessions.subscribeList(query, vi.fn());
          expect(filteredCalls).toBe(1);
        }
        active.resolve(result("agent:main:retired"));
        await loading;
        if (hidden) {
          expect(filteredCalls).toBe(1);
          visibility.mockReturnValue("visible");
          document.dispatchEvent(new Event("visibilitychange"));
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(filteredCalls).toBe(resubscribe ? 2 : 1);
        if (resubscribe) {
          expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:updated");
        }
      } finally {
        active.resolve(result("agent:main:retired"));
        unsubscribe();
        sessions.dispose();
        await loading;
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it("keeps a never-observed prefetch dormant until its dirty query gains a listener", async () => {
    vi.useFakeTimers();
    const active = createDeferred<SessionsListResult>();
    let filteredCalls = 0;
    const request = vi.fn(async (method: string, params?: { search?: string }) => {
      expect(method).toBe("sessions.list");
      if (params?.search === "prefetch") {
        filteredCalls += 1;
        return filteredCalls === 1 ? active.promise : result("agent:main:updated");
      }
      return result("agent:main:sidebar");
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const query = { search: "prefetch", includeDerivedTitles: false };
    const loading = sessions.refreshList(query);
    let unsubscribe: (() => void) | undefined;
    try {
      emitEvent(sessionChangedEvent("agent:main:changed"));
      await vi.advanceTimersByTimeAsync(200);
      expect(filteredCalls).toBe(1);
      active.resolve(result("agent:main:old"));
      await loading;
      await vi.advanceTimersByTimeAsync(200);
      expect(filteredCalls).toBe(1);
      unsubscribe = sessions.subscribeList(query, vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(filteredCalls).toBe(2);
      expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:updated");
    } finally {
      unsubscribe?.();
      sessions.dispose();
      active.resolve(result("cleanup"));
      await loading;
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it.each([false, true])(
    "retains the rename refresh during an older page request (replace query: %s)",
    async (replaceQuery) => {
      vi.useFakeTimers();
      const key = "agent:main:rename";
      const before = result(key);
      before.sessions[0]!.label = "Before rename";
      const after: SessionsListResult = {
        ...before,
        sessions: [{ ...before.sessions[0]!, label: "After rename", updatedAt: 2 }],
      };
      const patch = createDeferred<{
        ok: true;
        path: string;
        key: string;
        entry: { sessionId: string };
      }>();
      const older = createDeferred<SessionsListResult>();
      let pageRequests = 0;
      let mutationRefreshes = 0;
      const request = vi.fn(async (method: string, params?: { includeUnknown?: boolean }) => {
        if (method === "sessions.patch") {
          return patch.promise;
        }
        if (method === "sessions.compaction.list") {
          return { checkpoints: [] };
        }
        expect(method).toBe("sessions.list");
        if (params?.includeUnknown !== false) {
          mutationRefreshes += 1;
          return after;
        }
        pageRequests += 1;
        return pageRequests === 1 ? before : pageRequests === 2 ? older.promise : after;
      });
      const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
      const sessions = createSessionCapability(gateway);
      const page = await createRenderedPage(createContext(gateway, sessions), before);
      try {
        page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
        await page.updateComplete;
        const label = page.querySelector<HTMLInputElement>(".session-overrides-grid input")!;
        expect(label.disabled).toBe(false);
        label.value = "After rename";
        label.dispatchEvent(new Event("change", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledWith(
          "sessions.patch",
          expect.objectContaining({ key, label: "After rename" }),
        );
        [...page.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "Refresh")!
          .click();
        await vi.advanceTimersByTimeAsync(0);
        expect(pageRequests).toBe(2);
        patch.resolve({ ok: true, path: "", key, entry: { sessionId: "renamed-session" } });
        await vi.advanceTimersByTimeAsync(0);
        expect(mutationRefreshes).toBe(1);
        expect(pageRequests).toBe(2);
        expect(page.loading).toBe(true);
        if (replaceQuery) {
          const search = page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
          for (const value of ["n", "ne", "new"]) {
            search.value = value;
            search.dispatchEvent(new Event("input", { bubbles: true }));
            await page.updateComplete;
            await vi.advanceTimersByTimeAsync(40);
          }
          await vi.advanceTimersByTimeAsync(200);
          expect(pageRequests).toBe(2);
        }
        older.resolve(before);
        await vi.advanceTimersByTimeAsync(0);
        expect(pageRequests).toBe(3);
        expect(request.mock.calls.findLast(([method]) => method === "sessions.list")).toEqual([
          "sessions.list",
          expect.objectContaining({
            includeUnknown: false,
            ...(replaceQuery ? { search: "new" } : {}),
          }),
        ]);
        expect(page.textContent).toContain("After rename");
        expect(page.result?.sessions[0]?.label).toBe("After rename");
        expect(page.loading).toBe(false);
      } finally {
        page.remove();
        sessions.dispose();
        patch.resolve({ ok: true, path: "", key, entry: { sessionId: "renamed-session" } });
        older.resolve(before);
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it.each(["detach", "reconnect", "client", "context"])(
    "retires pending work on %s and starts the new owner's query without the old response",
    async (retirement) => {
      vi.useFakeTimers();
      const harness = await mountTypingPage();
      const { page, input, edit, requests, pending, connection, client } = harness;
      let replacementSessions: ReturnType<typeof createSessionCapability> | undefined;
      try {
        await edit("older");
        await vi.advanceTimersByTimeAsync(200);
        expect(requests).toHaveLength(2);
        await edit("latest");
        if (retirement === "detach") {
          page.remove();
        } else {
          connection.emit({ phase: "reconnecting" });
        }
        await vi.advanceTimersByTimeAsync(400);
        expect(requests).toHaveLength(2);
        if (retirement === "detach") {
          document.body.append(page);
        } else if (retirement === "context") {
          const replacement = createGateway(client);
          replacementSessions = createSessionCapability(replacement.gateway);
          page.context = createContext(replacement.gateway, replacementSessions);
          page.requestUpdate();
        } else {
          connection.emit({
            phase: "connected",
            client:
              retirement === "client"
                ? ({ request: client.request.bind(client) } as GatewayBrowserClient)
                : client,
          });
        }
        await page.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(3);
        expect(requests.at(-1)).toMatchObject({ search: "latest" });
        expect(input().value).toBe("latest");
        pending[0]!.resolve(result("agent:main:retired"));
        await vi.advanceTimersByTimeAsync(0);
        expect(page.result).toBeNull();
        expect(page.loading).toBe(true);
        expect(page.textContent).not.toContain("agent:main:retired");
        // Old completion cannot release the new connection's occupied slot.
        await edit("newest");
        await vi.advanceTimersByTimeAsync(200);
        expect(requests).toHaveLength(3);
        pending[1]!.resolve(result("agent:main:superseded"));
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(4);
        expect(requests.at(-1)).toMatchObject({ search: "newest" });
        pending[2]!.resolve(result("agent:main:final"));
        await vi.advanceTimersByTimeAsync(0);
        expect(page.result?.sessions[0]?.key).toBe("agent:main:final");
      } finally {
        replacementSessions?.dispose();
        await harness.cleanup();
      }
    },
  );

  it.each(["Refresh", "Load more sessions"])(
    "keeps last-good rows for %s but makes its slow request yield only to the latest text",
    async (action) => {
      vi.useFakeTimers();
      const initial = {
        ...result("agent:main:initial"),
        count: 50,
        hasMore: true,
        nextOffset: 50,
        totalCount: 51,
      };
      initial.sessions = Array.from({ length: 50 }, (_, index) => ({
        key: `agent:main:row-${index}`,
        kind: "direct",
        updatedAt: index,
      }));
      const harness = await mountTypingPage(initial);
      const { page, edit, pending, requests } = harness;
      try {
        [...page.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === action)!
          .click();
        await vi.advanceTimersByTimeAsync(0);
        page.context = { ...harness.context };
        page.requestUpdate();
        await page.updateComplete;
        expect(requests).toHaveLength(2);
        expect(page.result?.sessions).toHaveLength(50);
        expect(page.loading).toBe(true);
        if (action === "Load more sessions") {
          expect(requests.at(-1)).toMatchObject({ offset: 50 });
        }
        await edit("latest");
        await vi.advanceTimersByTimeAsync(200);
        expect(requests).toHaveLength(2);
        expect(page.result).toBeNull();
        pending[0]!.resolve(result("agent:main:retired"));
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(3);
        expect(requests.at(-1)).toMatchObject({ search: "latest" });
        expect(requests.at(-1)).not.toHaveProperty("offset");
        expect(page.result).toBeNull();
        pending[1]!.resolve(result("agent:main:final"));
        await vi.advanceTimersByTimeAsync(0);
        expect(page.result?.sessions.map((row) => row.key)).toEqual(["agent:main:final"]);
      } finally {
        await harness.cleanup();
      }
    },
  );

  it("coalesces scope and status edits behind a request and lets explicit filters consume debounce", async () => {
    vi.useFakeTimers();
    const harness = await mountTypingPage();
    const { page, input, edit, requests, pending, setScope } = harness;
    try {
      await edit("older");
      await vi.advanceTimersByTimeAsync(200);
      await edit("latest");
      setScope(null);
      await page.updateComplete;
      const statusGroup = page.querySelector<HTMLElement & { value: string }>(
        ".sessions-view-segment",
      )!;
      statusGroup.value = "archived";
      statusGroup.dispatchEvent(new Event("change", { bubbles: true }));
      await page.updateComplete;
      statusGroup.value = "all";
      statusGroup.dispatchEvent(new Event("change", { bubbles: true }));
      await page.updateComplete;
      expect(requests).toHaveLength(2);
      expect(page.result).toBeNull();
      pending[0]!.resolve(result("agent:main:retired"));
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toMatchObject({ search: "latest", archived: "all" });
      expect(requests.at(-1)).not.toHaveProperty("agentId");
      expect(input().value).toBe("latest");
      pending[1]!.resolve(result("agent:research:latest"));
      await vi.advanceTimersByTimeAsync(0);
      await edit("immediate");
      setScope("research");
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(4);
      expect(requests.at(-1)).toMatchObject({
        search: "immediate",
        agentId: "research",
        archived: "all",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("debounces rapid input and sends only the latest queued query behind a slow request", async () => {
    vi.useFakeTimers();
    const { page, requests, pending, input, type, cleanup } = await mountTypingPage();
    try {
      page.selectedKeys = new Set(["agent:main:initial"]);
      await type("older");
      expect.soft(requests).toHaveLength(1);
      expect(page.result).toBeNull();
      expect(page.selectedKeys.size).toBe(0);
      expect(page.loading).toBe(true);
      expect(input().value).toBe("older");
      expect(page.textContent).not.toContain("No sessions match your filters.");
      await vi.advanceTimersByTimeAsync(200);
      expect.soft(requests).toHaveLength(2);
      expect(requests.at(-1)).toMatchObject({ search: "older", limit: 50 });

      await type("superseded");
      await vi.advanceTimersByTimeAsync(200);
      // Metadata context wrappers share the same capability/connection owner.
      page.context = { ...page.context };
      page.requestUpdate();
      await page.updateComplete;
      await type("latest");
      await vi.advanceTimersByTimeAsync(200);
      expect.soft(requests).toHaveLength(2);
      pending[0]!.resolve(result("agent:main:retired"));
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(requests).toHaveLength(3);
      expect(requests.at(-1)).toMatchObject({ search: "latest", limit: 50 });
      expect(page.result).toBeNull();
      expect(page.loading).toBe(true);
      expect(page.textContent).not.toContain("agent:main:retired");
      expect(input().value).toBe("latest");
      pending.at(-1)!.resolve(result("agent:main:final"));
      await vi.advanceTimersByTimeAsync(0);
      expect(page.result?.sessions[0]?.key).toBe("agent:main:final");
      expect(page.loading).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
