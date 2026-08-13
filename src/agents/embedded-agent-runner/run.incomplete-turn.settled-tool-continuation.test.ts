// Focused incomplete-turn behavior coverage.
import { beforeEach, describe, expect, it } from "vitest";
import {
  REASONING_ONLY_RETRY_INSTRUCTION,
  SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
  runEmbeddedAgent,
  makeLastAssistant,
  makeRunParams,
  expectWarnMessageWith,
  expectNoWarnMessageWith,
  runAttemptCall,
  markUserMessagePersisted,
} from "./run.incomplete-turn.test-helpers.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  registerAgentHarness,
  resetRunIncompleteTurnOwnerMocks,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
  });

  it("preserves a structured visible failed-tool payload without finalizing (#118274)", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const visibleError = {
      text: "Review the failed operation.",
      isError: true,
      channelData: { structuredError: true },
    };
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec", isError: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "exec", isError: true },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        lastToolError: { toolName: "exec", error: "post-processing error" },
      }),
    );
    mockedBuildEmbeddedRunPayloads.mockReturnValueOnce([visibleError]);

    const result = await runEmbeddedAgent(makeRunParams("run-structured-failed-tool-payload"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(result.payloads?.[0]).toMatchObject(visibleError);
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("keeps the original failed-tool warning if finalization completes empty (#118274)", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const warning = { text: "⚠️ 🛠️ Exec failed", isError: true };
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "exec", isError: true }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            toolUseAssistant,
            { role: "toolResult", toolCallId: "tool_1", toolName: "exec", isError: true },
          ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
          lastToolError: { toolName: "exec", error: "post-processing error" },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: makeLastAssistant(),
          currentAttemptAssistant: makeLastAssistant(),
          currentAttemptCompletedAssistant: makeLastAssistant(),
        }),
      );
    mockedBuildEmbeddedRunPayloads.mockReturnValue([warning]);

    const result = await runEmbeddedAgent(makeRunParams("run-failed-tool-finalization-fallback"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toEqual(warning);
    expectWarnMessageWith("settled-turn finalization completed without a visible answer");
  });

  it("preserves the incomplete-turn failure when the selected harness cannot finalize safely", async () => {
    registerAgentHarness({
      id: "legacy",
      label: "Legacy harness without settled-turn finalization",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
    });
    try {
      const toolUseAssistant = makeLastAssistant({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } },
        ],
      });
      mockedClassifyFailoverReason.mockReturnValue(null);
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
        markUserMessagePersisted(attemptParams);
        return makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            toolUseAssistant,
            { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
          ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
        });
      });

      const result = await runEmbeddedAgent(
        makeRunParams("run-tool-use-no-finalization-capability", { agentHarnessId: "legacy" }),
      );

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]).toMatchObject({ isError: true });
      expect(result.payloads?.[0]?.text).toContain(
        "some tool actions may have already been executed",
      );
      expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
    } finally {
      resetRunIncompleteTurnOwnerMocks();
    }
  });

  it("continues from settled side-effecting tools after an empty stop without replaying them", async () => {
    const emptyStopAssistant = makeLastAssistant();
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Writing note.txt…"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "chat:123",
            text: "Writing note.txt…",
            sourceReplyFinal: false,
          },
        ],
        lastAssistant: emptyStopAssistant,
        currentAttemptAssistant: emptyStopAssistant,
      });
    });
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Write completed. Here is the final answer." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Write completed. Here is the final answer."],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ text: "Write completed. Here is the final answer." }]);

    const result = await runEmbeddedAgent(
      makeRunParams("run-empty-stop-settled-tool-continuation", {
        trigger: "cron",
        terminalReplyExpectation: "required",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("Write completed. Here is the final answer.");
    expect(runAttemptCall(1).prompt).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(runAttemptCall(1).disableTools).toBe(true);
    expectNoWarnMessageWith("empty response detected");
    expectWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it.each([
    {
      label: "explicit optional expectation",
      trigger: "user" as const,
      terminalReplyExpectation: "optional" as const,
    },
    {
      label: "heartbeat default",
      trigger: "heartbeat" as const,
      terminalReplyExpectation: undefined,
    },
  ])("does not continue settled tools for $label", async (runPolicy) => {
    const emptyStopAssistant = makeLastAssistant();
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: emptyStopAssistant,
        currentAttemptAssistant: emptyStopAssistant,
      });
    });
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);

    const result = await runEmbeddedAgent(
      makeRunParams("run-optional-empty-stop-settled-tool", {
        trigger: runPolicy.trigger,
        terminalReplyExpectation: runPolicy.terminalReplyExpectation,
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("surfaces an incomplete turn when a required settled-tool finalizer completes empty", async () => {
    const emptyStopAssistant = makeLastAssistant();
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: emptyStopAssistant,
        currentAttemptAssistant: emptyStopAssistant,
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: emptyStopAssistant,
        currentAttemptAssistant: emptyStopAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);

    const result = await runEmbeddedAgent(
      makeRunParams("run-empty-stop-settled-tool-continuation-exhausted", {
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "required",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expect(result.payloads?.[0]?.text).toContain(
      "some tool actions may have already been executed",
    );
    expect(result.meta.error?.kind).toBe("incomplete_turn");
    expect(result.meta.terminalReplyKind).toBeUndefined();
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.finalAssistantRawText).toBeUndefined();
    expectNoWarnMessageWith("empty response detected");
    expectWarnMessageWith("settled-turn finalization completed without a visible answer");
  });

  it.each([
    {
      label: "provider failure",
      finalAttempt: {
        assistantTexts: [],
        promptError: new Error("finalizer provider failure"),
        promptErrorSource: "prompt" as const,
      },
    },
    {
      label: "preflight recovery request",
      finalAttempt: {
        assistantTexts: [],
        preflightRecovery: { route: "compact_only" as const, handled: true as const },
      },
    },
    {
      label: "compaction continuation request",
      finalAttempt: { assistantTexts: [], compactionCount: 1 },
    },
    {
      label: "before-finalize revision request",
      finalAttempt: {
        assistantTexts: [],
        beforeAgentFinalizeRevisionReason: "revise this answer",
      },
    },
  ])("does not escape finalization through a $label", async ({ finalAttempt }) => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: {} }],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "write" }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            toolUseAssistant,
            { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
          ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult(finalAttempt));
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);

    const result = await runEmbeddedAgent(makeRunParams("run-settled-finalizer-sticky-operation"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({ isError: true });
    expect(result.payloads?.[0]?.text).toContain(
      "some tool actions may have already been executed",
    );
  });

  it("surfaces the existing incomplete-turn error after one tool-use continuation", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-tool-use-terminal-continuation-exhausted"),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain(
      "some tool actions may have already been executed",
    );
    expectWarnMessageWith("settled-turn finalization failed closed");
  });

  it("does not claim completion for a toolUse terminal whose tools never started", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-tool-use-terminal-never-started"));

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("ignores stale prior-turn tool results with colliding ids", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
        // A completed result from a PRIOR turn reusing the same id sits before
        // the terminal assistant; it must not prove the new batch dispatched.
        messagesSnapshot: [
          { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
          toolUseAssistant,
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-tool-use-terminal-stale-prior-result"));

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("does not claim completion when only part of a multi-tool request dispatched", async () => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tool_1", name: "write", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "tool_2", name: "write", arguments: { path: "b.txt" } },
      ],
    });
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=a.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-tool-use-terminal-partial-dispatch"));

    for (let call = 0; call < mockedRunEmbeddedAttempt.mock.calls.length; call += 1) {
      expect(runAttemptCall(call).prompt).not.toContain(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    }
    expectNoWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it("retries reasoning-only assistant turns even when deliberate silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_silent_group", type: "reasoning" }),
            },
          ],
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          content: [{ type: "text", text: "Visible answer." }],
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-reasoning-only-silent", { allowEmptyAssistantReplyAsSilent: true }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(runAttemptCall(1).prompt).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
    expectWarnMessageWith("reasoning-only assistant turn detected");
  });

  it("replays an unpersisted reasoning continuation across a missing-assistant retry", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_retry_boundary", type: "reasoning" }),
            },
          ],
        }),
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["Visible answer."] }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-reasoning-continuation-missing-assistant", { model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(runAttemptCall(1)).toMatchObject({
      prompt: REASONING_ONLY_RETRY_INSTRUCTION,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: true,
    });
    expect(runAttemptCall(2)).toMatchObject({
      prompt: REASONING_ONLY_RETRY_INSTRUCTION,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: true,
    });
  });
});
