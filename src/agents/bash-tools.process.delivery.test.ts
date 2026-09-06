import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import { copyInternalToolResultState } from "../../packages/agent-core/src/internal-hooks.js";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
} from "../infra/system-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginHookBeforeMessageWriteEvent } from "../plugins/types.js";
import {
  addSession,
  appendOutput,
  markExited,
  recordNotifyOnExitRemoval,
  type ProcessSession,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import type { AgentMessage, AgentToolResult } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { snapshotToolSearchTargetTranscriptResult } from "./tool-search-transcript.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetCodeModeTestState();
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

async function runProcessInCodeMode(args: Record<string, unknown>) {
  const harness = createCodeModeHarness();
  applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, createProcessTool()] });
  return await runUntilCompleted({
    execTool: expectDefined(harness.tools[0], "Code Mode exec"),
    waitTool: expectDefined(harness.tools[1], "Code Mode wait"),
    code: `return await process(${JSON.stringify(args)});`,
  });
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

test.each(["finished", "waiting"])(
  "retains a %s poll completion through failed persistence and acknowledges late receipts",
  async (phase) => {
    const session = createProcessSessionFixture({
      id: `persist-notify-${phase}`,
      backgrounded: true,
    });
    const sessionKey = `agent:main:${session.id}`;
    const eventOptions = { sessionKey, contextKey: `exec:${session.id}` };
    const unrelated = enqueueSystemEventEntry("unrelated", eventOptions);
    const recordCompletion = () =>
      recordNotifyOnExitRemoval(
        session,
        expectDefined(
          enqueueSystemEventWithReceipt("terminal output", eventOptions, { allowDuplicate: true }),
          "completion receipt",
        ),
      );
    addSession(session);
    const processTool = createProcessTool();
    const turn = processTurn("persist-notify", session.id);
    const finish = () => {
      appendOutput(session, "stdout", "terminal output");
      markExited(session, 0, null, "completed");
      if (phase === "finished") {
        recordCompletion();
      }
    };
    let result: AgentToolResult<unknown>;
    if (phase === "waiting") {
      vi.useFakeTimers();
      try {
        const pending = poll(processTool, session.id, turn.toolCall.id, turn, 1_000);
        finish();
        await vi.advanceTimersByTimeAsync(250);
        result = await pending;
      } finally {
        vi.useRealTimers();
      }
    } else {
      finish();
      result = await poll(processTool, session.id, turn.toolCall.id, turn);
    }
    const manager = SessionManager.inMemory();
    const append = manager.appendMessageWithTranscriptAnchor.bind(manager);
    let rejectAppend = true;
    const spy = vi
      .spyOn(manager, "appendMessageWithTranscriptAnchor")
      .mockImplementation((message, options) => {
        if (message.role === "toolResult" && rejectAppend) {
          throw new Error("result persistence failed");
        }
        return append(message, options);
      });
    try {
      installSessionToolResultGuard(manager);
      manager.appendMessage(turn.assistantMessage);
      expect(() => persistResult(manager, turn.toolCall.id, result)).toThrow(
        "result persistence failed",
      );
      if (phase === "waiting") {
        recordCompletion();
      }
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(2);
      expect(session.terminalPollObserved).not.toBe(true);
      rejectAppend = false;
      persistResult(manager, turn.toolCall.id, result);
      expect(peekSystemEventEntries(sessionKey)).toEqual([unrelated]);
      expect(session.terminalPollObserved).toBe(true);
      recordCompletion();
      expect(peekSystemEventEntries(sessionKey)).toEqual([unrelated]);
    } finally {
      spy.mockRestore();
      drainSystemEventEntries(sessionKey);
    }
  },
);

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
    const dropped = snapshotToolSearchTargetTranscriptResult(
      await poll(processTool, sessionId, droppedTurn.toolCall.id, droppedTurn),
    );
    expect(resultText(dropped)).toContain(`${status}-output`);
    manager.appendMessage(droppedTurn.assistantMessage);
    guard.flushPendingToolResults();

    const retryTurn = processTurn(`${status}-retry`, sessionId);
    const retry = snapshotToolSearchTargetTranscriptResult(
      await poll(processTool, sessionId, retryTurn.toolCall.id, retryTurn),
    );
    expect(resultText(retry)).toContain(`${status}-output`);
    manager.appendMessage(retryTurn.assistantMessage);
    persistResult(manager, retryTurn.toolCall.id, retry);

    const observed = await poll(processTool, sessionId, `${status}-observed`);
    expect(resultText(observed)).not.toContain(`${status}-output`);
  },
);

