// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each(["workspace", "full", "failure"] as const)(
  "resolves conflicting equal-time permission facts through the owned canonical read (%s)",
  async (canonical) => {
    const key = "agent:main:permission-tie";
    const sessionId = "permission-tie-generation";
    const initial = sessionsResult(
      [{ key, kind: "direct", sessionId, updatedAt: 1, permissionMode: "guarded" }],
      1,
    );
    const read = createDeferred<SessionsListResult>();
    const reply = createDeferred<unknown>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return reply.promise;
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      return listCalls === 1 ? initial : read.promise;
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    let patch: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ force: true });
      patch = sessions.patch(key, { permissionMode: "workspace" });
      emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          key,
          sessionKey: key,
          kind: "direct",
          sessionId,
          updatedAt: 2,
          permissionMode: "full",
          archived: false,
          hasActiveRun: true,
          status: "running",
        },
      });
      reply.resolve({
        ok: true,
        path: "(sessions)",
        key,
        entry: { sessionId, updatedAt: 2, permissionMode: "workspace" },
      });
      await vi.waitFor(() => expect(listCalls).toBe(2));
      expect(sessions.state.result?.sessions[0]?.permissionMode).toBe("full");
      if (canonical === "failure") {
        read.reject(new Error("Canonical read unavailable"));
        await expect(patch).resolves.toMatchObject({
          listRefreshError: "Canonical read unavailable",
        });
      } else {
        read.resolve(
          sessionsResult(
            [
              {
                key,
                kind: "direct",
                sessionId,
                updatedAt: 2,
                permissionMode: canonical,
              },
            ],
            2,
          ),
        );
        await patch;
      }
      expect(sessions.state.result?.sessions[0]?.permissionMode).toBe(
        canonical === "failure" ? "full" : canonical,
      );
      expect(sessions.state.loading).toBe(false);
      expect(listCalls).toBe(2);
    } finally {
      read.resolve(initial);
      await patch;
      sessions.dispose();
    }
  },
);

it.each(["ordinary", "permission"])(
  "keeps the latest queued %s refresh's error owner",
  async (lastOwner) => {
    const key = "agent:main:queued-permission";
    const sessionId = "queued-generation";
    const row = {
      key,
      kind: "direct" as const,
      sessionId,
      updatedAt: 1,
      permissionMode: "guarded" as const,
    };
    const initial = sessionsResult([row], 1);
    const blocker = createDeferred<SessionsListResult>();
    const queued = createDeferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          path: "(sessions)",
          key,
          entry: { sessionId, updatedAt: 2, permissionMode: "workspace" },
        };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      return listCalls === 1 ? initial : listCalls === 2 ? blocker.promise : queued.promise;
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const pending: Array<Promise<unknown>> = [];
    try {
      await sessions.refresh({ force: true });
      pending.push(sessions.refresh({ force: true }));
      if (lastOwner === "permission") {
        pending.push(sessions.refresh({ force: true }));
      }
      const patch = sessions.patch(key, { permissionMode: "workspace" });
      pending.push(patch);
      await vi.waitFor(() =>
        expect(sessions.state.result?.sessions[0]?.permissionMode).toBe("workspace"),
      );
      if (lastOwner === "ordinary") {
        pending.push(sessions.refresh({ force: true }));
      }
      emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          key,
          sessionKey: key,
          kind: "direct",
          sessionId,
          updatedAt: 3,
          permissionMode: "full",
          archived: false,
          hasActiveRun: true,
          status: "running",
        },
      });
      blocker.resolve(initial);
      await vi.waitFor(() => expect(listCalls).toBe(3));
      expect(sessions.state.loading).toBe(true);
      queued.reject(new Error("Selected refresh unavailable"));
      await Promise.all(pending);

      expect(sessions.state.loading).toBe(false);
      expect(sessions.state.result?.sessions[0]?.permissionMode).toBe("full");
      expect(sessions.state.error).toBe(
        lastOwner === "ordinary" ? "Selected refresh unavailable" : null,
      );
      await expect(patch).resolves.not.toHaveProperty("listRefreshError");
      expect(listCalls).toBe(3);
    } finally {
      blocker.resolve(initial);
      queued.resolve(initial);
      await Promise.allSettled(pending);
      sessions.dispose();
    }
  },
);

it("reports a permission refresh failure during another agent's active message", async () => {
  const key = "agent:main:permission-error";
  const sessionId = "permission-error-generation";
  const pending = createDeferred<SessionsListResult>();
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.patch") {
      return {
        ok: true,
        path: "(sessions)",
        key,
        entry: { sessionId, updatedAt: 2, permissionMode: "workspace" },
      };
    }
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    listCalls += 1;
    return listCalls === 1
      ? sessionsResult(
          [{ key, kind: "direct", sessionId, updatedAt: 1, permissionMode: "guarded" }],
          1,
        )
      : pending.promise;
  });
  const { sessions, emitEvent } = createSessionCapabilityHarness(
    request as unknown as GatewayBrowserClient["request"],
  );
  try {
    await sessions.refresh({ force: true });
    const patch = sessions.patch(key, { permissionMode: "workspace" });
    await vi.waitFor(() => expect(listCalls).toBe(2));
    emitEvent({
      type: "event",
      event: "session.message",
      payload: {
        key: "agent:other:active",
        sessionKey: "agent:other:active",
        kind: "direct",
        sessionId: "other-generation",
        updatedAt: 3,
        permissionMode: null,
        archived: false,
        hasActiveRun: true,
        status: "running",
      },
    });
    pending.reject(new Error("Roster unavailable"));

    await expect(patch).resolves.toMatchObject({ listRefreshError: "Roster unavailable" });
    expect(sessions.state.error).toBe("Roster unavailable");
    expect(sessions.state.loading).toBe(false);
    expect(sessions.state.result?.sessions[0]?.permissionMode).toBe("workspace");
  } finally {
    pending.resolve(sessionsResult([], 1));
    sessions.dispose();
  }
});
