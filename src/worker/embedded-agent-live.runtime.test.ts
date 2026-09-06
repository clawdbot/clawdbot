import { describe, expect, it } from "vitest";
import type { WorkerLiveEvent } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
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

  it("redacts lifecycle errors before terminal cloud egress", async () => {
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: () => false,
      emitTerminal: async (event) => void emitted.push(event),
    });

    runtime.enqueueRunFailure({
      aborted: false,
      error: new Error("failed data:video/mp4;base64,QUJDRA=="),
    });
    await runtime.emitTerminal();

    expect(emitted).toHaveLength(1);
    expect(JSON.stringify(emitted)).not.toContain("QUJDRA==");
  });
});
