// @vitest-environment node
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createSessionScopedOperations } from "./session-scoped-operations.ts";

const subscriptionRequestOptions = { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS };

function createGateway(client: GatewayBrowserClient) {
  return {
    snapshot: {
      client,
      phase: "connected" as const,
      sessionKey: "agent:main:main",
      assistantAgentId: "main",
      hello: null,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  };
}

describe("createSessionCapability message subscriptions", () => {
  it("retries a rejected unsubscribe against its original live Gateway observer", async () => {
    let unsubscribeCalls = 0;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.messages.subscribe") {
        return { key: params?.key };
      }
      if (method === "sessions.messages.unsubscribe") {
        unsubscribeCalls += 1;
        if (unsubscribeCalls === 1) {
          throw new Error("temporary observer release failure");
        }
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability(createGateway(client));
    const subscription = await sessions.subscribeMessages("agent:main:main");

    await expect(sessions.unsubscribeMessages(subscription)).rejects.toThrow(
      "temporary observer release failure",
    );
    await expect(sessions.unsubscribeMessages(subscription)).resolves.toBeUndefined();
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.messages.unsubscribe",
      { key: "agent:main:main" },
      subscriptionRequestOptions,
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "sessions.messages.unsubscribe",
      { key: "agent:main:main" },
      subscriptionRequestOptions,
    );
    sessions.dispose();
  });

  it("shares canonical observers across capabilities without releasing the live owner", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.messages.subscribe") {
        return { key: "agent:main:main" };
      }
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    const first = createSessionCapability(gateway);
    const second = createSessionCapability(gateway);

    const [firstLease, secondLease] = await Promise.all([
      first.subscribeMessages("main"),
      second.subscribeMessages("agent:main:main"),
    ]);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.messages.subscribe",
      { key: "main" },
      subscriptionRequestOptions,
    );
    await first.unsubscribeMessages(firstLease);
    expect(request).toHaveBeenCalledOnce();
    await second.unsubscribeMessages(secondLease);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.messages.unsubscribe",
      { key: "agent:main:main" },
      subscriptionRequestOptions,
    );
    first.dispose();
    second.dispose();
  });

  it("upgrades a plain observer for approvals without downgrading existing owners", async () => {
    const replay = { approvals: [{ id: "approval-1" }] };
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.messages.subscribe") {
        return {
          key: params?.key,
          ...(params?.includeApprovals ? { approvalReplay: replay } : {}),
        };
      }
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability(createGateway(client));

    const plain = await sessions.subscribeMessages("main");
    const approval = await sessions.subscribeMessages("main", { includeApprovals: true });
    const anotherPlain = await sessions.subscribeMessages("main");

    expect(approval).toEqual({
      key: "main",
      agentId: null,
      includeApprovals: true,
      approvalReplay: replay,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.messages.subscribe",
      { key: "main", includeApprovals: true },
      subscriptionRequestOptions,
    );
    await sessions.unsubscribeMessages(approval);
    await sessions.unsubscribeMessages(plain);
    expect(request).toHaveBeenCalledTimes(2);
    await sessions.unsubscribeMessages(anotherPlain);
    expect(request).toHaveBeenCalledTimes(3);
    sessions.dispose();
  });

  it.each(["global", "qualified main alias"])(
    "retains each global observer owner through %s acknowledgment and release",
    async (keyForm) => {
      const observers = new Map<string, boolean>();
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        const key = params?.key;
        const agentId =
          params?.agentId ??
          (key === "agent:main:main" ? "main" : key === "agent:work:main" ? "work" : null);
        if (agentId !== "main" && agentId !== "work") {
          throw new Error("Canonical global observer requires its owner");
        }
        if (method === "sessions.messages.subscribe") {
          observers.set(agentId, params?.includeApprovals === true);
          return { key: "global" };
        }
        if (method === "sessions.messages.unsubscribe") {
          observers.delete(agentId);
          return {};
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const sessions = createSessionCapability(createGateway(client));

      const keyFor = (agentId: string) =>
        keyForm === "global" ? "global" : `agent:${agentId}:main`;
      const [main, work] = await Promise.all([
        sessions.subscribeMessages(keyFor("main"), { agentId: " Main " }),
        sessions.subscribeMessages(keyFor("work"), { agentId: " Work " }),
      ]);

      await sessions.unsubscribeMessages(main);
      expect([...observers]).toEqual([["work", false]]);
      const approval = await sessions.subscribeMessages(keyFor("work"), {
        agentId: "work",
        includeApprovals: true,
      });
      await sessions.unsubscribeMessages(work);
      expect([...observers]).toEqual([["work", true]]);
      await sessions.unsubscribeMessages(approval);
      expect(observers.size).toBe(0);
      expect(main).toEqual({ key: "global", agentId: "main" });
      expect(work).toEqual({ key: "global", agentId: "work" });
      expect(request).toHaveBeenNthCalledWith(
        1,
        "sessions.messages.subscribe",
        { key: keyFor("main"), agentId: "main" },
        subscriptionRequestOptions,
      );
      expect(request).toHaveBeenNthCalledWith(
        2,
        "sessions.messages.subscribe",
        { key: keyFor("work"), agentId: "work" },
        subscriptionRequestOptions,
      );
      expect(request).toHaveBeenLastCalledWith(
        "sessions.messages.unsubscribe",
        { key: "global", agentId: "work" },
        subscriptionRequestOptions,
      );
      sessions.dispose();
    },
  );

  it("retires the current Gateway generation when a sent subscription cannot be recovered", async () => {
    const timeout = new GatewayProtocolRequestTimeoutError({
      method: "sessions.messages.subscribe",
      timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
      requestSent: true,
    });
    const recoveryError = new Error("subscription recovery unavailable");
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.messages.subscribe") {
        throw timeout;
      }
      throw recoveryError;
    });
    const forceReconnect = vi.fn();
    const client = { request, forceReconnect } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    const sessions = createSessionCapability(gateway);
    const anotherOwner = createSessionCapability(gateway);

    const failures = await Promise.allSettled([
      sessions.subscribeMessages("main", { includeApprovals: true }),
      anotherOwner.subscribeMessages("main", { includeApprovals: true }),
    ]);

    expect(failures).toEqual([
      { status: "rejected", reason: expect.objectContaining({ cause: recoveryError }) },
      { status: "rejected", reason: expect.objectContaining({ cause: recoveryError }) },
    ]);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.messages.unsubscribe",
      { key: "main" },
      subscriptionRequestOptions,
    );
    expect(forceReconnect).toHaveBeenCalledExactlyOnceWith("session subscription recovery failed");
    sessions.dispose();
    anotherOwner.dispose();
  });

  it("keeps the current Gateway connection when its sent subscription is recovered", async () => {
    const timeout = new GatewayProtocolRequestTimeoutError({
      method: "sessions.messages.subscribe",
      timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
      requestSent: true,
    });
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.messages.subscribe") {
        throw timeout;
      }
      return {};
    });
    const forceReconnect = vi.fn();
    const client = { request, forceReconnect } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability(createGateway(client));

    await expect(sessions.subscribeMessages("main")).rejects.toBe(timeout);
    expect(request).toHaveBeenCalledTimes(2);
    expect(forceReconnect).not.toHaveBeenCalled();
    sessions.dispose();
  });

  it("never reconnects a Gateway generation retired during subscription recovery", async () => {
    const timeout = new GatewayProtocolRequestTimeoutError({
      method: "sessions.messages.subscribe",
      timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
      requestSent: true,
    });
    const recovering = createDeferred();
    const recovery = createDeferred<never>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.messages.subscribe") {
        throw timeout;
      }
      recovering.resolve();
      return await recovery.promise;
    });
    const forceReconnect = vi.fn();
    const client = { request, forceReconnect } as unknown as GatewayBrowserClient;
    let current = true;
    const operations = createSessionScopedOperations({
      notifyCreated: vi.fn(),
      reportError: vi.fn(),
      connection: {
        capture: () => ({ client, epoch: 0 }),
        isCurrent: () => current,
      },
      agentId: () => null,
      refreshReplacement: async () => undefined,
    });
    const failure = operations.subscribeMessages("main").catch((error: unknown) => error);

    await recovering.promise;
    current = false;
    operations.retireConnection(client);
    recovery.reject(new Error("retired Gateway connection"));

    await expect(failure).resolves.toBe(timeout);
    expect(forceReconnect).not.toHaveBeenCalled();
    operations.dispose();
  });
});
