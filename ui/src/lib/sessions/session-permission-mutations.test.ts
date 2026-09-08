// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult, SessionsPatchResult } from "../../api/types.ts";
import {
  createSessionCapabilityHarness,
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each(["generation-b", "  generation-b  ", "  "])(
  "binds the normalized expected incarnation %j instead of a stale primary row",
  async (expectedSessionId) => {
    const key = "agent:main:permission-successor";
    const original = {
      key,
      kind: "direct" as const,
      sessionId: "generation-a",
      updatedAt: 1,
      permissionMode: "guarded" as const,
    };
    const successor = { ...original, sessionId: "generation-b", updatedAt: 3 };
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          path: "(sessions)",
          key,
          entry: { sessionId: successor.sessionId, updatedAt: 4, permissionMode: "full" },
        };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      return sessionsResult(
        [
          listCalls === 1
            ? original
            : listCalls === 2
              ? successor
              : { ...successor, updatedAt: 4, permissionMode: "full" },
        ],
        listCalls,
      );
    });
    const { sessions } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    try {
      await sessions.refresh({ force: true });
      await sessions.refreshList({ agentId: "main", includeDerivedTitles: false });
      expect(sessions.state.result?.sessions[0]?.sessionId).toBe(original.sessionId);
      await sessions.patch(key, { permissionMode: "full" }, { expectedSessionId });

      expect(sessions.state.result?.sessions[0]).toMatchObject({
        sessionId: successor.sessionId,
        permissionMode: "full",
      });
      expect(listCalls).toBe(3);
      expect(sessions.state.loading).toBe(false);
    } finally {
      sessions.dispose();
    }
  },
);

it.each([
  { eventAt: 2, ackAt: 3, eventMode: "guarded", expected: "workspace", expectedLists: 2 },
  { eventAt: 2, ackAt: 3, eventMode: "full", expected: "workspace", expectedLists: 2 },
  { eventAt: 3, ackAt: 2, eventMode: "guarded", expected: "guarded", expectedLists: 1 },
])(
  "keeps the newer permission when a $eventMode snapshot at $eventAt crosses an acknowledgment at $ackAt",
  async ({ eventAt, ackAt, eventMode, expected, expectedLists }) => {
    const key = "agent:main:permission-pending";
    const sessionId = "permission-pending-generation";
    const patch = createDeferred<SessionsPatchResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return patch.promise;
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      if (ackAt < eventAt && listCalls > 1) {
        throw new Error("Roster unavailable");
      }
      return sessionsResult(
        [
          {
            key,
            kind: "direct",
            sessionId,
            updatedAt: listCalls === 1 ? 1 : 3,
            permissionMode: listCalls === 1 ? "guarded" : "workspace",
          },
        ],
        listCalls,
      );
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    try {
      await sessions.refresh({ force: true });
      const pending = sessions.patch(key, { permissionMode: "workspace" });
      emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          key,
          sessionKey: key,
          kind: "direct",
          sessionId,
          updatedAt: eventAt,
          permissionMode: eventMode,
          archived: false,
          hasActiveRun: true,
          status: "running",
        },
      });
      patch.resolve({
        ok: true,
        path: "(sessions)",
        key,
        entry: { sessionId, updatedAt: ackAt, permissionMode: "workspace" },
      });
      await pending;
      expect(sessions.state.result?.sessions[0]?.permissionMode).toBe(expected);
      expect(sessions.state.loading).toBe(false);
      expect(listCalls).toBe(expectedLists);
    } finally {
      sessions.dispose();
    }
  },
);

