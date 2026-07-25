import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  TURN_ID,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  mockCallArg,
  findAgentEvent,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector command output projection", () => {
  it("uses streamed command output when final command snapshots omit aggregated output", async () => {
    const onAgentEvent = vi.fn();
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(
      {
        ...(await createParams()),
        onAgentEvent,
      },
      {
        trajectoryRecorder,
      },
    );

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-1",
        delta: "status passed\n",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-1",
        delta: "json /tmp/scenario.json\n",
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-1",
          command: "python scripts/run_demo_scenario.py",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    const toolResultContent = requireArray(toolResultMessage.content, "tool result content");
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.content).toBe("status passed\njson /tmp/scenario.json");
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "tool.result",
      expect.objectContaining({
        itemId: "cmd-1",
        output: "status passed\njson /tmp/scenario.json",
      }),
    );
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-1",
      name: "bash",
    }).data;
    expect(toolResult.result).toEqual({ status: "completed", exitCode: 0, durationMs: 42 });
  });

  it("keeps final command output UTF-16 safe at the transcript limit", async () => {
    const projector = await createProjector();
    // Position the surrogate pair so it straddles the transcript cap: the
    // truncation boundary must drop the whole emoji, never split it in half.
    const prefix = "a".repeat(9_886);
    const aggregatedOutput = `${prefix}😀${"a".repeat(400)}`;

    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-utf16-final",
          command: "printf output",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const message = requireRecord(result.messagesSnapshot[2], "tool result message");
    const content = requireArray(message.content, "tool result content");
    const item = requireRecord(content[0], "tool result content item");
    expect(item.content).toBe(
      `${prefix}\n...(OpenClaw truncated Codex native tool output: original 10288 chars, showing 10000; rerun with narrower args.)`,
    );
    // A split surrogate would leave a lone code unit behind.
    expect(item.content).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it("keeps streamed command output UTF-16 safe at the transcript limit", async () => {
    const projector = await createProjector();
    // The surrogate pair straddles the transcript cap in the first delta so the
    // bounded prefix must drop the whole emoji rather than split it.
    const prefix = "a".repeat(9_886);

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-utf16-streamed",
        delta: `${prefix}😀${"a".repeat(400)}`,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-utf16-streamed",
        delta: "must not resurrect a split surrogate",
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-utf16-streamed",
          command: "printf output",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const message = requireRecord(result.messagesSnapshot[2], "tool result message");
    const content = requireArray(message.content, "tool result content");
    const item = requireRecord(content[0], "tool result content item");
    // A split surrogate would leave a lone code unit behind; the streamed output
    // must stay well-formed while still carrying the truncation notice.
    expect(item.content).not.toMatch(/[\uD800-\uDFFF]/);
    expect(item.content).toContain("OpenClaw truncated Codex native tool output");
    expect(item.content).toContain("showing 10000");
  });

  it.each([
    { prefixLength: 7_999, delta: "😀tail", expectedChunk: "" },
    { prefixLength: 7_998, delta: "x😀tail", expectedChunk: "x\n" },
  ])(
    "keeps streamed progress UTF-16 safe with $prefixLength chars already emitted",
    async ({ prefixLength, delta, expectedChunk }) => {
      const onToolResult = vi.fn();
      const projector = await createProjector({
        ...(await createParams()),
        verboseLevel: "full",
        onToolResult,
      });

      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-progress-utf16",
          delta: "a".repeat(prefixLength),
        }),
      );
      onToolResult.mockClear();
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-progress-utf16",
          delta,
        }),
      );

      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(onToolResult).toHaveBeenCalledWith({
        text: `🛠️ Bash\n\`\`\`txt\n${expectedChunk}...(truncated)...\n\`\`\``,
      });
      const text = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
      expect(text).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    },
  );

  it("freezes streamed raw prefix after UTF-16-safe truncation so full-output echoes stay suppressed", async () => {
    const projector = await createProjector();
    // First over-cap delta ends mid-surrogate: truncateUtf16Safe backs up and
    // leaves spare capacity under the notice budget. Later deltas must not fill it.
    const prefix = "a".repeat(9_886);
    const firstDelta = `${prefix}😀${"a".repeat(400)}`;
    const moreDeltas = ["more-after-cap-1", "more-after-cap-2", "tail-chunk"];
    const fullOutput = `${firstDelta}${moreDeltas.join("")}`;

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-freeze-prefix",
        delta: firstDelta,
      }),
    );
    for (const delta of moreDeltas) {
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-freeze-prefix",
          delta,
        }),
      );
    }

    const echoState = (
      projector as unknown as {
        toolProgressProjection: {
          echoesByItem: Map<string, { streamedRawSignature?: { length: number; prefix: string } }>;
        };
      }
    ).toolProgressProjection.echoesByItem;
    const state = echoState.get("cmd-freeze-prefix");
    expect(state?.streamedRawSignature).toBeDefined();
    expect(fullOutput.startsWith(state!.streamedRawSignature!.prefix)).toBe(true);
    expect(state!.streamedRawSignature!.length).toBe(fullOutput.length);

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-freeze-full-output",
          role: "assistant",
          content: [{ type: "output_text", text: fullOutput }],
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-freeze-prefix",
          command: "printf output",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });

  it("keeps streaming after output text includes the truncation notice prefix", async () => {
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(await createParams(), {
      trajectoryRecorder,
    });
    const userOutputWithNotice =
      "...(OpenClaw truncated Codex native tool output is a literal line from the process)\n";

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-notice-prefix",
        delta: userOutputWithNotice,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-notice-prefix",
        delta: "second line must survive\n",
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-notice-prefix",
          command: "python scripts/run_demo_scenario.py",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    const toolResultContent = requireArray(toolResultMessage.content, "tool result content");
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.content).toBe(`${userOutputWithNotice}second line must survive`);
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "tool.result",
      expect.objectContaining({
        itemId: "cmd-notice-prefix",
        output: `${userOutputWithNotice}second line must survive`,
      }),
    );
  });

  it("does not parse user output as a prior truncation notice when streaming crosses the cap", async () => {
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(await createParams(), {
      trajectoryRecorder,
    });
    const userOutputWithNotice =
      "before user marker\n...(OpenClaw truncated Codex native tool output: original literal process text)\nsecond line must survive\n";

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-user-notice-prefix",
        delta: userOutputWithNotice,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-user-notice-prefix",
        delta: "x".repeat(12_000),
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-user-notice-prefix",
          command: "python scripts/run_demo_scenario.py",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const output = (
      trajectoryRecorder.recordEvent.mock.calls.find(([type]) => type === "tool.result")?.[1] as
        | { output?: string }
        | undefined
    )?.output;
    expect(output).toHaveLength(10_000);
    expect(output).toContain("OpenClaw truncated Codex native tool output");
    expect(output).toContain("original 12124 chars");
    expect(output).toContain("before user marker");
    expect(output).toContain("second line must survive");
  });

  it("caps streamed command output used for replay when snapshots omit aggregated output", async () => {
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(await createParams(), {
      trajectoryRecorder,
    });

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-stream-large",
        delta: "s".repeat(12_345),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-stream-large",
        delta: "e".repeat(678),
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-stream-large",
          command: "python scripts/run_demo_scenario.py",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const output = (
      trajectoryRecorder.recordEvent.mock.calls.find(([type]) => type === "tool.result")?.[1] as
        | { output?: string }
        | undefined
    )?.output;
    expect(output).toHaveLength(10_000);
    expect(output).toContain("OpenClaw truncated Codex native tool output");
    expect(output).toContain("original 13023 chars");
    expect(output).toContain("showing 10000");
    expect(output?.match(/OpenClaw truncated Codex native tool output/g)).toHaveLength(1);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = result.messagesSnapshot.find(
      (message) => requireRecord(message, "message").role === "toolResult",
    );
    const toolResultContent = requireArray(
      requireRecord(toolResultMessage, "tool result message").content,
      "tool result content",
    );
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.content).toHaveLength(10_000);
    expect(toolResultContentItem.content).toContain("OpenClaw truncated Codex native tool output");
  });

  it("uses streamed command output for failed native tool errors", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-streamed-failure",
        delta: "fatal: missing fixture\n",
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-streamed-failure",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "failed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 1,
          durationMs: 42,
        },
      ]),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "fatal: missing fixture",
      mutatingAction: true,
      actionFingerprint: JSON.stringify({
        type: "commandExecution",
        command: "pnpm test extensions/codex",
        cwd: "/workspace",
      }),
    });
  });

  it("does not duplicate native tool starts when the snapshot completes a started item", async () => {
    const onAgentEvent = vi.fn();
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(
      { ...(await createParams()), onAgentEvent },
      { trajectoryRecorder },
    );
    const commandItem = {
      type: "commandExecution",
      id: "cmd-started",
      command: "pnpm test extensions/codex",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 42,
    };

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...commandItem, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(turnCompleted([commandItem]));

    const toolEvents = onAgentEvent.mock.calls
      .map((call) => requireRecord(call[0], "agent event"))
      .filter((event) => event.stream === "tool")
      .map((event) => requireRecord(event.data, "agent event data"));
    expect(
      toolEvents.filter((event) => event.phase === "start" && event.itemId === "cmd-started"),
    ).toHaveLength(1);
    expect(
      toolEvents.filter((event) => event.phase === "result" && event.itemId === "cmd-started"),
    ).toHaveLength(1);
    expect(
      trajectoryRecorder.recordEvent.mock.calls.filter(([type]) => type === "tool.call"),
    ).toHaveLength(1);
    expect(
      trajectoryRecorder.recordEvent.mock.calls.filter(([type]) => type === "tool.result"),
    ).toHaveLength(1);
  });

  it("does not synthesize completed progress for running turn completion snapshots", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-running-snapshot",
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
        {
          type: "imageGeneration",
          id: "image-running-snapshot",
          status: "in_progress",
          revisedPrompt: null,
          result: null,
        },
      ]),
    );

    const toolEvents = onAgentEvent.mock.calls
      .map((call) => requireRecord(call[0], "agent event"))
      .filter((event) => event.stream === "tool")
      .map((event) => requireRecord(event.data, "agent event data"));
    expect(toolEvents).toEqual([]);
  });

  it("does not synthesize progress for stale prior-turn snapshot items", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-prior-turn",
          turnId: "turn-old",
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
        {
          type: "commandExecution",
          id: "cmd-current-turn",
          turnId: TURN_ID,
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
      ]),
    );

    const toolEvents = onAgentEvent.mock.calls
      .map((call) => requireRecord(call[0], "agent event"))
      .filter((event) => event.stream === "tool")
      .map((event) => requireRecord(event.data, "agent event data"));
    expect(toolEvents.map((event) => event.itemId)).toEqual([
      "cmd-current-turn",
      "cmd-current-turn",
    ]);
  });
});
