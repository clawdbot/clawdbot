import { describe, expect, it } from "vitest";
import type {
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AssistantMessageEvent } from "../llm/types.js";
import { createWorkerInferenceStreamAdapter } from "./inference-stream.runtime.js";
import type { WorkerInferenceProxyClient } from "./worker-rpc-clients.js";

// Regression coverage for the same class of bug fixed in
// extensions/amazon-bedrock/stream.runtime.ts: this client-side adapter
// reconstructs tool-call arguments from raw deltas forwarded over the Worker
// RPC connection, so it can receive the identical small-delta stream a large
// Bedrock tool call produces and must not silently truncate or drop the
// result once per-delta re-parsing is throttled for size.
function fakeClientEmittingToolCallDeltas(
  deltas: string[],
  finalArguments: Record<string, unknown>,
): WorkerInferenceProxyClient {
  return {
    start: (
      params: WorkerInferenceStartParams,
      handlers: { onEvent?: (event: WorkerInferenceEventParams) => void },
    ) => {
      let seq = 0;
      const emit = (event: WorkerInferenceEventParams["event"]) => {
        seq += 1;
        handlers.onEvent?.({
          runEpoch: params.runEpoch,
          sessionId: params.sessionId,
          runId: params.runId,
          turnId: params.turnId,
          seq,
          event,
        });
      };
      emit({
        type: "start",
        resolvedModel: {
          api: "anthropic-messages",
          provider: "amazon-bedrock",
          model: "test-model",
        },
        timestamp: Date.now(),
      });
      emit({ type: "toolcall_start", contentIndex: 0, id: "call_write", toolName: "write_file" });
      for (const delta of deltas) {
        emit({ type: "toolcall_delta", contentIndex: 0, delta });
      }
      emit({ type: "toolcall_end", contentIndex: 0 });
      const outcome: WorkerInferenceTerminalOutcome = {
        type: "done",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_write", name: "write_file", arguments: finalArguments },
          ],
          api: "anthropic-messages",
          provider: "amazon-bedrock",
          model: "test-model",
          stopReason: "toolUse",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        },
      } as never;
      return Promise.resolve(outcome);
    },
    cancel: () => Promise.resolve({ ok: true } as never),
  } as unknown as WorkerInferenceProxyClient;
}

describe("createWorkerInferenceStreamAdapter tool-call argument reconstruction", () => {
  it("resolves the full tool-call arguments in the live toolcall_end preview even when the buffer exceeds the streaming preview threshold", async () => {
    const longContent = "lorem ipsum dolor sit amet ".repeat(2000); // ~54KB
    const expectedArguments = { filename: "report.docx", content: longContent };
    const fullArgsJson = JSON.stringify(expectedArguments);

    const chunkSize = 40;
    const deltas: string[] = [];
    for (let index = 0; index < fullArgsJson.length; index += chunkSize) {
      deltas.push(fullArgsJson.slice(index, index + chunkSize));
    }

    const adapter = createWorkerInferenceStreamAdapter({
      client: fakeClientEmittingToolCallDeltas(deltas, expectedArguments),
      sessionId: "session-1",
      runEpoch: 0,
      runId: "run-1",
      turnId: "turn-1",
      modelRef: { provider: "amazon-bedrock", model: "test-model" } as never,
    });

    const stream = adapter({
      modelRef: { provider: "amazon-bedrock", model: "test-model" } as never,
      context: {} as never,
      options: {} as never,
    });

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();

    const toolcallEnd = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> =>
        event.type === "toolcall_end",
    );
    expect(toolcallEnd?.toolCall).toMatchObject({
      type: "toolCall",
      arguments: expectedArguments,
    });
    expect(toolcallEnd?.toolCall).not.toHaveProperty("partialJson");
    expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: expectedArguments });
  });
});
