import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  vi,
  THREAD_ID,
  flushDiagnosticEvents,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  findAgentEvent,
  forCurrentTurn,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector native tool audit projection", () => {
  it("synthesizes normalized tool progress for Codex-native tool items", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          startedAtMs: 1_750_000_000_000,
          item: {
            type: "commandExecution",
            id: "cmd-1",
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
          completedAtMs: 1_750_000_000_042,
          item: {
            type: "commandExecution",
            id: "cmd-1",
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
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const itemStart = findAgentEvent(onAgentEvent, {
      stream: "item",
      phase: "start",
      itemId: "cmd-1",
    }).data;
    expect(itemStart.kind).toBe("command");
    expect(itemStart.name).toBe("bash");
    expect(itemStart.suppressChannelProgress).toBe(true);
    const toolStart = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "start",
      itemId: "cmd-1",
      name: "bash",
    }).data;
    expect(toolStart.toolCallId).toBe("cmd-1");
    expect(toolStart.args).toEqual({ command: "pnpm test extensions/codex", cwd: "/workspace" });
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-1",
      name: "bash",
    }).data;
    expect(toolResult.toolCallId).toBe("cmd-1");
    expect(toolResult.status).toBe("completed");
    expect(toolResult.isError).toBe(false);
    const toolResultPayload = requireRecord(toolResult.result, "tool result payload");
    expect(toolResultPayload.exitCode).toBe(0);
    expect(toolResultPayload.durationMs).toBe(42);
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
        durationMs: "durationMs" in event ? event.durationMs : undefined,
        sourceTimestampMs: event.sourceTimestampMs,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "bash",
        toolCallId: "cmd-1",
        durationMs: undefined,
        sourceTimestampMs: 1_750_000_000_000,
      },
      {
        type: "tool.execution.completed",
        toolName: "bash",
        toolCallId: "cmd-1",
        durationMs: 42,
        sourceTimestampMs: 1_750_000_000_042,
      },
    ]);
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    expect(assistant.role).toBe("assistant");
    const assistantContent = requireArray(assistant.content, "assistant content");
    expect(assistantContent[0]).toEqual({
      type: "toolCall",
      id: "cmd-1",
      name: "bash",
      arguments: { command: "pnpm test extensions/codex", cwd: "/workspace" },
      input: { command: "pnpm test extensions/codex", cwd: "/workspace" },
    });
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage.role).toBe("toolResult");
    expect(toolResultMessage.toolCallId).toBe("cmd-1");
    expect(toolResultMessage.toolName).toBe("bash");
    expect(toolResultMessage.isError).toBe(false);
    const toolResultContent = requireArray(toolResultMessage.content, "tool result content");
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.type).toBe("toolResult");
    expect(toolResultContentItem.id).toBe("cmd-1");
    expect(toolResultContentItem.name).toBe("bash");
    expect(toolResultContentItem.toolName).toBe("bash");
    expect(toolResultContentItem.toolCallId).toBe("cmd-1");
    expect(toolResultContentItem.content).toBe("ok");
  });

  it("preserves structured file-change diffs in mirrored transcript calls", async () => {
    const projector = await createProjector();
    const changes = [
      {
        path: "src/updated.ts",
        kind: { type: "update", move_path: null },
        diff: [
          "--- a/src/updated.ts",
          "+++ b/src/updated.ts",
          "@@ -1 +1,2 @@",
          "-old",
          "+new",
          "+another",
          "",
        ].join("\n"),
      },
      {
        path: "src/created.ts",
        kind: { type: "add" },
        diff: "first\nsecond\n",
      },
      {
        path: "src/deleted.ts",
        kind: { type: "delete" },
        diff: "removed\n",
      },
    ];

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-structured",
          changes,
          status: "completed",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    const assistantContent = requireArray(assistant.content, "assistant content");
    const toolCall = requireRecord(assistantContent[0], "file-change tool call");
    const expectedChanges = [
      { ...changes[0], stat: { added: 2, removed: 1 } },
      { ...changes[1], stat: { added: 2, removed: 0 } },
      { ...changes[2], stat: { added: 0, removed: 1 } },
    ];
    expect(toolCall.name).toBe("apply_patch");
    expect(toolCall.arguments).toEqual({ changes: expectedChanges });
    expect(toolCall.input).toEqual({ changes: expectedChanges });
  });

  it.each([
    {
      label: "successful patch output after its native item",
      status: "completed",
      output: "Successfully applied patch to runtime-tool-fixture-patch.txt",
      outputFirst: false,
      isError: false,
    },
    {
      label: "successful patch output before its native item",
      status: "completed",
      output: "Successfully applied patch to runtime-tool-fixture-patch.txt",
      outputFirst: true,
      isError: false,
    },
    {
      label: "workspace rejection after its native item",
      status: "declined",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      outputFirst: false,
      isError: true,
    },
    {
      label: "workspace rejection before its native item",
      status: "declined",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      outputFirst: true,
      isError: true,
    },
    {
      label: "JSON-function patch success before its native item",
      status: "completed",
      output: "Successfully applied patch to runtime-tool-fixture-patch.txt",
      outputFirst: true,
      isError: false,
      functionCall: true,
    },
    {
      label: "JSON-function workspace rejection before its native item",
      status: "declined",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      outputFirst: true,
      isError: true,
      functionCall: true,
    },
    {
      label: "JSON-function workspace rejection without a native FileChange item",
      status: "declined",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      outputFirst: true,
      isError: true,
      functionCall: true,
      omitNativeItem: true,
    },
    {
      label: "intercepted exec-command patch success before its native FileChange item",
      status: "completed",
      output: "Successfully applied patch to runtime-tool-fixture-patch.txt",
      outputFirst: true,
      isError: false,
      functionCall: true,
      execCommand: true,
    },
    {
      label: "intercepted exec-command workspace rejection without a native FileChange item",
      status: "declined",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      outputFirst: true,
      isError: true,
      functionCall: true,
      execCommand: true,
      omitNativeItem: true,
    },
    {
      label:
        "intercepted cd-prefixed exec-command workspace rejection without a native FileChange item",
      status: "declined",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      outputFirst: true,
      isError: true,
      functionCall: true,
      execCommand: true,
      workingDirectoryPrefix: true,
      omitNativeItem: true,
    },
    {
      label: "workdir-scoped exec-command workspace rejection without a native FileChange item",
      status: "declined",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      outputFirst: true,
      isError: true,
      functionCall: true,
      execCommand: true,
      executionWorkdir: "/repo/subdir",
      omitNativeItem: true,
    },
    {
      label: "code-mode native workspace rejection without a FileChange item",
      status: "declined",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      outputFirst: true,
      isError: true,
      codeMode: true,
      omitNativeItem: true,
    },
    {
      label: "code-mode native invalid patch without a FileChange item",
      status: "failed",
      output: "apply_patch verification failed: failed to find expected lines",
      outputFirst: true,
      isError: true,
      codeMode: true,
      omitNativeItem: true,
    },
  ])("persists the linked Codex raw $label", async (testCase) => {
    const projector = await createProjector();
    const callId = "native-patch-raw-result";
    const patchInput =
      "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n+*** End Patch\n*** End Patch\n";

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "functionCall" in testCase ? "function_call" : "custom_tool_call",
          call_id: callId,
          name:
            "codeMode" in testCase
              ? "exec"
              : "execCommand" in testCase
                ? "exec_command"
                : "apply_patch",
          ...("functionCall" in testCase
            ? {
                arguments: JSON.stringify(
                  "execCommand" in testCase
                    ? {
                        cmd: `${"workingDirectoryPrefix" in testCase ? "cd /workspace && " : ""}apply_patch <<'PATCH'\n${patchInput}PATCH\n`,
                        ...("executionWorkdir" in testCase
                          ? { workdir: testCase.executionWorkdir }
                          : {}),
                      }
                    : { input: patchInput },
                ),
              }
            : {
                input:
                  "codeMode" in testCase
                    ? `const result = await tools.apply_patch(${JSON.stringify(patchInput)});\ntext(result);\n`
                    : patchInput,
              }),
        },
      }),
    );

    const completed = forCurrentTurn("item/completed", {
      item: {
        type: "fileChange",
        id: callId,
        changes: [{ path: "runtime-tool-fixture-patch.txt", kind: { type: "add" } }],
        status: testCase.status,
      },
    });
    const rawOutput = forCurrentTurn("rawResponseItem/completed", {
      item: {
        type: "functionCall" in testCase ? "function_call_output" : "custom_tool_call_output",
        call_id: callId,
        output:
          "codeMode" in testCase
            ? [
                {
                  type: "input_text",
                  text: `Script ${testCase.isError ? "failed" : "completed"}\nWall time 6.0 seconds\nOutput:\n`,
                },
                {
                  type: "input_text",
                  text: testCase.isError ? `Script error:\n${testCase.output}` : testCase.output,
                },
              ]
            : testCase.output,
      },
    });
    const notifications =
      "omitNativeItem" in testCase
        ? [rawOutput]
        : testCase.outputFirst
          ? [rawOutput, completed]
          : [completed, rawOutput];
    for (const notification of notifications) {
      await projector.handleNotification(notification);
    }

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const assistant = requireRecord(result.messagesSnapshot[1], "native patch call");
    const call = requireRecord(requireArray(assistant.content, "native patch content")[0], "call");
    expect(call).toMatchObject({
      type: "toolCall",
      id: callId,
      name: "apply_patch",
      arguments: {
        input: patchInput,
        ...("workingDirectoryPrefix" in testCase
          ? { cwd: "/workspace" }
          : "executionWorkdir" in testCase
            ? { cwd: testCase.executionWorkdir }
            : {}),
      },
    });
    const toolResult = requireRecord(result.messagesSnapshot[2], "native patch result");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      toolName: "apply_patch",
      isError: testCase.isError,
    });
    const output = requireRecord(
      requireArray(toolResult.content, "native patch result")[0],
      "result",
    );
    expect(output.content).toBe(testCase.output);
  });

  it("does not double-count a successful code-mode patch and its canonical FileChange", async () => {
    const projector = await createProjector();
    const outerCallId = "code-mode-patch-exec";
    const nativeCallId = "code-mode-patch-file-change";
    const patchInput =
      "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n";

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call",
          call_id: outerCallId,
          name: "exec",
          input: `const result = await tools.apply_patch(${JSON.stringify(patchInput)});\ntext(result);\n`,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: nativeCallId,
          changes: [{ path: "runtime-tool-fixture-patch.txt", kind: { type: "add" } }],
          status: "completed",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: outerCallId,
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 6.0 seconds\nOutput:\n",
            },
            { type: "input_text", text: "{}" },
          ],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const patchCalls = result.messagesSnapshot.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return [];
      }
      return message.content.filter(
        (block) => block.type === "toolCall" && "name" in block && block.name === "apply_patch",
      );
    });
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({ id: nativeCallId, name: "apply_patch" });
    expect(
      result.messagesSnapshot.some(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === outerCallId,
      ),
    ).toBe(false);
  });

  it("does not classify an unrecognized raw patch failure as a success", async () => {
    const projector = await createProjector();
    const callId = "native-patch-unrecognized-failure";
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call",
          call_id: callId,
          name: "apply_patch",
          input: "*** Begin Patch\n*** Add File: broken.txt\n+broken\n*** End Patch\n",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: callId,
          output: "apply_patch failed: invalid patch",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = requireRecord(result.messagesSnapshot[2], "unresolved native patch result");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      toolName: "apply_patch",
      isError: true,
    });
  });

  it.each([
    {
      label: "patch text quoted inside a shell heredoc",
      command:
        "cat <<'TEXT'\napply_patch is documented below\n*** Begin Patch\n*** Add File: fake.txt\n+not a patch invocation\n*** End Patch\nTEXT\n",
    },
    {
      label: "a nested apply_patch heredoc",
      command:
        "cat <<'OUTER'\napply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: fake.txt\n+not a patch invocation\n*** End Patch\nPATCH\nOUTER\n",
    },
    {
      label: "a user-created absolute-path executable",
      command:
        "/workspace/fake/apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: fake.txt\n+not a native patch invocation\n*** End Patch\nPATCH\n",
    },
    {
      label: "an expanding unquoted patch delimiter",
      command:
        "apply_patch <<PATCH\n*** Begin Patch\n*** Add File: fake.txt\n+$(touch /tmp/not-a-native-patch)\n*** End Patch\nPATCH\n",
    },
    {
      label: "an expanding working-directory operand",
      command:
        "cd $(touch /tmp/not-a-native-patch) && apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: fake.txt\n+not a native patch invocation\n*** End Patch\nPATCH\n",
    },
  ])("does not mistake $label for a native patch", async ({ command }) => {
    const projector = await createProjector();
    const callId = "not-a-native-patch";

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "function_call",
          call_id: callId,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: command }),
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "function_call_output",
          call_id: callId,
          output:
            "patch rejected: writing outside of the project; rejected by user approval settings",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(
      result.messagesSnapshot.some(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === callId,
      ),
    ).toBe(false);
  });

  it.each([
    {
      label: "an extra executable code-mode call",
      source:
        'const result = await tools.apply_patch("*** Begin Patch\\n*** Add File: fake.txt\\n+x\\n*** End Patch");\nawait tools.exec_command({cmd:"touch /tmp/not-a-native-patch"});\ntext(result);\n',
    },
    {
      label: "a dynamically interpolated code-mode patch",
      source:
        "const result = await tools.apply_patch(`*** Begin Patch\\n${patch}\\n*** End Patch`);\ntext(result);\n",
    },
    {
      label: "a mismatched code-mode output variable",
      source:
        'const result = await tools.apply_patch("*** Begin Patch\\n*** Add File: fake.txt\\n+x\\n*** End Patch");\ntext(other);\n',
    },
  ])("does not mistake $label for an isolated native patch", async ({ source }) => {
    const projector = await createProjector();
    const callId = "not-an-isolated-code-mode-patch";

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: { type: "custom_tool_call", call_id: callId, name: "exec", input: source },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: callId,
          output: [
            { type: "input_text", text: "Script failed\nWall time 6.0 seconds\nOutput:\n" },
            {
              type: "input_text",
              text: "Script error:\npatch rejected: writing outside of the project; rejected by user approval settings",
            },
          ],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(
      result.messagesSnapshot.some(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === callId,
      ),
    ).toBe(false);
  });

  it("does not infer a patch rejection from a successful path named denied", async () => {
    const projector = await createProjector();
    const callId = "successful-patch-path-named-denied";

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call",
          call_id: callId,
          name: "apply_patch",
          input:
            "*** Begin Patch\n*** Add File: denied.txt\n+not a rejected patch\n*** End Patch\n",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: callId,
          output: "Successfully applied patch to denied.txt",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = requireRecord(result.messagesSnapshot[2], "unresolved native patch result");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      toolName: "apply_patch",
      isError: true,
    });
  });

  it("bounds mirrored file-change diffs without losing full stats", async () => {
    const diff = [
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -1 +1,200 @@",
      "-old",
      ...Array.from({ length: 200 }, (_, index) => `+${index}-${"x".repeat(96)}`),
      "",
    ].join("\n");
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-large",
          changes: [{ path: "src/large.ts", kind: { type: "update" }, diff }],
          status: "completed",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    const assistantContent = requireArray(assistant.content, "assistant content");
    const toolCall = requireRecord(assistantContent[0], "file-change tool call");
    const args = requireRecord(toolCall.arguments, "file-change arguments");
    const projectedChanges = requireArray(args.changes, "projected file changes");
    const projectedChange = requireRecord(projectedChanges[0], "projected file change");
    const projectedDiff = projectedChange.diff;
    expect(typeof projectedDiff).toBe("string");
    if (typeof projectedDiff !== "string") {
      throw new Error("Expected bounded file-change diff");
    }
    expect(projectedDiff.length).toBeLessThanOrEqual(12_000);
    expect(projectedDiff.endsWith("\n")).toBe(true);
    expect(diff.startsWith(projectedDiff)).toBe(true);
    expect(projectedChange.diffTruncated).toBe(true);
    expect(projectedChange.stat).toEqual({ added: 200, removed: 1 });
  });

  it.each([
    ["cancelled", "cancelled"],
    [Object.assign(new Error("turn timed out"), { name: "TimeoutError" }), "timed_out"],
  ] as const)(
    "preserves enclosing %s provenance for failed native tools",
    async (abortReason, terminalReason) => {
      const abortController = new AbortController();
      abortController.abort(abortReason);
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector(undefined, {
        runAbortSignal: abortController.signal,
      });
      const commandItem = {
        type: "commandExecution",
        id: "cmd-aborted",
        command: "pnpm test extensions/codex",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };

      try {
        await projector.handleNotification(forCurrentTurn("item/started", { item: commandItem }));
        await projector.handleNotification(
          forCurrentTurn("item/completed", {
            item: { ...commandItem, status: "failed", durationMs: 4 },
          }),
        );
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "cmd-aborted",
          terminalReason,
        }),
      );
    },
  );

  it.each([
    ["cancelled", "cancelled"],
    [Object.assign(new Error("turn timed out"), { name: "TimeoutError" }), "timed_out"],
  ] as const)(
    "finalizes an active native tool as %s when building an interrupted result",
    async (abortReason, terminalReason) => {
      const abortController = new AbortController();
      abortController.abort(abortReason);
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector(undefined, {
        runAbortSignal: abortController.signal,
      });

      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", {
            item: {
              type: "commandExecution",
              id: "cmd-active-abort",
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
        projector.buildResult(buildEmptyToolTelemetry());
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "cmd-active-abort",
          terminalReason,
        }),
      );
      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === "cmd-active-abort")
          .map((event) => event.type),
      ).toEqual(["tool.execution.started", "tool.execution.error"]);
    },
  );

  it.each([
    [
      "collaboration",
      {
        id: "collab-audit-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: THREAD_ID,
        receiverThreadIds: ["child-thread-1"],
        prompt: "sensitive prompt text",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
      "collab.spawnAgent",
    ],
    [
      "image generation",
      {
        id: "image-generation-audit-1",
        type: "imageGeneration",
        status: "completed",
        revisedPrompt: "sensitive revised prompt",
        result: "sensitive image payload",
      },
      "image_generation",
    ],
    [
      "image view",
      {
        id: "image-view-audit-1",
        type: "imageView",
        path: "/workspace/sensitive-filename.png",
      },
      "image_view",
    ],
    [
      "sleep",
      {
        id: "sleep-audit-1",
        type: "sleep",
        durationMs: 250,
      },
      "sleep",
    ],
  ] as const)(
    "emits metadata-only lifecycle diagnostics for native %s items",
    async (_, item, toolName) => {
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector();

      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", { item, startedAtMs: 1_750_000_000_000 }),
        );
        await projector.handleNotification(
          forCurrentTurn("item/completed", { item, completedAtMs: 1_750_000_000_042 }),
        );
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === item.id)
          .map((event) => ({
            type: event.type,
            toolName: "toolName" in event ? event.toolName : null,
          })),
      ).toEqual([
        { type: "tool.execution.started", toolName },
        { type: "tool.execution.completed", toolName },
      ]);
      expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
    },
  );

  it.each([
    ["completed", "tool.execution.completed", undefined, undefined],
    ["failed", "tool.execution.error", "failed", undefined],
    ["cancelled", "tool.execution.error", "cancelled", undefined],
    [undefined, "tool.execution.error", "failed", "tool_outcome_unknown"],
    ["future_status", "tool.execution.error", "failed", "tool_outcome_unknown"],
  ] as const)(
    "uses raw %s status for redacted native web-search audit actions",
    async (status, terminalType, terminalReason, errorCode) => {
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
      const projector = await createProjector();
      const item = {
        id: "web-search-audit-1",
        type: "webSearch",
        query: "sensitive query",
        action: { type: "search", query: "sensitive query", queries: null },
      };

      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", { item, startedAtMs: 1_750_000_000_000 }),
        );
        await projector.handleNotification(
          forCurrentTurn("item/completed", { item, completedAtMs: 1_750_000_000_042 }),
        );
        await projector.handleNotification(
          forCurrentTurn("rawResponseItem/completed", {
            item: {
              id: item.id,
              type: "web_search_call",
              status,
              action: item.action,
            },
          }),
        );
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === item.id)
          .map((event) => ({
            type: event.type,
            toolName: "toolName" in event ? event.toolName : null,
            terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
            errorCode: "errorCode" in event ? event.errorCode : undefined,
            sourceTimestampMs: "sourceTimestampMs" in event ? event.sourceTimestampMs : undefined,
          })),
      ).toEqual([
        {
          type: "tool.execution.started",
          toolName: "web_search",
          terminalReason: undefined,
          errorCode: undefined,
          sourceTimestampMs: 1_750_000_000_000,
        },
        {
          type: terminalType,
          toolName: "web_search",
          terminalReason,
          errorCode,
          sourceTimestampMs: 1_750_000_000_042,
        },
      ]);
      expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
    },
  );
});
