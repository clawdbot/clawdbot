import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  TURN_ID,
  createProjector,
  buildEmptyToolTelemetry,
  expectUsageLimitPromptError,
  forCurrentTurn,
  agentMessageDelta,
  appServerError,
  rateLimitsUpdated,
  turnCompleted,
  turnWithStatus,
  pendingCommandStarted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector terminal errors", () => {
  it("does not treat app-server interrupted status as a user cancellation by itself", async () => {
    const projector = await createProjector();

    await projector.handleNotification(turnWithStatus("interrupted"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.aborted).toBe(false);
    expect(result.externalAbort).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
  });

  it("keeps sparse successful bash output eligible for the no-visible-answer guard", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      turnWithStatus("interrupted", [
        {
          type: "commandExecution",
          id: "cmd-empty-output",
          command:
            "ps -eo pid,ppid,stat,cmd | rg 'venv-roadmap|pytest|run_security_contract_validation|validate_public_install|git push|apply_patch' || true",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "",
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.aborted).toBe(false);
    expect(result.assistantTexts).toEqual([]);
    expect(result.toolMetas).toEqual([
      expect.objectContaining({ toolName: "bash", meta: expect.stringContaining("workspace") }),
    ]);
  });

  it("marks every failed tool in a multi-call turn", async () => {
    const projector = await createProjector();
    const commandItem = (id: string, status: "completed" | "failed", exitCode: number) => ({
      type: "commandExecution",
      id,
      command: `/bin/bash -lc 'exit ${exitCode}'`,
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status,
      commandActions: [],
      aggregatedOutput: "",
      exitCode,
      durationMs: 10,
    });

    await projector.handleNotification(
      turnCompleted([
        commandItem("cmd-failed-1", "failed", 1),
        commandItem("cmd-failed-2", "failed", 2),
        commandItem("cmd-success", "completed", 0),
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMetas).toHaveLength(3);
    expect(result.toolMetas.filter((meta) => meta.isError === true)).toHaveLength(2);
  });

  it("keeps explicit cancellation marked aborted for interrupted tool-only turns", async () => {
    const projector = await createProjector();
    projector.markAborted();

    await projector.handleNotification(
      turnWithStatus("interrupted", [
        {
          type: "commandExecution",
          id: "cmd-cancelled",
          command: "/bin/bash -lc true",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "",
          exitCode: 0,
          durationMs: 12,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.aborted).toBe(true);
    expect(result.assistantTexts).toEqual([]);
  });

  it("keeps missing tool detail without overriding an explicit abort", async () => {
    const projector = await createProjector();
    projector.markAborted();

    await projector.handleNotification(pendingCommandStarted("cmd-aborted"));
    await projector.handleNotification(turnWithStatus("interrupted"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.aborted).toBe(true);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.lastToolError).toMatchObject({
      toolName: "bash",
      error: expect.stringContaining("without a matching tool.result"),
    });
  });

  it("fails closed when interrupted status has no abort marker", async () => {
    const projector = await createProjector();

    await projector.handleNotification(pendingCommandStarted("cmd-interrupted"));
    await projector.handleNotification(turnWithStatus("interrupted"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.aborted).toBe(false);
    expect(result.promptError).toContain("without a matching tool.result");
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.lastToolError).toBeUndefined();
  });

  it("does not fail a completed reply after a retryable app-server error notification", async () => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("still working"));
    await projector.handleNotification(
      appServerError({ message: "stream disconnected", willRetry: true }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "final answer" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["final answer"]);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.lastAssistant?.stopReason).toBe("stop");
    expect(result.lastAssistant?.errorMessage).toBeUndefined();
  });

  it("uses nested app-server error messages for terminal errors", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      appServerError({ message: "stream failed permanently", willRetry: false }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.promptError).toBe("stream failed permanently");
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.lastAssistant).toBeUndefined();
  });

  it("uses Codex rate-limit resets for usage-limit app-server errors", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const projector = await createProjector(undefined, {
      readRecentRateLimits: () => rateLimitsUpdated(resetsAt).params,
    });

    await projector.handleNotification(
      forCurrentTurn("error", {
        error: {
          message: "You've reached your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        },
        willRetry: false,
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    const promptError = expectUsageLimitPromptError(result.promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(promptError.message).toContain("Wait until the reset time");
    expect(result.promptErrorSource).toBe("prompt");
  });

  it("uses Codex rate-limit resets for failed turns", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const projector = await createProjector(undefined, {
      readRecentRateLimits: () => rateLimitsUpdated(resetsAt).params,
    });

    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
          items: [],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    const promptError = expectUsageLimitPromptError(result.promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(result.promptErrorSource).toBe("prompt");
  });

  it("uses a recent Codex rate-limit snapshot when failed turns omit reset details", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
      rateLimitsByLimitId: null,
    };
    const projector = await createProjector(undefined, {
      readRecentRateLimits: () => rateLimits,
    });

    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
          items: [],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    const promptError = expectUsageLimitPromptError(result.promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(result.promptErrorSource).toBe("prompt");
  });

  it("preserves Codex retry hints when failed turns omit structured reset details", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "failed",
          error: {
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 11th, 2026 9:00 AM.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
          items: [],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    const promptError = expectUsageLimitPromptError(result.promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Codex says to try again at May 11th, 2026 9:00 AM.");
    expect(promptError.message).not.toContain("Codex did not return a reset time");
    expect(result.promptErrorSource).toBe("prompt");
  });
});
