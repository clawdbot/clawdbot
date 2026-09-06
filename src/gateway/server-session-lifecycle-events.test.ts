import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  createActiveRun,
  createGatewayBroadcaster,
  createLifecycleEventBroadcastHandler,
  expectPrivateSessionInvalidation,
  fixedStoreRuntimeConfig,
  loadGatewaySessionRowMock,
  ownerGoal,
  resolveEmbeddedAgentSessionProgressStateMock,
  runtimeConfigState,
  sessionRow,
  subscribePluginSessionsChanged,
} from "./server-session-events.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

describe("createLifecycleEventBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEmbeddedAgentSessionProgressStateMock.mockReturnValue(undefined);
    loadGatewaySessionRowMock.mockReturnValue(sessionRow);
    runtimeConfigState.value = {};
    sessionRow.key = "agent:main:main";
  });
  it("keeps delayed key-only deletes as invalidations without borrowing a replacement", () => {
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["observer"]) },
      chatAbortControllers: new Map(),
    });
    handler({ sessionKey: sessionRow.key, reason: "delete" });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      { sessionKey: sessionRow.key, agentId: "main", reason: "delete", ts: expect.any(Number) },
      new Set(["observer"]),
      expect.any(Object),
    );
    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
  });

  it.each(["swarm", "run-capacity"])(
    "prepares collector counts only for a committed parent invalidation (%s)",
    (reason) => {
      const broadcastToConnIds = vi.fn();
      loadGatewaySessionRowMock.mockImplementation((_key, options) => ({
        ...sessionRow,
        ...(options?.includeSwarmSummary ? { swarm: undefined } : {}),
      }));
      const handler = createLifecycleEventBroadcastHandler({
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => new Set(["observer"]) },
        chatAbortControllers: new Map(),
      });

      handler({ sessionKey: sessionRow.key, agentId: "main", reason });

      expect(loadGatewaySessionRowMock).toHaveBeenCalledExactlyOnceWith(sessionRow.key, {
        agentId: "main",
        ...(reason === "swarm" ? { includeSwarmSummary: true } : {}),
      });
      const payload = broadcastToConnIds.mock.calls[0]?.[1];
      if (reason === "swarm") {
        expect(payload).toHaveProperty("swarm", null);
      } else {
        expect(payload).not.toHaveProperty("swarm");
      }
    },
  );

  it.each(["phase", "log"] as const)("projects swarm %s payload fields", (kind) => {
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map(),
    });

    handler({
      sessionKey: "agent:main:main",
      reason: "swarm-note",
      swarmGroupId: "swarm:agent:main:main:run-1",
      kind,
      text: "Research",
    });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        swarmGroupId: "swarm:agent:main:main:run-1",
        kind,
        text: "Research",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  it("publishes lifecycle changes to plugins without websocket subscribers", async () => {
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(),
    });
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set() },
      chatAbortControllers: new Map(),
    });

    try {
      handler({
        sessionKey: "agent:main:main",
        reason: "rename",
        label: "Renamed session",
      });
      await Promise.resolve();
      expect(received).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        agentId: "main",
        label: "Renamed session",
        reason: "rename",
      });
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { name: "projects configured persisted state without publishing its goal" },
    { name: "publishes active state and goal for the explicit owner", agentId: "ops" },
  ])("$name through capacity transitions without a refresh", ({ agentId }) => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["ops", "research"]);
    sessionRow.key = "global";
    const goal = { ...ownerGoal };
    loadGatewaySessionRowMock.mockReturnValue({ ...sessionRow, goal });
    const activeRun = {
      ...createActiveRun(true),
      agentId: "ops",
      sessionKey: "global",
    };
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map([["run-before-finalize", activeRun]]),
    });

    handler({ sessionKey: "global", ...(agentId ? { agentId } : {}), reason: "updated" });

    expect(loadGatewaySessionRowMock).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "global",
        hasActiveRun: true,
        activeRunIds: ["run-before-finalize"],
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    if (agentId) {
      expect(payload).toMatchObject({ agentId: "ops", goal });
    } else {
      expect(payload).not.toHaveProperty("agentId");
      expect(payload).not.toHaveProperty("goal");
      expect(payload).not.toHaveProperty("session.goal");
    }
    const runId = "run-before-finalize";
    registerAgentRunContext(runId, { sessionKey: "global", agentId: "ops" });
    const unsubscribe = onSessionLifecycleEvent(handler);
    const releaseWait = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
    try {
      releaseWait?.();
      const transitions = broadcastToConnIds.mock.calls.slice(1);
      expect(
        transitions.map(([, event]) => [event.reason, event.status, event.hasActiveRun]),
      ).toEqual([
        ["run-capacity", "queued", true],
        ["run-capacity", "running", true],
      ]);
    } finally {
      unsubscribe();
      releaseWait?.();
      clearAgentRunContext(runId);
    }
  });

  it("publishes only a private invalidation for a retired fixed-store lifecycle owner", () => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["research"]);
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-events"]) },
      chatAbortControllers: new Map(),
    });

    handler({ sessionKey: "global", reason: "updated" });

    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", reason: "updated" }),
      new Set(["conn-events"]),
      {
        agentId: "ops",
        dropIfSlow: true,
        sessionKeys: ["agent:ops:global"],
      },
    );
    expectPrivateSessionInvalidation(broadcastToConnIds.mock.calls[0]?.[1]);
  });
});
