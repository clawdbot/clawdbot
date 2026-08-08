import type { AssistantMessage } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AfterToolOutcomeContext } from "../../runtime/index.js";
import { createInvalidToolArgumentsRecovery } from "./invalid-tool-arguments-recovery.js";

const validation = {
  argumentShape: "object" as const,
  issueCount: 1,
  issues: [{ code: "required" as const, path: "path" }],
  truncated: false,
};

function assistant(
  turnId: string,
  calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall" as const,
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
    })),
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    turnId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function harness(entries: Array<{ type: string; customType?: string; data?: unknown }> = []) {
  const notifyRejected = vi.fn(async () => {});
  const sessionManager = {
    appendCustomEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
      return String(entries.length);
    },
    getEntries: () => entries,
  };
  const sessionLockController = {
    withSessionWriteLock: async <T>(run: () => T | Promise<T>) => await run(),
  };
  const attempt = {
    runId: "run-1",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sandboxSessionKey: "agent:main:session-1",
    provider: "openai",
    modelId: "gpt-test",
    model: { api: "openai-responses", provider: "openai", id: "gpt-test" },
  };
  return { attempt, entries, notifyRejected, sessionLockController, sessionManager };
}

function fakeAgent(): Agent {
  return {
    afterToolOutcome: undefined,
    prepareNextTurnWithContext: undefined,
  } as Agent;
}

function invalidOutcome(message: AssistantMessage, callId: string): AfterToolOutcomeContext {
  const toolCall = message.content.find(
    (item): item is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
      item.type === "toolCall" && item.id === callId,
  );
  if (!toolCall) {
    throw new Error("missing test tool call");
  }
  return {
    assistantMessage: message,
    toolCall,
    args: toolCall.arguments,
    result: {
      content: [{ type: "text", text: "invalid" }],
      details: { classification: "invalid_tool_arguments", executionStarted: false, validation },
    },
    isError: true,
    executionStarted: false,
    errorKind: "argument-validation",
    context: { systemPrompt: "", messages: [] },
  };
}

async function settleTurn(agent: Agent, message: AssistantMessage): Promise<void> {
  await agent.prepareNextTurnWithContext?.({
    message,
    toolResults: [],
    context: { systemPrompt: "", messages: [message] },
    newMessages: [message],
  });
}

async function createController(fixture: ReturnType<typeof harness>) {
  return await createInvalidToolArgumentsRecovery({
    attempt: fixture.attempt as never,
    sessionManager: fixture.sessionManager,
    sessionLockController: fixture.sessionLockController as never,
    notifyRejected: fixture.notifyRejected,
  });
}

