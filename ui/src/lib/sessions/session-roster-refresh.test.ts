// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createSessionCapabilityHarness,
  sessionChangedEvent,
  sessionsResult,
} from "./session-capability.test-support.ts";

const EVENT_REFRESH_DEBOUNCE_MS = 200;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session roster refresh coordination", () => {
  it("runs one event refresh after a burst during an explicit refresh", async () => {
    vi.useFakeTimers();
    const explicitList = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      return listCalls === 1 ? await explicitList.promise : sessionsResult([], listCalls);
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      const explicitRefresh = sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:first"));
      await vi.advanceTimersByTimeAsync(EVENT_REFRESH_DEBOUNCE_MS);
      emitEvent(sessionChangedEvent("agent:main:second"));
      await vi.advanceTimersByTimeAsync(EVENT_REFRESH_DEBOUNCE_MS);

      explicitList.resolve(sessionsResult([], 1));
      await explicitRefresh;
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      explicitList.resolve(sessionsResult([], 1));
      sessions.dispose();
    }
  });

  it("runs one managed-list event refresh after a burst during an explicit refresh", async () => {
    vi.useFakeTimers();
    const explicitList = deferred<SessionsListResult>();
    let filteredCalls = 0;
    const request = vi.fn(async (method: string, params?: { archived?: string }) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      if (params?.archived !== "all") {
        return sessionsResult([], 0);
      }
      filteredCalls += 1;
      return filteredCalls === 1 ? await explicitList.promise : sessionsResult([], filteredCalls);
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const unsubscribe = sessions.subscribeList({ agentId: "main", archivedFilter: "all" }, vi.fn());

    try {
      const explicitRefresh = sessions.refreshList({
        agentId: "main",
        archivedFilter: "all",
        force: true,
      });
      emitEvent(sessionChangedEvent("agent:main:first"));
      await vi.advanceTimersByTimeAsync(EVENT_REFRESH_DEBOUNCE_MS);
      emitEvent(sessionChangedEvent("agent:main:second"));
      await vi.advanceTimersByTimeAsync(EVENT_REFRESH_DEBOUNCE_MS);

      explicitList.resolve(sessionsResult([], 1));
      await explicitRefresh;
      await vi.advanceTimersByTimeAsync(0);
      expect(filteredCalls).toBe(2);
    } finally {
      explicitList.resolve(sessionsResult([], 1));
      unsubscribe();
      sessions.dispose();
    }
  });
});
