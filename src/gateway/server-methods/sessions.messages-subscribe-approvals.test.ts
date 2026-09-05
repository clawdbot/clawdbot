import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayProtocolClient,
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolSocketHandlers,
} from "../../../packages/gateway-client/src/protocol-client.js";
import { GatewaySessionMessageSubscriptionCoordinator } from "../../../packages/gateway-client/src/session-subscriptions.js";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../../packages/gateway-client/src/timeouts.js";
import type { SessionApprovalReplay } from "../../../packages/gateway-protocol/src/index.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const loadSessionEntryMock = vi.fn((sessionKey: string, _opts?: { agentId?: string }) => ({
  canonicalKey: sessionKey,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
    loadGatewaySessionEntryReadOnly: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
  };
});

import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";

function createClient(params: {
  scopes: string[];
  deviceId?: string;
  connId?: string;
}): GatewayClient {
  return {
    connId: params.connId ?? "conn-approval-reviewer",
    connect: {
      client: { id: "approval-subscribe-test", displayName: "Approval Subscribe Test" },
      scopes: params.scopes,
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
  } as unknown as GatewayClient;
}

function createContext(params: {
  replay?: SessionApprovalReplay;
  replayError?: Error;
  globalScope?: boolean;
  mainKey?: string;
  agents?: Array<{ id: string; default?: boolean }>;
}) {
  const rollbackSubscription = vi.fn();
  const subscribeSessionMessageEvents = vi.fn(() => rollbackSubscription);
  const listSessionPendingApprovals = vi.fn(() => {
    if (params.replayError) {
      throw params.replayError;
    }
    return params.replay;
  });
  const logError = vi.fn();
  const context = {
    getRuntimeConfig: () => ({
      agents: { list: params.agents ?? [{ id: "main", default: true }] },
      ...(params.globalScope || params.mainKey
        ? {
            session: {
              ...(params.globalScope ? { scope: "global" as const } : {}),
              ...(params.mainKey ? { mainKey: params.mainKey } : {}),
            },
          }
        : {}),
    }),
    listSessionPendingApprovals,
    logGateway: { error: logError },
    subscribeSessionMessageEvents,
  } as unknown as GatewayRequestContext;
  return {
    context,
    listSessionPendingApprovals,
    logError,
    rollbackSubscription,
    subscribeSessionMessageEvents,
  };
}

async function subscribe(params: {
  body: Record<string, unknown>;
  client: GatewayClient;
  context: GatewayRequestContext;
}) {
  const respond = vi.fn();
  await expectDefined(
    sessionSubscriptionHandlers["sessions.messages.subscribe"],
    'sessionSubscriptionHandlers["sessions.messages.subscribe"] test invariant',
  )({
    req: { id: "req-subscribe-approvals" } as never,
    params: params.body,
    respond,
    context: params.context,
    client: params.client,
    isWebchatConnect: () => false,
  } satisfies GatewayRequestHandlerOptions);
  return respond;
}

function createCommittedSubscriptionBoundary(
  options: {
    holdApprovalUpgradeOnly?: boolean;
    rejectRecovery?: boolean;
  } = {},
) {
  const sessionKey = "agent:main:main";
  const registry = createSessionMessageSubscriberRegistry();
  const gatewayClient = createClient({ scopes: ["operator.admin"] });
  const replay = {
    sessionKey,
    updatedAtMs: 42,
    approvals: [],
    truncated: false,
  } satisfies SessionApprovalReplay;
  const context = {
    ...createContext({ replay }).context,
    subscribeSessionMessageEvents: registry.subscribe,
    unsubscribeSessionMessageEvents: registry.unsubscribe,
  } as GatewayRequestContext;
  const closed = vi.fn();
  const delayedResponses: string[] = [];
  let nextRequestId = 0;
  let socketHandlers: GatewayProtocolSocketHandlers | undefined;
  const protocol = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
      socketHandlers = handlers;
      return {
        isOpen: () => true,
        send: (raw) => {
          const request = JSON.parse(raw) as {
            id: string;
            method: string;
            params: Record<string, unknown>;
          };
          const isRecovery =
            request.method === "sessions.messages.unsubscribe" ||
            (options.holdApprovalUpgradeOnly &&
              request.method === "sessions.messages.subscribe" &&
              request.params.includeApprovals !== true &&
              nextRequestId > 1);
          if (options.rejectRecovery && isRecovery) {
            handlers.message(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: false,
                error: { code: "UNAVAILABLE", message: "subscription recovery unavailable" },
              }),
            );
            return;
          }
          const handler = expectDefined(
            sessionSubscriptionHandlers[request.method],
            `session subscription boundary handler ${request.method}`,
          );
          void handler({
            req: { id: request.id } as never,
            params: request.params,
            context,
            client: gatewayClient,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              const response = JSON.stringify({
                type: "res",
                id: request.id,
                ok,
                payload,
                error,
              });
              if (
                request.method === "sessions.messages.subscribe" &&
                (!options.holdApprovalUpgradeOnly || request.params.includeApprovals === true)
              ) {
                delayedResponses.push(response);
                return;
              }
              handlers.message(response);
            },
          } satisfies GatewayRequestHandlerOptions);
        },
        close: (code, reason) => {
          closed(code, reason);
          registry.unsubscribeAll(gatewayClient.connId ?? "");
          handlers.close(code ?? 1000, reason ?? "stopped");
        },
      };
    },
    createRequestId: () => `subscription-${++nextRequestId}`,
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  protocol.start();
  return {
    closed,
    coordinator: new GatewaySessionMessageSubscriptionCoordinator(protocol),
    gatewayClient,
    protocol,
    registry,
    sessionKey,
    deliverLateResponses() {
      for (const response of delayedResponses) {
        socketHandlers?.message(response);
      }
    },
  };
}

