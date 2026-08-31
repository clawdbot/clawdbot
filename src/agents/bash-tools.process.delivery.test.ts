import { afterEach, expect, test, vi } from "vitest";
import { copyInternalToolResultState } from "../../packages/agent-core/src/internal-hooks.js";
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
import type { AgentMessage, AgentToolResult } from "./runtime/index.js";
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
  timeout?: number,
) {
  return await runWithAgentToolExecutionContext(turn, () =>
    processTool.execute(toolCallId, {
      action: "poll",
      sessionId,
      ...(timeout === undefined ? {} : { timeout }),
    }),
  );
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function toolResultMessage(
  toolCallId: string,
  result: AgentToolResult<unknown>,
): Extract<AgentMessage, { role: "toolResult" }> {
  return copyInternalToolResultState(result, {
    role: "toolResult" as const,
    toolCallId,
    toolName: "process",
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  });
}

function persistResult(
  manager: ReturnType<typeof SessionManager.inMemory>,
  toolCallId: string,
  result: AgentToolResult<unknown>,
): void {
  manager.appendMessage(toolResultMessage(toolCallId, result));
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

test.each(["initial", "retry"] as const)(
  "does not duplicate $phase output across parallel polls from one assistant turn",
  async (phase) => {
    const session: ProcessSession = createProcessSessionFixture({
      id: `parallel-${phase}-delivery`,
      backgrounded: true,
    });
    addSession(session);
    appendOutput(session, "stdout", "one-copy\n");
    const processTool = createProcessTool();
    if (phase === "retry") {
      await poll(processTool, session.id, "parallel-dropped");
    }
    const turn = processTurn("parallel-first", session.id);

    const first = await poll(processTool, session.id, "parallel-first", turn);
    const second = await poll(processTool, session.id, "parallel-second", turn);

    expect(resultText(first)).toContain("one-copy");
    expect(resultText(second)).not.toContain("one-copy");
  },
);

test("consumes staged output after transformed transcript persistence", async () => {
  const session = createProcessSessionFixture({
    id: "transformed-delivery",
    backgrounded: true,
  });
  addSession(session);
  appendOutput(session, "stdout", "transformed-output\n");
  const processTool = createProcessTool();
  const turn = processTurn("transformed-result", session.id);
  const result = await poll(processTool, session.id, turn.toolCall.id, turn);
  const manager = SessionManager.inMemory();
  installSessionToolResultGuard(manager, {
    runId: "transformed-run",
    maxToolResultChars: 16,
    transformMessageForPersistence: (message) => ({ ...message }),
    transformToolResultForPersistence: (message) => ({ ...message }),
    beforeMessageWriteHook: ({ message }) => ({ message: { ...message } }),
  });

  manager.appendMessage(turn.assistantMessage);
  persistResult(manager, turn.toolCall.id, result);

  const observed = await poll(processTool, session.id, "transformed-observed");
  expect(resultText(observed)).not.toContain("transformed-output");
});

test("replays blocked poll output immediately when the retry has a timeout", async () => {
  const session = createProcessSessionFixture({
    id: "blocked-delivery",
    backgrounded: true,
  });
  addSession(session);
  appendOutput(session, "stdout", "blocked-output\n");
  const processTool = createProcessTool();
  const droppedTurn = processTurn("blocked-result", session.id);
  const dropped = await poll(processTool, session.id, droppedTurn.toolCall.id, droppedTurn);
  const manager = SessionManager.inMemory();
  installSessionToolResultGuard(manager, {
    beforeMessageWriteHook(event) {
      return event.message.role === "toolResult" && event.message.toolCallId === "blocked-result"
        ? { block: true }
        : undefined;
    },
  });
  manager.appendMessage(droppedTurn.assistantMessage);
  expect(
    manager.appendMessage(toolResultMessage(droppedTurn.toolCall.id, dropped)),
  ).toBeUndefined();

  vi.useFakeTimers();
  try {
    const retryTurn = processTurn("blocked-retry", session.id);
    let settled = false;
    const retryPromise = poll(
      processTool,
      session.id,
      retryTurn.toolCall.id,
      retryTurn,
      30_000,
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(resultText(await retryPromise)).toContain("blocked-output");
  } finally {
    vi.useRealTimers();
  }
});
