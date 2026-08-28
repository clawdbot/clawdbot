import { expect, it, vi } from "vitest";
import type {
  WorkerInferenceEventParams,
  WorkerInferenceModelRef,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { Usage } from "../llm/types.js";
import { createWorkerInferenceStreamAdapter } from "./inference-stream.runtime.js";
import type { WorkerInferenceProxyClient } from "./worker-rpc-clients.js";

const modelRef: WorkerInferenceModelRef = { provider: "test", model: "test-model" };
const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
  const client = { start, cancel: vi.fn() } as unknown as WorkerInferenceProxyClient;
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
});
