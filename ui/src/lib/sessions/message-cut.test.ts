import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    sessionKey: string;
    assistantAgentId: string | null;
    hello: GatewayHelloOk | null;
  } = {
    client,
    connected: true,
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: null,
  };
  const listeners = new Set<(next: typeof snapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeEvents(listener: (event: GatewayEventFrame) => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    publish: (connected: boolean) => {
      snapshot = { ...snapshot, connected };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

describe("session capability message cuts", () => {
  it("returns a committed rewind result after the connection is replaced", async () => {
    const committed = deferred<{ editorText?: string }>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.rewind") {
        return committed.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const sessions = createSessionCapability(harness.gateway);

    const pending = sessions.rewind("agent:main:main", "user-entry");
    harness.publish(false);
    committed.resolve({ editorText: "edit me" });

    await expect(pending).resolves.toEqual({ editorText: "edit me" });
    expect(request).toHaveBeenCalledWith("sessions.rewind", {
      sessionKey: "agent:main:main",
      entryId: "user-entry",
    });
    sessions.dispose();
  });

  it("returns a committed fork result when the replacement refresh fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.fork") {
        return { sessionKey: "agent:main:dashboard:forked", editorText: "edit me" };
      }
      if (method === "sessions.list") {
        throw new Error("refresh failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.forkAtMessage("agent:main:main", "user-entry")).resolves.toEqual({
      sessionKey: "agent:main:dashboard:forked",
      editorText: "edit me",
    });
    expect(request).toHaveBeenCalledWith("sessions.fork", {
      sessionKey: "agent:main:main",
      entryId: "user-entry",
    });
    sessions.dispose();
  });

  it("lists branches and sends the selected leaf to the switch RPC", async () => {
    const branch = {
      leafEntryId: "branch-b",
      headline: "Try the earlier path",
      messageCount: 3,
      active: false,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.branches.list") {
        return { branches: [branch] };
      }
      if (method === "sessions.branches.switch") {
        return {};
      }
      if (method === "sessions.list") {
        return { sessions: [], count: 0 };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.listBranches("agent:main:main")).resolves.toEqual([branch]);
    await expect(sessions.switchBranch("agent:main:main", "branch-b")).resolves.toEqual({});
    expect(request).toHaveBeenCalledWith("sessions.branches.switch", {
      sessionKey: "agent:main:main",
      leafEntryId: "branch-b",
    });
    sessions.dispose();
  });
});
