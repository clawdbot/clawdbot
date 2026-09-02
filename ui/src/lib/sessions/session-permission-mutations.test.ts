// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult, SessionsPatchResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

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
  const sessions = createSessionCapability(gateway);

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
  const sessions = createSessionCapability(gateway);
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

it("discards patch A refresh failure after event B applies", async () => {
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
  const sessions = createSessionCapability(gateway);
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
  refreshA.reject(new Error("obsolete refresh failed"));

  await expect(older).resolves.not.toHaveProperty("listRefreshError");
  expect(sessions.state.result?.sessions).toEqual([
    expect.objectContaining({ key, permissionMode: "full", sessionId, updatedAt: 3 }),
  ]);
  expect(sessions.state.error).toBeNull();
  sessions.dispose();
});
