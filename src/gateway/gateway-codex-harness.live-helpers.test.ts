/**
 * Tests live helper utilities used by the Codex gateway harness.
 */
import { describe, expect, it } from "vitest";
import {
  requireSuccessfulNativeCommandCompactionEvidence,
  requireSuccessfulPersistedNativeCommandExecution,
} from "./gateway-codex-harness.command-evidence.live-helpers.js";
import {
  buildCodexHarnessLargeOutputCommand,
  CODEX_HARNESS_MAX_LARGE_OUTPUT_BYTES,
  EXPECTED_CODEX_MODELS_COMMAND_TEXT,
  EXPECTED_CODEX_STATUS_COMMAND_TEXT,
  isExpectedCodexModelsCommandText,
  isExpectedCodexStatusCommandText,
  isExpectedYieldedAgentTimeout,
  isRetryableCodexHarnessLiveError,
  isStrictExpectedCodexModelsCommandText,
  requireSuccessfulNativeCommandExecution,
  shouldUseCodexHarnessSubagentOnlyFastPath,
} from "./gateway-codex-harness.live-helpers.js";

const includesExpectedCodexModelsCommandText = (text: string) =>
  EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText));

const shellSingleQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function expectExpectedCodexModelsCommandText(text: string): void {
  expect(includesExpectedCodexModelsCommandText(text)).toBe(true);
}

function expectRecognizedCodexModelsCommandText(text: string): void {
  expectExpectedCodexModelsCommandText(text);
  expect(isExpectedCodexModelsCommandText(text)).toBe(true);
}

function expectStrictCodexModelsCommandText(text: string): void {
  expectRecognizedCodexModelsCommandText(text);
  expect(isStrictExpectedCodexModelsCommandText(text)).toBe(true);
}

