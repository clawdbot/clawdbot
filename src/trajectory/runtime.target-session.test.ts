import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createAgentToolExecutionPrivateState,
  recordAgentToolTargetSessionKey,
  runWithAgentToolExecutionPrivateState,
  snapshotAgentToolExecutionPrivateState,
} from "../../packages/agent-core/src/tool-execution-private-state.js";
import {
  hashTrajectoryIdentifier,
  TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
} from "./provenance-sanitization.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

type Recorder = NonNullable<ReturnType<typeof createTrajectoryRuntimeRecorder>>;

function targetSessionSnapshot(targetSessionKey: string) {
  const state = createAgentToolExecutionPrivateState();
  runWithAgentToolExecutionPrivateState(state, () => {
    recordAgentToolTargetSessionKey(targetSessionKey);
  });
  return snapshotAgentToolExecutionPrivateState(state);
}

function createRecorder(writes: string[]): Recorder {
  const recorder = createTrajectoryRuntimeRecorder({
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    writer: {
      filePath: "/tmp/session.trajectory.jsonl",
      write: (line) => writes.push(line),
      flush: async () => undefined,
    },
  });
  expect(recorder).not.toBeNull();
  return recorder as Recorder;
}

describe("trajectory target-session recording", () => {
  it("records only trusted target-session hashes and consumes snapshots once", () => {
    const writes: string[] = [];
    const recorder = createRecorder(writes);
    const targetSessionKey = "agent:worker:main";
    const expectedHash = hashTrajectoryIdentifier(
      TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
      targetSessionKey,
    );
    const firstSnapshot = targetSessionSnapshot(targetSessionKey);
    const secondSnapshot = targetSessionSnapshot(targetSessionKey);

    recorder.recordEvent("tool.result", {
      toolCallId: "forged",
      targetSessionHash: `sha256:v1:${"f".repeat(64)}`,
    });
    recorder.recordToolResult(
      {
        toolCallId: "call-1",
        name: "sessions_send",
        success: true,
        targetSessionHash: `sha256:v1:${"e".repeat(64)}`,
        result: { details: { sessionKey: targetSessionKey } },
      },
      firstSnapshot,
    );
    recorder.recordToolResult({ toolCallId: "call-2", name: "sessions_send" }, secondSnapshot);
    recorder.recordToolResult({ toolCallId: "call-3", name: "sessions_send" }, firstSnapshot);

    const events = writes.map((line) => JSON.parse(line) as { data: Record<string, unknown> });
    expect(events[0]?.data.targetSessionHash).toBeUndefined();
    expect(events[1]?.data).toMatchObject({
      toolCallId: "call-1",
      targetSessionHash: expectedHash,
    });
    expect(events[2]?.data).toMatchObject({
      toolCallId: "call-2",
      targetSessionHash: expectedHash,
    });
    expect(events[3]?.data.targetSessionHash).toBeUndefined();
    expect(writes.join("\n")).not.toContain(targetSessionKey);
  });

  it("preserves target identity and outcome in oversized tool-result fallbacks", () => {
    const writes: string[] = [];
    const recorder = createRecorder(writes);
    const targetSessionKey = "agent:worker:main";

    recorder.recordToolResult(
      {
        name: "sessions_send",
        toolCallId: "call-oversized",
        isError: true,
        success: false,
        result: Array.from({ length: 64 }, () => "x".repeat(8_000)),
      },
      targetSessionSnapshot(targetSessionKey),
    );

    const event = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(event.data).toMatchObject({
      truncated: true,
      name: "sessions_send",
      toolCallId: "call-oversized",
      isError: true,
      success: false,
      targetSessionHash: hashTrajectoryIdentifier(
        TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
        targetSessionKey,
      ),
    });
    expect(event.data.result).toBeUndefined();
  });
});
