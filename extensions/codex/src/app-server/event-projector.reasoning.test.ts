import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  THREAD_ID,
  TURN_ID,
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

function guardianWarning(message: string, threadId = THREAD_ID): ProjectorNotification {
  return { method: "guardianWarning", params: { threadId, message } } as ProjectorNotification;
}

function guardianReview(params: {
  id: string;
  status: string;
  target?: string | null;
  phase?: "started" | "completed";
  riskLevel?: string;
  userAuthorization?: string;
  rationale?: string | null;
  action?: Record<string, unknown>;
}): ProjectorNotification {
  const phase = params.phase ?? "completed";
  return forCurrentTurn(`item/autoApprovalReview/${phase}`, {
    reviewId: params.id,
    targetItemId: params.target === undefined ? "cmd-1" : params.target,
    ...(phase === "completed" ? { decisionSource: "agent" } : {}),
    review: {
      status: params.status,
      ...(params.riskLevel ? { riskLevel: params.riskLevel } : {}),
      ...(params.userAuthorization ? { userAuthorization: params.userAuthorization } : {}),
      ...(params.rationale !== undefined ? { rationale: params.rationale } : {}),
    },
    action: params.action ?? {
      type: "execve",
      source: "shell",
      program: "/bin/printf",
      argv: ["printf", "hello"],
      cwd: "/tmp",
    },
  });
}

function commandItem(phase: "started" | "completed", id = "cmd-1"): ProjectorNotification {
  const completed = phase === "completed";
  return forCurrentTurn(`item/${phase}`, {
    item: {
      type: "commandExecution",
      id,
      command: "printf hello",
      cwd: "/tmp",
      status: completed ? "completed" : "inProgress",
      commandActions: [],
      ...(completed ? { aggregatedOutput: "hello", exitCode: 0 } : {}),
    },
  });
}