describe("gateway codex harness live helpers", () => {
  it("builds an exact large-output command without escape-sensitive newlines", () => {
    const command = buildCodexHarnessLargeOutputCommand({
      commandMarker: "OPENCLAW-LARGE-OUTPUT-ABC",
      outputBytes: CODEX_HARNESS_MAX_LARGE_OUTPUT_BYTES,
    });

    expect(command).toContain('"OPENCLAW-LARGE-OUTPUT-ABC|"');
    expect(command).toContain(".slice(0,800000)");
    expect(CODEX_HARNESS_MAX_LARGE_OUTPUT_BYTES).toBeLessThan(1024 * 1024);
    expect(command).not.toContain("\\n");
    expect(command).not.toContain("\n");
  });

  it("keeps combined stress probes out of the subagent-only fast path", () => {
    const base = {
      chatImageProbe: false,
      codeModeOnly: false,
      compactionStress: false,
      explicitOptOut: false,
      guardianProbe: false,
      imageProbe: false,
      mcpProbe: false,
      resumeStress: false,
      subagentProbe: true,
    };

    expect(shouldUseCodexHarnessSubagentOnlyFastPath(base)).toBe(true);
    expect(shouldUseCodexHarnessSubagentOnlyFastPath({ ...base, resumeStress: true })).toBe(false);
    expect(shouldUseCodexHarnessSubagentOnlyFastPath({ ...base, compactionStress: true })).toBe(
      false,
    );
    expect(shouldUseCodexHarnessSubagentOnlyFastPath({ ...base, codeModeOnly: true })).toBe(false);
    expect(shouldUseCodexHarnessSubagentOnlyFastPath({ ...base, explicitOptOut: true })).toBe(
      false,
    );
  });

  it("classifies sessions.list timeouts as retryable live Codex errors", () => {
    const error = new Error("gateway request timeout for sessions.list");

    expect(isRetryableCodexHarnessLiveError(error)).toBe(true);
  });

  it("does not classify unrelated live Codex errors as retryable gateway timeouts", () => {
    const error = new Error("subagent child did not emit lifecycle event");

    expect(isRetryableCodexHarnessLiveError(error)).toBe(false);
  });

  it("matches a successful wrapped native command by its per-turn marker", () => {
    const expectedCommand = `node -e 'console.log("OPENCLAW-LARGE-OUTPUT-ABC")'`;
    const wrappedCommand = `node -e "console.log(\\"OPENCLAW-LARGE-OUTPUT-ABC\\")"`;
    const events = [
      {
        stream: "tool",
        data: {
          phase: "start",
          name: "bash",
          itemId: "item-1",
          args: { command: `/bin/bash -lc ${shellSingleQuote(wrappedCommand)}` },
        },
      },
      {
        stream: "tool",
        data: {
          phase: "result",
          itemId: "item-1",
          status: "completed",
          isError: false,
          result: { exitCode: 0 },
        },
      },
    ];

    expect(
      requireSuccessfulNativeCommandExecution(events, {
        commandMarker: "OPENCLAW-LARGE-OUTPUT-ABC",
        expectedCommand,
      }),
    ).toEqual({ itemId: "item-1", resultIndex: 1, startIndex: 0 });
  });

  it("rejects a successful command that only echoes the expected command", () => {
    const expectedCommand = `node -e 'console.log("OPENCLAW-LARGE-OUTPUT-ABC")'`;
    expect(() =>
      requireSuccessfulNativeCommandExecution(
        [
          {
            stream: "tool",
            data: {
              phase: "start",
              name: "bash",
              itemId: "item-echo",
              args: { command: `echo ${shellSingleQuote(expectedCommand)}` },
            },
          },
          {
            stream: "tool",
            data: {
              phase: "result",
              itemId: "item-echo",
              status: "completed",
              isError: false,
              result: { exitCode: 0 },
            },
          },
        ],
        {
          commandMarker: "OPENCLAW-LARGE-OUTPUT-ABC",
          expectedCommand,
        },
      ),
    ).toThrow("missing native bash command start for marker OPENCLAW-LARGE-OUTPUT-ABC");
  });

  it("accepts a completed native command when Codex omits or nulls its optional exit code", () => {
    const expectedCommand = "node -e OPENCLAW-NO-EXIT-CODE";
    for (const result of [{ status: "completed" }, { status: "completed", exitCode: null }]) {
      const events = [
        {
          stream: "tool",
          data: {
            phase: "start",
            name: "bash",
            itemId: "item-no-exit-code",
            args: { command: expectedCommand },
          },
        },
        {
          stream: "tool",
          data: {
            phase: "result",
            itemId: "item-no-exit-code",
            status: "completed",
            isError: false,
            result,
          },
        },
      ];

      expect(
        requireSuccessfulNativeCommandExecution(events, {
          commandMarker: "OPENCLAW-NO-EXIT-CODE",
          expectedCommand,
        }),
      ).toEqual({ itemId: "item-no-exit-code", resultIndex: 1, startIndex: 0 });
    }
  });

  it("reports a missing native command start explicitly", () => {
    expect(() =>
      requireSuccessfulNativeCommandExecution([], {
        commandMarker: "OPENCLAW-MISSING",
        expectedCommand: "node -e OPENCLAW-MISSING",
      }),
    ).toThrow("missing native bash command start for marker OPENCLAW-MISSING");
  });

  it("reports a missing native command item id explicitly", () => {
    expect(() =>
      requireSuccessfulNativeCommandExecution(
        [
          {
            stream: "tool",
            data: {
              phase: "start",
              name: "bash",
              args: { command: "node -e OPENCLAW-NO-ITEM" },
            },
          },
        ],
        {
          commandMarker: "OPENCLAW-NO-ITEM",
          expectedCommand: "node -e OPENCLAW-NO-ITEM",
        },
      ),
    ).toThrow("native bash command start for marker OPENCLAW-NO-ITEM has no itemId");
  });

  it("reports a missing successful native command result explicitly", () => {
    expect(() =>
      requireSuccessfulNativeCommandExecution(
        [
          {
            stream: "tool",
            data: {
              phase: "start",
              name: "bash",
              itemId: "item-failed",
              args: { command: "node -e OPENCLAW-FAILED" },
            },
          },
          {
            stream: "tool",
            data: {
              phase: "result",
              itemId: "item-failed",
              status: "completed",
              isError: true,
              result: { exitCode: 1 },
            },
          },
        ],
        {
          commandMarker: "OPENCLAW-FAILED",
          expectedCommand: "node -e OPENCLAW-FAILED",
        },
      ),
    ).toThrow(
      "native bash command item-failed for marker OPENCLAW-FAILED has no successful result",
    );
  });

  it("bounds failed-command diagnostics to the matching item without raw output", () => {
    const secretOutput = "sensitive-command-output";
    let message = "";
    try {
      requireSuccessfulNativeCommandExecution(
        [
          {
            stream: "tool",
            data: {
              phase: "start",
              name: "bash",
              itemId: "item-failed",
              args: { command: "node -e OPENCLAW-FAILED" },
            },
          },
          {
            stream: "tool",
            data: {
              phase: "result",
              itemId: "item-other",
              status: "completed",
              isError: true,
              result: { stderr: secretOutput, exitCode: 1 },
            },
          },
          {
            stream: "tool",
            data: {
              phase: "result",
              itemId: "item-failed",
              status: "completed",
              isError: true,
              result: { stdout: secretOutput, exitCode: 1 },
            },
          },
        ],
        {
          commandMarker: "OPENCLAW-FAILED",
          expectedCommand: "node -e OPENCLAW-FAILED",
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('"itemId":"item-failed"');
    expect(message).toContain(`"stdoutChars":${secretOutput.length}`);
    expect(message).not.toContain("item-other");
    expect(message).not.toContain(secretOutput);
  });

  it("requires a successful marker-bearing large result in durable history", () => {
    const expectedCommand = `node -e 'console.log("OPENCLAW-PERSISTED")'`;
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "persisted-call",
            name: "bash",
            arguments: { command: expectedCommand },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "persisted-call",
        isError: false,
        content: [
          {
            type: "text",
            text: "OPENCLAW-PERSISTED",
          },
          {
            type: "text",
            text: "...(truncated: original 2000 chars)",
          },
        ],
      },
    ];

    expect(
      requireSuccessfulPersistedNativeCommandExecution(messages, {
        commandMarker: "OPENCLAW-PERSISTED",
        expectedCommand,
        minimumOutputChars: 1_000,
      }),
    ).toEqual({ callIndex: 0, resultIndex: 1, toolCallId: "persisted-call" });
    expect(() =>
      requireSuccessfulPersistedNativeCommandExecution(messages.slice(1), {
        commandMarker: "OPENCLAW-PERSISTED",
        expectedCommand,
        minimumOutputChars: 1_000,
      }),
    ).toThrow("has no successful large result");
    expect(
      requireSuccessfulPersistedNativeCommandExecution(messages.slice(1), {
        commandMarker: "OPENCLAW-PERSISTED",
        expectedCommand,
        minimumOutputChars: 1_000,
        toolCallId: "persisted-call",
      }),
    ).toEqual({ callIndex: -1, resultIndex: 0, toolCallId: "persisted-call" });
  });

  it("rejects echoed or failed native commands in durable history", () => {
    const expectedCommand = `node -e 'console.log("OPENCLAW-PERSISTED")'`;
    const echoedMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "echoed-call",
            name: "bash",
            arguments: { command: `echo ${shellSingleQuote(expectedCommand)}` },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "echoed-call",
        isError: false,
        content: [
          {
            type: "text",
            text: "OPENCLAW-PERSISTED\n...(truncated: original 2000 chars)",
          },
        ],
      },
    ];
    expect(() =>
      requireSuccessfulPersistedNativeCommandExecution(echoedMessages, {
        commandMarker: "OPENCLAW-PERSISTED",
        expectedCommand,
        minimumOutputChars: 1_000,
      }),
    ).toThrow("has no successful large result");

    const failedMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "failed-call",
            name: "bash",
            arguments: { command: expectedCommand },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "failed-call",
        isError: true,
        content: [
          {
            type: "text",
            text: "OPENCLAW-PERSISTED\n...(truncated: original 2000 chars)",
          },
        ],
      },
    ];
    expect(() =>
      requireSuccessfulPersistedNativeCommandExecution(failedMessages, {
        commandMarker: "OPENCLAW-PERSISTED",
        expectedCommand,
        minimumOutputChars: 1_000,
      }),
    ).toThrow(
      "persisted native bash command for marker OPENCLAW-PERSISTED has no successful large result",
    );

    const nonzeroMessages = [
      failedMessages[0],
      {
        ...failedMessages[1],
        isError: false,
        details: { status: "completed", exitCode: 17 },
      },
    ];
    expect(() =>
      requireSuccessfulPersistedNativeCommandExecution(nonzeroMessages, {
        commandMarker: "OPENCLAW-PERSISTED",
        expectedCommand,
        minimumOutputChars: 1_000,
      }),
    ).toThrow("has no successful large result");
  });

  it("accepts successful request-local evidence when compaction removed durable history", () => {
    const expectedCommand = "node -e OPENCLAW-COMPACTED";
    const events = [
      {
        stream: "tool",
        data: {
          phase: "start",
          name: "bash",
          itemId: "compacted-command",
          args: { command: expectedCommand },
        },
      },
      {
        stream: "tool",
        data: {
          phase: "result",
          itemId: "compacted-command",
          status: "completed",
          isError: false,
          result: { exitCode: 0 },
        },
      },
      { stream: "compaction", data: { phase: "end", completed: true } },
    ];

    expect(
      requireSuccessfulNativeCommandCompactionEvidence({
        commandMarker: "OPENCLAW-COMPACTED",
        events,
        expectedCommand,
        messages: [],
        minimumOutputChars: 1_000,
      }),
    ).toEqual({ source: "compacted-event" });
    expect(() =>
      requireSuccessfulNativeCommandCompactionEvidence({
        commandMarker: "OPENCLAW-COMPACTED",
        events: events.slice(0, 2),
        expectedCommand,
        messages: [],
        minimumOutputChars: 1_000,
      }),
    ).toThrow("successful request-local command result was not followed by compaction");

    expect(() =>
      requireSuccessfulNativeCommandCompactionEvidence({
        commandMarker: "OPENCLAW-COMPACTED",
        events,
        expectedCommand,
        messages: [
          {
            role: "toolResult",
            toolCallId: "compacted-command",
            isError: true,
            content: [
              {
                type: "text",
                text: "OPENCLAW-COMPACTED\n...(truncated: original 2000 chars)",
              },
            ],
          },
        ],
        minimumOutputChars: 1_000,
      }),
    ).toThrow("durable result for successful request-local command failed validation");
  });

  it("rejects large durable output from a different marker-bearing command", () => {
    const expectedCommand = "node -e OPENCLAW-EXACT";
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "mismatched-call",
            name: "bash",
            arguments: { command: `echo ${shellSingleQuote(expectedCommand)}` },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "mismatched-call",
        isError: false,
        content: [
          {
            type: "text",
            text: "OPENCLAW-EXACT\n...(truncated: original 2000 chars)",
          },
        ],
      },
    ];

    expect(() =>
      requireSuccessfulNativeCommandCompactionEvidence({
        commandMarker: "OPENCLAW-EXACT",
        events: [],
        expectedCommand,
        messages,
        minimumOutputChars: 1_000,
      }),
    ).toThrow("has no successful request-local evidence");
  });

  it("ties a result-only durable row to the exact request-local item id", () => {
    const expectedCommand = "node -e OPENCLAW-RESULT-ONLY";
    const events = [
      {
        stream: "tool",
        data: {
          phase: "start",
          name: "bash",
          itemId: "exact-call",
          args: { command: expectedCommand },
        },
      },
      {
        stream: "tool",
        data: {
          phase: "result",
          itemId: "exact-call",
          status: "completed",
          isError: false,
          result: { exitCode: 0 },
        },
      },
    ];
    const resultOnlyMessage = (toolCallId: string) => ({
      role: "toolResult",
      toolCallId,
      isError: false,
      content: [
        {
          type: "text",
          text: "OPENCLAW-RESULT-ONLY\n...(truncated: original 2000 chars)",
        },
      ],
    });

    expect(
      requireSuccessfulNativeCommandCompactionEvidence({
        commandMarker: "OPENCLAW-RESULT-ONLY",
        events,
        expectedCommand,
        messages: [resultOnlyMessage("different-call"), resultOnlyMessage("exact-call")],
        minimumOutputChars: 1_000,
      }),
    ).toEqual({ source: "persisted-history" });
    expect(() =>
      requireSuccessfulNativeCommandCompactionEvidence({
        commandMarker: "OPENCLAW-RESULT-ONLY",
        events,
        expectedCommand,
        messages: [resultOnlyMessage("different-call")],
        minimumOutputChars: 1_000,
      }),
    ).toThrow("successful request-local command result was not followed by compaction");
  });

  it("accepts only paused yielded agent timeouts for native subagent delivery", () => {
    expect(
      isExpectedYieldedAgentTimeout({
        status: "timeout",
        result: { meta: { livenessState: "paused", yielded: true } },
      }),
    ).toBe(true);
    expect(
      isExpectedYieldedAgentTimeout({
        status: "timeout",
        result: { meta: { livenessState: "paused", yielded: false } },
      }),
    ).toBe(false);
    expect(
      isExpectedYieldedAgentTimeout({
        status: "ok",
        result: { meta: { livenessState: "paused", yielded: true } },
      }),
    ).toBe(false);
  });

  it("accepts the current codex status prose from the live harness", () => {
    const text =
      "OpenClaw is running on `openai/gpt-5.5` with low reasoning/text settings. Context is at `22k/272k` tokens, no compactions, and the current session is `agent:dev:live-codex-harness`.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(false);
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts current status prose that reports session context without the session id", () => {
    const text = [
      "OpenClaw is running on `openai/gpt-5.5` with low reasoning/text settings.",
      "",
      "Session context is light: `22k/272k` tokens used, `8%`, no compactions. There is 1 active task: `/codex status`.",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts current status prose that reports healthy session context without the session id", () => {
    const text = [
      "Status: running on `openai/gpt-5.5` with low reasoning/text settings.",
      "",
      "Session context is healthy: `22k/272k` tokens used, `0` compactions, `53%` cache hit. Current workspace is `/tmp/openclaw-live-codex-harness/workspace/dev`.",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts current app-server status prose without the OpenClaw prefix", () => {
    const text = [
      "Status: running on `openai/gpt-5.5` in `/tmp/openclaw-live-codex-harness/workspace/dev`.",
      "",
      "Context is at 22k / 272k tokens, with no compactions. There’s 1 active task: `/codex status`.",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts current app-server status prose with session-is wording", () => {
    const text =
      "Status: running on `openai/gpt-5.5`, context at 22k/272k tokens (8%), no compactions. Session is `agent:dev:live-codex-harness`; execution is direct with elevated mode.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts compact session status prose emitted by current codex", () => {
    const text =
      "Session status: running on `openai/gpt-5.5`, context at 24k/272k (9%), no compactions, execution mode `direct`, reasoning `low`, text `low`.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts workspace-only healthy status prose emitted by current codex", () => {
    const text =
      "Working normally. Current workspace: `/tmp/openclaw-live-codex-harness/workspace/dev`.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts terse idle-ready status prose emitted by current codex", () => {
    const text = "Idle and ready.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts terse ready status prose emitted by current codex", () => {
    const text = "Ready.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts running-session status prose emitted by current codex", () => {
    const text =
      "Session is running on `codex/gpt-5.5` with low reasoning, direct execution, and about `24k/272k` context used. Cache hit is `99%`; no compactions so far.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts natural running-session status prose with the session id", () => {
    const text =
      "Session is running on `codex/gpt-5.5` with low thinking. Context is about 9% used, no compactions, and the current session is `agent:dev:live-codex-harness`.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts the current status card emitted by OpenAI Codex", () => {
    const text = [
      "Current session status:",
      "",
      "- Model: `openai/gpt-5.5`",
      "- Context: `22k/272k` tokens, `8%`",
      "- Cache hit: `52%`",
      "- Compactions: `0`",
      "- Execution: `direct`",
      "- Runtime: `OpenAI Codex`",
      "- Think: `low`",
      "- Active tasks: `1`",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts the OpenAI Codex status card emitted by the GPT-5.5 Docker harness", () => {
    const text = [
      "OpenClaw 2026.4.30-beta.1 is running on `openai/gpt-5.5`.",
      "",
      "Session is healthy:",
      "- Context: `21k/272k` used, `8%`",
      "- Cache: `19%` hit",
      "- Runtime: `OpenAI Codex`",
      "- Execution: `direct`",
      "- Active tasks: `1` (`/codex status`)",
      "- Queue: `steer`, depth `0`",
    ].join("\n");

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts the compact status-card pointer emitted by current codex", () => {
    const text = "OpenClaw status shown above.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the completed-session status emitted by current codex", () => {
    const text = "No active task is running.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the online idle status emitted by current codex", () => {
    const text =
      "I'm online in `/tmp/openclaw-live-codex-harness-KiaUQ4/workspace/dev`, with workspace-write access. No active task is running right now.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("accepts the completed-work status emitted by current codex", () => {
    const text = "No active work is running. Ready for the next task.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the normal-work status emitted by current codex", () => {
    const text =
      "Working normally. Current cwd is `/tmp/openclaw-live-codex-harness/workspace/dev`, sandbox is workspace-write, network is restricted, and the current date is 2026-05-09 UTC.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the ready status emitted by current codex", () => {
    const text = "Ready.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts the idle-ready status emitted by current codex", () => {
    const text = "I'm idle and ready.";

    expect(
      EXPECTED_CODEX_STATUS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)) ||
        isExpectedCodexStatusCommandText(text),
    ).toBe(true);
  });

  it("rejects status prose for a different codex session", () => {
    const text =
      "OpenClaw is running on `openai/gpt-5.5` with low reasoning/text settings. Context is at `22k/272k` tokens, no compactions, and the current session is `agent:dev:other`.";

    expect(isExpectedCodexStatusCommandText(text)).toBe(false);
  });

  it("accepts the interactive model-selection summary emitted by current codex", () => {
    const text = [
      "`/codex models` opened an interactive model-selection prompt rather than printing a plain list.",
      "",
      "Visible options in this session:",
      "- `GPT-5.4`",
      "- `GPT-5.3-Codex` (listed as the existing model)",
      "",
      "Current active model is `codex/gpt-5.4`.",
    ].join("\n");

    expectStrictCodexModelsCommandText(text);
  });

  it("accepts the configured-model fallback summary", () => {
    const text = [
      "Configured models in this session:",
      "- `codex/gpt-5.4`",
      "Current session model is `codex/gpt-5.4`.",
    ].join("\n");

    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the agent-id summary with active Codex model", () => {
    const text = [
      "Available agent IDs in this session:",
      "",
      "- `dev`",
      "",
      "Current active model:",
      "- `codex/gpt-5.4`",
      "",
      "I couldn’t get a fuller model catalog from the local `codex` CLI here.",
    ].join("\n");

    expectRecognizedCodexModelsCommandText(text);
    expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
  });

  it("accepts the current Codex agent model list from the live harness", () => {
    const text = [
      "Available Codex agent models:",
      "",
      "- `dev`: `openai/gpt-5.5`",
      "  - Runtime: `codex`",
      "  - Configured: `false`",
      "",
      "No other agent models are currently exposed for this session.",
    ].join("\n");

    expectStrictCodexModelsCommandText(text);
  });

  it("accepts healthy literal codex model lists for strict live proof", () => {
    const texts = [
      ["Codex models:", "", "- `openai/gpt-5.5`", "- `codex/gpt-5.4`"].join("\n"),
      ["Available Codex models", "", "- `GPT-5.5`", "- `GPT-5.4-Codex`"].join("\n"),
      ["Available models:", "", "- `gpt-5.4`", "- `gpt-5.4-mini`"].join("\n"),
      ["Available model overrides:", "", "- `gpt-5.4`"].join("\n"),
      ["Available model overrides in this session:", "", "- `codex/gpt-5.4`"].join("\n"),
      ["Available models in this Codex install", "", "- `gpt-5.4`"].join("\n"),
      ["Available agent models:", "", "- `codex/gpt-5.4`"].join("\n"),
    ];

    for (const text of texts) {
      expectExpectedCodexModelsCommandText(text);
      expect(isStrictExpectedCodexModelsCommandText(text)).toBe(true);
    }
  });

  it("rejects model-list headings without model evidence", () => {
    const text = "Available models:";

    expectExpectedCodexModelsCommandText(text);
    expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
  });

  it("accepts the singular Codex agent model list from the live harness", () => {
    const text = [
      "Available Codex agent model:",
      "",
      "- `dev`: `openai/gpt-5.5`",
      "- Runtime: `codex`",
      "- Fallback: `none`",
      "- Configured override: `false`",
    ].join("\n");

    expectStrictCodexModelsCommandText(text);
  });

  it("accepts sandbox namespace failures with current-session model fallback", () => {
    const text = [
      "I can’t enumerate `/codex models` from this sandbox because the local `codex` CLI fails to start here with a user-namespace restriction (`bwrap: No permissions to create a new namespace`).",
      "",
      "What I can confirm from the current session is that it’s running on `codex/gpt-5.4`.",
    ].join("\n");

    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the GPT-5.5 Docker harness shell fallback", () => {
    const text = [
      "I couldn’t get `/codex models` from the shell here.",
      "",
      "What happened:",
      "- In the sandbox, `codex models` failed because the kernel disallows unprivileged user namespaces.",
      "- Outside the sandbox, `codex` is not on `PATH`.",
      "",
      "Current session model from OpenClaw status is `openai/gpt-5.5`.",
    ].join("\n");

    expectRecognizedCodexModelsCommandText(text);
  });

  it("accepts missing codex CLI fallback output", () => {
    const texts = [
      [
        "`codex` is not installed on the shell PATH in this environment.",
        "",
        "Command result:",
        "```text",
        "/bin/bash: line 1: codex: command not found",
        "```",
      ].join("\n"),
      [
        "`codex` is not installed in the shell environment, so `/codex models` could not be executed.",
        "",
        "Error:",
        "```text",
        "/bin/bash: line 1: codex: command not found",
        "```",
      ].join("\n"),
      [
        "I can confirm the current session is using `codex/gpt-5.4`.",
        "",
        "I can’t list additional local Codex models from this shell because the `codex` CLI isn’t installed here (`codex models` returned `command not found`).",
      ].join("\n"),
    ];

    for (const text of texts) {
      expectExpectedCodexModelsCommandText(text);
      expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
    }
    expect(isExpectedCodexModelsCommandText(texts[1] ?? "")).toBe(true);
    expect(isExpectedCodexModelsCommandText(texts[2] ?? "")).toBe(true);
  });

  it("rejects command-unavailable prose for strict live codex models proof", () => {
    const texts = [
      "`codex` is not installed on the shell PATH in this environment.",
      "I couldn’t list them because `codex models` requires running outside the sandbox here, and that approval was rejected.",
      "`codex models` didn’t return a plain list in this environment; it dropped into the interactive TUI instead.",
    ];

    for (const text of texts) {
      expect(
        includesExpectedCodexModelsCommandText(text) || isExpectedCodexModelsCommandText(text),
      ).toBe(true);
      expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
    }
  });

  it("accepts current session model summaries from codex models fallback", () => {
    const text = [
      "Available here:",
      "",
      "- `codex/gpt-5.4` (`codex`) - current session model",
      "- `codex/gpt-5.4-mini` (`codex-mini`)",
    ].join("\n");

    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the app-server model override list", () => {
    const texts = [
      [
        "Available model overrides in this session:",
        "",
        "- `gpt-5.4`",
        "- `GPT-5.5`",
        "- `gpt-5.4-mini`",
      ].join("\n"),
      ["Available model overrides here:", "", "- `gpt-5.4`"].join("\n"),
      ["Available model overrides:", "", "- `gpt-5.4`"].join("\n"),
      ["Available model overrides listed for this session:", "", "- `gpt-5.5`"].join("\n"),
      ["Available models:", "", "- `gpt-5.4`", "- `gpt-5.4-mini`"].join("\n"),
      [
        "Available model overrides exposed in this session are:",
        "",
        "- `codex/gpt-5.4` (current)",
        "- `gpt-5.4-mini`",
        "",
        "The local `codex` CLI here does not provide a separate non-interactive `models` listing command; `codex models` dropped into the interactive UI instead of printing a catalog.",
      ].join("\n"),
    ];

    for (const text of texts) {
      expectExpectedCodexModelsCommandText(text);
    }
  });

  it("accepts missing codex shell PATH fallback with current-session model", () => {
    const texts = [
      [
        "I can only confirm the current session model here: `codex/gpt-5.4`.",
        "",
        "A direct `codex models` CLI lookup is not available in this environment because `codex` is not installed on the shell path.",
      ].join("\n"),
      [
        "`codex models` is not available in this environment because the `codex` CLI is not installed on `PATH`.",
        "",
        "The current session model is `codex/gpt-5.4`.",
      ].join("\n"),
    ];

    for (const text of texts) {
      expect(isExpectedCodexModelsCommandText(text)).toBe(true);
      expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
    }
  });

  it("accepts sandbox escalation rejection for codex models", () => {
    const texts = [
      "I couldn’t list them because `codex models` requires running outside the sandbox here, and that approval was rejected.",
      "I couldn’t list them because the local `codex models` command requires elevated execution in this environment, and that request was rejected.",
      "I couldn’t list them because the local `codex models` command requires host permissions here, and that escalation was rejected.",
      "I couldn’t run `codex models` because the sandboxed attempt failed and the required elevated retry was not approved.",
      [
        "I tried `codex models`, but the sandbox blocked it due to the kernel namespace restriction.",
        "I then requested an escalated run, but the automatic approval review failed before it could be approved.",
        "",
        "I can’t safely run the command from here right now.",
      ].join("\n"),
    ];

    for (const text of texts) {
      expect(isExpectedCodexModelsCommandText(text)).toBe(true);
      expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
    }
  });

  it("accepts the interactive TUI current-model summary", () => {
    const text = [
      "`codex models` didn’t return a plain list in this environment; it dropped into the interactive TUI instead.",
      "",
      "What I could confirm from that session is:",
      "- Codex CLI version: `v0.125.0`",
      "- Current selected model: `local-default-model`",
      "- The UI indicates `/model` is the command to change models",
    ].join("\n");

    expectRecognizedCodexModelsCommandText(text);
    expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
  });

  it("accepts the local Codex model-cache summary", () => {
    const text = [
      "Available models in this Codex install, from the local cache fetched on `2026-04-18`, are:",
      "",
      "- `gpt-5.4`",
      "- `local-default-model`",
      "- `gpt-5.4-mini`",
      "",
      "This session is currently running `codex/gpt-5.4` with `low` reasoning according to `/codex status`.",
    ].join("\n");

    expectStrictCodexModelsCommandText(text);
  });

  it("accepts the sandboxed CLI failure active-model summary", () => {
    const text = [
      "I couldn’t inspect the CLI model list because sandboxed `codex --help` failed on a namespace restriction, and the escalated retry was rejected.",
      "",
      "What I can confirm from the current session is:",
      "- Active model: `codex/gpt-5.4`",
    ].join("\n");

    expectExpectedCodexModelsCommandText(text);
  });

  it("rejects unrelated codex command output", () => {
    expect(isExpectedCodexModelsCommandText("Codex is healthy.")).toBe(false);
  });

  it("rejects generic current-status output that is not a model listing", () => {
    const text = [
      "Current: waiting for the Codex CLI to finish booting.",
      "Try again in a few seconds.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(false);
    expect(isExpectedCodexModelsCommandText(text)).toBe(false);
  });
});
