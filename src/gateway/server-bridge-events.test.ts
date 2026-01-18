import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));
vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

import { enqueueSystemEvent } from "../infra/system-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { handleBridgeEvent } from "./server-bridge-events.js";
import type { BridgeHandlersContext } from "./server-bridge-types.js";
import type { HealthSummary } from "../commands/health.js";
import type { CliDeps } from "../cli/deps.js";

const enqueueSystemEventMock = vi.mocked(enqueueSystemEvent);
const requestHeartbeatNowMock = vi.mocked(requestHeartbeatNow);

function buildCtx(): BridgeHandlersContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    bridgeSendToSession: () => {},
    bridgeSubscribe: () => {},
    bridgeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    loadGatewayModelCatalog: async () => [],
    logBridge: { warn: () => {} },
  };
}

describe("bridge exec events", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    requestHeartbeatNowMock.mockReset();
  });

  it("enqueues exec.started events", async () => {
    const ctx = buildCtx();
    await handleBridgeEvent(ctx, "node-1", {
      event: "exec.started",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:main:main",
        runId: "run-1",
        command: "ls -la",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec started (node=node-1 id=run-1): ls -la",
      { sessionKey: "agent:main:main", contextKey: "exec:run-1" },
    );
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({ reason: "exec-event" });
  });

  it("enqueues exec.finished events with output", async () => {
    const ctx = buildCtx();
    await handleBridgeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON: JSON.stringify({
        runId: "run-2",
        exitCode: 0,
        timedOut: false,
        output: "done",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2 id=run-2, code 0)\ndone",
      { sessionKey: "node-node-2", contextKey: "exec:run-2" },
    );
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({ reason: "exec-event" });
  });

  it("enqueues exec.denied events with reason", async () => {
    const ctx = buildCtx();
    await handleBridgeEvent(ctx, "node-3", {
      event: "exec.denied",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:demo:main",
        runId: "run-3",
        command: "rm -rf /",
        reason: "allowlist-miss",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec denied (node=node-3 id=run-3, allowlist-miss): rm -rf /",
      { sessionKey: "agent:demo:main", contextKey: "exec:run-3" },
    );
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({ reason: "exec-event" });
  });
});
