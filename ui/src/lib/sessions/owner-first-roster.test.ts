// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;

function sessionsResult(
  ts: number,
  sessions: SessionsListResult["sessions"] = [],
): SessionsListResult {
  return {
    ts,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function sessionChangedEvent(key: string): GatewayEventFrame {
  return {
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: key, reason: "create", key, kind: "direct", updatedAt: 1 },
  };
}

function createHarness(request: GatewayBrowserClient["request"], ownerId: string) {
  const client = { request } as GatewayBrowserClient;
  let eventListener: ((event: GatewayEventFrame) => void) | undefined;
  const sessions = createSessionCapability({
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "agent:main:main",
      assistantAgentId: "main",
      hello: null,
      selfUser: { id: ownerId },
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

describe("owner-first session roster plan", () => {
  it("retains owner and appended shared pages when an event replaces the list", async () => {
    vi.useFakeTimers();
    const ownerId = "profile-ada";
    const ownerTail = {
      key: "agent:main:owner-tail",
      kind: "direct" as const,
      updatedAt: 1,
      createdActor: { type: "human" as const, id: ownerId },
    };
    const ownerHead = {
      key: "agent:main:owner-head",
      kind: "direct" as const,
      updatedAt: 3,
      createdActor: { type: "human" as const, id: ownerId },
    };
    const sharedRows = [
      ownerHead,
      ...Array.from({ length: 119 }, (_, index) => ({
        key: `agent:main:shared-${index}`,
        kind: "direct" as const,
        updatedAt: 119 - index,
        createdActor: { type: "human" as const, id: "profile-bob" },
      })),
    ];
    const request = vi.fn(
      async (method: string, params?: { limit?: number; offset?: number; ownerId?: string }) => {
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        if (params?.ownerId === ownerId) {
          return sessionsResult(1, [ownerHead, ownerTail]);
        }
        const offset = params?.offset ?? 0;
        return sessionsResult(2, sharedRows.slice(offset, offset + (params?.limit ?? 50)));
      },
    );
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
      ownerId,
    );

    try {
      await sessions.refresh({ agentId: "main", limit: 60, force: true });
      await sessions.refresh({ agentId: "main", limit: 60, offset: 60, append: true, force: true });
      expect(sessions.state.result?.sessions).toHaveLength(121);

      emitEvent(sessionChangedEvent(sharedRows[1]!.key));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      expect(request.mock.calls).toHaveLength(5);
      expect(request.mock.calls.map(([, params]) => params)).toEqual([
        expect.objectContaining({ ownerId, limit: 60 }),
        expect.objectContaining({ limit: 60 }),
        expect.objectContaining({ limit: 60, offset: 60 }),
        expect.objectContaining({ ownerId, limit: 60 }),
        expect.objectContaining({ limit: 120 }),
      ]);
      expect(sessions.state.result?.sessions).toHaveLength(121);
      expect(sessions.state.result?.sessions.map((row) => row.key)).toContain(ownerTail.key);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps foreign-owned rows published through a warm owner-first refresh", async () => {
    vi.useFakeTimers();
    const ownerId = "profile-ada";
    const ownRow = {
      key: "agent:main:ada",
      kind: "direct" as const,
      updatedAt: 2,
      createdActor: { type: "human" as const, id: ownerId },
    };
    const foreignRow = {
      key: "agent:main:bob",
      kind: "direct" as const,
      updatedAt: 1,
      createdActor: { type: "human" as const, id: "profile-bob" },
    };
    const request = vi.fn(async (method: string, params?: { ownerId?: string }) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return params?.ownerId === ownerId
        ? sessionsResult(1, [ownRow])
        : sessionsResult(2, [ownRow, foreignRow]);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
      ownerId,
    );

    try {
      await sessions.refresh({ agentId: "main", limit: 60, force: true });
      expect(sessions.state.result?.sessions.map((row) => row.key)).toContain(foreignRow.key);

      const publishedKeySets: string[][] = [];
      const stop = sessions.subscribe((next) => {
        if (next.result) {
          publishedKeySets.push(next.result.sessions.map((row) => row.key));
        }
      });
      emitEvent(sessionChangedEvent(ownRow.key));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      stop();

      // Cold start fired owner + shared; the warm event refresh fired both again.
      expect(request.mock.calls).toHaveLength(4);
      expect(publishedKeySets.length).toBeGreaterThan(0);
      for (const keys of publishedKeySets) {
        expect(keys).toContain(foreignRow.key);
      }
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps the previous roster when the shared phase of a warm refresh fails", async () => {
    vi.useFakeTimers();
    const ownerId = "profile-ada";
    const ownRow = {
      key: "agent:main:ada",
      kind: "direct" as const,
      updatedAt: 2,
      createdActor: { type: "human" as const, id: ownerId },
    };
    const foreignRow = {
      key: "agent:main:bob",
      kind: "direct" as const,
      updatedAt: 1,
      createdActor: { type: "human" as const, id: "profile-bob" },
    };
    let failShared = false;
    const request = vi.fn(async (method: string, params?: { ownerId?: string }) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      if (params?.ownerId === ownerId) {
        return sessionsResult(1, [ownRow]);
      }
      if (failShared) {
        throw new Error("shared roster unavailable");
      }
      return sessionsResult(2, [ownRow, foreignRow]);
    });
    const { sessions, emitEvent } = createHarness(
      request as unknown as GatewayBrowserClient["request"],
      ownerId,
    );

    try {
      await sessions.refresh({ agentId: "main", limit: 60, force: true });
      expect(sessions.state.result?.sessions).toHaveLength(2);

      failShared = true;
      emitEvent(sessionChangedEvent(ownRow.key));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      expect(sessions.state.error).not.toBeNull();
      expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
        ownRow.key,
        foreignRow.key,
      ]);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });
});