describe("CodexAppServerEventProjector reasoning and guardian projection", () => {
  it("projects guardian review lifecycle details into agent events", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(commandItem("started"));
    await projector.handleNotification(
      guardianReview({ id: "review-1", status: "inProgress", phase: "started" }),
    );
    await projector.handleNotification(
      guardianWarning(
        "Automatic approval review approved (risk: low, authorization: high): Benign local probe.",
      ),
    );
    await projector.handleNotification(
      guardianReview({
        id: "review-1",
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Benign local probe.",
      }),
    );
    await projector.handleNotification(commandItem("completed"));

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.guardian",
      phase: "started",
    }).data;
    expect(started).toMatchObject({
      reviewId: "review-1",
      targetItemId: "cmd-1",
      status: "inProgress",
    });
    const completed = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.guardian",
      phase: "completed",
    }).data;
    expect(completed).toMatchObject({
      reviewId: "review-1",
      targetItemId: "cmd-1",
      status: "approved",
      command: "printf hello",
    });
    const toolReviews = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event?.stream === "tool" &&
          event.data?.phase === "review" &&
          event.data?.toolCallId === "cmd-1",
      );
    expect(toolReviews.map((event) => event.data.review)).toEqual([
      {
        id: "review-1",
        label: "Guardian",
        status: "in_progress",
      },
      {
        id: "review-1",
        label: "Guardian",
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Benign local probe.",
      },
    ]);
    expect(toolReviews[0]?.data.approvalReviewOutcome).toBe("reviewing");
    expect(toolReviews[1]?.data.approvalReviewOutcome).toBe("approved");
    expect(toolReviews.every((event) => event.data.hideFromChannelProgress === true)).toBe(true);
    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = result.messagesSnapshot.find((message) => message.role === "toolResult");
    expect(requireRecord(toolResult, "reviewed tool result").details).toMatchObject({
      approvalReviews: [{ id: "review-1", status: "approved" }],
      approvalReviewOutcome: "approved",
    });
  });

  it("correlates identical parallel routine warnings with two distinct command reviews", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const warning =
      "Automatic approval review approved (risk: low, authorization: high): Safe command.";

    for (const [index, command] of ["printf first", "printf second"].entries()) {
      const itemId = `cmd-${index + 1}`;
      await projector.handleNotification(guardianWarning(warning));
      await projector.handleNotification(
        guardianReview({
          id: `review-${index + 1}`,
          target: itemId,
          status: "approved",
          riskLevel: "low",
          userAuthorization: "high",
          rationale: "Safe command.",
          action: { type: "command", source: "shell", command, cwd: "/tmp" },
        }),
      );
    }

    const events = onAgentEvent.mock.calls.map(([event]) => event);
    expect(
      events.filter(
        (event) => event.stream === "codex_app_server.guardian" && event.data.phase === "warning",
      ),
    ).toEqual([]);
    expect(
      events
        .filter((event) => event.stream === "tool" && event.data.phase === "review")
        .map((event) => event.data.review.id),
    ).toEqual(["review-1", "review-2"]);
  });

  it("flushes routine warnings at targetless, unrelated, and projector-finalization boundaries", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const approvedWarning =
      "Automatic approval review approved (risk: low, authorization: high): Network call.";
    const deniedWarning =
      "Automatic approval review denied (risk: high, authorization: low): Unsafe command.";
    const timeoutWarning =
      "Automatic approval review timed out while evaluating the requested approval.";

    await projector.handleNotification(guardianWarning(approvedWarning));
    expect(onAgentEvent).not.toHaveBeenCalled();
    await projector.handleNotification(
      guardianReview({
        id: "review-network",
        target: null,
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Network call.",
        action: {
          type: "networkAccess",
          target: "https://example.invalid",
          host: "example.invalid",
          protocol: "https",
          port: 443,
        },
      }),
    );
    await projector.handleNotification(guardianWarning(deniedWarning));
    await projector.handleNotification(
      forCurrentTurn("item/plan/delta", { itemId: "plan-1", delta: "continue" }),
    );
    await projector.handleNotification(guardianWarning(timeoutWarning));
    projector.buildResult(buildEmptyToolTelemetry());

    const warnings = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) => event.stream === "codex_app_server.guardian" && event.data.phase === "warning",
      );
    expect(warnings.map((event) => event.data.message)).toEqual([
      approvedWarning,
      deniedWarning,
      timeoutWarning,
    ]);
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "tool" && event.data.phase === "review"),
    ).toEqual([]);
  });

  it.each([
    { firstStatus: "denied", liveOutcome: "denied", persistedOutcome: "denied" },
    { firstStatus: "inProgress", liveOutcome: "reviewing", persistedOutcome: "approved" },
  ])("bounds rows without losing a $liveOutcome aggregate", async (scenario) => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(commandItem("started", "cmd-many-reviews"));
    for (let index = 0; index < 18; index += 1) {
      const status = index === 0 ? scenario.firstStatus : "approved";
      await projector.handleNotification(
        guardianReview({
          id: `review-${index}`,
          target: "cmd-many-reviews",
          status,
          ...(status === "inProgress" ? { phase: "started" as const } : {}),
          riskLevel: status === "approved" ? "low" : "high",
          userAuthorization: status === "approved" ? "high" : "low",
          rationale: `${status} ${index}.`,
        }),
      );
    }
    const reviewEvents = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "tool" && event.data.phase === "review");
    expect(reviewEvents.at(-1)?.data.approvalReviewOutcome).toBe(scenario.liveOutcome);
    await projector.handleNotification(commandItem("completed", "cmd-many-reviews"));

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = result.messagesSnapshot.find((message) => message.role === "toolResult");
    const details = requireRecord(toolResult, "bounded review tool result").details as {
      approvalReviews: Array<{ id: string }>;
      approvalReviewOutcome: string;
    };
    expect(details.approvalReviews).toHaveLength(16);
    expect(details.approvalReviews.map((review) => review.id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `review-${index + 2}`),
    );
    expect(details.approvalReviewOutcome).toBe(scenario.persistedOutcome);
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.stream === "tool" && event.data.phase === "result")?.data
        .approvalReviewOutcome,
    ).toBe(scenario.persistedOutcome);
  });

  it.each([
    {
      status: "timedOut",
      normalizedStatus: "timed_out",
      warning: "Automatic approval review timed out while evaluating the requested approval.",
      rationale: "Automatic approval review timed out while evaluating the requested approval.",
    },
    { status: "aborted", normalizedStatus: "aborted", warning: undefined, rationale: null },
  ])("keeps a targeted $normalizedStatus review command-owned", async (terminal) => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    if (terminal.warning) {
      await projector.handleNotification(guardianWarning(terminal.warning));
    }
    await projector.handleNotification(
      guardianReview({
        id: `review-${terminal.normalizedStatus}`,
        target: "cmd-terminal",
        status: terminal.status,
        rationale: terminal.rationale,
      }),
    );

    const events = onAgentEvent.mock.calls.map(([event]) => event);
    expect(
      events.filter(
        (event) => event.stream === "codex_app_server.guardian" && event.data.phase === "warning",
      ),
    ).toEqual([]);
    expect(
      events.find((event) => event.stream === "tool" && event.data.phase === "review")?.data,
    ).toMatchObject({
      approvalReviewOutcome: "denied",
      review: { status: terminal.normalizedStatus },
    });
  });

  it("routes strict review requirements to the human-visible guardian lane", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("item/autoApprovalReview/started", {
        reviewId: "review-strict",
        targetItemId: "cmd-strict",
        review: { status: "inProgress" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("autoApprovalReview/strictReviewRequired", {
        startedAtMs: 1_787_273_600_000,
      }),
    );

    expect(
      findAgentEvent(onAgentEvent, {
        stream: "codex_app_server.guardian",
        phase: "strict_review_required",
      }).data,
    ).toMatchObject({
      method: "autoApprovalReview/strictReviewRequired",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      reviewId: "review-strict",
      targetItemId: "cmd-strict",
      startedAtMs: 1_787_273_600_000,
    });
    expect(
      projector.buildResult(buildEmptyToolTelemetry()).didSendDeterministicApprovalPrompt,
    ).toBe(false);
  });

  it("projects thread-scoped guardian warnings", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(guardianWarning("Wrong thread.", "thread-other"));
    await projector.handleNotification(
      guardianWarning("Guardian rejection limit reached; ending turn as interrupted."),
    );
    projector.buildResult(buildEmptyToolTelemetry());

    const warnings = onAgentEvent.mock.calls.map(([event]) => event.data.message);
    expect(warnings).toEqual(["Guardian rejection limit reached; ending turn as interrupted."]);
  });

  it("describes targetless network reviews using the upstream network target", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      guardianReview({
        id: "network-review",
        status: "inProgress",
        phase: "started",
        target: null,
        action: {
          type: "networkAccess",
          target: "https://api.example.test:443",
          host: "api.example.test",
          protocol: "https",
          port: 443,
        },
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.guardian",
      data: expect.objectContaining({
        phase: "started",
        reviewId: "network-review",
        targetItemId: null,
        command: "https://api.example.test:443",
      }),
    });
  });

  it("preserves Codex 0.149 strict-review correlation for its active Guardian assessment", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      guardianReview({ id: "strict-review", status: "inProgress", phase: "started" }),
    );
    await projector.handleNotification(
      forCurrentTurn("autoApprovalReview/strictReviewRequired", {
        startedAtMs: 1_787_273_600_000,
      }),
    );

    expect(
      findAgentEvent(onAgentEvent, {
        stream: "codex_app_server.guardian",
        phase: "strict_review_required",
      }).data,
    ).toMatchObject({
      reviewId: "strict-review",
      targetItemId: "cmd-1",
      command: "printf hello",
      startedAtMs: 1_787_273_600_000,
    });
  });

  it("surfaces startup and thread warnings without requiring an upstream turn id", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification({
      method: "configWarning",
      params: {
        summary: "Error parsing rules; custom rules not applied.",
        details: "rules.toml: unexpected token",
      },
    });
    await projector.handleNotification({
      method: "warning",
      params: { threadId: THREAD_ID, message: "Project hooks were disabled." },
    });
    await projector.handleNotification({
      method: "warning",
      params: { threadId: "another-thread", message: "Other session warning." },
    });

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        stream: "notice",
        data: {
          phase: "warning",
          message: "Error parsing rules; custom rules not applied.\nrules.toml: unexpected token",
        },
      },
      {
        stream: "notice",
        data: { phase: "warning", message: "Project hooks were disabled." },
      },
    ]);
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
    expect(result.toolMetas).toEqual([{ toolName: "sessions_send", isError: false }]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(result.messagesSnapshot[1])).toContain("Codex reasoning");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("Codex plan:");
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
