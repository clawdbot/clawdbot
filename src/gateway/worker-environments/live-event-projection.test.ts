import { describe, expect, it } from "vitest";
import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  recordWorkerLiveTrajectoryEvent,
  type WorkerLiveTrajectoryRecorder,
} from "./live-event-projection.js";

function createCapturingRecorder(): {
  recorder: WorkerLiveTrajectoryRecorder;
  recorded: Array<{ type: string; data?: Record<string, unknown> }>;
} {
  const recorded: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const recorder = {
    recordEvent: (type: string, data?: Record<string, unknown>) => {
      recorded.push({ type, ...(data ? { data } : {}) });
    },
    flush: async () => {},
  } as unknown as WorkerLiveTrajectoryRecorder;
  return { recorder, recorded };
}

describe("recordWorkerLiveTrajectoryEvent", () => {
  it("persists tool starts with the canonical arguments field", () => {
    const { recorder, recorded } = createCapturingRecorder();
    const event = {
      kind: "tool",
      payload: {
        phase: "start",
        name: "sessions_send",
        toolCallId: "worker-tool-1",
        args: { sessionKey: "agent:main:worker", message: "ping" },
      },
    } as unknown as WorkerLiveEventParams["event"];

    recordWorkerLiveTrajectoryEvent(recorder, event);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.type).toBe("tool.call");
    expect(recorded[0]?.data?.arguments).toEqual({
      sessionKey: "agent:main:worker",
      message: "ping",
    });
    expect(recorded[0]?.data).not.toHaveProperty("args");
    expect(recorded[0]?.data?.name).toBe("sessions_send");
  });

  it("keeps tool results unchanged aside from success", () => {
    const { recorder, recorded } = createCapturingRecorder();
    const event = {
      kind: "tool",
      payload: {
        phase: "result",
        name: "sessions_send",
        toolCallId: "worker-tool-1",
        isError: false,
        result: { content: [{ type: "text", text: "delivered" }] },
      },
    } as unknown as WorkerLiveEventParams["event"];

    recordWorkerLiveTrajectoryEvent(recorder, event);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.type).toBe("tool.result");
    expect(recorded[0]?.data?.success).toBe(true);
  });
});
