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
    expect(result.replayMetadata.replaySafe).toBe(true);
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
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
        lateTool,
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
    // Newer Codex app-servers (>= 0.139) stream agentMessage deltas without a
    // "final_answer" phase. These surface on the replaceable agent-event path;
    // legacy append-oriented partial callbacks stay quiet.
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