test.each(["transformed", "blocked", "error"] as const)(
  "preserves poll acknowledgement through %s nested activity persistence",
  async (mode) => {
    const session = createProcessSessionFixture({ id: "nested-poll", backgrounded: true });
    addSession(session);
    appendOutput(session, "stdout", "nested-output\n");
    if (mode === "error") {
      markExited(session, 1, null, "failed");
    }
    let writes = 0;
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "nested-poll-write",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message }: PluginHookBeforeMessageWriteEvent) => {
        if (message.role !== "custom") {
          return undefined;
        }
        writes += 1;
        return mode === "blocked" && writes === 1 ? { block: true } : { message: { ...message } };
      },
    });
    initializeGlobalHookRunner(registry);
    const harness = createSubscribedCodeModeHarness({ name: "poll-persistence" });
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, createProcessTool()] });
    const execTool = expectDefined(harness.tools[0], "Code Mode exec tool");
    const waitTool = expectDefined(harness.tools[1], "Code Mode wait tool");
    const code = 'return await process({ action: "poll", sessionId: "nested-poll" });';
    const pollThroughBridge = async (id: string) => {
      const toolCall = { type: "toolCall" as const, id, name: execTool.name, arguments: { code } };
      const assistantMessage = makeAgentAssistantMessage({
        content: [toolCall],
        stopReason: "toolUse",
      });
      return await runWithAgentToolExecutionContext({ assistantMessage, toolCall }, async () => {
        const details = resultDetails(await execTool.execute(id, { code }));
        return await waitUntilCompleted({ details, waitTool });
      });
    };
    try {
      expect(await pollThroughBridge("nested-first")).toMatchObject({ status: "completed" });
      expect(harness.nestedToolActivities).toHaveLength(1);
      expect(harness.nestedToolActivities[0]?.details.result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("nested-output") }),
      );
      if (mode === "error") {
        expect(harness.nestedToolActivities[0]?.details.isError).toBe(true);
      }

      expect(await pollThroughBridge("nested-next-turn")).toMatchObject({ status: "completed" });
      expect(harness.nestedToolActivities).toHaveLength(2);
      if (mode === "blocked") {
        expect(harness.nestedToolActivities[1]?.details.result.content).toContainEqual(
          expect.objectContaining({ type: "text", text: expect.stringContaining("nested-output") }),
        );
        expect(await pollThroughBridge("nested-after-retry")).toMatchObject({
          status: "completed",
        });
      }
      expect(harness.nestedToolActivities.at(-1)?.details.result.content).not.toContainEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("nested-output") }),
      );
      expect(writes).toBe(mode === "blocked" ? 3 : 2);
      expect(
        harness.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "custom"),
      ).toHaveLength(2);
    } finally {
      harness.dispose();
    }
  },
);

test.each(["running", "completed"] as const)(
  "Code Mode reads the requested page from a %s process log",
  async (status) => {
    const session = createProcessSessionFixture({ id: "paged-log", backgrounded: true });
    addSession(session);
    appendOutput(session, "stdout", "before-page\nrequested-page\nafter-page\n");
    if (status === "completed") {
      markExited(session, 0, null, "completed");
    }

    const result = await runProcessInCodeMode({
      action: "log",
      sessionId: session.id,
      offset: 1,
      limit: 1,
    });

    expect(result).toMatchObject({
      status: "completed",
      value: { status, output: "requested-page", totalLines: 3 },
    });
  },
);

test("Code Mode retains the default log page limit and continuation hint", async () => {
  const session = createProcessSessionFixture({ id: "tailed-log", backgrounded: true });
  addSession(session);
  appendOutput(
    session,
    "stdout",
    Array.from({ length: 205 }, (_, index) => `line-${index}`).join("\n"),
  );

  const result = await runProcessInCodeMode({ action: "log", sessionId: session.id });

  expect(result).toMatchObject({
    status: "completed",
    value: {
      output: `${Array.from({ length: 200 }, (_, index) => `line-${index + 5}`).join("\n")}\n\n[showing last 200 of 205 lines; pass offset/limit to page]`,
    },
  });
});

test.each([
  { action: "log", sessionId: "missing-process", error: "No session found for missing-process" },
  {
    action: "paste",
    sessionId: "interactive-process",
    text: "",
    bracketed: false,
    error: "No paste text provided.",
  },
  {
    action: "send-keys",
    sessionId: "interactive-process",
    keys: ["up"],
    error:
      "Session interactive-process cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.",
  },
])("Code Mode preserves actionable $action failures", async ({ error, ...args }) => {
  const session = createProcessSessionFixture({
    id: "interactive-process",
    backgrounded: true,
    cursorKeyMode: "unknown",
  });
  const write = vi.fn<NonNullable<ProcessSession["stdin"]>["write"]>((_data, callback) =>
    callback?.(),
  );
  session.stdin = { write, end: vi.fn() };
  addSession(session);

  const result = await runProcessInCodeMode(args);

  expect(result).toMatchObject({ status: "completed", value: { status: "failed", error } });
  expect(write).not.toHaveBeenCalled();
});

test("a retained old snapshot cannot consume a successor poll delivery", async () => {
  const session = createProcessSessionFixture({ id: "retained-poll", backgrounded: true });
  addSession(session);
  appendOutput(session, "stdout", "old-output\n");
  const processTool = createProcessTool();
  const firstTurn = processTurn("old-result", session.id);
  const result = await poll(processTool, session.id, firstTurn.toolCall.id, firstTurn);
  const retained = snapshotToolSearchTargetTranscriptResult(result);
  const manager = SessionManager.inMemory();
  installSessionToolResultGuard(manager);
  manager.appendMessage(firstTurn.assistantMessage);
  persistResult(manager, firstTurn.toolCall.id, result);

  appendOutput(session, "stdout", "successor-output\n");
  expect(resultText(await poll(processTool, session.id, "successor-dropped"))).toContain(
    "successor-output",
  );
  const retainedTurn = processTurn("retained-old-result", session.id);
  manager.appendMessage(retainedTurn.assistantMessage);
  persistResult(manager, retainedTurn.toolCall.id, retained);

  expect(resultText(await poll(processTool, session.id, "successor-retry"))).toContain(
    "successor-output",
  );
});

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
