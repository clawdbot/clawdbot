import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  type WorkerInferenceContext,
  type WorkerInferenceEventParams,
  type WorkerInferenceModelRef,
  type WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { Usage } from "../llm/types.js";
import { createWorkerInferenceStreamAdapter } from "./inference-stream.runtime.js";
import { createWorkerImageHistory } from "./replay-images.test-support.js";
import { fitWorkerReplayImages } from "./replay-message-window.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "./transcript-message.js";
import { createWorkerConnection } from "./worker-connection.js";
import { WorkerInferenceProxyClient } from "./worker-rpc-clients.js";

const modelRef: WorkerInferenceModelRef = { provider: "test", model: "test-model" };
const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

it("keeps an already fitting image projection by reference", () => {
  const messages: WorkerInferenceContext["messages"] = [
    {
      role: "user",
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      timestamp: 1,
    },
  ];
  expect(
    fitWorkerReplayImages(messages, (candidate) =>
      Buffer.byteLength(JSON.stringify(candidate), "utf8"),
    ),
  ).toBe(messages);
});

function createClient() {
  return new WorkerInferenceProxyClient(
    createWorkerConnection({
      endpoint: { kind: "unix", socketPath: "/tmp/worker-inference-size-test.sock" },
      connectParams: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: GATEWAY_CLIENT_IDS.WORKER,
          mode: GATEWAY_CLIENT_MODES.WORKER,
          version: "test",
          platform: process.platform,
        },
        role: "worker",
        admission: {
          environmentId: "environment-1",
          credential: "fixture-credential",
          ownerEpoch: 1,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          handshake: {
            bundleHash: "a".repeat(64),
            openclawVersion: "test",
            protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
          },
          sessionId: "session-1",
          runId: "run-1",
        },
      },
    }),
  );
}

function createAdapterFixture(computerContextEpoch?: {
  value: number;
  frameToolCallId?: string;
  frameImageIdentity?: string;
}) {
  const client = createClient();
  const start = vi.spyOn(client, "start").mockResolvedValue({
    type: "done",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      api: "openai-responses",
      provider: "test",
      model: "test-model",
      stopReason: "stop",
      usage,
      timestamp: 1,
    },
  });
  const options = {
    client,
    sessionId: "session-1",
    runEpoch: 1,
    runId: "run-1",
    turnId: "turn-1",
    modelRef,
    computerContextEpoch,
  };
  return { client, start, stream: createWorkerInferenceStreamAdapter(options) };
}

it.each([false, true])(
  "fits observed screenshot history without changing durable messages (user image: %s)",
  async (userImage) => {
    const messages = createWorkerImageHistory(userImage);
    const originalContents = messages.map((message) => message.content);
    const current = messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "image-0",
    );
    const image = current?.content.find((part) => part.type === "image");
    if (image?.type !== "image") {
      throw new Error("Missing current computer image");
    }
    const computerContextEpoch = {
      value: 0,
      frameToolCallId: "image-0",
      frameImageIdentity: createHash("sha256")
        .update(JSON.stringify([image.mimeType, image.data]))
        .digest("hex"),
    };
    const fixture = createAdapterFixture(computerContextEpoch);
    try {
      await fixture.stream({ modelRef, context: { messages }, options: {} }).result();
      const request = fixture.start.mock.calls[0]?.[0];
      expect(request).toBeDefined();
      const bytes = Buffer.byteLength(
        JSON.stringify({
          type: "req",
          id: "00000000-0000-4000-8000-000000000000",
          method: "worker.inference.start",
          params: request,
        }),
        "utf8",
      );
      expect(bytes).toBeLessThanOrEqual(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES);
      expect(request?.context.messages).toHaveLength(messages.length);
      expect(request?.context.messages[2]).toEqual(current);
      expect(request?.context.messages.at(-1)).toEqual(messages.at(-1));
      for (const [index, message] of messages.entries()) {
        expect(message.content).toBe(originalContents[index]);
        if (message.role === "assistant") {
          expect(request?.context.messages[index]).toEqual(message);
        } else {
          for (const part of message.content.filter((block) => block.type === "text")) {
            expect(request?.context.messages[index]?.content).toContainEqual(part);
          }
        }
      }
      expect(computerContextEpoch.value).toBe(0);
    } finally {
      fixture.client.dispose();
    }
  },
);

