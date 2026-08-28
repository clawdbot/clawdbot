// @vitest-environment node
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  GatewayProtocolClient,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";

function emptySessionsResult(): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
}

function runningSessionsResult(): SessionsListResult {
  return {
    ...emptySessionsResult(),
    count: 1,
    sessions: [
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["run-1"],
        status: "running",
        startedAt: 1,
      },
    ],
  };
}

function createSubscriptionHydrationHarness(request: GatewayBrowserClient["request"]) {
  const client = { request } as GatewayBrowserClient;
  let snapshot = {
    client: null as GatewayBrowserClient | null,
    phase: "reconnecting" as "connected" | "reconnecting",
    sessionKey: "agent:main:main",
    assistantAgentId: "main" as string | null,
    hello: null as GatewayHelloOk | null,
  };
  let gatewayListener: ((next: typeof snapshot) => void) | undefined;
  const sessions = createSessionCapability({
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      gatewayListener = listener;
      return () => {
        gatewayListener = undefined;
      };
    },
    subscribeEvents: () => () => undefined,
  });
  return {
    client,
    sessions,
    connect: () => {
      snapshot = { ...snapshot, client, phase: "connected" };
      gatewayListener?.(snapshot);
    },
    disconnect: () => {
      snapshot = { ...snapshot, phase: "reconnecting" };
      gatewayListener?.(snapshot);
    },
  };
}

const targetedSessionReconciliationCases = [
  {
    description: "targeted session changes",
    reconcile: (sessions: ReturnType<typeof createSessionCapability>) => {
      expect(
        sessions.reconcileChanged(
          {
            sessionKey: "agent:main:main",
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 2,
            hasActiveRun: false,
            status: "done",
          },
          { resultAgentId: "main" },
        ).applied,
      ).toBe(true);
    },
  },
  {
    description: "targeted run-terminal reconciliation",
    reconcile: (sessions: ReturnType<typeof createSessionCapability>) => {
      expect(
        sessions.reconcileRunTerminal({
          sessionKeys: ["agent:main:main"],
          runId: "run-1",
          status: "done",
          endedAt: 2,
        }),
      ).toBe(true);
    },
  },
];

