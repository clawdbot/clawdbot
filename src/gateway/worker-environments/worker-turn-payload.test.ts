import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../infra/node-commands.js";
import {
  completeWorkerLaunchDescriptor,
  parseWorkerLaunchPlan,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import { parseNodeWorkerLaunchInput } from "../../worker/node-supervisor-protocol.js";
import {
  buildWorkerProcessTurn,
  serializeWorkerProcessInput,
  parseWorkerProcessRequest,
} from "../../worker/worker-process-protocol.js";
import { buildNodeInvokeRequest, serializeNodeEvent } from "../node-invoke-request.js";
import { measureNodeWorkerLaunchBytes } from "./node-launch-adapter.js";
import {
  assertSupportedTurn,
  fitLaunchDescriptorWithRuntimeIdentity,
  windowInitialMessages,
} from "./worker-turn-payload.js";

const runtimeIdentityToken = vi.hoisted(() => ({
  value: "fixture-runtime-identity-token",
  measure: vi.fn(() => Buffer.byteLength("fixture-runtime-identity-token", "utf8")),
  mint: vi.fn(
    async (_params: { operationalRunInstance: OperationalRunInstanceRef }) =>
      "fixture-runtime-identity-token",
  ),
}));

vi.mock("../agent-runtime-identity-token.js", () => ({
  measureAgentRuntimeIdentityTokenBytes: runtimeIdentityToken.measure,
  mintAgentRuntimeIdentityToken: runtimeIdentityToken.mint,
}));

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
  initialMessages: WorkerLaunchPlan["assignment"]["initialMessages"],
  agentRuntimeIdentityToken: string,
  operationalRunInstance: OperationalRunInstanceRef,
): WorkerLaunchPlan {
  return {
    version: 4,
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
      agentId: "main",
      operationalRunInstance,
      agentRuntimeIdentityToken,
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

function measureLaunch(plan: WorkerLaunchPlan): number {
  return measureNodeWorkerLaunchBytes("fixture-node", {
    environmentSession: 1,
    launchId: plan.assignment.turnId,
    gatewayNamespace: "fixture-gateway",
    expectedBundleHash: plan.admission.handshake.bundleHash,
    placementGeneration: 1,
    descriptor: plan,
  });
}

function fitLaunchDescriptor(messages: WorkerLaunchPlan["assignment"]["initialMessages"]) {
  const operationalRunInstance = createTestAdmittedRunContext("run").operationalRunInstance;
  return {
    operationalRunInstance,
    plan: fitLaunchDescriptorWithRuntimeIdentity({
      measure: measureLaunch,
      build: (identityToken, initialMessages) =>
        buildDescriptor(initialMessages, identityToken, operationalRunInstance),
      messages,
      runtimeIdentity: {
        agentId: "main",
        sessionKey: "worker:session",
        operationalRunInstance,
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertSupportedTurn", () => {
  it("accepts scheduled authority for the worker launch envelope", () => {
    expect(
      assertSupportedTurn({
        admittedRunContext: createTestAdmittedRunContext("run-1"),
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
  it("reports oversized replay through the typed unavailable result", () => {
    const project = vi.fn(windowInitialMessages);
    const message = assistantMessage(1, true);
    if (message.role !== "assistant" || !message.providerReplay) {
      throw new Error("expected replay carrier");
    }
    message.providerReplay = {
      ...message.providerReplay,
      data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1),
    };

    expect(project([message])).toEqual({
      kind: "provider-replay-unavailable",
      details: {
        bytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1,
        limitBytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
        reason: "provider-replay-data-budget",
      },
    });
    expect(project).toHaveBeenCalledOnce();
  });

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
  it.each([-1, 0, 1])("fits the complete transport bound at cap %+i byte(s)", async (delta) => {
    const projected = windowInitialMessages([
      assistantMessage(1, true),
      toolResultMessage({ payload: "" }, 2),
    ]);
    if (projected.kind !== "complete" || projected.messages[1]?.role !== "toolResult") {
      throw new Error("expected replay context");
    }
    const operationalRunInstance = createTestAdmittedRunContext("run").operationalRunInstance;
    const build = (token: string, messages: typeof projected.messages) =>
      parseWorkerLaunchPlan(buildDescriptor(messages, token, operationalRunInstance));
    const targetBytes = WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES + delta;
    const emptyBytes = measureLaunch(build(runtimeIdentityToken.value, projected.messages));
    projected.messages[1].details = { payload: "x".repeat(targetBytes - emptyBytes) };
    const candidate = build(runtimeIdentityToken.value, projected.messages);
    expect(measureLaunch(candidate)).toBe(targetBytes);
    const fitted = await fitLaunchDescriptorWithRuntimeIdentity({
      build,
      measure: measureLaunch,
      messages: projected.messages,
      runtimeIdentity: { agentId: "main", sessionKey: "worker:session", operationalRunInstance },
    });
    expect(fitted.kind).toBe(delta > 0 ? "local-fallback" : "launch");
    expect(runtimeIdentityToken.mint).toHaveBeenCalledTimes(delta > 0 ? 0 : 1);
    if (fitted.kind === "launch") {
      expect(fitted.plan.assignment.operationalRunInstance).toEqual(operationalRunInstance);
      expect(fitted.plan.assignment.initialMessages[0]).toMatchObject({
        providerReplay: PROVIDER_REPLAY,
      });
    }
    console.info("worker-fit-boundary", JSON.stringify({ bytes: targetBytes, kind: fitted.kind }));
  });

  it("preserves a small two-image launch and its exact run identity", async () => {
    const operationalRunInstance = createTestAdmittedRunContext("run").operationalRunInstance;
    const images = [
      { type: "image" as const, data: "A".repeat(1_200_000), mimeType: "image/png" },
      { type: "image" as const, data: "B".repeat(1_200_000), mimeType: "image/png" },
    ];
    const fitted = await fitLaunchDescriptorWithRuntimeIdentity({
      build: (token, messages) => {
        const plan = buildDescriptor(messages, token, operationalRunInstance);
        plan.assignment.prompt = [{ type: "text", text: "Compare images" }, ...images];
        return parseWorkerLaunchPlan(plan);
      },
      measure: measureLaunch,
      messages: [],
      runtimeIdentity: { agentId: "main", sessionKey: "worker:session", operationalRunInstance },
    });
    if (fitted.kind !== "launch") {
      throw new Error("expected ordinary image launch");
    }
    expect(fitted.plan.assignment.prompt).toEqual([
      { type: "text", text: "Compare images" },
      ...images,
    ]);
    expect(fitted.plan.assignment.operationalRunInstance).toEqual(operationalRunInstance);
    const completed = completeWorkerLaunchDescriptor(fitted.plan, {
      kind: "unix",
      socketPath: "/tmp/worker.sock",
    });
    const encoded = serializeWorkerProcessInput(buildWorkerProcessTurn(completed));
    parseWorkerProcessRequest(JSON.parse(encoded));
    console.info(
      "worker-two-image-control",
      JSON.stringify({
        imageBytes: 2_400_000,
        managedLineBytes: Buffer.byteLength(encoded) - 1,
        measuredBytes: measureLaunch(fitted.plan),
      }),
    );
  });

  it.each(["nested escaping", "maximal endpoint"])(
    "fits the actual near-ceiling launch transport: %s",
    async (scenario) => {
      const operationalRunInstance = createTestAdmittedRunContext("run").operationalRunInstance;
      const projected = windowInitialMessages([
        assistantMessage(1, true),
        toolResultMessage({ payload: "" }, 2),
      ]);
      if (projected.kind !== "complete") {
        throw new Error("expected complete projection");
      }
      const messages = projected.messages;
      const result = messages[1];
      if (result?.role !== "toolResult") {
        throw new Error("expected tool result");
      }
      const build = (identityToken: string, initialMessages: typeof messages) =>
        buildDescriptor(initialMessages, identityToken, operationalRunInstance);
      const emptyBytes = Buffer.byteLength(
        JSON.stringify(build(runtimeIdentityToken.value, messages)),
      );
      const payloadBytes = WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES - 4_608 - emptyBytes;
      const escaped = scenario === "nested escaping" ? '"\\\0\n'.repeat(500_000) : "";
      result.details = {
        payload: escaped + "x".repeat(payloadBytes - (JSON.stringify(escaped).length - 2)),
      };
      const candidate = parseWorkerLaunchPlan(build(runtimeIdentityToken.value, messages));
      const input = {
        environmentSession: 1,
        launchId: candidate.assignment.turnId,
        gatewayNamespace: "fixture-gateway",
        expectedBundleHash: candidate.admission.handshake.bundleHash,
        placementGeneration: 1,
        descriptor: candidate,
      };
      const paramsJSON = JSON.stringify(input);
      parseNodeWorkerLaunchInput(paramsJSON);
      const frame = serializeNodeEvent(
        "node.invoke.request",
        buildNodeInvokeRequest({
          id: "00000000-0000-0000-0000-000000000000",
          nodeId: "fixture-node",
          command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
          params: input,
          timeoutMs: 30_000,
          idempotencyKey: candidate.assignment.turnId,
        }),
      );
      const suffix = "/__openclaw__/worker";
      const prefix = "wss://worker.invalid/";
      const descriptor = completeWorkerLaunchDescriptor(candidate, {
        kind: "websocket",
        url: prefix + "x".repeat(4_096 - prefix.length - suffix.length) + suffix,
        tlsFingerprint: "a".repeat(64),
        cloudflareAccess: { clientId: "i".repeat(4_096), clientSecret: "s".repeat(4_096) },
      });
      const line = JSON.stringify({
        type: "turn",
        turnId: candidate.assignment.turnId,
        descriptor,
      });
      parseWorkerProcessRequest(JSON.parse(line));
      console.info(
        "worker-sizing-before",
        JSON.stringify({
          scenario,
          planBytes: Buffer.byteLength(JSON.stringify(candidate)),
          estimatorBytes: Buffer.byteLength(JSON.stringify(candidate)) + 4_608,
          frameBytes: Buffer.byteLength(frame),
          managedLineBytes: Buffer.byteLength(line),
          limitBytes: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
        }),
      );
      const fitted = await fitLaunchDescriptorWithRuntimeIdentity({
        measure: measureLaunch,
        build,
        messages,
        runtimeIdentity: { agentId: "main", sessionKey: "worker:session", operationalRunInstance },
      });
      expect(fitted.kind).toBe("local-fallback");
      expect(runtimeIdentityToken.mint).not.toHaveBeenCalled();
      console.info(
        "worker-sizing-after",
        JSON.stringify({ scenario, kind: fitted.kind, measuredBytes: measureLaunch(candidate) }),
      );
    },
  );

  it("drops complete old turns while retaining the replay anchor", async () => {
    const large = "x".repeat(13 * 1024 * 1024);
    const projected = windowInitialMessages([
      userMessage("old turn", 1),
      toolResultMessage({ payload: large }, 2),
      assistantMessage(3, true),
      userMessage("new turn", 4),
      toolResultMessage({ payload: large }, 5),
      assistantMessage(6, true),
    ]);
    if (projected.kind !== "complete") {
      throw new Error("expected complete projection");
    }

    const fitted = fitLaunchDescriptor(projected.messages);
    const plan = await fitted.plan;

    expect(plan.kind).toBe("launch");
    if (plan.kind !== "launch") {
      throw new Error("expected launch plan");
    }
    parseWorkerLaunchPlan(plan.plan);
    expect(plan.plan.assignment.initialMessages.map((message) => message.timestamp)).toEqual([
      4, 5, 6,
    ]);
    expect(plan.plan.assignment.initialMessages[2]).toMatchObject({
      role: "assistant",
      providerReplay: PROVIDER_REPLAY,
    });
    expect(plan.plan.assignment.agentRuntimeIdentityToken).toBe(runtimeIdentityToken.value);
    expect(plan.plan.assignment.operationalRunInstance).toBe(fitted.operationalRunInstance);
    expect(runtimeIdentityToken.mint).toHaveBeenCalledOnce();
    expect(runtimeIdentityToken.mint.mock.calls[0]?.[0].operationalRunInstance).toBe(
      fitted.operationalRunInstance,
    );
  });

  it("drops a non-user prefix directly to the replay owner", async () => {
    const projected = windowInitialMessages([
      toolResultMessage({ payload: "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) }, 1),
      assistantMessage(2, true),
    ]);
    if (projected.kind !== "complete") {
      throw new Error("expected complete projection");
    }

    const fitted = fitLaunchDescriptor(projected.messages);
    const plan = await fitted.plan;

    expect(plan.kind).toBe("launch");
    if (plan.kind !== "launch") {
      throw new Error("expected launch plan");
    }
    expect(plan.plan.assignment.initialMessages).toEqual([
      expect.objectContaining({ role: "assistant", providerReplay: PROVIDER_REPLAY }),
    ]);
    expect(plan.plan.assignment.operationalRunInstance).toBe(fitted.operationalRunInstance);
    expect(runtimeIdentityToken.mint.mock.calls[0]?.[0].operationalRunInstance).toBe(
      fitted.operationalRunInstance,
    );
  });

  it("requires local fallback when the replay unit cannot fit the descriptor", async () => {
    const projected = windowInitialMessages([
      assistantMessage(1, true),
      toolResultMessage({ payload: "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) }, 2),
    ]);
    if (projected.kind !== "complete") {
      throw new Error("expected complete projection");
    }

    const fitted = fitLaunchDescriptor(projected.messages);
    await expect(fitted.plan).resolves.toMatchObject({
      kind: "local-fallback",
      reason: "provider-replay-launch-payload-limit",
      limitBytes: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
    });
    expect(runtimeIdentityToken.mint).not.toHaveBeenCalled();
  });
});