describe("sessions.messages.subscribe approval opt-in", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows an admin without a paired device and uses the exact scoped subscription key", async () => {
    const approvalReplay = {
      sessionKey: "agent:work:global",
      updatedAtMs: 42,
      approvals: [],
      truncated: false,
    } satisfies SessionApprovalReplay;
    const { context, listSessionPendingApprovals, subscribeSessionMessageEvents } = createContext({
      replay: approvalReplay,
      globalScope: true,
      agents: [{ id: "main", default: true }, { id: "work" }],
    });

    const respond = await subscribe({
      body: { key: "global", agentId: "work", includeApprovals: true },
      client: createClient({ scopes: ["operator.admin"], connId: " conn-admin " }),
      context,
    });

    expect(listSessionPendingApprovals).toHaveBeenCalledWith(
      "agent:work:global",
      expect.objectContaining({ connId: " conn-admin " }),
    );
    expect(subscribeSessionMessageEvents.mock.invocationCallOrder[0]).toBeLessThan(
      listSessionPendingApprovals.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith("conn-admin", "agent:work:global", {
      includeApprovals: true,
      provisional: true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "global", approvalReplay },
      undefined,
    );
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
  });

  it("allows a paired device with approval scope", async () => {
    const approvalReplay = {
      sessionKey: "agent:main:child",
      updatedAtMs: 43,
      approvals: [],
      truncated: false,
    } satisfies SessionApprovalReplay;
    const { context, subscribeSessionMessageEvents } = createContext({ replay: approvalReplay });

    const respond = await subscribe({
      body: { key: "child", includeApprovals: true },
      client: createClient({ scopes: ["operator.approvals"], deviceId: "phone" }),
      context,
    });

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-approval-reviewer",
      "agent:main:child",
      { includeApprovals: true, provisional: true },
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:child", approvalReplay },
      undefined,
    );
  });

  it.each([
    {
      name: "approval scope without a paired device",
      client: createClient({ scopes: ["operator.approvals"] }),
    },
    {
      name: "paired device without approval authority",
      client: createClient({ scopes: ["operator.read"], deviceId: "phone" }),
    },
  ])("rejects $name", async ({ client }) => {
    const { context, listSessionPendingApprovals, subscribeSessionMessageEvents } = createContext(
      {},
    );

    const respond = await subscribe({
      body: { key: "agent:main:child", includeApprovals: true },
      client,
      context,
    });

    expect(listSessionPendingApprovals).not.toHaveBeenCalled();
    expect(subscribeSessionMessageEvents).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("operator.approvals"),
      }),
    );
  });

  it("keeps the non-approval response shape and skips replay", async () => {
    const { context, listSessionPendingApprovals, subscribeSessionMessageEvents } = createContext(
      {},
    );

    const respond = await subscribe({
      body: { key: "child" },
      client: createClient({ scopes: ["operator.read"] }),
      context,
    });

    expect(listSessionPendingApprovals).not.toHaveBeenCalled();
    expect(subscribeSessionMessageEvents).toHaveBeenCalled();
    expect(subscribeSessionMessageEvents.mock.calls[0]?.slice(0, 2)).toEqual([
      "conn-approval-reviewer",
      "agent:main:child",
    ]);
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:child" },
      undefined,
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("approvalReplay");
  });

  it("canonicalizes configured main aliases without loading the session store", async () => {
    const { context, subscribeSessionMessageEvents } = createContext({ mainKey: "work" });

    const respond = await subscribe({
      body: { key: "main" },
      client: createClient({ scopes: ["operator.read"] }),
      context,
    });

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-approval-reviewer",
      "agent:main:work",
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:work" },
      undefined,
    );
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "throws", replayError: new Error("database unavailable") },
    { name: "returns no snapshot", replayError: undefined },
  ])("restores the prior subscription when replay $name", async ({ replayError }) => {
    const {
      context,
      listSessionPendingApprovals,
      logError,
      rollbackSubscription,
      subscribeSessionMessageEvents,
    } = createContext({ replayError });

    const respond = await subscribe({
      body: { key: "agent:main:child", includeApprovals: true },
      client: createClient({ scopes: ["operator.admin"] }),
      context,
    });

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-approval-reviewer",
      "agent:main:child",
      { includeApprovals: true, provisional: true },
    );
    expect(subscribeSessionMessageEvents.mock.invocationCallOrder[0]).toBeLessThan(
      listSessionPendingApprovals.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(rollbackSubscription).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    if (replayError) {
      expect(logError).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
    }
  });

  it.each([
    { name: "plain", includeApprovals: false },
    { name: "approval-enabled", includeApprovals: true },
  ])(
    "removes a committed $name observer when its subscription acknowledgment times out",
    async ({ includeApprovals }) => {
      vi.useFakeTimers();
      const boundary = createCommittedSubscriptionBoundary();
      let failure: unknown;
      void boundary.coordinator.acquire("main", { includeApprovals }).catch((error: unknown) => {
        failure = error;
      });

      expect(
        boundary.registry.get(boundary.sessionKey).has(boundary.gatewayClient.connId ?? ""),
      ).toBe(true);
      expect(
        boundary.registry
          .getApprovals(boundary.sessionKey)
          .has(boundary.gatewayClient.connId ?? ""),
      ).toBe(includeApprovals);

      await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

      expect(failure).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
      expect(boundary.registry.get(boundary.sessionKey)).toEqual(new Set());
      expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(new Set());
      boundary.deliverLateResponses();
      expect(boundary.registry.get(boundary.sessionKey)).toEqual(new Set());
      boundary.protocol.stop();
    },
  );

  it("removes timed-out approval authority while preserving an existing plain observer", async () => {
    vi.useFakeTimers();
    const boundary = createCommittedSubscriptionBoundary({ holdApprovalUpgradeOnly: true });
    const plain = await boundary.coordinator.acquire("main");
    let failure: unknown;

    void boundary.coordinator
      .acquire("main", { includeApprovals: true })
      .catch((error: unknown) => {
        failure = error;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(
      new Set([boundary.gatewayClient.connId]),
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

    expect(failure).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(boundary.registry.get(boundary.sessionKey)).toEqual(
      new Set([boundary.gatewayClient.connId]),
    );
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(new Set());
    boundary.deliverLateResponses();
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(new Set());
    await boundary.coordinator.release(plain);
    boundary.protocol.stop();
  });

  it("retires the committed approval observer when both acknowledgment and recovery fail", async () => {
    vi.useFakeTimers();
    const boundary = createCommittedSubscriptionBoundary({ rejectRecovery: true });
    let failure: unknown;

    void boundary.coordinator
      .acquire("main", { includeApprovals: true })
      .catch((error: unknown) => {
        failure = error;
        if (error instanceof AggregateError) {
          boundary.protocol.closeSocket(4000, "session subscription recovery failed");
        }
      });
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(
      new Set([boundary.gatewayClient.connId]),
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(boundary.closed).toHaveBeenCalledExactlyOnceWith(
      4000,
      "session subscription recovery failed",
    );
    expect(boundary.registry.get(boundary.sessionKey)).toEqual(new Set());
    expect(boundary.registry.getApprovals(boundary.sessionKey)).toEqual(new Set());
    boundary.protocol.stop();
  });
});
