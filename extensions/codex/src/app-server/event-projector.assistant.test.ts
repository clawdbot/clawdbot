import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createCodexTestModel,
  createParams,
  createProjector,
  createProjectorWithAssistantHooks,
  buildEmptyToolTelemetry,
  requireRecord,
  expectUsageFields,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector assistant projection", () => {
  it("projects assistant deltas and usage into embedded attempt results", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      await createProjectorWithAssistantHooks();

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("hel"));
    await projector.handleNotification(agentMessageDelta("lo"));
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-1",
        usage: {
          totalTokens: 12,
          inputTokens: 5,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 1,
          outputTokens: 7,
          reasoningOutputTokens: 3,
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "hello" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls.map((call) => call[0])).toEqual([
      { text: "hel", delta: "hel" },
      { text: "hello", delta: "lo" },
    ]);
    expect(result.assistantTexts).toEqual(["hello"]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.currentAttemptAssistant?.content).toEqual([{ type: "text", text: "hello" }]);
    expectUsageFields(result.attemptUsage, {
      input: 2,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      total: 12,
    });
    expect(result.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
    expect(result.attemptUsage?.reasoningTokens).toBe(3);
    expectUsageFields(result.lastAssistant?.usage, {
      input: 2,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      total: 12,
    });
    expect(result.lastAssistant?.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
    expect(normalizeUsage(result.lastAssistant?.usage)?.reasoningTokens).toBe(3);
    expect(normalizeUsage(result.currentAttemptAssistant?.usage)?.reasoningTokens).toBe(3);
    expect(result.replayMetadata.replaySafe).toBe(true);
  });

  it("projects a current-turn model reroute onto the terminal assistant", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(
      forCurrentTurn("model/rerouted", {
        fromModel: "gpt-5.4-codex",
        toModel: "gpt-5.4-codex-mini",
        reason: "high_risk_cyber_activity",
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-rerouted", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.currentAttemptAssistant?.responseModel).toBe("gpt-5.4-codex-mini");
    expect(result.lastAssistant?.responseModel).toBe("gpt-5.4-codex-mini");
    expect(result).toMatchObject({
      terminalTurnId: "turn-1",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "fallback",
      data: {
        fromModel: "gpt-5.4-codex",
        toModel: "gpt-5.4-codex-mini",
        reason: "high_risk_cyber_activity",
      },
    });
  });

  it("keeps reopened final answers as Activity candidates until turn completion selects one", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );

    const lateTool = {
      type: "commandExecution",
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "late",
      exitCode: 0,
      durationMs: 1,
    };
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...lateTool, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item: lateTool }));

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Second candidate", "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: "Second candidate",
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: "Second candidate",
        },
      ]),
    );

    const candidateEvents = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
      .map((event) => event.data);
    expect(candidateEvents).toEqual([
      expect.objectContaining({
        itemId: "answer-1",
        status: "candidate",
        progressText: "First candidate",
        hideFromChannelProgress: true,
      }),
      expect.objectContaining({
        itemId: "answer-1",
        status: "superseded",
        progressText: "First candidate",
        hideFromChannelProgress: true,
      }),
      expect.objectContaining({
        itemId: "answer-2",
        status: "candidate",
        progressText: "Second candidate",
        hideFromChannelProgress: true,
      }),
      expect.objectContaining({
        itemId: "answer-2",
        status: "selected",
        progressText: "Second candidate",
        hideFromChannelProgress: true,
      }),
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Second candidate"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("answer_candidate");
  });

  it("keeps an earlier final answer when a later coda arrives with no tool work between them", async () => {
    const projector = await createProjector(await createParams());
    const summary = "Read-only; inspected actual diffs, no mutations: - #122457 — Copies";
    const coda = "The summary above already incorporates the final review results.";

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta(summary, "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: summary,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta(coda, "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: coda,
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: coda,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const snapshot = JSON.stringify(result.messagesSnapshot);

    expect(result.assistantTexts).toEqual([summary, coda]);
    expect(result.lastAssistant?.content).toEqual([
      { type: "text", text: `${summary}\n\n${coda}` },
    ]);
    expect(snapshot).toContain(summary);
    expect(snapshot).toContain(coda);
  });

  it("drops a pre-unphased final when a later final follows the replacement", async () => {
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Replacement draft", "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-3", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Later final", "answer-3"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-3",
          phase: "final_answer",
          text: "Later final",
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "answer-3", phase: "final_answer", text: "Later final" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Later final"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("Replacement draft");
  });

  it("keeps the unphased replacement when a later silent final follows", async () => {
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Replacement draft", "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-3", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("NO_REPLY", "answer-3"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-3",
          phase: "final_answer",
          text: "NO_REPLY",
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "answer-3", phase: "final_answer", text: "NO_REPLY" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Replacement draft"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("NO_REPLY");
  });

  it("omits a silent completed answer from the steering transcript boundary", async () => {
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "silent-before-steer",
          phase: "final_answer",
          text: "NO_REPLY",
        },
      }),
    );

    expect(projector.buildSteeringTranscriptPrefix()).toEqual([]);
  });

  it("drops a pre-sleep final after a later sleep handoff", async () => {
    const projector = await createProjector(await createParams());
    const sleepItem = { type: "sleep", id: "sleep-1", durationMs: 250 };

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/started", { item: sleepItem }));
    await projector.handleNotification(forCurrentTurn("item/completed", { item: sleepItem }));
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("After sleep", "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: "After sleep",
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "After sleep" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["After sleep"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
  });

  it("drops a trailing JSON silent payload when an earlier audible final remains", async () => {
    const projector = await createProjector(await createParams());
    const jsonSilent = '{"action":"NO_REPLY"}';

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Keep this answer", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "Keep this answer",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta(jsonSilent, "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: jsonSilent,
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "answer-2", phase: "final_answer", text: jsonSilent },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Keep this answer"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(jsonSilent);
  });

  it("keeps a final answer that arrives while an earlier native tool is still active", async () => {
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "imageGeneration", id: "ig_1", status: "inProgress" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Done.", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "Done.",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "imageGeneration", id: "ig_1", status: "completed" },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "Done." },
      ]),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual(["Done."]);
  });

  it("drops a pre-handoff final after a later dynamic tool call", async () => {
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "dynamicToolCall",
          id: "call-search",
          tool: "memory_search",
          status: "inProgress",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "dynamicToolCall",
          id: "call-search",
          tool: "memory_search",
          status: "completed",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Second candidate", "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: "Second candidate",
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: "Second candidate",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Second candidate"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
  });

  it("keeps a post-handoff silent final instead of recovering the pre-tool answer", async () => {
    const projector = await createProjector(await createParams());
    const lateTool = {
      type: "commandExecution",
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "late",
      exitCode: 0,
      durationMs: 1,
    };

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...lateTool, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item: lateTool }));
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("NO_REPLY", "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: "NO_REPLY",
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "NO_REPLY" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["NO_REPLY"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
  });

  it("does not reselect a final answer superseded by late tool work", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );

    const lateTool = {
      type: "commandExecution",
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "late",
      exitCode: 0,
      durationMs: 1,
    };
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...lateTool, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item: lateTool }));
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
        lateTool,
      ]),
    );

    const candidateStatuses = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
      .map((event) => event.data.status);
    expect(candidateStatuses).toEqual(["candidate", "superseded"]);
  });

  it("selects an unphased final answer supplied only by the completed-turn snapshot", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "answer-unphased", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.messagesSnapshot.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      }),
    );
    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
        .map((event) => event.data),
    ).toEqual([
      expect.objectContaining({
        itemId: "answer-unphased",
        status: "selected",
        progressText: "done",
        hideFromChannelProgress: true,
      }),
    ]);
  });

  it("streams final-answer assistant deltas into partial replies", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
      onPartialReply,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "agentMessage",
          id: "msg-final",
          phase: "final_answer",
          text: "",
        },
      }),
    );
    await projector.handleNotification(agentMessageDelta("hel", "msg-final"));
    await projector.handleNotification(agentMessageDelta("lo", "msg-final"));

    expect(onPartialReply).toHaveBeenCalledTimes(2);
    expect(onPartialReply.mock.calls.map((call) => call[0])).toEqual([
      { text: "hel", delta: "hel" },
      { text: "hello", delta: "lo" },
    ]);
    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "assistant"),
    ).toEqual([
      { stream: "assistant", data: { text: "hel", delta: "hel" } },
      { stream: "assistant", data: { text: "hello", delta: "lo" } },
    ]);
  });

  it("streams assistant deltas when the app-server omits the item phase", async () => {
    // Codex can stream agentMessage deltas without a final-answer phase. Route
    // them through replaceable events, not append-oriented partial callbacks.
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      onAgentEvent,
      onPartialReply,
    });

    await projector.handleNotification(agentMessageDelta("hel", "msg-final"));
    await projector.handleNotification(agentMessageDelta("lo", "msg-final"));

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onAgentEvent.mock.calls.map((call) => call[0])).toEqual([
      { stream: "assistant", data: { text: "hel", delta: "hel", replaceable: true } },
      { stream: "assistant", data: { text: "hello", delta: "lo", replaceable: true } },
    ]);
  });

  it("marks partial replacement when an unphased intermediate item is superseded by a final item", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      onAgentEvent,
      onPartialReply,
    });

    await projector.handleNotification(agentMessageDelta("coordination ", "msg-intermediate"));
    await projector.handleNotification(agentMessageDelta("draft", "msg-intermediate"));
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-final", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("final ", "msg-final"));
    await projector.handleNotification(agentMessageDelta("answer", "msg-final"));

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "assistant"),
    ).toEqual([
      {
        stream: "assistant",
        data: { text: "coordination ", delta: "coordination ", replaceable: true },
      },
      {
        stream: "assistant",
        data: { text: "coordination draft", delta: "draft", replaceable: true },
      },
      {
        stream: "assistant",
        data: { text: "final ", delta: "", replace: true, replaceable: true },
      },
      { stream: "assistant", data: { text: "final answer", delta: "answer", replaceable: true } },
    ]);
  });

  it("suppresses mirrored user prompt when the inbound message was already persisted", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      suppressNextUserMessagePersistence: true,
    });
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "retry result" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.messagesSnapshot.map((message) => message.role)).toEqual(["assistant"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(params.prompt);
  });

  it("tags mirrored prompts with the exact upstream user text", async () => {
    const projector = await createProjector(undefined, {
      upstreamUserText: "decorated upstream prompt",
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const userMessage = requireRecord(result.messagesSnapshot[0], "user message");
    expect(userMessage["__openclaw"]).toMatchObject({
      upstreamUserText: "decorated upstream prompt",
    });
  });

  it("records canonical OpenAI Codex app-server turns with Codex local attribution", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      provider: "openai",
      modelId: "gpt-5.5",
      model: {
        ...createCodexTestModel("openai"),
        id: "gpt-5.5",
        name: "gpt-5.5",
        api: "openai-responses",
      } as EmbeddedRunAttemptParams["model"],
      runtimePlan: {
        auth: {},
        observability: {
          resolvedRef: "openai/gpt-5.5",
          provider: "openai",
          modelId: "gpt-5.5",
          harnessId: "codex",
        },
        prompt: {
          resolveSystemPromptContribution: () => undefined,
        },
        tools: {
          normalize: (tools: unknown[]) => tools,
          logDiagnostics: () => undefined,
        },
      } as unknown as EmbeddedRunAttemptParams["runtimePlan"],
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.lastAssistant?.provider).toBe("openai");
    expect(result.lastAssistant?.api).toBe("openai-chatgpt-responses");
    expect(result.lastAssistant?.model).toBe("gpt-5.5");
  });

  it("preserves OpenAI attribution for Codex app-server OpenAI API-key fallback profiles", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      provider: "openai",
      authProfileId: "openai:work",
      modelId: "gpt-5.5",
      model: {
        ...createCodexTestModel("openai"),
        id: "gpt-5.5",
        name: "gpt-5.5",
        api: "openai-responses",
      } as EmbeddedRunAttemptParams["model"],
      runtimePlan: {
        auth: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          harnessAuthProvider: "openai",
          forwardedAuthProfileId: "openai:work",
        },
        observability: {
          resolvedRef: "openai/gpt-5.5",
          provider: "openai",
          modelId: "gpt-5.5",
          harnessId: "codex",
        },
        prompt: {
          resolveSystemPromptContribution: () => undefined,
        },
        tools: {
          normalize: (tools: unknown[]) => tools,
          logDiagnostics: () => undefined,
        },
      } as unknown as EmbeddedRunAttemptParams["runtimePlan"],
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.lastAssistant?.provider).toBe("openai");
    expect(result.lastAssistant?.api).toBe("openai-responses");
    expect(result.lastAssistant?.model).toBe("gpt-5.5");
  });

  it("preserves inbound sender metadata on the mirrored user prompt", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      messageChannel: "discord",
      messageProvider: "discord-voice",
      senderId: "user-123",
      senderName: "Test User",
      senderUsername: "testuser",
      inputProvenance: {
        kind: "external_user",
        sourceChannel: "discord",
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    const userMessage = requireRecord(result.messagesSnapshot[0], "user message");
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toBe("hello");
    expect(userMessage.sourceChannel).toBe("discord");
    expect(userMessage.senderId).toBe("user-123");
    expect(userMessage.senderName).toBe("Test User");
    expect(userMessage.senderUsername).toBe("testuser");
    expect(userMessage.senderLabel).toBe("Test User (user-123)");
    expect(userMessage.provenance).toEqual({
      kind: "external_user",
      sourceChannel: "discord",
    });
  });
});
