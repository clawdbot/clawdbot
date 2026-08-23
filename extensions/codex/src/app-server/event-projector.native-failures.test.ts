import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  vi,
  createCodexTestToolTerminalObserver,
  flushDiagnosticEvents,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  forCurrentTurn,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector native tool failure recovery", () => {
  it("orders declined native tool diagnostics after their start event", async () => {
    const observeToolTerminal = vi.fn(createCodexTestToolTerminalObserver());
    const projector = await createProjector({
      ...(await createParams()),
      observeToolTerminal,
    });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: {
            type: "commandExecution",
            id: "cmd-declined",
            command: "pnpm test extensions/codex",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "commandExecution",
            id: "cmd-declined",
            command: "pnpm test extensions/codex",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "declined",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: 1,
          },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const toolDiagnosticEvents = diagnosticEvents.filter(
      (
        event,
      ): event is Extract<
        DiagnosticEventPayload,
        {
          type:
            | "tool.execution.started"
            | "tool.execution.completed"
            | "tool.execution.error"
            | "tool.execution.blocked";
        }
      > => event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "bash",
        toolCallId: "cmd-declined",
      },
      {
        type: "tool.execution.blocked",
        toolName: "bash",
        toolCallId: "cmd-declined",
      },
    ]);
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "codex native tool blocked",
      mutatingAction: false,
    });
    expect(observeToolTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        executionStarted: false,
        nativeMutation: { mutatingAction: false, replaySafe: true },
        outcome: "failure",
      }),
    );
  });

  it.each(["failed", "cancelled", "timed_out"] as const)(
    "projects a declined native approval with %s disposition as one terminal error",
    async (disposition) => {
      const projector = await createProjector();
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", {
            item: {
              type: "commandExecution",
              id: "cmd-approval-failure",
              command: "pnpm test extensions/codex",
              cwd: "/workspace",
              processId: null,
              source: "agent",
              status: "inProgress",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          }),
        );
        projector.recordNativeToolApprovalFailure("cmd-approval-failure", disposition);
        await projector.handleNotification(
          forCurrentTurn("item/completed", {
            item: {
              type: "commandExecution",
              id: "cmd-approval-failure",
              command: "pnpm test extensions/codex",
              cwd: "/workspace",
              processId: null,
              source: "agent",
              status: "declined",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: 1,
            },
          }),
        );
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(
        diagnosticEvents
          .filter((event) => event.type.startsWith("tool.execution."))
          .map((event) =>
            "terminalReason" in event
              ? { type: event.type, terminalReason: event.terminalReason }
              : { type: event.type },
          ),
      ).toEqual([
        { type: "tool.execution.started" },
        { type: "tool.execution.error", terminalReason: disposition },
      ]);
    },
  );

  it("coalesces a native pre-tool failure with the matching item terminal", async () => {
    const projector = await createProjector();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
    const item = {
      type: "commandExecution" as const,
      id: "cmd-pre-tool-failure",
      command: "pnpm test extensions/codex",
      cwd: "/workspace",
      processId: null,
      source: "agent" as const,
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
    };

    try {
      projector.recordNativeToolPreToolUseFailure({
        toolName: "exec",
        toolCallId: item.id,
        disposition: "timed_out",
        durationMs: 5,
      });
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { ...item, status: "inProgress", durationMs: null },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: { ...item, status: "declined", durationMs: 7 },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    expect(
      diagnosticEvents
        .filter(
          (event) =>
            event.type.startsWith("tool.execution.") &&
            "toolCallId" in event &&
            event.toolCallId === item.id,
        )
        .map((event) =>
          event.type === "tool.execution.error"
            ? {
                type: event.type,
                toolName: event.toolName,
                durationMs: event.durationMs,
                errorCategory: event.errorCategory,
                terminalReason: event.terminalReason,
              }
            : {
                type: event.type,
                toolName: "toolName" in event ? event.toolName : undefined,
              },
        ),
    ).toEqual([
      { type: "tool.execution.started", toolName: "bash" },
      {
        type: "tool.execution.error",
        toolName: "bash",
        durationMs: 7,
        errorCategory: "before_tool_call",
        terminalReason: "timed_out",
      },
    ]);
  });

  it("finalizes a native pre-tool failure when no item arrives", async () => {
    const runAbortController = new AbortController();
    const projector = await createProjector(undefined, {
      runAbortSignal: runAbortController.signal,
    });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      projector.recordNativeToolPreToolUseFailure({
        toolName: "exec",
        toolCallId: "native-no-item",
        disposition: "failed",
        durationMs: 5,
      });
      runAbortController.abort("codex_side_question_finished");
      projector.buildResult(buildEmptyToolTelemetry());
      projector.recordNativeToolPreToolUseFailure({
        toolName: "exec",
        toolCallId: "native-late-no-item",
        disposition: "failed",
        durationMs: 6,
      });
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    expect(
      diagnosticEvents.filter(
        (event) =>
          event.type.startsWith("tool.execution.") &&
          "toolCallId" in event &&
          (event.toolCallId === "native-no-item" || event.toolCallId === "native-late-no-item"),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "tool.execution.error",
        toolName: "exec",
        toolCallId: "native-no-item",
        durationMs: 5,
        errorCategory: "before_tool_call",
        terminalReason: "failed",
      }),
      expect.objectContaining({
        type: "tool.execution.error",
        toolName: "exec",
        toolCallId: "native-late-no-item",
        durationMs: 6,
        errorCategory: "before_tool_call",
        terminalReason: "cancelled",
      }),
    ]);
  });

  it("clears a recovered declined native tool error", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-declined",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "declined",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: 1,
        },
      }),
    );
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "codex native tool blocked",
      mutatingAction: false,
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-recovered",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
  });

  it("preserves distinct native mutation failures when only one action recovers", async () => {
    const observeToolTerminal = vi.fn(createCodexTestToolTerminalObserver());
    const projector = await createProjector({
      ...(await createParams()),
      observeToolTerminal,
    });
    const commandItem = (
      id: string,
      command: string,
      status: "completed" | "failed",
      output: string,
      exitCode: number,
    ) => ({
      type: "commandExecution",
      id,
      command,
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status,
      commandActions: [],
      aggregatedOutput: output,
      exitCode,
      durationMs: 1,
    });
    const firstCommand = "node scripts/first.js --publish";
    const secondCommand = "node scripts/second.js --publish";

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: commandItem("cmd-first-failed", firstCommand, "failed", "first failed", 1),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: commandItem("cmd-second-failed", secondCommand, "failed", "second failed", 1),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: commandItem("cmd-second-recovered", secondCommand, "completed", "ok", 0),
      }),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toMatchObject({
      toolName: "bash",
      error: "first failed",
      actionFingerprint: expect.stringContaining(firstCommand),
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: commandItem("cmd-first-recovered", firstCommand, "completed", "ok", 0),
      }),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
    expect(observeToolTerminal).toHaveBeenCalledTimes(4);
  });

  it("clears a declined pre-execution error after a later successful action", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-declined",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "declined",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: 1,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-unrelated-success",
          command: "pnpm test src/foo.test.ts",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
  });
});