it("invalidates computer coordinates when the final model context lacks their screenshot", async () => {
  const computerContextEpoch = {
    value: 0,
    frameToolCallId: "missing",
    frameImageIdentity: "missing",
  };
  const fixture = createAdapterFixture(computerContextEpoch);
  try {
    await fixture.stream({ modelRef, context: { messages: [] }, options: {} }).result();
    expect(computerContextEpoch.value).toBe(1);
    expect(computerContextEpoch).not.toHaveProperty("frameToolCallId");
  } finally {
    fixture.client.dispose();
  }
});

it("refuses oversized unprocessed images without discarding them", async () => {
  const content = createWorkerImageHistory().flatMap((message) =>
    message.role === "toolResult" ? message.content : [],
  );
  const context: WorkerInferenceContext = { messages: [{ role: "user", content, timestamp: 1 }] };
  const fixture = createAdapterFixture();
  try {
    const result = await fixture.stream({ modelRef, context, options: {} }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/(image|context).*(limit|budget)/i);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(context.messages[0]?.content).toBe(content);
    expect(content.filter((part) => part.type === "image")).toHaveLength(7);
  } finally {
    fixture.client.dispose();
  }
});

it("preserves opaque replay and its image history when the mandatory replay cannot fit", async () => {
  const messages = createWorkerImageHistory();
  const owner = messages[1];
  if (owner?.role !== "assistant") {
    throw new Error("Missing replay owner");
  }
  owner.providerReplay = {
    v: 1,
    type: "openai-responses-compaction",
    data: "opaque-checkpoint",
    provider: "test",
    api: "openai-responses",
    model: "test-model",
  };
  const before = JSON.stringify(messages);
  const fixture = createAdapterFixture();
  try {
    const result = await fixture.stream({ modelRef, context: { messages }, options: {} }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toBe(before);
  } finally {
    fixture.client.dispose();
  }
});

it("delays worker tool argument previews while preserving exact terminal arguments", async () => {
  const initialContent = "a".repeat(128);
  const checkpointContent = "b".repeat(400);
  const deltas = [`{"content":"${initialContent}`, checkpointContent, `","terminal":"exact"}`];
  const terminalArguments = {
    content: initialContent + checkpointContent,
    terminal: "exact",
  };
  const start: WorkerInferenceProxyClient["start"] = async (request, handlers) => {
    const identity = {
      runEpoch: request.runEpoch,
      sessionId: request.sessionId,
      runId: request.runId,
      turnId: request.turnId,
    };
    const streamEvents: WorkerInferenceEventParams["event"][] = [
      { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "write" },
      ...deltas.map((delta) => ({ type: "toolcall_delta" as const, contentIndex: 0, delta })),
      { type: "toolcall_end", contentIndex: 0 },
    ];
    for (const [index, event] of streamEvents.entries()) {
      handlers?.onEvent?.({ ...identity, seq: index + 1, event });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    return {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: terminalArguments }],
        api: "openai-responses",
        provider: modelRef.provider,
        model: modelRef.model,
        stopReason: "toolUse",
        usage,
        timestamp: 1,
      },
    } satisfies WorkerInferenceTerminalOutcome;
  };
  const client = createClient();
  vi.spyOn(client, "start").mockImplementation(start);
  const streamFn = createWorkerInferenceStreamAdapter({
    client,
    sessionId: "session-1",
    runEpoch: 1,
    runId: "run-1",
    turnId: "turn-1",
    modelRef,
  });

  const stream = streamFn({ modelRef, context: { messages: [] }, options: {} });
  const argumentSnapshots: Array<Record<string, unknown>> = [];
  let endArguments: Record<string, unknown> | undefined;
  for await (const event of stream) {
    if (event.type === "toolcall_delta") {
      const content = event.partial.content[event.contentIndex];
      if (content?.type === "toolCall") {
        argumentSnapshots.push(structuredClone(content.arguments));
      }
    } else if (event.type === "toolcall_end") {
      endArguments = structuredClone(event.toolCall.arguments);
    }
  }

  const checkpointPreview = { content: initialContent + checkpointContent };
  expect(argumentSnapshots).toEqual([{}, checkpointPreview, checkpointPreview]);
  expect(endArguments).toEqual(terminalArguments);
  await expect(stream.result()).resolves.toMatchObject({
    content: [{ type: "toolCall", arguments: terminalArguments }],
  });
  client.dispose();
});