describe("session connection hydration", () => {
  it("subscribes and hydrates the owner-first roster in one bootstrap request", async () => {
    const roster: SessionsListResult = {
      ...emptySessionsResult(),
      count: 3,
      sessions: [
        {
          key: "agent:main:mine-new",
          kind: "direct",
          updatedAt: 3,
          createdActor: { type: "human", id: "operator" },
        },
        {
          key: "agent:main:mine-old",
          kind: "direct",
          updatedAt: 1,
          createdActor: { type: "human", id: "operator" },
        },
        {
          key: "agent:main:theirs",
          kind: "direct",
          updatedAt: 2,
          createdActor: { type: "human", id: "collaborator" },
        },
      ],
    };
    const bootstrap = createDeferred<{ subscribed: true; list: SessionsListResult }>();
    const queuedList = createDeferred<SessionsListResult>();
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.subscribe") {
        return await bootstrap.promise;
      }
      if (method === "sessions.list") {
        return params?.search === "queued" ? await queuedList.promise : emptySessionsResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    let snapshot = {
      client: null as GatewayBrowserClient | null,
      phase: "reconnecting" as "connected" | "reconnecting",
      sessionKey: "agent:main:mine-new",
      assistantAgentId: "main" as string | null,
      hello: null as GatewayHelloOk | null,
      selfUser: { id: "operator", name: "Operator" },
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
        "sessions.subscribe",
        expect.objectContaining({
          agentId: "main",
          ownerFirst: true,
          limit: 60,
        }),
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(0);
    expect(sessions.state.result).toBeNull();
    const queuedRefresh = sessions.refresh({ agentId: "other", search: "queued", force: true });

    bootstrap.resolve({ subscribed: true, list: roster });
    await waitForFast(() =>
      expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
        "agent:main:mine-new",
        "agent:main:mine-old",
        "agent:main:theirs",
      ]),
    );
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1),
    );
    expect(request.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ agentId: "other", search: "queued" }),
    );
    queuedList.resolve(emptySessionsResult());
    await queuedRefresh;
    sessions.dispose();
  });

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
        return { subscribed: true };
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

  it("rehydrates owner sessions when identity arrives on the same connection", async () => {
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
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
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
    await Promise.resolve();
    expect(listCalls).toBe(1);

    snapshot = { ...snapshot, selfUser: { id: "operator", name: "Operator" } };
    gatewayListener?.(snapshot);
    resolveList(result);
    await waitForFast(() => expect(listCalls).toBe(2));

    expect(
      request.mock.calls
        .filter(([method]) => method === "sessions.list")
        .map(([, params]) => params),
    ).toEqual([
      expect.not.objectContaining({ ownerFirst: expect.anything() }),
      expect.objectContaining({ ownerFirst: true, limit: 60 }),
    ]);
    expect(sessions.state.result?.sessions).toEqual([]);
    expect(sessions.state.agentId).toBe("main");
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
        return { subscribed: true };
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

  it("preserves a failed session observer through hydration and retries the current connection", async () => {
    vi.useFakeTimers();
    const result = emptySessionsResult();
    const recoveredResult: SessionsListResult = {
      ...result,
      count: 1,
      sessions: [{ key: "agent:main:recovered", kind: "direct", updatedAt: 2 }],
    };
    let subscriptionCalls = 0;
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        subscriptionCalls += 1;
        if (subscriptionCalls === 1) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "session observer temporarily unavailable",
            retryable: true,
            retryAfterMs: 100,
          });
        }
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        listCalls += 1;
        return listCalls === 1 ? result : recoveredResult;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions, connect } = createSubscriptionHydrationHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(sessions.state.result).toBe(result);
      expect(sessions.state.error).toBe("session observer temporarily unavailable");
      expect(subscriptionCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(subscriptionCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.error).toBeNull();
      expect(sessions.state.result).toBe(recoveredResult);
      expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("recovers the roster after a subscription deadline without admitting late replies", async () => {
    vi.useFakeTimers();
    const initialResult = emptySessionsResult();
    const recoveredResult: SessionsListResult = {
      ...initialResult,
      count: 1,
      sessions: [{ key: "agent:main:recovered", kind: "direct", updatedAt: 2 }],
    };
    const sent: Array<{ id: string; method: string }> = [];
    let handlers: GatewayProtocolSocketHandlers | undefined;
    const protocol = new GatewayProtocolClient<Record<string, never>>({
      createSocket: (nextHandlers) => {
        handlers = nextHandlers;
        return {
          isOpen: () => true,
          send: (data) => {
            const frame = JSON.parse(data) as { id: string; method: string };
            sent.push({ id: frame.id, method: frame.method });
          },
          close: () => undefined,
        };
      },
      createRequestId: () => "request",
      buildConnectPlan: () => ({}),
      buildConnectParams: (plan) => plan,
      resolveClose: () => ({ retry: false, notify: false }),
      handshake: { mode: "require-challenge", timeoutMs: 100 },
      reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
    });
    protocol.start();
    const request = protocol.request.bind(protocol) as GatewayBrowserClient["request"];
    const { sessions, connect } = createSubscriptionHydrationHarness(request);
    const recoveredStates: SessionsListResult[] = [];
    const unsubscribe = sessions.subscribe((next) => {
      if (next.result?.sessions.some((row) => row.key === "agent:main:recovered")) {
        recoveredStates.push(next.result);
      }
    });
    const respond = (id: string, payload: unknown) => {
      handlers?.message(JSON.stringify({ type: "res", id, ok: true, payload }));
    };

    try {
      connect();
      expect(sent).toEqual([{ id: "1:request", method: "sessions.subscribe" }]);

      await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
      expect(sent).toContainEqual({ id: "2:request", method: "sessions.list" });
      respond("2:request", initialResult);
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.result).toEqual(initialResult);

      await vi.advanceTimersByTimeAsync(500);
      expect(sent).toContainEqual({ id: "3:request", method: "sessions.subscribe" });

      respond("1:request", { status: "accepted" });
      respond("1:request", { subscribed: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.error).not.toBeNull();
      expect(sent.filter(({ method }) => method === "sessions.list")).toHaveLength(1);

      respond("3:request", { subscribed: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toContainEqual({ id: "4:request", method: "sessions.list" });
      respond("4:request", recoveredResult);
      await vi.advanceTimersByTimeAsync(0);

      respond("1:request", { status: "accepted" });
      respond("1:request", { subscribed: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(sessions.state.error).toBeNull();
      expect(sessions.state.result).toEqual(recoveredResult);
      expect(recoveredStates).toEqual([recoveredResult]);
      expect(sent.filter(({ method }) => method === "sessions.subscribe")).toHaveLength(2);
      expect(sent.filter(({ method }) => method === "sessions.list")).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unsubscribe();
      sessions.dispose();
      protocol.stop();
      vi.useRealTimers();
    }
  });

  it.each([
    { description: "an explicitly declined", response: { subscribed: false } },
    { description: "an unacknowledged", response: {} },
    { description: "a missing", response: null },
  ])(
    "rejects $description session observer and retries until acknowledged",
    async ({ response }) => {
      vi.useFakeTimers();
      let subscriptionCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.subscribe") {
          subscriptionCalls += 1;
          return subscriptionCalls === 1 ? response : { subscribed: true };
        }
        if (method === "sessions.list") {
          return emptySessionsResult();
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { sessions, connect } = createSubscriptionHydrationHarness(
        request as unknown as GatewayBrowserClient["request"],
      );

      try {
        connect();
        await vi.advanceTimersByTimeAsync(0);

        expect(subscriptionCalls).toBe(1);
        expect(sessions.state.result).not.toBeNull();
        expect(sessions.state.error).toContain("did not activate the session event subscription");

        await vi.advanceTimersByTimeAsync(500);

        expect(subscriptionCalls).toBe(2);
        expect(sessions.state.error).toBeNull();
        expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("retires observer retries on disconnect before the same client reconnects", async () => {
    vi.useFakeTimers();
    let subscriptionCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        subscriptionCalls += 1;
        if (subscriptionCalls === 1) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "session observer temporarily unavailable",
            retryable: true,
            retryAfterMs: 100,
          });
        }
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return emptySessionsResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions, connect, disconnect } = createSubscriptionHydrationHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(subscriptionCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      disconnect();
      expect(sessions.state.error).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(subscriptionCalls).toBe(1);

      connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.error).toBeNull();
      expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("does not recreate a retry timer when an observer-error listener disposes its owner", async () => {
    vi.useFakeTimers();
    let subscriptionCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        subscriptionCalls += 1;
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "observer unavailable during teardown",
          retryable: true,
          retryAfterMs: 100,
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions, connect } = createSubscriptionHydrationHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    sessions.subscribe((next) => {
      if (next.error) {
        sessions.dispose();
      }
    });

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(subscriptionCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(subscriptionCalls).toBe(1);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each(targetedSessionReconciliationCases)(
    "preserves an active observer failure across $description",
    async ({ reconcile }) => {
      vi.useFakeTimers();
      let subscriptionCalls = 0;
      const result = runningSessionsResult();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.subscribe") {
          subscriptionCalls += 1;
          if (subscriptionCalls === 1) {
            throw new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "broad session observer unavailable",
              retryable: true,
              retryAfterMs: 100,
            });
          }
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          return result;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { sessions, connect } = createSubscriptionHydrationHarness(
        request as unknown as GatewayBrowserClient["request"],
      );

      try {
        connect();
        await vi.advanceTimersByTimeAsync(0);
        const observerError = "broad session observer unavailable";
        expect(sessions.state.error).toBe(observerError);

        reconcile(sessions);
        expect(sessions.state.error).toBe(observerError);

        await vi.advanceTimersByTimeAsync(100);
        expect(subscriptionCalls).toBe(2);
        expect(sessions.state.error).toBeNull();
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(targetedSessionReconciliationCases)(
    "preserves a newer operation failure across $description",
    async ({ reconcile }) => {
      vi.useFakeTimers();
      let subscriptionCalls = 0;
      let listCalls = 0;
      const result = runningSessionsResult();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.subscribe") {
          subscriptionCalls += 1;
          if (subscriptionCalls === 1) {
            throw new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "broad session observer unavailable",
              retryable: true,
              retryAfterMs: 100,
            });
          }
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          listCalls += 1;
          if (listCalls === 2) {
            throw new Error("newer session list failure");
          }
          return result;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { sessions, connect } = createSubscriptionHydrationHarness(
        request as unknown as GatewayBrowserClient["request"],
      );

      try {
        connect();
        await vi.advanceTimersByTimeAsync(0);
        await sessions.refresh({ force: true });
        const operationError = "newer session list failure";
        expect(sessions.state.error).toBe(operationError);

        reconcile(sessions);
        expect(sessions.state.error).toBe(operationError);

        await vi.advanceTimersByTimeAsync(100);
        expect(subscriptionCalls).toBe(2);
        expect(sessions.state.error).toBeNull();
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("keeps newer session-list failures visible across repeated observer retry failures", async () => {
    vi.useFakeTimers();
    let subscriptionCalls = 0;
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        subscriptionCalls += 1;
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: `observer unavailable ${subscriptionCalls}`,
          retryable: true,
          retryAfterMs: 100,
        });
      }
      if (method === "sessions.list") {
        listCalls += 1;
        if (listCalls > 1) {
          throw new Error("newer session list failure");
        }
        return emptySessionsResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions, connect } = createSubscriptionHydrationHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      await sessions.refresh({ force: true });
      expect(sessions.state.error).toBe("newer session list failure");

      await vi.advanceTimersByTimeAsync(100);

      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.error).toBe("newer session list failure");
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("does not clear an unrelated list error with the same observer error message", async () => {
    vi.useFakeTimers();
    let completeCatchUpList: (result: SessionsListResult) => void = () => undefined;
    const pendingCatchUpList = new Promise<SessionsListResult>((resolve) => {
      completeCatchUpList = resolve;
    });
    const sharedError = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "same failure message",
      retryable: true,
      retryAfterMs: 100,
    });
    let subscriptionCalls = 0;
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        subscriptionCalls += 1;
        if (subscriptionCalls === 1) {
          throw sharedError;
        }
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        listCalls += 1;
        if (listCalls === 2) {
          throw sharedError;
        }
        return listCalls === 3 ? await pendingCatchUpList : emptySessionsResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions, connect } = createSubscriptionHydrationHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      await sessions.refresh({ force: true });
      expect(sessions.state.error).toBe("same failure message");

      await vi.advanceTimersByTimeAsync(100);

      expect(subscriptionCalls).toBe(2);
      expect(listCalls).toBe(3);
      expect(sessions.state.error).toBe("same failure message");
      completeCatchUpList(emptySessionsResult());
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.error).toBeNull();
    } finally {
      completeCatchUpList(emptySessionsResult());
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("ignores an outdated observer refusal after the same client reconnects", async () => {
    vi.useFakeTimers();
    let settleRetiredSubscription: (response: { subscribed: boolean }) => void = () => undefined;
    const retiredSubscription = new Promise<{ subscribed: boolean }>((resolve) => {
      settleRetiredSubscription = resolve;
    });
    let subscriptionCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        subscriptionCalls += 1;
        return subscriptionCalls === 1 ? await retiredSubscription : { subscribed: true };
      }
      if (method === "sessions.list") {
        return emptySessionsResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions, connect, disconnect } = createSubscriptionHydrationHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(subscriptionCalls).toBe(1);

      disconnect();
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.result).not.toBeNull();

      settleRetiredSubscription({ subscribed: false });
      await vi.advanceTimersByTimeAsync(0);

      expect(sessions.state.error).toBeNull();
      expect(subscriptionCalls).toBe(2);
      expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      settleRetiredSubscription({ subscribed: false });
      sessions.dispose();
      vi.useRealTimers();
    }
  });
});
