// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createSessionCapabilityHarness,
  sessionChangedEvent,
  sessionsResult,
} from "./session-capability.test-support.ts";

describe("session roster refresh cooldown", () => {
  it.each([false, true])(
    "spaces authoritative reads for a slow managed=%s query",
    async (managed) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const slow = createDeferred<SessionsListResult>();
      const starts: number[] = [];
      const scope = { agentId: "main", ...(managed ? { archivedFilter: "all" as const } : {}) };
      const request = vi.fn(async (_method: string, params?: { archived?: string }) => {
        if ((params?.archived === "all") !== managed) {
          return sessionsResult([], 0);
        }
        starts.push(Date.now());
        return starts.length === 2 ? await slow.promise : sessionsResult([], Date.now());
      });
      const { sessions, emitEvent } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const unsubscribe = managed ? sessions.subscribeList(scope, vi.fn()) : () => {};
      try {
        await sessions.refreshList({ ...scope, force: true });
        emitEvent(sessionChangedEvent("agent:main:first"));
        await vi.advanceTimersByTimeAsync(200);
        expect(starts).toEqual([0, 200]);
        await vi.advanceTimersByTimeAsync(100);
        emitEvent(sessionChangedEvent("agent:main:queued"));
        await vi.advanceTimersByTimeAsync(1200);
        slow.resolve(sessionsResult([], 200));
        await vi.advanceTimersByTimeAsync(0);
        expect(starts).toEqual([0, 200, 1500]);
        await vi.advanceTimersByTimeAsync(50);
        emitEvent(sessionChangedEvent("agent:main:latest"));
        await vi.advanceTimersByTimeAsync(949);
        expect(starts).toEqual([0, 200, 1500]);
        await vi.advanceTimersByTimeAsync(1);
        expect(starts).toEqual([0, 200, 1500, 2500]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(starts).toHaveLength(4);
      } finally {
        slow.resolve(sessionsResult([], 0));
        unsubscribe();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "bounds spaced event bursts while keeping manual refresh immediate, managed=%s",
    async (managed) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const starts: number[] = [];
      const scope = { agentId: "main", ...(managed ? { archivedFilter: "all" as const } : {}) };
      const request = vi.fn(async (_method: string, params?: { archived?: string }) => {
        if ((params?.archived === "all") === managed) {
          starts.push(Date.now());
        }
        return sessionsResult([], Date.now());
      });
      const { sessions, emitEvent } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const unsubscribe = managed ? sessions.subscribeList(scope, vi.fn()) : () => {};
      try {
        await sessions.refreshList({ ...scope, force: true });
        for (let index = 0; index < 7; index += 1) {
          emitEvent(sessionChangedEvent(`agent:main:burst-${index}`));
          await vi.advanceTimersByTimeAsync(300);
        }
        expect(starts).toEqual([0, 200, 1200]);
        await vi.advanceTimersByTimeAsync(100);
        expect(starts).toEqual([0, 200, 1200, 2200]);
        emitEvent(sessionChangedEvent("agent:main:manual"));
        await sessions.refreshList({ ...scope, force: true });
        expect(starts).toEqual([0, 200, 1200, 2200, 2200]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(starts).toHaveLength(5);
      } finally {
        unsubscribe();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
