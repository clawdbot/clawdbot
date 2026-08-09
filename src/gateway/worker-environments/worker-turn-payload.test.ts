import { describe, expect, it } from "vitest";
import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import type { WorkerLaunchDescriptor } from "../../worker/launch-descriptor.js";
import {
  assertSupportedTurn,
  fitLaunchDescriptor,
  windowInitialMessages,
} from "./worker-turn-payload.js";

const PROVIDER_REPLAY = {
  v: 1 as const,
  type: "openai-responses-compaction",
  data: "opaque-worker-replay",
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.6-luna",
  baseUrlHash: "ozhevd1smnk8s",
};

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(timestamp: number, replay = false): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "visible" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    ...(replay ? { providerReplay: structuredClone(PROVIDER_REPLAY) } : {}),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function toolResultMessage(details: unknown, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-replay",
    toolName: "read",
    content: [{ type: "text", text: "result" }],
    details,
    isError: false,
    timestamp,
  };
}

function buildDescriptor(
  initialMessages: WorkerLaunchDescriptor["assignment"]["initialMessages"],
): WorkerLaunchDescriptor {
  return {
    version: 2,
    socketPath: "/tmp/worker.sock",
    admission: {
      environmentId: "environment",
      credential: "worker-fixture-credential",
      sessionId: "session",
      ownerEpoch: 1,
      rpcSetVersion: 1,
      handshake: {
        bundleHash: "a".repeat(64),
        openclawVersion: "test",
        protocolFeatures: [],
      },
    },
    assignment: {
      runId: "run",
      turnId: "turn",
      prompt: "prompt",
      suppressPromptTranscript: true,
      workspaceDir: "/tmp/workspace",
      modelRef: { provider: "openai", model: "gpt-5.6-luna" },
      inferenceOptions: {},
      initialMessages,
      transcript: { baseLeafId: null, nextSeq: 1 },
      liveEvents: { ackedSeq: 0, nextSeq: 1 },
      toolAuthority: { allowedToolNames: [] },
    },
  };
}

describe("assertSupportedTurn", () => {
  it("accepts scheduled authority for the worker launch envelope", () => {
    expect(
      assertSupportedTurn({
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "run",
        timeoutMs: 1_000,
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
        toolsAllow: ["write"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "default",
        },
      } as SessionPlacementTurnParams),
    ).toEqual({ provider: "openai", model: "gpt-5.4" });
  });
});

describe("windowInitialMessages", () => {
  it("pins the newest replay carrier when the normal cutoff would pass it", () => {
    const history = [userMessage("old", 1), assistantMessage(2, true)];
    history.push(
      ...Array.from({ length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 2 }, (_value, index) =>
        userMessage(`suffix-${index}`, index + 3),
      ),
    );

    const result = windowInitialMessages(history);

    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") {
      throw new Error("expected complete window");
    }
    expect(result.messages).toHaveLength(WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 1);
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      providerReplay: PROVIDER_REPLAY,
    });
  });

  it("reserves one context slot for the current prompt", () => {
    const history = Array.from({ length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES }, (_value, index) =>
      userMessage(`history-${index}`, index + 1),
    );

    const result = windowInitialMessages(history);

    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") {
      throw new Error("expected complete window");
    }
    expect(result.messages).toHaveLength(WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 1);
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "history-1" }],
    });
  });

  it("keeps historical replay that fits launch inference but not a transcript commit frame", () => {
    const message = assistantMessage(1, true);
    if (message.role !== "assistant" || !message.providerReplay) {
      throw new Error("expected replay carrier");
    }
    const ciphertext = "\0".repeat(12_000);
    message.providerReplay = {
      ...message.providerReplay,
      id: "i".repeat(65_536),
      data: ciphertext,
    };

    const result = windowInitialMessages([message]);

    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") {
      throw new Error("expected complete window");
    }
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      providerReplay: { id: "i".repeat(65_536), data: ciphertext },
    });
  });

  it("returns a typed degraded result instead of slicing past replay", () => {
    const history = [assistantMessage(1, true)];
    history.push(
      ...Array.from({ length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 1 }, (_value, index) =>
        userMessage(`suffix-${index}`, index + 2),
      ),
    );

    expect(windowInitialMessages(history)).toEqual({
      kind: "provider-replay-unavailable",
      details: {
        reason: "provider-replay-message-limit",
        messageCount: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
        limitMessages: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 1,
      },
    });
  });
});

describe("fitLaunchDescriptor", () => {
  it("drops complete old turns while retaining the replay anchor", () => {
    const large = "x".repeat(13 * 1024 * 1024);
    const projected = windowInitialMessages([
      userMessage(large, 1),
      userMessage(large, 2),
      assistantMessage(3, true),
    ]);
    if (projected.kind !== "complete") {
      throw new Error("expected complete projection");
    }

    const plan = fitLaunchDescriptor(buildDescriptor, projected.messages);

    expect(plan.kind).toBe("launch");
    if (plan.kind !== "launch") {
      throw new Error("expected launch plan");
    }
    expect(plan.descriptor.assignment.initialMessages).toHaveLength(2);
    expect(plan.descriptor.assignment.initialMessages[1]).toMatchObject({
      role: "assistant",
      providerReplay: PROVIDER_REPLAY,
    });
  });

  it("drops a non-user prefix directly to the replay owner", () => {
    const projected = windowInitialMessages([
      toolResultMessage({ payload: "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) }, 1),
      assistantMessage(2, true),
    ]);
    if (projected.kind !== "complete") {
      throw new Error("expected complete projection");
    }

    const plan = fitLaunchDescriptor(buildDescriptor, projected.messages);

    expect(plan.kind).toBe("launch");
    if (plan.kind !== "launch") {
      throw new Error("expected launch plan");
    }
    expect(plan.descriptor.assignment.initialMessages).toEqual([
      expect.objectContaining({ role: "assistant", providerReplay: PROVIDER_REPLAY }),
    ]);
  });

  it("requires local fallback when the replay unit cannot fit the descriptor", () => {
    const projected = windowInitialMessages([
      assistantMessage(1, true),
      toolResultMessage({ payload: "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) }, 2),
    ]);
    if (projected.kind !== "complete") {
      throw new Error("expected complete projection");
    }

    expect(fitLaunchDescriptor(buildDescriptor, projected.messages)).toMatchObject({
      kind: "local-fallback",
      reason: "provider-replay-launch-payload-limit",
      limitBytes: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
    });
  });
});
