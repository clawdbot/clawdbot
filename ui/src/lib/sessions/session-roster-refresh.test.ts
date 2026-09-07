// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createGatewayHarness,
  createSessionCapabilityHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

describe("session roster refresh", () => {
  it.each([
    { name: "primary", scope: { agentId: " Main " } },
    { name: "owner-first", scope: { agentId: "main", ownerFirst: true } },
    { name: "owner-filtered", scope: { agentId: "main", ownerId: "profile-self" } },
    { name: "involving-me", scope: { agentId: "main", involvingMe: true } },
    { name: "searched", scope: { agentId: "main", search: "report" } },
    { name: "all-agents", scope: {} },
  ])("invalidates the $name roster only for matching or unscoped events", async ({ scope }) => {
    vi.useFakeTimers();
    const request = vi.fn(async () => sessionsResult([], 1));
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
      { ownerId: "profile-self" },
    );
    try {
      await sessions.refresh({ ...scope, force: true });
      request.mockClear();
      for (const agentId of ["research", "main", undefined]) {
        emitEvent({
          type: "event",
          event: "session.message",
          payload: { sessionKey: "global", agentId, hasActiveRun: false, status: "done" },
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(request).toHaveBeenCalledTimes(agentId === "research" && scope.agentId ? 0 : 1);
        request.mockClear();
      }
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    { weakKind: "append", weakOptions: { offset: 25, append: true }, outcome: "rows" },
    { weakKind: "append", weakOptions: { offset: 25, append: true }, outcome: "error" },
    { weakKind: "background", weakOptions: { backgroundHydrate: true }, outcome: "rows" },
    { weakKind: "background", weakOptions: { backgroundHydrate: true }, outcome: "error" },
  ] as const)(
    "keeps a queued Research replacement ahead of a later Work $weakKind after stale Work $outcome",
    async ({ weakOptions, outcome }) => {
      const workList = createDeferred<SessionsListResult>();
      const researchList = createDeferred<SessionsListResult>();
      const workResult = sessionsResult(
        [{ key: "agent:work:main", kind: "direct", updatedAt: 1 }],
        1,
      );
      const researchResult = sessionsResult(
        [{ key: "agent:research:main", kind: "direct", updatedAt: 2 }],
        2,
      );
      const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
        expect(method).toBe("sessions.list");
        if (params?.agentId === "work") {
          return await workList.promise;
        }
        if (params?.agentId === "research") {
          return await researchList.promise;
        }
        throw new Error(`Unexpected refresh: ${params?.agentId}`);
      });
      const { sessions } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const observed: Array<{
        result: SessionsListResult | null;
        error: string | null;
      }> = [];
      const unsubscribe = sessions.subscribe(({ result, error }) => {
        observed.push({ result, error });
      });
      const workSettled = vi.fn();
      const researchSettled = vi.fn();
      const weakSettled = vi.fn();
      const work = sessions.refresh({ agentId: "work", force: true }).then(workSettled);
      const research = sessions.refresh({ agentId: "research", force: true }).then(researchSettled);
      const weak = sessions
        .refresh({ agentId: "work", limit: 25, force: true, ...weakOptions })
        .then(weakSettled);

      try {
        if (outcome === "rows") {
          workList.resolve(workResult);
        } else {
          workList.reject(new Error("stale Work failure"));
        }
        await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
        await waitForFast(() => expect(workSettled).toHaveBeenCalledOnce());

        expect(researchSettled).not.toHaveBeenCalled();
        expect(weakSettled).not.toHaveBeenCalled();
        expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "research" });
        expect(
          observed.some(({ result }) =>
            result?.sessions.some((row) => row.key === "agent:work:main"),
          ),
        ).toBe(false);
        expect(observed.some(({ error }) => error === "stale Work failure")).toBe(false);

        researchList.resolve(researchResult);
        await Promise.all([research, weak]);
        expect(researchSettled).toHaveBeenCalledOnce();
        expect(weakSettled).toHaveBeenCalledOnce();
        expect(sessions.state.agentId).toBe("research");
        expect(sessions.state.result).toBe(researchResult);
        expect(sessions.state.error).toBeNull();
      } finally {
        workList.resolve(workResult);
        researchList.resolve(researchResult);
        unsubscribe();
        sessions.dispose();
        await Promise.all([work, research, weak]);
      }
    },
  );

  it.each([
    { weakKind: "append", weakOptions: { offset: 25, append: true } },
    { weakKind: "background", weakOptions: { backgroundHydrate: true } },
  ] as const)(
    "lets a foreground replacement supersede an already queued $weakKind",
    async ({ weakOptions }) => {
      const activeList = createDeferred<SessionsListResult>();
      const researchList = createDeferred<SessionsListResult>();
      const researchResult = sessionsResult(
        [{ key: "agent:research:main", kind: "direct", updatedAt: 2 }],
        2,
      );
      const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
        expect(method).toBe("sessions.list");
        if (params?.agentId === "work") {
          return await activeList.promise;
        }
        if (params?.agentId === "research") {
          return await researchList.promise;
        }
        throw new Error(`Unexpected refresh: ${params?.agentId}`);
      });
      const { sessions } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const active = sessions.refresh({ agentId: "work", force: true });
      const weak = sessions.refresh({
        agentId: "work",
        limit: 25,
        force: true,
        ...weakOptions,
      });
      const research = sessions.refresh({ agentId: "research", force: true });

      try {
        activeList.resolve(sessionsResult([], 1));
        await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
        expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "research" });

        researchList.resolve(researchResult);
        await Promise.all([active, weak, research]);
        expect(sessions.state.agentId).toBe("research");
        expect(sessions.state.result).toBe(researchResult);
      } finally {
        activeList.resolve(sessionsResult([], 1));
        researchList.resolve(researchResult);
        sessions.dispose();
        await Promise.all([active, weak, research]);
      }
    },
  );

  it.each([
    { scenario: "a superseding query", nextAgentId: "research", superseded: true },
    { scenario: "an equivalent query", nextAgentId: " writer ", superseded: false },
  ])(
    "keeps queued replacement results with their query for $scenario",
    async ({ nextAgentId, superseded }) => {
      const initialList = createDeferred<SessionsListResult>();
      const replacementList = createDeferred<SessionsListResult>();
      const initialResult = sessionsResult(
        [{ key: "agent:initial:main", kind: "direct", updatedAt: 1 }],
        1,
      );
      const writerResult = sessionsResult(
        [{ key: "agent:writer:main", kind: "direct", updatedAt: 2 }],
        2,
      );
      const researchResult = sessionsResult(
        [{ key: "agent:research:main", kind: "direct", updatedAt: 3 }],
        3,
      );
      const replacementResult = superseded ? researchResult : writerResult;
      const normalizedAgentId = nextAgentId.trim();
      const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
        expect(method).toBe("sessions.list");
        if (params?.agentId === "initial") {
          return await initialList.promise;
        }
        if (params?.agentId === normalizedAgentId) {
          return await replacementList.promise;
        }
        throw new Error(`Unexpected refresh: ${params?.agentId}`);
      });
      const { sessions } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const initial = sessions.refresh({ agentId: "initial", force: true });
      const writer = sessions.refreshReplacement("writer");
      const replacement = sessions.refreshReplacement(nextAgentId);

      try {
        expect(request).toHaveBeenCalledOnce();
        initialList.resolve(initialResult);
        await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
        replacementList.resolve(replacementResult);
        const [writerOutcome, replacementOutcome] = await Promise.all([writer, replacement]);

        expect(writerOutcome).toBe(superseded ? null : writerResult);
        expect(replacementOutcome).toBe(replacementResult);
        expect(sessions.state.agentId).toBe(normalizedAgentId);
        expect(sessions.state.result).toBe(replacementResult);
        expect(request.mock.calls.map(([, params]) => params?.agentId)).toEqual([
          "initial",
          normalizedAgentId,
        ]);
      } finally {
        initialList.resolve(initialResult);
        replacementList.resolve(replacementResult);
        sessions.dispose();
        await Promise.all([initial, writer, replacement]);
      }
    },
  );

  it("settles coalesced refresh callers without waiting for a later replacement", async () => {
    const initialList = createDeferred<SessionsListResult>();
    const coalescedList = createDeferred<SessionsListResult>();
    const laterList = createDeferred<SessionsListResult>();
    const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
      expect(method).toBe("sessions.list");
      switch (params?.agentId) {
        case "initial":
          return await initialList.promise;
        case "coalesced":
          return await coalescedList.promise;
        case "later":
          return await laterList.promise;
        default:
          throw new Error(`Unexpected refresh: ${params?.agentId}`);
      }
    });
    const { sessions } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const initialSettled = vi.fn();
    const coalescedSettled = vi.fn();
    const initial = sessions.refresh({ agentId: "initial", force: true }).then(initialSettled);
    const first = sessions.refreshReplacement("superseded").then(coalescedSettled);
    const second = sessions.refreshReplacement("coalesced").then(coalescedSettled);
    let later: ReturnType<typeof sessions.refreshReplacement> | undefined;

    try {
      expect(sessions.state.loading).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      initialList.resolve(sessionsResult([], 1));
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      await waitForFast(() => expect(initialSettled).toHaveBeenCalledOnce());
      expect(coalescedSettled).not.toHaveBeenCalled();

      later = sessions.refreshReplacement("later");
      coalescedList.resolve(sessionsResult([], 2));
      await waitForFast(() => expect(coalescedSettled).toHaveBeenCalledTimes(2));

      expect(coalescedSettled.mock.calls).toEqual([[null], [null]]);
      expect(sessions.state.result).toBeNull();
      expect(sessions.state.loading).toBe(true);
      expect(request.mock.calls.map(([, params]) => params?.agentId)).toEqual([
        "initial",
        "coalesced",
        "later",
      ]);
      const laterResult = sessionsResult([], 3);
      laterList.resolve(laterResult);
      await expect(later).resolves.toBe(laterResult);
      expect(sessions.state.result?.ts).toBe(3);
      expect(sessions.state.loading).toBe(false);
    } finally {
      initialList.resolve(sessionsResult([], 1));
      coalescedList.resolve(sessionsResult([], 2));
      laterList.resolve(sessionsResult([], 3));
      sessions.dispose();
      await Promise.all([initial, first, second, later]);
    }
  });

  it("returns a failed replacement outcome while preserving the previous roster", async () => {
    const previous = sessionsResult([{ key: "agent:main:main", kind: "direct", updatedAt: 1 }], 1);
    const request = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockRejectedValueOnce(new Error("Roster unavailable"));
    const { sessions } = createSessionCapabilityHarness(request);
    try {
      await sessions.refresh({ agentId: "main", search: "draft", force: true });
      await expect(sessions.refreshReplacement()).resolves.toBeNull();
      expect(sessions.state.result).toBe(previous);
      expect(sessions.state.error).toBe("Roster unavailable");
    } finally {
      sessions.dispose();
    }
  });

  it.each(["disconnect", "same-client reconnect", "replacement-client reconnect", "dispose"])(
    "settles unissued refreshes on %s without dispatching them through a replacement owner",
    async (retirement) => {
      const activeList = createDeferred<SessionsListResult>();
      const refreshed = sessionsResult([], 2);
      const request = vi.fn(async (method: string, params?: { search?: string }) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true, list: refreshed };
        }
        if (method === "sessions.list" && params?.search === "active") {
          return await activeList.promise;
        }
        throw new Error(`Unexpected request: ${method} ${params?.search}`);
      });
      const replacementRequest = vi.fn(async (method: string, _params?: { search?: string }) => {
        expect(method).toBe("sessions.subscribe");
        return { subscribed: true, list: refreshed };
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const replacement = { request: replacementRequest } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client);
      const sessions = createTestSessionCapability(gateway);
      const retired = vi.fn();
      const active = sessions.refresh({ search: "active", force: true });
      const first = sessions.refreshReplacement("unissued-first").then(retired);
      const second = sessions.refreshReplacement("unissued-second").then(retired);

      try {
        expect(request).toHaveBeenCalledTimes(1);
        if (retirement === "dispose") {
          sessions.dispose();
        } else {
          publish(false);
          if (retirement !== "disconnect") {
            publish(true, retirement === "same-client reconnect" ? client : replacement);
          }
        }
        await waitForFast(() => expect(retired).toHaveBeenCalledTimes(2));
        expect(retired.mock.calls).toEqual([[null], [null]]);
        if (retirement.endsWith("reconnect")) {
          await waitForFast(() => expect(sessions.state.result?.ts).toBe(2));
        } else {
          await expect(sessions.refreshReplacement()).resolves.toBeNull();
        }

        activeList.resolve(sessionsResult([], 1));
        await active;
        expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1);
        expect(replacementRequest.mock.calls.some(([method]) => method === "sessions.list")).toBe(
          false,
        );
        if (retirement.endsWith("reconnect")) {
          expect(sessions.state.result?.ts).toBe(2);
        } else if (retirement === "disconnect") {
          expect(sessions.state.result).toBeNull();
        }
      } finally {
        activeList.resolve(sessionsResult([], 1));
        sessions.dispose();
        await Promise.all([active, first, second]);
      }
    },
  );
});
