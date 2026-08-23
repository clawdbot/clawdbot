import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  CodexAppServerEventProjector,
  createCodexTestModel,
  THREAD_ID,
  TURN_ID,
  createParams,
  createProjector,
  createProjectorWithAssistantHooks,
  buildEmptyToolTelemetry,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector commentary projection", () => {
  it("keeps intermediate agentMessage items out of the final visible reply", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      await createProjectorWithAssistantHooks();

    await projector.handleNotification(
      agentMessageDelta(
        "checking thread context; then post a tight progress reply here.",
        "msg-commentary",
      ),
    );
    await projector.handleNotification(
      agentMessageDelta(
        "release fixes first. please drop affected PRs, failing checks, and blockers here.",
        "msg-final",
      ),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-commentary",
          text: "checking thread context; then post a tight progress reply here.",
        },
        {
          type: "agentMessage",
          id: "msg-final",
          text: "release fixes first. please drop affected PRs, failing checks, and blockers here.",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    // Phase-less snapshots stay on the replaceable agent-event path so legacy
    // append-only channel previews do not render superseded coordination text.
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(result.assistantTexts).toEqual([
      "release fixes first. please drop affected PRs, failing checks, and blockers here.",
    ]);
    expect(result.lastAssistant?.content).toEqual([
      {
        type: "text",
        text: "release fixes first. please drop affected PRs, failing checks, and blockers here.",
      },
    ]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("checking thread context");
  });

  it("preserves an empty final assistant item after tool activity", async () => {
    const projector = await createProjector();
    projector.recordDynamicToolCall({
      callId: "call-search",
      tool: "memory_search",
      arguments: { query: "scheduler" },
    });
    projector.recordDynamicToolResult({
      callId: "call-search",
      tool: "memory_search",
      success: true,
      sideEffectEvidence: false,
      contentItems: [{ type: "inputText", text: "no matches" }],
    });
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "msg-before-tool", text: "Checking the scheduler now." },
        { type: "agentMessage", id: "msg-final", text: "" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["Checking the scheduler now."]);
    expect(result.currentAttemptAssistant?.content).toEqual([{ type: "text", text: "" }]);
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: false, replaySafe: true });
  });

  it.each([
    { itemId: "msg_mock_1", text: "" },
    { itemId: "msg_mock_1", text: " \n " },
    { itemId: undefined, text: "" },
    { itemId: undefined, text: " \n " },
  ])(
    "preserves an explicit raw empty stop ($itemId) after a settled write",
    async ({ itemId, text }) => {
      const onAgentEvent = vi.fn();
      const projector = await createProjector({ ...(await createParams()), onAgentEvent });
      const priorAssistant = { type: "agentMessage", id: "msg-before-write", text: "" };
      await projector.handleNotification(forCurrentTurn("item/started", { item: priorAssistant }));
      await projector.handleNotification(
        forCurrentTurn("item/completed", { item: priorAssistant }),
      );
      const item = {
        type: "dynamicToolCall",
        id: "call-write",
        namespace: null,
        tool: "write",
        arguments: { path: "note.txt", content: "written once" },
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      };
      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      projector.recordDynamicToolCall({
        callId: item.id,
        tool: item.tool,
        arguments: item.arguments,
      });
      projector.recordDynamicToolResult({
        callId: item.id,
        tool: item.tool,
        success: true,
        sideEffectEvidence: true,
        contentItems: [{ type: "inputText", text: "written once" }],
      });
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            ...item,
            status: "completed",
            contentItems: [{ type: "inputText", text: "written once" }],
            success: true,
            durationMs: 1,
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "message",
            ...(itemId ? { id: itemId } : {}),
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        }),
      );
      await projector.handleNotification(turnCompleted([]));

      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.assistantTexts).toEqual([]);
      expect(result.lastAssistant).toBeUndefined();
      expect(result.currentAttemptAssistant).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "" }],
      });
      expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
      expect(result.itemLifecycle).toEqual({ startedCount: 2, completedCount: 2, activeCount: 0 });
      expect(result.messagesSnapshot.filter((message) => message.role === "assistant")).toEqual([
        expect.objectContaining({ content: [expect.objectContaining({ type: "toolCall" })] }),
      ]);
      expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "assistant")).toBe(false);
    },
  );

  it.each([
    { label: "missing content", content: [] },
    { label: "missing text", content: [{ type: "output_text" }] },
    { label: "non-text content", content: [{ type: "reasoning", text: "" }] },
    { label: "commentary", content: [{ type: "output_text", text: "" }], phase: "commentary" },
    { label: "active tool", content: [{ type: "output_text", text: "" }], active: true },
  ])("does not fabricate a terminal assistant for $label", async ({ content, phase, active }) => {
    const projector = await createProjector();
    if (active) {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "commandExecution", id: "pending-tool", status: "inProgress" },
        }),
      );
    }
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: { type: "message", role: "assistant", ...(phase ? { phase } : {}), content },
      }),
    );
    await projector.handleNotification(turnCompleted([]));

    expect(
      projector.buildResult(buildEmptyToolTelemetry()).currentAttemptAssistant,
    ).toBeUndefined();
  });

  it("streams commentary agent messages as keyed progress events", async () => {
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
          id: "msg-commentary",
          phase: "commentary",
          text: "",
        },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Checking", "msg-commentary"));
    await projector.handleNotification(
      agentMessageDelta(" the app-server stream", "msg-commentary"),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "Checking the app-server stream",
        },
        {
          type: "agentMessage",
          id: "msg-final",
          phase: "final_answer",
          text: "final answer",
        },
      ]),
    );

    const progressEvents = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "preamble");

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(progressEvents.map((event) => event.data)).toEqual([
      {
        itemId: "msg-commentary",
        kind: "preamble",
        title: "Preamble",
        phase: "update",
        progressText: "Checking",
        source: "codex-app-server",
      },
      {
        itemId: "msg-commentary",
        kind: "preamble",
        title: "Preamble",
        phase: "update",
        progressText: "Checking the app-server stream",
        source: "codex-app-server",
      },
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["final answer"]);
    const commentary = result.messagesSnapshot.find(
      (message) =>
        (message as { openclawStreamFallback?: { itemId?: unknown } }).openclawStreamFallback
          ?.itemId === "msg-commentary",
    );
    expect(commentary).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Checking the app-server stream" }],
      openclawStreamFallback: {
        replacementText: "Checking the app-server stream",
        source: "segment",
        itemId: "msg-commentary",
      },
      __openclaw: { mirrorIdentity: `${TURN_ID}:commentary:msg-commentary` },
    });
    expect((commentary as { phase?: unknown } | undefined)?.phase).toBeUndefined();
  });

  it("omits durable commentary when the operator explicitly disables persistence", async () => {
    const params = await createParams();
    params.config = { ui: { prefs: { chatPersistCommentary: false } } };
    const projector = await createProjector(params);

    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "Checking the workspace",
        },
        { type: "agentMessage", id: "msg-final", phase: "final_answer", text: "Done" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Done"]);
    expect(
      result.messagesSnapshot.some(
        (message) =>
          (message as { openclawStreamFallback?: { itemId?: unknown } }).openclawStreamFallback
            ?.itemId === "msg-commentary",
      ),
    ).toBe(false);
  });

  it("mirrors commentary and tool activity in event order when timestamps collide", async () => {
    const projector = await createProjector();
    vi.spyOn(Date, "now").mockReturnValue(100);

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-before-tool", phase: "commentary", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Before the tool", "msg-before-tool"));

    projector.recordDynamicToolCall({ callId: "call-search", tool: "memory_search" });
    projector.recordDynamicToolResult({
      callId: "call-search",
      tool: "memory_search",
      success: true,
      contentItems: [{ type: "inputText", text: "found it" }],
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-after-tool", phase: "commentary", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("After the tool", "msg-after-tool"));
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-before-tool",
          phase: "commentary",
          text: "Before the tool",
        },
        {
          type: "agentMessage",
          id: "msg-after-tool",
          phase: "commentary",
          text: "After the tool",
        },
        { type: "agentMessage", id: "msg-final", phase: "final_answer", text: "Done" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const identities = result.messagesSnapshot.flatMap((message) => {
      const identity = (message as { __openclaw?: { mirrorIdentity?: unknown } })["__openclaw"]
        ?.mirrorIdentity;
      return typeof identity === "string" &&
        (identity.includes(":commentary:") || identity.includes(":tool:"))
        ? [identity]
        : [];
    });
    expect(identities).toEqual([
      `${TURN_ID}:commentary:msg-before-tool`,
      `${TURN_ID}:tool:call-search:call`,
      `${TURN_ID}:tool:call-search:result`,
      `${TURN_ID}:commentary:msg-after-tool`,
    ]);
  });

  it("does not double-deliver a commentary note echoed on the raw response lane", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    // Typed agentMessage lane streams the note, keyed by the thread item id.
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-commentary", phase: "commentary", text: "" },
      }),
    );
    await projector.handleNotification(
      agentMessageDelta("Checking the workspace", "msg-commentary"),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "Checking the workspace",
        },
      }),
    );
    // Raw response lane echoes the same note. Codex omits the message id on the
    // wire (ResponseItem::Message.id is skip_serializing), so the projector
    // synthesizes a `raw-assistant-*` id that never matches the thread item id.
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking the workspace" }],
        },
      }),
    );

    const preambles = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "preamble");

    expect(preambles.map((event) => event.data.progressText)).toEqual(["Checking the workspace"]);
    expect(preambles.every((event) => event.data.itemId === "msg-commentary")).toBe(true);
  });

  it("delivers distinct same-text commentary notes from the same lane within a turn", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    // Two separate notes that happen to share text must each be delivered.
    for (const id of ["msg-1", "msg-2"]) {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "agentMessage", id, phase: "commentary", text: "" },
        }),
      );
      await projector.handleNotification(agentMessageDelta("Checking the workspace", id));
    }

    const preambles = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "preamble");

    expect(preambles.map((event) => event.data.itemId)).toEqual(["msg-1", "msg-2"]);
    expect(preambles.map((event) => event.data.progressText)).toEqual([
      "Checking the workspace",
      "Checking the workspace",
    ]);
  });

  it("delivers a later raw-only commentary note after consuming a same-text typed echo", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });
    const rawCommentary = () =>
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking the workspace" }],
        },
      });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-commentary", phase: "commentary", text: "" },
      }),
    );
    await projector.handleNotification(
      agentMessageDelta("Checking the workspace", "msg-commentary"),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "Checking the workspace",
        },
      }),
    );
    await projector.handleNotification(rawCommentary());
    await projector.handleNotification(rawCommentary());

    const preambles = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "preamble");

    expect(preambles.map((event) => event.data.itemId)).toEqual([
      "msg-commentary",
      "raw-assistant-2",
    ]);
  });

  it("pairs a raw commentary echo after a rewritten typed completion", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-commentary", phase: "commentary", text: "" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "Contributor-rewritten note",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Original model note" }],
        },
      }),
    );

    const preambles = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "preamble");

    expect(preambles.map((event) => event.data.progressText)).toEqual([
      "Contributor-rewritten note",
    ]);
    expect(preambles.every((event) => event.data.itemId === "msg-commentary")).toBe(true);
  });

  it("clears a pending commentary echo when the raw envelope has no text", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-commentary", phase: "commentary", text: "" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: " ",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Later raw-only note" }],
        },
      }),
    );

    const preambles = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "preamble");

    expect(preambles.map((event) => event.data.progressText)).toEqual(["Later raw-only note"]);
  });

  it("does not resolve commentary-phase assistant text as the final reply", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-final",
          phase: "final_answer",
          text: "final answer",
        },
        {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "I am checking one more thing.",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["final answer"]);
  });

  it("ignores notifications for other turns", async () => {
    const projector = await createProjector();

    await projector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn-2", itemId: "msg-1", delta: "wrong" },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toStrictEqual([]);
  });

  it("ignores notifications that omit top-level thread and turn ids", async () => {
    const projector = await createProjector();

    await projector.handleNotification({
      method: "turn/completed",
      params: {
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "wrong turn" }],
        },
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toStrictEqual([]);
    expect(result.lastAssistant).toBeUndefined();
  });

  it("preserves accepted session spawns as yield continuation evidence", () => {
    const projector = new CodexAppServerEventProjector(
      {
        prompt: "hello",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.4-codex",
        model: createCodexTestModel(),
        thinkLevel: "medium",
      } as EmbeddedRunAttemptParams,
      THREAD_ID,
      TURN_ID,
    );

    const result = projector.buildResult(
      {
        ...buildEmptyToolTelemetry(),
        acceptedSessionSpawns: [
          { runId: "child-run", childSessionKey: "agent:main:subagent:child" },
        ],
      },
      { yieldDetected: true },
    );

    expect(result.yieldDetected).toBe(true);
    expect(result.acceptedSessionSpawns).toEqual([
      { runId: "child-run", childSessionKey: "agent:main:subagent:child" },
    ]);
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });
});
