import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodePendingHandlers } from "./nodes-pending.js";

const mocks = vi.hoisted(() => ({
  drainNodePendingWork: vi.fn(),
  enqueueNodePendingWork: vi.fn(),
  maybeWakeNodeWithApns: vi.fn(),
  maybeSendNodeWakeNudge: vi.fn(),
  waitForNodeReconnect: vi.fn(),
}));

vi.mock("../node-pending-work.js", () => ({
  drainNodePendingWork: mocks.drainNodePendingWork,
  enqueueNodePendingWork: mocks.enqueueNodePendingWork,
}));

vi.mock("./nodes.js", () => ({
  NODE_WAKE_RECONNECT_WAIT_MS: 3_000,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS: 12_000,
  maybeWakeNodeWithApns: mocks.maybeWakeNodeWithApns,
  maybeSendNodeWakeNudge: mocks.maybeSendNodeWakeNudge,
  waitForNodeReconnect: mocks.waitForNodeReconnect,
}));

type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
    details?: unknown;
  }?,
];

function makeContext(overrides?: Partial<Record<string, unknown>>) {
  return {
    nodeRegistry: {
      get: vi.fn(() => undefined),
    },
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    getRuntimeConfig: () => ({}),
    ...overrides,
  };
}

describe("node.pending handlers", () => {
  beforeEach(() => {
    mocks.drainNodePendingWork.mockReset();
    mocks.enqueueNodePendingWork.mockReset();
    mocks.maybeWakeNodeWithApns.mockReset();
    mocks.maybeSendNodeWakeNudge.mockReset();
    mocks.waitForNodeReconnect.mockReset();
  });

  it("drains pending work for the connected node identity", async () => {
    mocks.drainNodePendingWork.mockReturnValue({
      revision: 2,
      items: [{ id: "baseline-status", type: "status.request", priority: "default" }],
      hasMore: false,
    });
    const respond = vi.fn();

    await nodePendingHandlers["node.pending.drain"]({
      params: { maxItems: 3 },
      respond: respond as never,
      client: { connect: { device: { id: "ios-node-1" } } } as never,
      context: makeContext() as never,
      req: { type: "req", id: "req-node-pending-drain", method: "node.pending.drain" },
      isWebchatConnect: () => false,
    });

    expect(mocks.drainNodePendingWork).toHaveBeenCalledWith("ios-node-1", {
      maxItems: 3,
      includeDefaultStatus: true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        nodeId: "ios-node-1",
        revision: 2,
        items: [{ id: "baseline-status", type: "status.request", priority: "default" }],
        hasMore: false,
      },
      undefined,
    );
  });

  it("rejects node.pending.drain without a connected device identity", async () => {
    const respond = vi.fn();

    await nodePendingHandlers["node.pending.drain"]({
      params: {},
      respond: respond as never,
      client: null,
      context: makeContext() as never,
      req: { type: "req", id: "req-node-pending-drain-missing", method: "node.pending.drain" },
      isWebchatConnect: () => false,
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toContain("connected device identity");
  });

  it("enqueues pending work and wakes a disconnected node once", async () => {
    mocks.enqueueNodePendingWork.mockReturnValue({
      revision: 4,
      deduped: false,
      item: {
        id: "pending-1",
        type: "location.request",
        priority: "high",
        createdAtMs: 100,
        expiresAtMs: null,
      },
    });
    mocks.maybeWakeNodeWithApns.mockResolvedValue({
      available: true,
      throttled: false,
      path: "apns",
      durationMs: 12,
      apnsStatus: 200,
      apnsReason: null,
    });
    let connected = false;
    mocks.waitForNodeReconnect.mockImplementation(async () => {
      connected = true;
      return true;
    });
    const context = makeContext({
      nodeRegistry: {
        get: vi.fn(() => (connected ? { nodeId: "ios-node-2" } : undefined)),
      },
    });
    const respond = vi.fn();

    await nodePendingHandlers["node.pending.enqueue"]({
      params: {
        nodeId: "ios-node-2",
        type: "location.request",
        priority: "high",
      },
      respond: respond as never,
      client: null,
      context: context as never,
      req: { type: "req", id: "req-node-pending-enqueue", method: "node.pending.enqueue" },
      isWebchatConnect: () => false,
    });

    expect(mocks.enqueueNodePendingWork).toHaveBeenCalledWith({
      nodeId: "ios-node-2",
      type: "location.request",
      priority: "high",
      expiresInMs: undefined,
    });
    expect(mocks.maybeWakeNodeWithApns).toHaveBeenCalledWith("ios-node-2", {
      wakeReason: "node.pending",
      cfg: {},
    });
    expect(mocks.waitForNodeReconnect).toHaveBeenCalledWith({
      nodeId: "ios-node-2",
      context,
      timeoutMs: 3_000,
    });
    expect(mocks.maybeSendNodeWakeNudge).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        nodeId: "ios-node-2",
        revision: 4,
        wakeTriggered: true,
      }),
      undefined,
    );
  });
});
