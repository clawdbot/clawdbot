import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  THREAD_ID,
  TURN_ID,
  createProjector,
  buildEmptyToolTelemetry,
  createParams,
  readAttemptTerminal,
  expectUsageLimitPromptError,
  forCurrentTurn,
  agentMessageDelta,
  appServerError,
  rateLimitsUpdated,
  turnCompleted,
  turnWithStatus,
  pendingCommandStarted,
  vi,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector terminal errors", () => {
  it.each([
    { codexErrorInfo: "rateLimitExceeded", status: 429 },
    { codexErrorInfo: "serverOverloaded", status: 503, code: "OVERLOADED" },
    { codexErrorInfo: "internalServerError", status: 500 },
    ...[
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ].map((variant) => ({
      codexErrorInfo: { [variant]: { httpStatusCode: 503 } },
      status: 503,
    })),
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 404 } }, status: 404 },
  ])(
    "preserves terminal provider facts for $codexErrorInfo",
    async ({ codexErrorInfo, ...facts }) => {
      for (const method of ["error", "turn/completed"] as const) {
        const projector = await createProjector();
        const error = { message: "The model is not available.", codexErrorInfo };
        await projector.handleNotification(
          forCurrentTurn(
            method,
            method === "error"
              ? { error, willRetry: false }
              : { turn: { id: TURN_ID, status: "failed", items: [], error } },
          ),
        );
        const terminal = readAttemptTerminal(projector.buildResult(buildEmptyToolTelemetry()));
        expect(terminal.promptError).toBeInstanceOf(Error);
        expect(terminal.promptError).toMatchObject({ message: error.message, ...facts });
      }
    },
  );

  it("does not treat app-server interrupted status as a user cancellation by itself", async () => {
    const projector = await createProjector();

    await projector.handleNotification(turnWithStatus("interrupted"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      externalAbort: false,
      timedOut: false,
      promptError: null,
    });
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

    expect(readAttemptTerminal(result).aborted).toBe(false);
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
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(result.assistantTexts).toEqual([]);
  });

  it("keeps missing tool detail without overriding an explicit abort", async () => {
    const projector = await createProjector();
    projector.markAborted();

    await projector.handleNotification(pendingCommandStarted("cmd-aborted"));
    await projector.handleNotification(turnWithStatus("interrupted"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: true,
      promptError: null,
      promptErrorSource: null,
    });
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

    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      promptErrorSource: "prompt",
    });
    expect(readAttemptTerminal(result).promptError).toContain("without a matching tool.result");
    expect(result.lastToolError).toBeUndefined();
  });

  it("does not fail a completed reply after a retryable app-server error notification", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(agentMessageDelta("still working"));
    await projector.handleNotification(
      appServerError({
        message: "Rate limit reached",
        willRetry: true,
        codexErrorInfo: "rateLimitExceeded",
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "final answer" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["final answer"]);
    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: null,
      promptErrorSource: null,
    });
    expect(result.lastAssistant?.stopReason).toBe("stop");
    expect(result.lastAssistant?.errorMessage).toBeUndefined();
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "run_status",
        data: { phase: "retrying", message: "Rate limited. The provider is retrying." },
      }),
    );
  });

  it("uses nested app-server error messages for terminal errors", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      appServerError({ message: "stream failed permanently", willRetry: false }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: "stream failed permanently",
      promptErrorSource: "prompt",
    });
    expect(result.lastAssistant).toBeUndefined();
  });

  it.each([
    {
      label: "biological-risk",
      message: "This content was flagged for possible biological risk. Try rephrasing it.",
      codexErrorInfo: "other",
      category: "bio",
    },
    {
      label: "typed cyber",
      message: "This request was blocked by the provider's cyber policy.",
      codexErrorInfo: "cyberPolicy",
      category: "cyber",
    },
    {
      label: "typed misalignment",
      message: "This request was blocked due to a misalignment policy violation.",
      codexErrorInfo: "misalignmentPolicyViolation",
      category: "misalignment",
    },
  ])(
    "keeps $label refusals terminal when error is followed by failed turn completion",
    async ({ message, codexErrorInfo, category }) => {
      const projector = await createProjector();
      const error = { message, codexErrorInfo };

      await projector.handleNotification(appServerError({ ...error, willRetry: false }));
      await projector.handleNotification(
        forCurrentTurn("turn/completed", {
          turn: { id: TURN_ID, status: "failed", items: [], error },
        }),
      );

      const result = projector.buildResult(buildEmptyToolTelemetry());
      const terminalAssistant = result.currentAttemptAssistant;

      expect(readAttemptTerminal(result)).toMatchObject({
        promptError: null,
        promptErrorSource: null,
      });
      expect(terminalAssistant).toMatchObject({
        stopReason: "error",
        errorMessage: message,
        diagnostics: [
          {
            type: "provider_refusal",
            details: { provider: "openai", category },
          },
        ],
      });
      expect(result.lastAssistant).toBe(terminalAssistant);
      expect(projector.settledTurnFailureFinalizationAllowed).toBe(false);
      expect(
        result.messagesSnapshot.filter(
          (candidate) =>
            candidate.role === "assistant" &&
            candidate.diagnostics?.some((diagnostic) => diagnostic.type === "provider_refusal"),
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    { codexErrorInfo: "serverOverloaded", expected: true },
    { codexErrorInfo: "usageLimitExceeded", expected: false },
    { codexErrorInfo: "unauthorized", expected: false },
    { codexErrorInfo: "other", expected: false },
  ])(
    "projects $codexErrorInfo terminal error recovery eligibility as $expected",
    async ({ codexErrorInfo, expected }) => {
      const projector = await createProjector();

      await projector.handleNotification(
        appServerError({ message: "provider failure", willRetry: false, codexErrorInfo }),
      );

      expect(projector.settledTurnFailureFinalizationAllowed).toBe(expected);
      expect(
        readAttemptTerminal(projector.buildResult(buildEmptyToolTelemetry())).promptErrorSource,
      ).toBe("prompt");
    },
  );

  it("keeps an active native compaction failure scoped through the failed turn", async () => {
    const onAgentEvent = vi.fn();
    const onContextCompacted = vi.fn();
    const projector = await createProjector(
      { ...(await createParams()), onAgentEvent },
      { onContextCompacted },
    );

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "contextCompaction", id: "compact-failed" },
      }),
    );
    await projector.handleNotification(
      appServerError({
        message: "remote compaction failed",
        willRetry: false,
        codexErrorInfo: "other",
      }),
    );

    expect(readAttemptTerminal(projector.buildResult(buildEmptyToolTelemetry()))).toMatchObject({
      promptError: "remote compaction failed",
      promptErrorSource: "compaction",
    });
    expect(projector.settledTurnFailureFinalizationAllowed).toBe(true);

    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "failed",
          error: { message: "remote compaction failed", codexErrorInfo: "other" },
          items: [],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: "remote compaction failed",
      promptErrorSource: "compaction",
    });
    expect(projector.settledTurnFailureFinalizationAllowed).toBe(true);
    expect(projector.isCompacting()).toBe(false);
    expect(result.itemLifecycle).toEqual({ startedCount: 0, completedCount: 0, activeCount: 0 });
    expect(result.compactionCount).toBeUndefined();
    expect(onContextCompacted).not.toHaveBeenCalled();
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "compaction"),
    ).toEqual([
      {
        stream: "compaction",
        data: {
          phase: "start",
          backend: "codex-app-server",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "compact-failed",
        },
      },
      {
        stream: "compaction",
        data: {
          phase: "end",
          backend: "codex-app-server",
          completed: false,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "compact-failed",
        },
      },
    ]);
  });

  it("keeps other errors prompt-scoped after native compaction completes", async () => {
    const projector = await createProjector();
    const compaction = { item: { type: "contextCompaction", id: "compact-completed" } };

    await projector.handleNotification(forCurrentTurn("item/started", compaction));
    await projector.handleNotification(forCurrentTurn("item/completed", compaction));
    await projector.handleNotification(
      appServerError({
        message: "unrelated provider failure",
        willRetry: false,
        codexErrorInfo: "other",
      }),
    );

    expect(readAttemptTerminal(projector.buildResult(buildEmptyToolTelemetry()))).toMatchObject({
      promptError: "unrelated provider failure",
      promptErrorSource: "prompt",
    });
    expect(projector.settledTurnFailureFinalizationAllowed).toBe(false);
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

    const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(promptError.message).toContain("Wait until the reset time");
    expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
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

    const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
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

    const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
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

    const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Codex says to try again at May 11th, 2026 9:00 AM.");
    expect(promptError.message).not.toContain("Codex did not return a reset time");
    expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
  });
});
