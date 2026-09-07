import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  formatToolAggregate,
  inferToolMetaFromArgs,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  mockCallArg,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();


function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("CodexAppServerEventProjector tool progress echo filtering", () => {
  it("does not promote repeated tool progress text to the final assistant reply", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
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
    const toolProgressText = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string })
      .text;
    expect(toolProgressText).toBe("🛠️ `run tests (workspace)`");

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-tool-progress",
          role: "assistant",
          content: [{ type: "output_text", text: toolProgressText }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });

  it("does not promote raw oversized tool progress echoes after display truncation", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });
    const command = "pnpm test";
    const cwd = `/very-long-root/${"a".repeat(10_500)}`;
    const rawToolProgressText = formatToolAggregate(
      "bash",
      [inferToolMetaFromArgs("exec", { command, cwd }, { detailMode: "explain" }) ?? ""],
      { markdown: true },
    );
    expect(rawToolProgressText.length).toBeGreaterThan(10_000);

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-oversized-progress",
          command,
          cwd,
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
    const emittedProgressText = (
      mockCallArg(onToolResult, 0, 0, "onToolResult") as {
        text?: string;
      }
    ).text;
    expect(emittedProgressText).toHaveLength(10_000);
    expect(emittedProgressText).toContain("OpenClaw truncated Codex native tool output");

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-oversized-tool-progress",
          role: "assistant",
          content: [{ type: "output_text", text: rawToolProgressText }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(
      rawToolProgressText.slice(0, 1_000),
    );
  });

  it("does not promote raw streamed full-output echoes after replay truncation", async () => {
    const projector = await createProjector();
    const rawOutput = `${"s".repeat(12_345)}tail-should-not-appear`;

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-streamed-echo",
        delta: rawOutput,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-streamed-full-output",
          role: "assistant",
          content: [{ type: "output_text", text: rawOutput }],
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-streamed-echo",
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

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
    const toolResultMessage = result.messagesSnapshot.find(
      (message) => requireRecord(message, "message").role === "toolResult",
    );
    const toolResultContent = requireArray(
      requireRecord(toolResultMessage, "tool result message").content,
      "tool result content",
    );
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.content).toHaveLength(10_000);
    expect(toolResultContentItem.content).toContain("original 12367 chars");
    expect(toolResultContentItem.content).not.toContain("tail-should-not-appear");
  });

  it("bounds streamed output echo signatures per tool item", async () => {
    const projector = await createProjector();
    const chunks = ["s".repeat(6_000), "t".repeat(6_000), "u".repeat(6_000)];
    const rawOutput = chunks.join("");

    for (const delta of chunks) {
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-streamed-echo",
          delta,
        }),
      );
    }

    const echoState = (
      projector as unknown as {
        toolProgressProjection: {
          echoesByItem: Map<
            string,
            {
              rawSignatures: Array<{ length: number; prefix: string }>;
              streamedRawSignature?: { length: number; prefix: string };
            }
          >;
        };
      }
    ).toolProgressProjection.echoesByItem;
    expect(echoState.size).toBe(1);
    const state = echoState.get("cmd-streamed-echo");
    // Stream owns one dedicated slot; FIFO stays empty for pure stream accumulation.
    expect(state?.rawSignatures).toEqual([]);
    const latestRaw = state?.streamedRawSignature;
    expect(latestRaw?.length).toBe(rawOutput.length);
    expect(latestRaw?.prefix.length).toBeLessThanOrEqual(10_000);

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-streamed-full-output",
          role: "assistant",
          content: [{ type: "output_text", text: rawOutput }],
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-streamed-echo",
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

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });

  it("normalizes streamed raw echo lengths before comparing assistant echoes", async () => {
    const projector = await createProjector();
    const rawOutput = `${"s".repeat(12_345)}\n`;

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-streamed-echo-newline",
        delta: rawOutput,
      }),
    );
    const echoState = (
      projector as unknown as {
        toolProgressProjection: {
          echoesByItem: Map<
            string,
            {
              rawSignatures: Array<{ length: number; prefix: string }>;
              streamedRawSignature?: { length: number; prefix: string };
            }
          >;
        };
      }
    ).toolProgressProjection.echoesByItem;
    const state = echoState.get("cmd-streamed-echo-newline");
    expect(state?.streamedRawSignature?.length).toBe(rawOutput.trim().length);

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-streamed-full-output-newline",
          role: "assistant",
          content: [{ type: "output_text", text: rawOutput }],
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-streamed-echo-newline",
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

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });

  it("preserves raw aggregate echo signatures before snapshot output truncation", async () => {
    const projector = await createProjector();
    const rawOutput = `\n${"s".repeat(12_345)}tail-should-not-appear\n`;

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-aggregate-full-output",
          role: "assistant",
          content: [{ type: "output_text", text: rawOutput }],
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-aggregate-echo",
          command: "python scripts/run_demo_scenario.py",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: rawOutput,
          exitCode: 0,
          durationMs: 42,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("tail-should-not-appear");
  });

  it("keeps aggregate echo prefixes UTF-16 safe at the transcript budget via projector write sites", async () => {
    const projector = await createProjector();
    // Surrogate pair straddles TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS (10_000): a raw
    // .slice would leave a lone high surrogate in both echo-prefix writers.
    const asciiPrefix = "a".repeat(9_999);
    const aggregatedOutput = `${asciiPrefix}😀${"a".repeat(400)}`;
    const brokenSlice = aggregatedOutput.slice(0, 10_000);

    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-aggregate-utf16-echo",
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

    // Production path: turn/completed → rememberCommandAggregateOutputEcho →
    // toolOutputRawEchoSignature (write site 1) → rememberEcho prefix cap (write site 2).
    const echoState = (
      projector as unknown as {
        toolProgressProjection: {
          echoesByItem: Map<string, { rawSignatures: Array<{ length: number; prefix: string }> }>;
        };
      }
    ).toolProgressProjection.echoesByItem;
    const signatures = echoState.get("cmd-aggregate-utf16-echo")?.rawSignatures ?? [];
    expect(signatures.length).toBeGreaterThan(0);
    expect(brokenSlice.charCodeAt(brokenSlice.length - 1)).toBe(0xd83d);

    for (const signature of signatures) {
      expect(hasLoneSurrogate(signature.prefix)).toBe(false);
      expect(signature.prefix.endsWith("😀")).toBe(true);
      expect(signature.prefix).toBe(`${asciiPrefix}😀`);
      expect(signature.prefix.length).toBe(10_001);
      expect(signature.length).toBe(aggregatedOutput.length);
      process.stdout.write(
        `[utf16-echo-proof] write_sites=toolOutputRawEchoSignature+rememberEcho\n`,
      );
      process.stdout.write(
        `[utf16-echo-proof] broken_slice_last_codeunit=${brokenSlice
          .charCodeAt(brokenSlice.length - 1)
          .toString(16)}\n`,
      );
      process.stdout.write(`[utf16-echo-proof] stored_prefix_len=${signature.prefix.length}\n`);
      process.stdout.write(
        `[utf16-echo-proof] stored_prefix_last_codeunit=${signature.prefix
          .charCodeAt(signature.prefix.length - 1)
          .toString(16)}\n`,
      );
      process.stdout.write(
        `[utf16-echo-proof] stored_prefix_has_lone_surrogate=${hasLoneSurrogate(signature.prefix)}\n`,
      );
      process.stdout.write(
        `[utf16-echo-proof] stored_prefix_ends_with_emoji=${signature.prefix.endsWith("😀")}\n`,
      );
      process.stdout.write(`[utf16-echo-proof] stored_raw_length=${signature.length}\n`);
    }
  });

  it("retains distinct same-length assistant text at the UTF-16 echo budget via projector caller", async () => {
    const projector = await createProjector();
    const asciiPrefix = "a".repeat(9_999);
    const aggregatedOutput = `${asciiPrefix}😀${"a".repeat(400)}`;
    // Same UTF-16 length, differs at the former lone-surrogate cutoff.
    const distinctAssistant = `${asciiPrefix}b${"a".repeat(aggregatedOutput.length - 10_000)}`;
    expect(distinctAssistant.length).toBe(aggregatedOutput.length);

    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-aggregate-utf16-discriminator",
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

    const progress = (
      projector as unknown as {
        toolProgressProjection: { matchesEcho: (text: string) => boolean };
      }
    ).toolProgressProjection;

    expect(progress.matchesEcho(aggregatedOutput)).toBe(true);
    expect(progress.matchesEcho(distinctAssistant)).toBe(false);

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-distinct", text: distinctAssistant }]),
    );
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([distinctAssistant]);
    process.stdout.write(
      `[utf16-echo-proof] caller_path=turn/completed+matchesEcho+assistant retention\n`,
    );
    process.stdout.write(
      `[utf16-echo-proof] echo_matches_tool_output=${progress.matchesEcho(aggregatedOutput)}\n`,
    );
    process.stdout.write(
      `[utf16-echo-proof] echo_matches_distinct=${progress.matchesEcho(distinctAssistant)}\n`,
    );
    process.stdout.write(
      `[utf16-echo-proof] assistant_retained=${result.assistantTexts.includes(distinctAssistant)}\n`,
    );
  });

  it("keeps final answers that only start with a streamed tool-output prefix", async () => {
    const projector = await createProjector();
    const rawOutput = "s".repeat(12_345);
    const finalAnswer = `${rawOutput.slice(0, 1_500)}\n\nHere is the explanation after the quoted output.`;

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-streamed-prefix",
        delta: rawOutput,
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-final", text: finalAnswer }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([finalAnswer]);
    expect(result.lastAssistant).toBeDefined();
    expect(result.currentAttemptAssistant).toBeDefined();
  });
});
