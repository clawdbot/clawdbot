// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";

describe("session connection hydration", () => {
  it("uses the selected agent before a session key is available", async () => {
    const result: SessionsListResult = {
      ts: 1,
      path: "(multiple)",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "agent:roboclaw:dashboard:one", kind: "direct", updatedAt: 1 }],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return result;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    let snapshot = {
      client: null as GatewayBrowserClient | null,
      phase: "reconnecting" as "connected" | "reconnecting",
      sessionKey: "",
      assistantAgentId: "roboclaw" as string | null,
      hello: null as GatewayHelloOk | null,
    };
    let gatewayListener: ((next: typeof snapshot) => void) | undefined;
    const sessions = createSessionCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener) {
        gatewayListener = listener;
        return () => undefined;
      },
      subscribeEvents: () => () => undefined,
    });

    snapshot = { ...snapshot, client, phase: "connected" };
    gatewayListener?.(snapshot);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "roboclaw", includeDerivedTitles: true }),
      ),
    );
    await waitForFast(() => expect(sessions.state.agentId).toBe("roboclaw"));
    expect(sessions.state.result).toBe(result);
    sessions.dispose();
  });

  it("ignores same-connection gateway metadata snapshots during hydration", async () => {
    let resolveList: (result: SessionsListResult) => void = () => undefined;
    const pendingList = new Promise<SessionsListResult>((resolve) => {
      resolveList = resolve;
    });
    let listCalls = 0;
    const result: SessionsListResult = {
      ts: 1,
      path: "(multiple)",
      count: 0,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        listCalls += 1;
        return listCalls === 1 ? await pendingList : result;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    let snapshot = {
      client: null as GatewayBrowserClient | null,
      phase: "reconnecting" as "connected" | "reconnecting",
      sessionKey: "agent:main:main",
      assistantAgentId: "main" as string | null,
      hello: null as GatewayHelloOk | null,
      canvasPluginSurfaceUrl: null as string | null,
      selfUser: null as { id: string; name?: string } | null,
    };
    let gatewayListener: ((next: typeof snapshot) => void) | undefined;
    const sessions = createSessionCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener) {
        gatewayListener = listener;
        return () => undefined;
      },
      subscribeEvents: () => () => undefined,
    });

    snapshot = { ...snapshot, client, phase: "connected" };
    gatewayListener?.(snapshot);
    await waitForFast(() => expect(listCalls).toBe(1));

    snapshot = { ...snapshot, canvasPluginSurfaceUrl: "https://gateway.example.test/canvas" };
    gatewayListener?.(snapshot);
    snapshot = { ...snapshot, selfUser: { id: "operator", name: "Operator" } };
    gatewayListener?.(snapshot);
    resolveList(result);
    await waitForFast(() => expect(sessions.state.result).toBe(result));
    await Promise.resolve();
    await Promise.resolve();

    expect(listCalls).toBe(1);
    sessions.dispose();
  });

  it("hydrates again after the current client reconnects", async () => {
    let listCalls = 0;
    const result: SessionsListResult = {
      ts: 1,
      path: "(multiple)",
      count: 0,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        listCalls += 1;
        return result;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    let snapshot = {
      client,
      phase: "connected" as "connected" | "reconnecting",
      sessionKey: "agent:main:main",
      assistantAgentId: "main" as string | null,
      hello: null as GatewayHelloOk | null,
      canvasPluginSurfaceUrl: null as string | null,
      selfUser: null as { id: string; name?: string } | null,
    };
    let gatewayListener: ((next: typeof snapshot) => void) | undefined;
    const sessions = createSessionCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener) {
        gatewayListener = listener;
        return () => undefined;
      },
      subscribeEvents: () => () => undefined,
    });

    gatewayListener?.(snapshot);
    await waitForFast(() => expect(listCalls).toBe(1));
    await waitForFast(() => expect(sessions.state.result).toBe(result));

    snapshot = { ...snapshot, phase: "reconnecting" };
    gatewayListener?.(snapshot);
    expect(sessions.state.result).toBeNull();

    snapshot = { ...snapshot, phase: "connected" };
    gatewayListener?.(snapshot);
    await waitForFast(() => expect(listCalls).toBe(2));
    await waitForFast(() => expect(sessions.state.result).toBe(result));

    sessions.dispose();
  });
});
