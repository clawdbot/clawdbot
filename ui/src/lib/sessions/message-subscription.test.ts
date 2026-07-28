// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";

describe("session message subscriptions", () => {
  it("does not refresh while the shared initial subscription is pending", async () => {
    let rejectInitial: (reason: Error) => void = () => undefined;
    const initial = new Promise<never>((_resolve, reject) => {
      rejectInitial = reject;
    });
    let subscribeCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "sessions.messages.unsubscribe") {
        return Promise.resolve({ unsubscribed: true });
      }
      if (method !== "sessions.messages.subscribe") {
        throw new Error(`Unexpected request: ${method}`);
      }
      subscribeCount += 1;
      if (subscribeCount === 1) {
        return initial;
      }
      return Promise.resolve({ subscribed: true, key: "agent:main:session-1" });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = {
      snapshot: {
        client,
        phase: "connected" as const,
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: null as GatewayHelloOk | null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    };
    const sessions = createSessionCapability(gateway);

    const first = sessions.subscribeMessages("agent:main:session-1");
    const second = sessions.subscribeMessages("agent:main:session-1");
    expect(request).toHaveBeenCalledTimes(1);

    rejectInitial(new Error("initial subscribe failed"));
    await expect(first).rejects.toThrow("initial subscribe failed");
    await expect(second).rejects.toThrow("initial subscribe failed");
    expect(request).toHaveBeenCalledTimes(1);

    const recovered = await sessions.subscribeMessages("agent:main:session-1");
    expect(request).toHaveBeenCalledTimes(2);
    await sessions.unsubscribeMessages(recovered);
    sessions.dispose();
  });

  it("refreshes and preserves a preamble replay when the sidebar already owns the subscription", async () => {
    let subscribeCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.messages.subscribe") {
        throw new Error(`Unexpected request: ${method}`);
      }
      subscribeCount += 1;
      return {
        subscribed: true,
        key: "agent:main:session-1",
        preambleReplay: {
          runId: "run-1",
          itemId: "commentary-1",
          progressText:
            subscribeCount === 1
              ? "Checking the gateway"
              : "Checking the gateway subscription handoff",
          updatedAt: subscribeCount === 1 ? 41 : 42,
        },
      };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = {
      snapshot: {
        client,
        phase: "connected" as const,
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: null as GatewayHelloOk | null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    };
    const sessions = createSessionCapability(gateway);

    const sidebarSubscription = await sessions.subscribeMessages("agent:main:session-1");
    await expect(sessions.subscribeMessages("agent:main:session-1")).resolves.toEqual({
      key: "agent:main:session-1",
      agentId: null,
      preambleReplay: {
        runId: "run-1",
        itemId: "commentary-1",
        progressText: "Checking the gateway subscription handoff",
        updatedAt: 42,
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
    await sessions.unsubscribeMessages(sidebarSubscription);
    sessions.dispose();
  });
});
