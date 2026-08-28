/** Tests that a command waiting through a recovery handoff runs on the adopted session. */
import { afterEach, describe, expect, it } from "vitest";
import {
  createReplyOperation,
  registerReplyOperationSuccessorBarrier,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import {
  agentCommand,
  compactionTestRuntime,
  compactionTestState as state,
  makeCompactionResult as makeResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath as requireStorePath,
} from "./agent-command.compaction.test-support.js";

const { replaceSessionEntry } = compactionTestRuntime;

registerAgentCommandCompactionTestHooks();

describe("agentCommand reply-lane session adoption", () => {
  const openOperations: ReplyOperation[] = [];

  afterEach(() => {
    for (const operation of openOperations.splice(0)) {
      operation.complete();
    }
  });

  it("admits the command on the session the lane adopted during a handoff", async () => {
    const sessionKey = "agent:main:explicit:handoff-adoption",
      preparedSessionId = "handoff-adoption",
      rotatedSessionId = "handoff-adoption-rotated";
    // The command starts on the prepared session; the handoff rotates the
    // durable entry only while it waits for the lane.
    await replaceSessionEntry({ sessionKey, storePath: requireStorePath() }, {
      sessionId: preparedSessionId,
      updatedAt: Date.now(),
    } as InternalSessionEntry);
    // A live run holds the lane, so the command waits rather than racing it.
    const predecessor = createReplyOperation({
      sessionKey,
      sessionId: preparedSessionId,
      resetTriggered: false,
    });
    openOperations.push(predecessor);
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId: rotatedSessionId, text: "ran after the handoff" }),
    );

    const pending = agentCommand({
      message: "must survive the handoff",
      sessionId: preparedSessionId,
      sessionKey,
      mainRestartRecoveryAdmitted: true,
      mainRestartRecoveryAttempt: 1,
    });
    // Wait until the command is past preparation and blocked on the held lane,
    // so the handoff below happens while it waits rather than before it starts.
    for (let waited = 0; waited < 5_000; waited += 25) {
      if (state.normalizeProviderModelIdWithRuntimeMock.mock.calls.length > 0) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();

    // The predecessor hands off to a successor that rotates the session. The
    // barrier clears only once the rotation is durable, so the waiting command
    // reaches admission against the rotated entry.
    registerReplyOperationSuccessorBarrier({
      operation: predecessor,
      sessionId: rotatedSessionId,
      sessionKeys: [sessionKey],
      start: async () => {
        await replaceSessionEntry({ sessionKey, storePath: requireStorePath() }, {
          sessionId: rotatedSessionId,
          updatedAt: Date.now(),
        } as InternalSessionEntry);
      },
    });
    predecessor.complete();

    // Before the adopted id reached admission this rejected with
    // "changed while starting work" and the waited-for command was dropped.
    await expect(pending).resolves.toBeDefined();
    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(1);
  });
});
