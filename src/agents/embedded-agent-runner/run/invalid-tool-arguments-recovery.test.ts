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

type HarnessEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  message?: AssistantMessage;
  active?: boolean;
};

function harness(entries: HarnessEntry[] = []) {
  const notifyRejected = vi.fn(async () => {});
  const sessionManager = {
    appendCustomEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
      return String(entries.length);
    },
    getEntries: () => entries,
    getBranch: () => entries.filter((entry) => entry.active !== false),
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

    const correctionId = `provider-correction-different-${"x".repeat(160)}`;
    const correction = assistant("turn-correction", [{ id: correctionId, name: "EDIT" }]);
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
    expect(fixture.entries.map((entry) => (entry.data as { state?: string }).state)).toEqual([
      "retry_available",
      "retry_claimed",
      "succeeded",
    ]);
    await settleTurn(agent, correction);
    expect(fixture.entries).toHaveLength(3);
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
    const correctionValidation = {
      argumentShape: "string" as const,
      issueCount: 2,
      issues: [{ code: "type" as const, path: "replacement" }],
      truncated: false,
    };

    const admission = await controller.beforeToolBatch({
      assistantMessage: correction,
      calls: [],
      rejections: [{ toolCall: correctionCall, validation: correctionValidation }],
      context: { systemPrompt: "", messages: [] },
    });
    expect(admission?.intervention).toMatchObject({
      kind: "invalid-tool-arguments-recovery",
      rejection: {
        reason: "retry_exhausted",
        correlation: { turnId: "turn-correction", providerToolCallId: "correction" },
        recovery: { remainingAttempts: 0 },
        validation: correctionValidation,
      },
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

  it("claims a same-tool correction even when preflight cannot resolve it", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const correction = assistant("turn-correction", [
      { id: "unresolved-correction", name: "EDIT" },
    ]);

    await expect(
      controller.beforeToolBatch({
        assistantMessage: correction,
        calls: [],
        rejections: [],
        context: { systemPrompt: "", messages: [] },
      }),
    ).resolves.toBeUndefined();
    expect((fixture.entries.at(-1)?.data as { state?: string }).state).toBe("retry_claimed");
  });

  it("closes a different unresolved correction without another provider turn", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await agent.afterToolOutcome?.(invalidOutcome(original, "original"));
    const correction = assistant("turn-correction", [
      { id: "unresolved-other", name: "missing_tool" },
    ]);

    const admission = await controller.beforeToolBatch({
      assistantMessage: correction,
      calls: [],
      rejections: [],
      context: { systemPrompt: "", messages: [] },
    });

    expect(admission?.intervention).toMatchObject({
      kind: "invalid-tool-arguments-recovery",
      toolCallId: "unresolved-other",
      rejection: { reason: "retry_not_matched" },
    });
    expect((fixture.entries.at(-1)?.data as { state?: string }).state).toBe("retry_not_matched");
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
    expect(restarted.notifyRejected).not.toHaveBeenCalled();
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

  it("closes retry_available when a later provider turn ended before admission", async () => {
    const first = harness();
    const originalController = await createController(first);
    const originalAgent = fakeAgent();
    originalController.install(originalAgent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await originalAgent.afterToolOutcome?.(invalidOutcome(original, "original"));
    first.entries.push({
      type: "message",
      message: {
        ...assistant("turn-provider-error", []),
        content: [{ type: "text", text: "provider failed" }],
        stopReason: "error",
        errorMessage: "provider failed",
      },
    });

    const restarted = harness(first.entries);
    await createController(restarted);

    expect((restarted.entries.at(-1)?.data as { state?: string }).state).toBe("retry_not_matched");
    expect(restarted.notifyRejected).toHaveBeenCalledOnce();
  });

  it("ignores recovery entries outside the active transcript branch", async () => {
    const first = harness();
    const originalController = await createController(first);
    const originalAgent = fakeAgent();
    originalController.install(originalAgent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    await originalAgent.afterToolOutcome?.(invalidOutcome(original, "original"));
    first.entries[0]!.active = false;

    const restarted = harness(first.entries);
    const recovered = await createController(restarted);
    const unrelated = assistant("turn-unrelated", [{ id: "unrelated", name: "read" }]);
    const unrelatedCall = unrelated.content.find((item) => item.type === "toolCall")!;

    await expect(
      recovered.beforeToolBatch({
        assistantMessage: unrelated,
        calls: [{ toolCall: unrelatedCall, args: {} }],
        rejections: [],
        context: { systemPrompt: "", messages: [] },
      }),
    ).resolves.toBeUndefined();
    expect(restarted.entries).toHaveLength(1);
    expect(restarted.notifyRejected).not.toHaveBeenCalled();
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

  it("does not open durable recovery after cancellation", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [{ id: "original", name: "edit" }]);
    const abortController = new AbortController();
    abortController.abort(new Error("cancelled"));

    await expect(
      agent.afterToolOutcome?.(invalidOutcome(original, "original"), abortController.signal),
    ).resolves.toBeUndefined();
    expect(fixture.entries).toEqual([]);
    expect(fixture.notifyRejected).not.toHaveBeenCalled();
  });

  it("blocks siblings in an original rejected batch but preserves the correction turn", async () => {
    const fixture = harness();
    const controller = await createController(fixture);
    const agent = fakeAgent();
    controller.install(agent);
    const original = assistant("turn-original", [
      { id: "invalid", name: "edit" },
      { id: "sibling", name: "read" },
    ]);
    const [invalidCall, siblingCall] = original.content.filter((item) => item.type === "toolCall");

    const admission = await controller.beforeToolBatch({
      assistantMessage: original,
      calls: [{ toolCall: siblingCall!, args: {} }],
      rejections: [{ toolCall: invalidCall!, validation }],
      context: { systemPrompt: "", messages: [] },
    });
    expect(admission?.intervention).toMatchObject({
      kind: "invalid-tool-arguments-recovery",
      continueRecovery: true,
      rejection: { reason: "schema_validation_failed" },
    });
    expect((fixture.entries.at(-1)?.data as { state?: string }).state).toBe("retry_available");

    const offered = await agent.afterToolOutcome?.(invalidOutcome(original, "invalid"));
    expect(offered).toMatchObject({ terminate: false });
    expect(fixture.entries).toHaveLength(1);

    const correction = assistant("turn-correction", [{ id: "correction", name: "EDIT" }]);
    const correctionCall = correction.content.find((item) => item.type === "toolCall")!;
    await expect(
      controller.beforeToolBatch({
        assistantMessage: correction,
        calls: [{ toolCall: correctionCall, args: {} }],
        rejections: [],
        context: { systemPrompt: "", messages: [] },
      }),
    ).resolves.toBeUndefined();
    expect((fixture.entries.at(-1)?.data as { state?: string }).state).toBe("retry_claimed");
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
