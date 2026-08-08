// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";

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
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
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

    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.messages.subscribe", {
      key: "main",
    });
    await first.unsubscribeMessages(firstLease);
    expect(request).toHaveBeenCalledOnce();
    await second.unsubscribeMessages(secondLease);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
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
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.subscribe", {
      key: "main",
      includeApprovals: true,
    });
    await sessions.unsubscribeMessages(approval);
    await sessions.unsubscribeMessages(plain);
    expect(request).toHaveBeenCalledTimes(2);
    await sessions.unsubscribeMessages(anotherPlain);
    expect(request).toHaveBeenCalledTimes(3);
    sessions.dispose();
  });

  it("isolates targeted global observers by the selected canonical agent", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.messages.subscribe") {
        return { key: params?.key };
      }
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability(createGateway(client));

    const [main, research] = await Promise.all([
      sessions.subscribeMessages("global", { agentId: "main" }),
      sessions.subscribeMessages("global", { agentId: "research" }),
    ]);

    expect(main).toEqual({ key: "global", agentId: "main" });
    expect(research).toEqual({ key: "global", agentId: "research" });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.messages.subscribe", {
      key: "global",
      agentId: "main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.subscribe", {
      key: "global",
      agentId: "research",
    });
    await sessions.unsubscribeMessages(main);
    await sessions.unsubscribeMessages(research);
    sessions.dispose();
  });
});
