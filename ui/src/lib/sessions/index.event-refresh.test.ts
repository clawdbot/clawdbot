// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;
const SESSION_EVENT_REFRESH_MAX_WAIT_MS = 1_000;

function sessionsResult(ts: number): SessionsListResult {
  return {
    ts,
    path: "",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function sessionChangedEvent(key: string): GatewayEventFrame {
  return {
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: key, reason: "create", key, kind: "direct", updatedAt: 1 },
  };
}

function createHarness(request: GatewayBrowserClient["request"]) {
  const client = { request } as GatewayBrowserClient;
  let eventListener: ((event: GatewayEventFrame) => void) | undefined;
  const sessions = createSessionCapability({
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "agent:main:main",
      assistantAgentId: "main",
      hello: null,
    },
    subscribe: () => () => undefined,
    subscribeEvents(listener) {
      eventListener = listener;
      return () => {
        eventListener = undefined;
      };
    },
  });
  return { sessions, emitEvent: (event: GatewayEventFrame) => eventListener?.(event) };
}

describe("event-driven session list refresh", () => {
  it("clears a recreated session's prior deletion before the debounced refresh", async () => {
    vi.useFakeTimers();
    const key = "agent:main:recreated-thread";
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { sessionKey: key, reason: "delete" },
      });
      expect(sessions.state.deletedSessions).toEqual([{ key, agentId: undefined }]);

      emitEvent(sessionChangedEvent(key));

      expect(sessions.state.deletedSessions).toEqual([]);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("debounces rapid session events into one trailing list refresh", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:first"));
      emitEvent(sessionChangedEvent("agent:main:second"));
      emitEvent(sessionChangedEvent("agent:main:third"));

      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("bounds canonical refresh latency during sustained event traffic", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:first"));
      for (let index = 0; index < 5; index += 1) {
        await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS - 1);
        emitEvent(sessionChangedEvent(`agent:main:sustained-${index}`));
      }

      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(
        SESSION_EVENT_REFRESH_MAX_WAIT_MS - 5 * (SESSION_EVENT_REFRESH_DEBOUNCE_MS - 1),
      );
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("lets an explicit refresh bypass and subsume the event debounce", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:event"));
      await sessions.refresh({ force: true });

      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("queues one trailing refresh for an event during an in-flight refresh", async () => {
    vi.useFakeTimers();
    const secondList = deferred<SessionsListResult>();
    const thirdListStarted = deferred<void>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      if (listCalls === 2) {
        return await secondList.promise;
      }
      if (listCalls === 3) {
        thirdListStarted.resolve();
      }
      return sessionsResult(listCalls);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:first"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(2);

      emitEvent(sessionChangedEvent("agent:main:during-flight"));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(request).toHaveBeenCalledTimes(2);

      secondList.resolve(sessionsResult(2));
      await thirdListStarted.promise;
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("flushes a pending event refresh synchronously on dispose", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(1);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ force: true });
      emitEvent(sessionChangedEvent("agent:main:pending"));
      sessions.dispose();

      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS * 2);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });
});
