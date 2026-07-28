import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionApprovalReplay } from "../../../packages/gateway-protocol/src/index.js";
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
    loadSessionEntryReadOnly: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
  };
});

import { sessionsHandlers } from "./sessions.js";

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
  agents?: Array<{ id: string; default?: boolean }>;
  observerAvailable?: boolean;
  preambleReplay?: {
    runId: string;
    itemId?: string;
    progressText: string;
    updatedAt: number;
  };
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
  const getPreambleReplay = vi.fn(() => params.preambleReplay);
  const context = {
    getRuntimeConfig: () => ({
      agents: { list: params.agents ?? [{ id: "main", default: true }] },
      ...(params.globalScope ? { session: { scope: "global" as const } } : {}),
    }),
    listSessionPendingApprovals,
    logGateway: { error: logError },
    ...(params.observerAvailable === false ? {} : { sessionObserver: { getPreambleReplay } }),
    subscribeSessionMessageEvents,
  } as unknown as GatewayRequestContext;
  return {
    context,
    getPreambleReplay,
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
    sessionsHandlers["sessions.messages.subscribe"],
    'sessionsHandlers["sessions.messages.subscribe"] test invariant',
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

describe("sessions.messages.subscribe approval opt-in", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({ canonicalKey: sessionKey }));
  });

  it("returns the active preamble after installing the message subscription", async () => {
    const preambleReplay = {
      runId: "run-1",
      itemId: "commentary-1",
      progressText: "Checking the gateway subscription handoff",
      updatedAt: 42,
    };
    const { context, getPreambleReplay, subscribeSessionMessageEvents } = createContext({
      preambleReplay,
    });

    const respond = await subscribe({
      body: { key: "agent:main:session-1" },
      client: createClient({ scopes: ["operator.read"], connId: "conn-chat" }),
      context,
    });

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith("conn-chat", "agent:main:session-1");
    expect(subscribeSessionMessageEvents.mock.invocationCallOrder[0]).toBeLessThan(
      getPreambleReplay.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:session-1", preambleReplay },
      undefined,
    );
  });

  it("allows an admin without a paired device and uses the exact scoped subscription key", async () => {
    loadSessionEntryMock.mockReturnValueOnce({ canonicalKey: "global" });
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
      body: { key: "agent:work:main", includeApprovals: true },
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
      { subscribed: true, key: "global", preambleReplay: null, approvalReplay },
      undefined,
    );
  });

  it("allows a paired device with approval scope", async () => {
    loadSessionEntryMock.mockReturnValueOnce({ canonicalKey: "agent:main:child" });
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
      { subscribed: true, key: "agent:main:child", preambleReplay: null, approvalReplay },
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

  it("returns an authoritative empty preamble snapshot without approval replay", async () => {
    loadSessionEntryMock.mockReturnValueOnce({ canonicalKey: "agent:main:child" });
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
      { subscribed: true, key: "agent:main:child", preambleReplay: null },
      undefined,
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("approvalReplay");
  });

  it("omits the preamble snapshot when observer replay support is unavailable", async () => {
    loadSessionEntryMock.mockReturnValueOnce({ canonicalKey: "agent:main:child" });
    const { context, getPreambleReplay } = createContext({ observerAvailable: false });

    const respond = await subscribe({
      body: { key: "child" },
      client: createClient({ scopes: ["operator.read"] }),
      context,
    });

    expect(getPreambleReplay).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:child" },
      undefined,
    );
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
});
