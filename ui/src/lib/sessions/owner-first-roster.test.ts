// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createSessionCapabilityHarness,
  sessionChangedEvent,
  sessionsResult,
} from "./session-capability.test-support.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;

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
      async (
        method: string,
        params?: { limit?: number; offset?: number; ownerFirst?: boolean },
      ) => {
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        const offset = params?.offset ?? 0;
        const shared = sharedRows.slice(offset, offset + (params?.limit ?? 50));
        return sessionsResult(
          params?.ownerFirst
            ? [ownerHead, ownerTail, ...shared.filter((row) => row !== ownerHead)]
            : shared,
          2,
        );
      },
    );
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
      { ownerId },
    );

    try {
      await sessions.refresh({ agentId: "main", limit: 60, force: true });
      await sessions.refresh({ agentId: "main", limit: 60, offset: 60, append: true, force: true });
      expect(sessions.state.result?.sessions).toHaveLength(121);

      emitEvent(sessionChangedEvent(sharedRows[1]!.key));
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      expect(request.mock.calls).toHaveLength(3);
      expect(request.mock.calls.map(([, params]) => params)).toEqual([
        expect.objectContaining({ ownerFirst: true, limit: 60 }),
        expect.objectContaining({ limit: 60, offset: 60 }),
        expect.objectContaining({ ownerFirst: true, limit: 120 }),
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
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult([ownRow, foreignRow], 2);
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
      { ownerId },
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

      expect(request.mock.calls).toHaveLength(2);
      expect(publishedKeySets.length).toBeGreaterThan(0);
      for (const keys of publishedKeySets) {
        expect(keys).toContain(foreignRow.key);
      }
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps the previous roster when a warm owner-first refresh fails", async () => {
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
    let failRefresh = false;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      if (failRefresh) {
        throw new Error("session roster unavailable");
      }
      return sessionsResult([ownRow, foreignRow], 2);
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
      { ownerId },
    );

    try {
      await sessions.refresh({ agentId: "main", limit: 60, force: true });
      expect(sessions.state.result?.sessions).toHaveLength(2);

      failRefresh = true;
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
