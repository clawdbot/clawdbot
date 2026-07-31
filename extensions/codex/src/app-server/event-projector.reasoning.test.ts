import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  THREAD_ID,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  findAgentEvent,
  findPlanEventWithSteps,
  forCurrentTurn,
  turnCompleted,
  type ProjectorNotification,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector reasoning and guardian projection", () => {
  it("projects guardian review lifecycle details into agent events", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("item/autoApprovalReview/started", {
        reviewId: "review-1",
        targetItemId: "cmd-1",
        review: { status: "inProgress" },
        action: {
          type: "execve",
          source: "shell",
          program: "/bin/printf",
          argv: ["printf", "hello"],
          cwd: "/tmp",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/autoApprovalReview/completed", {
        reviewId: "review-1",
        targetItemId: "cmd-1",
        decisionSource: "agent",
        review: {
          status: "approved",
          riskLevel: "low",
          userAuthorization: "high",
          rationale: "Benign local probe.",
        },
        action: {
          type: "execve",
          source: "shell",
          program: "/bin/printf",
          argv: ["printf", "hello"],
          cwd: "/tmp",
        },
      }),
    );

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.guardian",
      phase: "started",
    }).data;
    expect(started.reviewId).toBe("review-1");
    expect(started.targetItemId).toBe("cmd-1");
    expect(started.status).toBe("inProgress");
    expect(started.actionType).toBe("execve");
    const completed = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.guardian",
      phase: "completed",
    }).data;
    expect(completed.reviewId).toBe("review-1");
    expect(completed.targetItemId).toBe("cmd-1");
    expect(completed.decisionSource).toBe("agent");
    expect(completed.status).toBe("approved");
    expect(completed.riskLevel).toBe("low");
    expect(completed.userAuthorization).toBe("high");
    expect(completed.rationale).toBe("Benign local probe.");
    expect(completed.actionType).toBe("execve");
    expect(
      projector.buildResult(buildEmptyToolTelemetry()).didSendDeterministicApprovalPrompt,
    ).toBe(false);
  });

  it("projects thread-scoped guardian warnings", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification({
      method: "guardianWarning",
      params: { threadId: "thread-other", message: "Wrong thread." },
    } as ProjectorNotification);
    await projector.handleNotification({
      method: "guardianWarning",
      params: {
        threadId: THREAD_ID,
        message: "Guardian rejection limit reached; ending turn as interrupted.",
      },
    } as ProjectorNotification);

    const warning = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.guardian",
      phase: "warning",
    }).data;
    expect(warning.message).toBe("Guardian rejection limit reached; ending turn as interrupted.");
    expect(onAgentEvent).toHaveBeenCalledTimes(1);
  });

  it("projects reasoning end, plan updates, compaction state, and tool metadata", async () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();
    const onAgentEvent = vi.fn();
    const params = {
      ...(await createParams()),
      onReasoningStream,
      onReasoningEnd,
      onAgentEvent,
    };
    const onContextCompacted = vi.fn();
    const projector = await createProjector(params, { onContextCompacted });

    await projector.handleNotification(
      forCurrentTurn("item/reasoning/textDelta", { itemId: "reason-1", delta: "thinking" }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/plan/delta", { itemId: "plan-1", delta: "- inspect\n" }),
    );
    await projector.handleNotification(
      forCurrentTurn("turn/plan/updated", {
        explanation: "next",
        plan: [{ step: "patch", status: "inProgress" }],
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    expect(projector.isCompacting()).toBe(true);
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    expect(projector.isCompacting()).toBe(false);
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          tool: "sessions_send",
          status: "completed",
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onReasoningStream).toHaveBeenCalledWith({
      text: "thinking",
      isReasoningSnapshot: true,
    });
    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
    expect(
      findPlanEventWithSteps(onAgentEvent, [{ step: "inspect", status: "pending" }]).steps,
    ).toEqual([{ step: "inspect", status: "pending" }]);
    expect(
      findPlanEventWithSteps(onAgentEvent, [{ step: "patch", status: "in_progress" }]).steps,
    ).toEqual([{ step: "patch", status: "in_progress" }]);
    expect(findAgentEvent(onAgentEvent, { stream: "compaction", phase: "start" }).data.itemId).toBe(
      "compact-1",
    );
    expect(findAgentEvent(onAgentEvent, { stream: "compaction", phase: "end" }).data).toMatchObject(
      {
        itemId: "compact-1",
        completed: true,
      },
    );
    expect(result.toolMetas).toEqual([{ toolName: "sessions_send" }]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(JSON.stringify(result.messagesSnapshot[1])).toContain("Codex reasoning");
    expect(JSON.stringify(result.messagesSnapshot[2])).toContain("Codex plan");
    expect(JSON.stringify(result.messagesSnapshot[2])).toContain("next");
    expect(JSON.stringify(result.messagesSnapshot[2])).toContain("[in_progress] patch");
    expect(result.compactionCount).toBe(1);
    expect(requireRecord(result.itemLifecycle, "item lifecycle")).not.toHaveProperty(
      "compactionCount",
    );
    expect(onContextCompacted).toHaveBeenCalledOnce();
  });

  it("streams accumulated reasoning snapshots grouped by Codex reasoning indexes", async () => {
    const onReasoningStream = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onReasoningStream,
    });

    await projector.handleNotification(
      forCurrentTurn("item/reasoning/textDelta", {
        itemId: "reason-1",
        contentIndex: 1,
        delta: "Checking ",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/reasoning/textDelta", {
        itemId: "reason-1",
        contentIndex: 0,
        delta: "Reading ",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/reasoning/textDelta", {
        itemId: "reason-1",
        contentIndex: 0,
        delta: "files",
      }),
    );

    expect(onReasoningStream).toHaveBeenCalledTimes(3);
    expect(onReasoningStream).toHaveBeenNthCalledWith(1, {
      text: "Checking ",
      isReasoningSnapshot: true,
    });
    expect(onReasoningStream).toHaveBeenNthCalledWith(2, {
      text: "Reading \n\nChecking ",
      isReasoningSnapshot: true,
    });
    expect(onReasoningStream).toHaveBeenNthCalledWith(3, {
      text: "Reading files\n\nChecking ",
      isReasoningSnapshot: true,
    });
  });

  it("streams accumulated reasoning summaries grouped by summary section", async () => {
    const onReasoningStream = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onReasoningStream,
    });

    await projector.handleNotification(
      forCurrentTurn("item/reasoning/summaryTextDelta", {
        itemId: "reason-1",
        summaryIndex: 1,
        delta: "Second",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/reasoning/summaryTextDelta", {
        itemId: "reason-1",
        summaryIndex: 0,
        delta: "First ",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/reasoning/summaryTextDelta", {
        itemId: "reason-1",
        summaryIndex: 0,
        delta: "section",
      }),
    );

    expect(onReasoningStream).toHaveBeenCalledTimes(3);
    expect(onReasoningStream).toHaveBeenNthCalledWith(1, {
      text: "Second",
      isReasoningSnapshot: true,
    });
    expect(onReasoningStream).toHaveBeenNthCalledWith(2, {
      text: "First \n\nSecond",
      isReasoningSnapshot: true,
    });
    expect(onReasoningStream).toHaveBeenNthCalledWith(3, {
      text: "First section\n\nSecond",
      isReasoningSnapshot: true,
    });
  });
});
