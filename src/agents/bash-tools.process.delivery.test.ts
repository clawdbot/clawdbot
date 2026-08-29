import { afterEach, expect, test } from "vitest";
import { copyInternalToolResultAcknowledgement } from "../../packages/agent-core/src/internal-hooks.js";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import {
  addSession,
  appendOutput,
  markExited,
  type ProcessSession,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { AgentToolResult } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

function processTurn(toolCallId: string, sessionId: string) {
  const toolCall = {
    type: "toolCall" as const,
    id: toolCallId,
    name: "process",
    arguments: { action: "poll", sessionId },
  };
  return {
    assistantMessage: makeAgentAssistantMessage({
      content: [toolCall],
      stopReason: "toolUse",
    }),
    toolCall,
  };
}

async function poll(
  processTool: ReturnType<typeof createProcessTool>,
  sessionId: string,
  toolCallId: string,
  turn = processTurn(toolCallId, sessionId),
) {
  return await runWithAgentToolExecutionContext(turn, () =>
    processTool.execute(toolCallId, { action: "poll", sessionId }),
  );
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function persistResult(
  manager: ReturnType<typeof SessionManager.inMemory>,
  toolCallId: string,
  result: AgentToolResult<unknown>,
): void {
  const message = copyInternalToolResultAcknowledgement(result, {
    role: "toolResult" as const,
    toolCallId,
    toolName: "process",
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendMessage(message);
}

test.each(["running", "completed"] as const)(
  "replays $status poll output after transcript repair and consumes it after persistence",
  async (status) => {
    const sessionId = `delivery-${status}`;
    const session = createProcessSessionFixture({
      id: sessionId,
      backgrounded: true,
    });
    addSession(session);
    appendOutput(session, "stdout", `${status}-output\n`);
    if (status === "completed") {
      markExited(session, 0, null, "completed");
    }
    const processTool = createProcessTool();
    const manager = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(manager);

    const droppedTurn = processTurn(`${status}-dropped`, sessionId);
    const dropped = await poll(processTool, sessionId, droppedTurn.toolCall.id, droppedTurn);
    expect(resultText(dropped)).toContain(`${status}-output`);
    manager.appendMessage(droppedTurn.assistantMessage);
    guard.flushPendingToolResults();

    const retryTurn = processTurn(`${status}-retry`, sessionId);
    const retry = await poll(processTool, sessionId, retryTurn.toolCall.id, retryTurn);
    expect(resultText(retry)).toContain(`${status}-output`);
    manager.appendMessage(retryTurn.assistantMessage);
    persistResult(manager, retryTurn.toolCall.id, retry);

    const observed = await poll(processTool, sessionId, `${status}-observed`);
    expect(resultText(observed)).not.toContain(`${status}-output`);
  },
);

test("does not duplicate staged output across parallel polls from one assistant turn", async () => {
  const session: ProcessSession = createProcessSessionFixture({
    id: "parallel-delivery",
    backgrounded: true,
  });
  addSession(session);
  appendOutput(session, "stdout", "one-copy\n");
  const processTool = createProcessTool();
  const turn = processTurn("parallel-first", session.id);

  const first = await poll(processTool, session.id, "parallel-first", turn);
  const second = await poll(processTool, session.id, "parallel-second", turn);

  expect(resultText(first)).toContain("one-copy");
  expect(resultText(second)).not.toContain("one-copy");
});