describe("invalid tool argument recovery", () => {
  it("claims one corrected call with a different provider call id and records success", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "provider-original", name: "edit" }]);

    const offered = await agent.afterToolOutcome?.(invalidOutcome(original, "provider-original"));
    expect(offered?.details).toMatchObject({
      classification: "invalid_tool_arguments",
      recovery: { state: "retry_available", remainingAttempts: 1 },
    });

    const correction = assistant("turn-correction", [
      { id: "provider-correction-different", name: "EDIT" },
    ]);
    const correctionCall = correction.content.find((item) => item.type === "toolCall")!;
    await expect(
      controller.beforeToolBatch({
        assistantMessage: correction,
        calls: [{ toolCall: correctionCall, args: { path: "safe.txt" } }],
        rejections: [],
        context: { systemPrompt: "", messages: [] },
      }),
    ).resolves.toBeUndefined();

    await agent.afterToolOutcome?.({
      assistantMessage: correction,
      toolCall: correctionCall,
      args: { path: "safe.txt" },
      result: { content: [{ type: "text", text: "ok" }], details: undefined },
      isError: false,
      executionStarted: true,
      context: { systemPrompt: "", messages: [] },
    });
    await settleTurn(agent, correction);
    expect(fixture.entries.map((entry) => (entry.data as { state?: string }).state)).toEqual([
      "retry_available",
      "retry_claimed",
      "succeeded",
    ]);
  });

  it("exhausts the chain on a second malformed call without opening another chain", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const correction = assistant("turn-correction", [{ id: "correction", name: "edit" }]);
    const correctionCall = correction.content.find((item) => item.type === "toolCall")!;

    const admission = await controller.beforeToolBatch({
      assistantMessage: correction,
      calls: [],
      rejections: [{ toolCall: correctionCall, validation }],
      context: { systemPrompt: "", messages: [] },
    });
    expect(admission?.intervention).toMatchObject({
      kind: "invalid-tool-arguments-recovery",
      rejection: { reason: "retry_exhausted", recovery: { remainingAttempts: 0 } },
    });
    expect(fixture.entries.map((entry) => (entry.data as { state?: string }).state)).toEqual([
      "retry_available",
      "retry_exhausted",
    ]);
    const terminalRejection =
      admission?.intervention?.kind === "invalid-tool-arguments-recovery"
        ? admission.intervention.rejection
        : undefined;
    const entryCount = fixture.entries.length;
    await agent.afterToolOutcome?.({
      ...invalidOutcome(correction, "correction"),
      result: {
        content: [{ type: "text", text: "terminal" }],
        details: terminalRejection,
      },
    });
    expect(fixture.entries).toHaveLength(entryCount);
  });

  it("closes an unmatched recovery turn and prevents every call in the batch", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const recovery = assistant("turn-other", [{ id: "other", name: "read" }]);
    const otherCall = recovery.content.find((item) => item.type === "toolCall")!;

    const admission = await controller.beforeToolBatch({
      assistantMessage: recovery,
      calls: [{ toolCall: otherCall, args: {} }],
      rejections: [],
      context: { systemPrompt: "", messages: [] },
    });
    expect(admission?.intervention).toMatchObject({
      kind: "invalid-tool-arguments-recovery",
      rejection: { reason: "retry_not_matched" },
    });
  });

  it("fails closed after restart when a claim has no receipt", async () => {
    const first = harness();
    const controller = await createController(first);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const correction = assistant("turn-correction", [{ id: "correction", name: "edit" }]);
    const correctionCall = correction.content.find((item) => item.type === "toolCall")!;
    await controller.beforeToolBatch({
      assistantMessage: correction,
      calls: [{ toolCall: correctionCall, args: {} }],
      rejections: [],
      context: { systemPrompt: "", messages: [] },
    });

    const restarted = harness(first.entries);
    const recovered = await createController(restarted);
    const restartedAgent = fakeAgent();
    recovered.install(restartedAgent);
    expect(restarted.notifyRejected).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "retry_claimed_without_receipt" }),
    );
    const admission = await recovered.beforeToolBatch({
      assistantMessage: correction,
      calls: [{ toolCall: correctionCall, args: {} }],
      rejections: [],
      context: { systemPrompt: "", messages: [] },
    });
    expect(admission?.intervention).toMatchObject({
      kind: "invalid-tool-arguments-recovery",
      rejection: { reason: "retry_claimed_without_receipt" },
    });
    const terminalRejection =
      admission?.intervention?.kind === "invalid-tool-arguments-recovery"
        ? admission.intervention.rejection
        : undefined;
    const entryCount = restarted.entries.length;
    await restartedAgent.afterToolOutcome?.({
      ...invalidOutcome(correction, "correction"),
      result: {
        content: [{ type: "text", text: "terminal" }],
        details: terminalRejection,
      },
    });
    expect(restarted.entries).toHaveLength(entryCount);
  });

  it("preserves retry_available across restart and accepts the one correction", async () => {
    const first = harness();
    const originalController = await createController(first);
    const originalAgent = fakeAgent();
    originalController.install(originalAgent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await originalAgent.afterToolOutcome?.(invalidOutcome(original, "original"));

    const restarted = harness(first.entries);
    const recovered = await createController(restarted);
    const correction = assistant("turn-correction", [{ id: "correction", name: "EDIT" }]);
    const correctionCall = correction.content.find((item) => item.type === "toolCall")!;
    await expect(
      recovered.beforeToolBatch({
        assistantMessage: correction,
        calls: [{ toolCall: correctionCall, args: {} }],
        rejections: [],
        context: { systemPrompt: "", messages: [] },
      }),
    ).resolves.toBeUndefined();
    expect((restarted.entries.at(-1)?.data as { state?: string }).state).toBe("retry_claimed");
  });

  it("treats a completed receipt as terminal when the transcript is reopened", async () => {
    const first = harness();
    const controller = await createController(first);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const correction = assistant("turn-correction", [{ id: "correction", name: "edit" }]);
    const correctionCall = correction.content.find((item) => item.type === "toolCall")!;
    await controller.beforeToolBatch({
      assistantMessage: correction,
      calls: [{ toolCall: correctionCall, args: {} }],
      rejections: [],
      context: { systemPrompt: "", messages: [] },
    });
    await agent.afterToolOutcome?.({
      assistantMessage: correction,
      toolCall: correctionCall,
      args: {},
      result: { content: [{ type: "text", text: "persisted result" }], details: undefined },
      isError: false,
      executionStarted: true,
      context: { systemPrompt: "", messages: [] },
    });
    await settleTurn(agent, correction);
    const entryCount = first.entries.length;

    const restarted = harness(first.entries);
    await createController(restarted);

    expect(restarted.entries).toHaveLength(entryCount);
    expect((restarted.entries.at(-1)?.data as { state?: string }).state).toBe("succeeded");
    expect(restarted.notifyRejected).not.toHaveBeenCalled();
  });

  it("closes retry_available when the recovery turn has no tool call", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));

    await settleTurn(agent, assistant("turn-without-call", []));

    expect((fixture.entries.at(-1)?.data as { state?: string }).state).toBe("retry_not_matched");
    expect(fixture.notifyRejected).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "retry_not_matched" }),
    );
  });

  it("closes retry_available on an ambiguous multi-call recovery batch", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const correction = assistant("turn-correction", [
      { id: "correction", name: "edit" },
      { id: "extra", name: "edit" },
    ]);
    const correctionCalls = correction.content.filter((item) => item.type === "toolCall");

    const admission = await controller.beforeToolBatch({
      assistantMessage: correction,
      calls: correctionCalls.map((toolCall) => ({ toolCall, args: {} })),
      rejections: [],
      context: { systemPrompt: "", messages: [] },
    });

    expect(admission?.intervention).toMatchObject({
      kind: "invalid-tool-arguments-recovery",
      rejection: { reason: "retry_not_matched" },
    });
  });

  it("never persists rejected raw arguments or values in recovery metadata", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const secret = "RECOVERY_SECRET_CANARY_820";
    const original = assistant("turn-original", [
      { id: "original", name: "edit", arguments: { password: secret } },
    ]);

    const offered = await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const serialized = JSON.stringify({ entries: fixture.entries, offered });

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("password");
  });

  it.each([
    { isError: true, executionStarted: false, state: "blocked" },
    { isError: true, executionStarted: true, state: "failed" },
  ])("records a claimed correction receipt as $state", async (expected) => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const correction = assistant("turn-correction", [{ id: "correction", name: "edit" }]);
    const correctionCall = correction.content.find((item) => item.type === "toolCall")!;
    await controller.beforeToolBatch({
      assistantMessage: correction,
      calls: [{ toolCall: correctionCall, args: {} }],
      rejections: [],
      context: { systemPrompt: "", messages: [] },
    });
    await agent.afterToolOutcome?.({
      assistantMessage: correction,
      toolCall: correctionCall,
      args: {},
      result: {
        content: [{ type: "text", text: "native failure" }],
        details: undefined,
      },
      isError: expected.isError,
      executionStarted: expected.executionStarted,
      context: { systemPrompt: "", messages: [] },
    });
    await settleTurn(agent, correction);
    expect((fixture.entries.at(-1)?.data as { state?: string }).state).toBe(expected.state);
  });
});
