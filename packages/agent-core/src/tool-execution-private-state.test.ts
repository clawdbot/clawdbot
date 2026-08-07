import { describe, expect, it } from "vitest";
import {
  consumeAgentToolTargetSessionKey,
  createAgentToolExecutionPrivateState,
  recordAgentToolTargetSessionKey,
  runWithAgentToolExecutionPrivateState,
  snapshotAgentToolExecutionPrivateState,
  type AgentToolExecutionPrivateState,
} from "./tool-execution-private-state.js";

describe("agent tool execution private state", () => {
  it("captures target identity only inside its active scope and consumes it once", async () => {
    recordAgentToolTargetSessionKey("outside");
    const state = createAgentToolExecutionPrivateState();

    await runWithAgentToolExecutionPrivateState(state, async () => {
      await Promise.resolve();
      recordAgentToolTargetSessionKey(" agent:worker:main ");
    });

    const snapshot = snapshotAgentToolExecutionPrivateState(state);
    expect(consumeAgentToolTargetSessionKey(snapshot)).toBe("agent:worker:main");
    expect(consumeAgentToolTargetSessionKey(snapshot)).toBeUndefined();
    expect(snapshotAgentToolExecutionPrivateState(state)).toBeUndefined();
  });

  it("isolates parallel calls and rejects forged opaque tokens", async () => {
    const first = createAgentToolExecutionPrivateState();
    const second = createAgentToolExecutionPrivateState();

    await Promise.all([
      runWithAgentToolExecutionPrivateState(first, async () => {
        await Promise.resolve();
        recordAgentToolTargetSessionKey("agent:shared:main");
      }),
      runWithAgentToolExecutionPrivateState(second, async () => {
        recordAgentToolTargetSessionKey("agent:shared:main");
        await Promise.resolve();
      }),
    ]);

    expect(consumeAgentToolTargetSessionKey(snapshotAgentToolExecutionPrivateState(first))).toBe(
      "agent:shared:main",
    );
    expect(consumeAgentToolTargetSessionKey(snapshotAgentToolExecutionPrivateState(second))).toBe(
      "agent:shared:main",
    );
    expect(consumeAgentToolTargetSessionKey({} as AgentToolExecutionPrivateState)).toBeUndefined();
  });
});