it("keeps a confirmed permission mode when its list refresh fails", async () => {
  const key = "agent:main:permission-refresh";
  const sessionId = "permission-refresh-generation";
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      listCalls += 1;
      if (listCalls > 1) {
        throw new Error("Roster refresh unavailable");
      }
      return sessionsResult(
        [
          {
            key,
            kind: "direct",
            label: "Permission refresh",
            permissionMode: "guarded",
            sessionId,
            updatedAt: 1,
          },
        ],
        1,
      );
    }
    if (method === "sessions.patch") {
      return {
        key,
        entry: { permissionMode: "workspace", sessionId, updatedAt: 2 },
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const sessions = createTestSessionCapability(gateway);

  await sessions.refresh({ force: true });
  const result = await sessions.patch(key, { permissionMode: "workspace" });

  expect(result).toMatchObject({ listRefreshError: "Roster refresh unavailable" });
  expect(sessions.state.result?.sessions).toEqual([
    expect.objectContaining({
      key,
      label: "Permission refresh",
      permissionMode: "workspace",
      sessionId,
      updatedAt: 2,
    }),
  ]);
  expect(sessions.state.error).toContain("Roster refresh unavailable");
  sessions.dispose();
});

it("discards patch A and its refresh after patch B applies first", async () => {
  const key = "agent:main:permission-ordering";
  const sessionId = "permission-ordering-generation";
  const patchA = createDeferred<SessionsPatchResult>();
  const patchB = createDeferred<SessionsPatchResult>();
  let listCalls = 0;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      listCalls += 1;
      if (listCalls > 2) {
        throw new Error("Obsolete refresh should not run");
      }
      return sessionsResult(
        [
          {
            key,
            kind: "direct",
            permissionMode: listCalls === 1 ? "guarded" : "full",
            sessionId,
            updatedAt: listCalls,
          },
        ],
        1,
      );
    }
    if (method === "sessions.patch") {
      const permissionMode = (params as { permissionMode?: unknown })?.permissionMode;
      return permissionMode === "workspace" ? patchA.promise : patchB.promise;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const sessions = createTestSessionCapability(gateway);
  await sessions.refresh({ force: true });

  const older = sessions.patch(key, { permissionMode: "workspace" });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ permissionMode: "workspace" }),
    ),
  );
  const newer = sessions.patch(key, { permissionMode: "full" });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ permissionMode: "full" }),
    ),
  );
  patchB.resolve({
    ok: true,
    path: "/sessions/permission-ordering.jsonl",
    key,
    entry: { permissionMode: "full", sessionId, updatedAt: 2 },
  });
  await newer;
  patchA.resolve({
    ok: true,
    path: "/sessions/permission-ordering.jsonl",
    key,
    entry: { permissionMode: "workspace", sessionId, updatedAt: 3 },
  });
  await older;

  expect(sessions.state.result?.sessions).toEqual([
    expect.objectContaining({ key, permissionMode: "full", sessionId, updatedAt: 2 }),
  ]);
  expect(listCalls).toBe(2);
  sessions.dispose();
});

it.each(["success", "failure"])(
  "settles patch A refresh %s after event B applies",
  async (outcome) => {
    const key = "agent:main:permission-refresh-ordering";
    const sessionId = "permission-refresh-ordering-generation";
    const refreshA = createDeferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        listCalls += 1;
        return listCalls === 1
          ? sessionsResult(
              [{ key, kind: "direct", permissionMode: "guarded", sessionId, updatedAt: 1 }],
              1,
            )
          : refreshA.promise;
      }
      if (method === "sessions.patch") {
        return {
          ok: true,
          path: "/sessions/permission-refresh-ordering.jsonl",
          key,
          entry: { permissionMode: "workspace", sessionId, updatedAt: 2 },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ force: true });

    const older = sessions.patch(key, { permissionMode: "workspace" });
    await vi.waitFor(() => expect(listCalls).toBe(2));
    sessions.reconcileChanged({
      sessionKey: key,
      key,
      kind: "direct",
      reason: "patch",
      permissionMode: "full",
      sessionId,
      updatedAt: 3,
    });
    if (outcome === "failure") {
      refreshA.reject(new Error("obsolete refresh failed"));
    } else {
      refreshA.resolve(
        sessionsResult(
          [{ key, kind: "direct", permissionMode: "workspace", sessionId, updatedAt: 2 }],
          2,
        ),
      );
    }

    await expect(older).resolves.not.toHaveProperty("listRefreshError");
    expect(sessions.state.result?.sessions).toEqual([
      expect.objectContaining({
        key,
        permissionMode: "full",
        sessionId,
        updatedAt: outcome === "failure" ? 3 : 2,
      }),
    ]);
    expect(sessions.state.error).toBeNull();
    expect(sessions.state.loading).toBe(false);
    sessions.dispose();
  },
);
