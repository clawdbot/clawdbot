import { describe, expect, it, vi } from "vitest";
// @vitest-environment node
import type { SessionsDeleteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

type RpcHandler = () => unknown;

function createMutationHarness(handlers: Record<string, RpcHandler>) {
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    const handler = handlers[method];
    if (handler) {
      return await handler();
    }
    if (method === "sessions.list") {
      return sessionsResult([], 2);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const gatewayHarness = createGatewayHarness(client);
  return {
    ...gatewayHarness,
    client,
    request,
    sessions: createSessionCapability(gatewayHarness.gateway),
  };
}

function reconnectSameClient(publish: (connected: boolean) => void) {
  publish(false);
  publish(true);
}

describe("session mutation reconnect truth", () => {
  it.each(["before-response", "after-response"] as const)(
    "retains a confirmed create across a same-client reconnect %s without stale publication",
    async (reconnectOrder) => {
      const createResponse = createDeferred<{ key: string }>();
      const { publish, request, sessions } = createMutationHarness({
        "sessions.create": () => createResponse.promise,
      });
      const created = vi.fn();
      sessions.subscribeCreated(created);

      const operation = sessions.create({ agentId: "main" });
      if (reconnectOrder === "before-response") {
        reconnectSameClient(publish);
        createResponse.resolve({ key: "agent:main:stale" });
      } else {
        // Resolving queues the RPC continuation; retire its epoch before that microtask runs.
        createResponse.resolve({ key: "agent:main:stale" });
        reconnectSameClient(publish);
      }

      await expect(operation).resolves.toBe("agent:main:stale");
      expect(created).not.toHaveBeenCalled();
      expect(sessions.state.error).toContain("completed on the previous connection");
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.list").length,
      ).toBeGreaterThan(0);
      sessions.dispose();
    },
  );

  it("reports both confirmed completion and replacement refresh failure", async () => {
    const createResponse = createDeferred<{ key: string }>();
    let failRefresh = false;
    const { publish, sessions } = createMutationHarness({
      "sessions.create": () => createResponse.promise,
      "sessions.list": () => {
        if (failRefresh) {
          throw new Error("replacement roster unavailable");
        }
        return sessionsResult([], 1);
      },
    });

    const operation = sessions.create({ agentId: "main" });
    reconnectSameClient(publish);
    await waitForFast(() => expect(sessions.state.result).not.toBeNull());
    failRefresh = true;
    createResponse.resolve({ key: "agent:main:refresh-failed" });

    await expect(operation).resolves.toBe("agent:main:refresh-failed");
    expect(sessions.state.error).toContain("completed on the previous connection");
    expect(sessions.state.error).toContain("replacement roster unavailable");
    sessions.dispose();
  });

  it("does not carry a confirmed create into a different client owner", async () => {
    const createResponse = createDeferred<{ key: string }>();
    const { publish, request, sessions } = createMutationHarness({
      "sessions.create": () => createResponse.promise,
    });
    const created = vi.fn();
    sessions.subscribeCreated(created);

    const operation = sessions.create({ agentId: "main" });
    publish(false);
    publish(true, { request } as unknown as GatewayBrowserClient);
    createResponse.resolve({ key: "agent:main:other-gateway" });

    await expect(operation).resolves.toBeNull();
    expect(created).not.toHaveBeenCalled();
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });

  it("revalidates the same-client owner after replacement reconciliation", async () => {
    const createResponse = createDeferred<{ key: string }>();
    const reconciliation = createDeferred<ReturnType<typeof sessionsResult>>();
    let listCalls = 0;
    const { publish, request, sessions } = createMutationHarness({
      "sessions.create": () => createResponse.promise,
      "sessions.list": () => {
        listCalls += 1;
        return listCalls === 2 ? reconciliation.promise : sessionsResult([], listCalls);
      },
    });
    const created = vi.fn();
    sessions.subscribeCreated(created);

    const operation = sessions.create({ agentId: "main" });
    reconnectSameClient(publish);
    await waitForFast(() => expect(listCalls).toBe(1));
    createResponse.resolve({ key: "agent:main:stale-owner" });
    await waitForFast(() => expect(listCalls).toBe(2));
    publish(false);
    publish(true, { request } as unknown as GatewayBrowserClient);
    reconciliation.resolve(sessionsResult([], 2));

    await expect(operation).resolves.toBeNull();
    expect(created).not.toHaveBeenCalled();
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });

  it("keeps a rejected create uncertain across a same-client reconnect", async () => {
    const createResponse = createDeferred<{ key: string }>();
    const { publish, sessions } = createMutationHarness({
      "sessions.create": () => createResponse.promise,
    });

    const operation = sessions.create({ agentId: "main" });
    reconnectSameClient(publish);
    createResponse.reject(new Error("transport closed before response"));

    await expect(operation).resolves.toBeNull();
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });

  it.each(["delete", "deleteMany"] as const)(
    "retains a confirmed %s across a same-client reconnect without stale deletion publication",
    async (operationName) => {
      const deleteResponse = createDeferred<SessionsDeleteResult>();
      const { publish, request, sessions } = createMutationHarness({
        "sessions.delete": () => deleteResponse.promise,
      });
      const key = "agent:main:deleted-on-previous-connection";

      const operation =
        operationName === "delete" ? sessions.delete(key) : sessions.deleteMany([{ key }]);
      reconnectSameClient(publish);
      const worktreePreserved = {
        id: "wt-busy",
        branch: "openclaw/busy",
        path: "/worktrees/busy",
        reason: "busy" as const,
      };
      deleteResponse.resolve({
        ok: true,
        key,
        deleted: true,
        archived: [],
        worktreePreserved,
      });

      await expect(operation).resolves.toEqual(
        operationName === "delete"
          ? { deleted: true, worktreePreserved }
          : { deleted: [key], errors: [], preservedWorktrees: [worktreePreserved] },
      );
      expect(sessions.state.deletedSessions).toEqual([]);
      expect(sessions.state.error).toContain("completed on the previous connection");
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.list").length,
      ).toBeGreaterThan(0);
      sessions.dispose();
    },
  );

  it.each([
    { laterOutcome: "no-op", errors: [] },
    { laterOutcome: "transport rejection", errors: ["transport closed before response"] },
  ] as const)(
    "keeps earlier confirmed batch deletions when a later $laterOutcome follows reconnect",
    async ({ laterOutcome, errors }) => {
      const laterDelete = createDeferred<{ deleted: boolean }>();
      let deleteCalls = 0;
      const { publish, sessions } = createMutationHarness({
        "sessions.delete": () => {
          deleteCalls += 1;
          return deleteCalls === 1 ? { deleted: true } : laterDelete.promise;
        },
      });

      const operation = sessions.deleteMany([
        { key: "agent:main:confirmed" },
        { key: "agent:main:unchanged" },
      ]);
      await waitForFast(() => expect(deleteCalls).toBe(2));
      reconnectSameClient(publish);
      if (laterOutcome === "no-op") {
        laterDelete.resolve({ deleted: false });
      } else {
        laterDelete.reject(new Error("transport closed before response"));
      }

      await expect(operation).resolves.toEqual({
        deleted: ["agent:main:confirmed"],
        errors: [...errors],
        preservedWorktrees: [],
      });
      expect(sessions.state.deletedSessions).toEqual([]);
      expect(sessions.state.error).toContain("completed on the previous connection");
      sessions.dispose();
    },
  );
});
