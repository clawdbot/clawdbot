import { describe, expect, it } from "vitest";
import type { WorkerLiveEvent } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { recordModelFallbackStop } from "../agents/failover-error.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createWorkerLiveRuntime } from "./embedded-agent-live.runtime.js";

describe("createWorkerLiveRuntime", () => {
  it("redacts media payloads from tool diagnostics before cloud egress", () => {
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: (event) => {
        emitted.push(event);
        return true;
      },
      emitTerminal: async (event) => void emitted.push(event),
    });
    const events: AgentSessionEvent[] = [
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { type: "video", data: Buffer.from([1, 2, 3]) },
      },
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        args: {},
        partialResult: { mimeType: "audio/mpeg", blob: new Uint8Array([4, 5, 6]) },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: "failed data:video/mp4;base64,QUJDRA==",
        isError: true,
      },
    ];

    for (const event of events) {
      runtime.handleSessionEvent(event);
    }
    expect(JSON.stringify(emitted)).not.toContain("QUJDRA==");
    expect(JSON.stringify(emitted)).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
    expect(emitted).toHaveLength(3);
  });

  it("stops preparing previews after the client degrades", () => {
    let previewCalls = 0;
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: () => {
        previewCalls += 1;
        return false;
      },
      emitTerminal: async () => {},
    });

    runtime.handleSessionEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: {},
    });
    runtime.handleSessionEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "ignored",
      isError: false,
    });

    expect(previewCalls).toBe(1);
  });

  it.each([
    { recordedStop: false, aborted: false },
    { recordedStop: true, aborted: false },
    { recordedStop: false, aborted: true },
    { recordedStop: true, aborted: true },
  ])(
    "retains only recorded replay stops across terminal merges ($recordedStop, $aborted)",
    async ({ recordedStop, aborted }) => {
      const emitted: WorkerLiveEvent[] = [];
      const runtime = createWorkerLiveRuntime({
        enqueuePreview: () => false,
        emitTerminal: async (event) => void emitted.push(event),
      });
      const failure = Object.freeze(new Error("request timed out"));
      if (recordedStop) {
        recordModelFallbackStop(failure);
      }
      runtime.enqueueRunFailure({
        aborted: false,
        error: new AggregateError([failure], "wrapper"),
      });
      runtime.handleSessionEvent({
        type: "agent_end",
        messages: [
          makeAgentAssistantMessage({ content: [], stopReason: aborted ? "aborted" : "stop" }),
        ],
        willRetry: false,
      });
      runtime.enqueueRunFailure({ aborted: false, error: new Error("later provider failure") });
      await runtime.emitTerminal();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({
        phase: "finishing",
        stopReason: aborted ? "aborted" : "error",
      });
      if (recordedStop) {
        expect(emitted[0]?.payload).toHaveProperty("replayInvalid", true);
      } else {
        expect(emitted[0]?.payload).not.toHaveProperty("replayInvalid");
      }
      if (aborted) {
        expect(emitted[0]?.payload).not.toHaveProperty("error");
      }
    },
  );

  it("redacts lifecycle errors before terminal cloud egress", async () => {
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: () => false,
      emitTerminal: async (event) => void emitted.push(event),
    });

    runtime.enqueueRunFailure({
      aborted: false,
      error: new AggregateError(
        [new Error(`native close failed data:video/mp4;base64,QUJDRA== ${"x".repeat(8_000)}`)],
        "cleanup failed",
      ),
    });
    await runtime.emitTerminal();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      phase: "finishing",
      stopReason: "error",
      error: expect.stringContaining("cleanup failed | native close failed"),
    });
    expect(JSON.stringify(emitted)).not.toContain("QUJDRA==");
    const event = emitted[0];
    if (event?.kind !== "lifecycle" || event.payload.phase !== "finishing") {
      throw new Error("expected a finishing event");
    }
    expect(Buffer.byteLength(event.payload.error ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
  });
});
