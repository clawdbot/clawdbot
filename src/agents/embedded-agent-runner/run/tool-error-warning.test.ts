// Tool warning tests ensure failed actions remain visible without exposing
// verbose execution details unless the operator explicitly requests them.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import {
  buildPayloads,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool warnings", () => {
  const errorJson =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
  const makeAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage =>
    // Default to an overloaded provider error so each test can override only
    // the assistant fields relevant to user-visible payload sanitization.
    makeAssistantMessageFixture({
      errorMessage: errorJson,
      content: [{ type: "text", text: errorJson }],
      ...overrides,
    });
  const makeStoppedAssistant = () =>
    makeAssistant({
      stopReason: "stop",
      errorMessage: undefined,
      content: [],
    });

  function expectSinglePayloadSummary(
    payloads: ReturnType<typeof buildPayloads>,
    expected: { text: string; isError?: boolean },
  ) {
    expectSinglePayloadText(payloads, expected.text);
    if (expected.isError === undefined) {
      expect(payloads[0]?.isError).toBeUndefined();
      return;
    }
    expect(payloads[0]?.isError).toBe(expected.isError);
  }

  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
    const payloads = buildPayloads(params);
    expect(payloads).toHaveLength(0);
  }

  function expectNoSyntheticCompletionForSession(sessionKey: string) {
    expectNoPayloads({
      sessionKey,
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
    });
  }

  it("adds a fallback error when a tool fails and no assistant output exists", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "tab not found" },
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Browser",
      absentDetail: "tab not found",
    });
  });

  it("does not add tool error fallback when assistant output exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["All good"],
      lastAssistant: makeStoppedAssistant(),
      lastToolError: { toolName: "browser", error: "tab not found" },
    });

    expectSinglePayloadText(payloads, "All good");
  });

  it("does not add synthetic completion text for channel sessions", () => {
    expectNoSyntheticCompletionForSession("agent:main:discord:channel:c123");
  });

  it("does not add synthetic completion text for group sessions", () => {
    expectNoSyntheticCompletionForSession("agent:main:telegram:group:g123");
  });

  it("does not add synthetic completion text when messaging tool already delivered output", () => {
    expectNoPayloads({
      sessionKey: "agent:main:discord:direct:u123",
      didSendViaMessagingTool: true,
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
    });
  });

  it("does not add synthetic completion text when no tools ran", () => {
    expectNoPayloads({
      lastAssistant: makeStoppedAssistant(),
    });
  });

  it("adds compact tool error fallback when the assistant only invoked tools and verbose mode is on", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "toolUse",
        errorMessage: undefined,
        content: [
          {
            type: "toolCall",
            id: "toolu_01",
            name: "exec",
            arguments: { command: "echo hi" },
          },
        ],
      }),
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      absentDetail: "code 1",
    });
  });

  it("does not add tool error fallback when assistant text exists after tool calls", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Checked the page and recovered with final answer."],
      lastAssistant: makeAssistant({
        stopReason: "toolUse",
        errorMessage: undefined,
        content: [
          {
            type: "toolCall",
            id: "toolu_01",
            name: "browser",
            arguments: { action: "search", query: "openclaw docs" },
          },
        ],
      }),
      lastToolError: { toolName: "browser", error: "connection timeout" },
    });

    expectSinglePayloadSummary(payloads, {
      text: "Checked the page and recovered with final answer.",
    });
  });

  it("suppresses non-mutating non-recoverable tool errors when messages.suppressToolErrors is enabled", () => {
    expectNoPayloads({
      lastToolError: { toolName: "browser", error: "connection timeout" },
      config: { messages: { suppressToolErrors: true } },
    });
  });

  it("suppresses mutating tool errors when suppressToolErrorWarnings is enabled", () => {
    expectNoPayloads({
      lastToolError: { toolName: "exec", error: "command not found" },
      suppressToolErrorWarnings: true,
    });
  });

  it("keeps exec-like tool error warnings when there is no user-facing reply", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        error: "/bin/bash: line 1: python: command not found",
        mutatingAction: true,
      },
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      absentDetail: "python: command not found",
    });
  });

  it.each(["bash", "write"])(
    "includes a semantic %s timeout explanation at normal verbosity",
    (toolName) => {
      const timeoutExplanation = "approval wait expired";
      const payloads = buildPayloads({
        lastToolError: {
          toolName,
          error: timeoutExplanation,
          errorCode: "approval_timeout",
          timedOut: true,
        },
        verboseLevel: "on",
      });

      expect(payloads[0]?.text).toContain(timeoutExplanation);
    },
  );

  it("treats a user-facing reply as authoritative after a mutating tool failure", () => {
    const payloads = buildPayloads({
      assistantTexts: ["No issues found. The update is complete."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { toolName: "edit", error: "file missing" },
    });

    expectSinglePayloadSummary(payloads, {
      text: "No issues found. The update is complete.",
    });
  });

  it("hides exec command and cwd metadata without full verbosity", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 /path/to/daily-cost-audit.py (in /private/workspace)",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
      verboseLevel: "off",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ Exec failed (exit 1)",
      isError: true,
    });
  });

  it("keeps full-verbose exec failure labels outside markdown command text", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 /path/to/daily-cost-audit.py",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
      verboseLevel: "full",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ Exec failed: `python3 /path/to/daily-cost-audit.py`: Command exited with code 1",
      isError: true,
    });
    expect(payloads[0]?.text).not.toContain("`run python3");
  });

  it.each([
    [false, "off", "⚠️ Exec blocked (exit 7)"],
    [false, "full", "⚠️ Exec blocked: `make build`: Command exited with code 7"],
    [true, "off", "⚠️ Exec failed (exit 7)"],
    [true, "full", "⚠️ Exec failed: `make build`: Command exited with code 7"],
    [undefined, "off", "⚠️ Exec failed (exit 7)"],
    [undefined, "full", "⚠️ Exec failed: `make build`: Command exited with code 7"],
  ] as const)(
    "renders executionStarted=%s at %s verbosity from structured state",
    (executionStarted, verboseLevel, expected) => {
      expectSinglePayloadText(
        buildPayloads({
          lastToolError: {
            toolName: "exec",
            executionStarted,
            meta: "run make build",
            error: "Command exited with code 7",
          },
          toolResultFormat: "markdown",
          verboseLevel,
        }),
        expected,
      );
    },
  );

  it.each([
    {
      title: "prefers raw exec metadata when tool progress detail includes it",
      meta: "run python3 /tmp/audit.py · `python3 /tmp/audit.py`",
      toolResultFormat: "markdown",
      expected: "⚠️ Exec failed: `python3 /tmp/audit.py`: Command exited with code 1",
    },
    {
      title: "prefers raw exec metadata when the literal command contains backticks",
      meta: "run node inline script, `node -e 'console.log(1, `x`)'`",
      toolResultFormat: "markdown",
      expected: "⚠️ Exec failed: ``node -e 'console.log(1, `x`)'``: Command exited with code 1",
    },
    {
      title: "leaves exec metadata unwrapped for plain tool results",
      meta: "run node inline script, `node -e 'console.log(1, `x`)'`",
      toolResultFormat: "plain",
      expected: "⚠️ Exec failed: node -e 'console.log(1, `x`)': Command exited with code 1",
    },
    {
      title: "preserves raw exec context before trailing raw command metadata",
      meta: "run python3 /tmp/audit.py, node: mac-1, `python3 /tmp/audit.py`",
      toolResultFormat: "markdown",
      expected: "⚠️ Exec failed: `node: mac-1 · python3 /tmp/audit.py`: Command exited with code 1",
    },
    {
      title: "does not promote display-summary commas into raw exec context",
      meta: 'search "foo,bar" in src, `rg "foo,bar" src`',
      toolResultFormat: "markdown",
      expected: '⚠️ Exec failed: `rg "foo,bar" src`: Command exited with code 1',
    },
    {
      title: "does not treat parenthesized raw command arguments as cwd context",
      meta: 'list files in (in progress) · `ls "(in progress)"`',
      toolResultFormat: "markdown",
      expected: '⚠️ Exec failed: `ls "(in progress)"`: Command exited with code 1',
    },
    {
      title: "does not duplicate compact cwd labels already present in raw command arguments",
      meta: 'print text (repo) · `printf "%s" "(repo)"`',
      toolResultFormat: "markdown",
      expected: '⚠️ Exec failed: `printf "%s" "(repo)"`: Command exited with code 1',
    },
    {
      title: "keeps arbitrary exec cwd suffixes inside markdown command text",
      meta: "run python3 /tmp/audit.py (in /tmp/build @everyone)",
      toolResultFormat: "markdown",
      expected:
        "⚠️ Exec failed: `python3 /tmp/audit.py (in /tmp/build @everyone)`: Command exited with code 1",
    },
  ] as const)("$title", ({ meta, toolResultFormat, expected }) => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta,
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat,
      verboseLevel: "full",
    });

    expectSinglePayloadSummary(payloads, {
      text: expected,
      isError: true,
    });
  });

  it("preserves raw exec cwd context before trailing raw command metadata", () => {
    const cwdPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 audit.py (in /tmp/build) · `python3 audit.py`",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
      verboseLevel: "full",
    });
    const workspaceNodePayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 audit.py (workspace), node: mac-1, `python3 audit.py`",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
      verboseLevel: "full",
    });
    const semanticCompactPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "check git status (repo), `git status`",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
      verboseLevel: "full",
    });

    expectSinglePayloadSummary(cwdPayloads, {
      text: "⚠️ Exec failed: `python3 audit.py (in /tmp/build)`: Command exited with code 1",
      isError: true,
    });
    expectSinglePayloadSummary(workspaceNodePayloads, {
      text: "⚠️ Exec failed: `node: mac-1 · python3 audit.py (workspace)`: Command exited with code 1",
      isError: true,
    });
    expectSinglePayloadSummary(semanticCompactPayloads, {
      text: "⚠️ Exec failed: `git status (repo)`: Command exited with code 1",
      isError: true,
    });
  });

  it.each([
    {
      name: "strips a literal synthetic run prefix",
      meta: "run make build",
      error: "Command failed with exit code 2",
      expected: "⚠️ Exec failed: `make build`: Command failed with exit code 2",
    },
    {
      name: "preserves a semantic test summary",
      meta: "run tests",
      error: "Command failed with exit code 1",
      expected: "⚠️ Exec failed: `run tests`: Command failed with exit code 1",
    },
    {
      name: "preserves a semantic deploy summary",
      meta: "run deploy",
      error: "Command failed with exit code 1",
      expected: "⚠️ Exec failed: `run deploy`: Command failed with exit code 1",
    },
    {
      name: "preserves a compound summary",
      meta: "run tests → install dependencies",
      error: "Command failed with exit code 1",
      expected:
        "⚠️ Exec failed: `run tests → install dependencies`: Command failed with exit code 1",
    },
    {
      name: "preserves an inline-script summary",
      meta: "run node inline script",
      error: "Command failed with exit code 1",
      expected: "⚠️ Exec failed: `run node inline script`: Command failed with exit code 1",
    },
    {
      name: "preserves a heredoc summary",
      meta: "run python3 inline script (heredoc)",
      error: "Command failed with exit code 1",
      expected:
        "⚠️ Exec failed: `run python3 inline script (heredoc)`: Command failed with exit code 1",
    },
    {
      name: "preserves a sed summary",
      meta: "run sed on file",
      error: "Command failed with exit code 1",
      expected: "⚠️ Exec failed: `run sed on file`: Command failed with exit code 1",
    },
    {
      name: "preserves a pipeline summary",
      meta: "run tests -> show first 3 lines",
      error: "Command failed with exit code 1",
      expected:
        "⚠️ Exec failed: `run tests -> show first 3 lines`: Command failed with exit code 1",
    },
  ])("formats exec metadata: $name", ({ meta, error, expected }) => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta,
        error,
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
      verboseLevel: "full",
    });

    expectSinglePayloadSummary(payloads, { text: expected, isError: true });
  });

  it("wraps markdown-capable mutating tool warnings so mention-looking names stay inert", () => {
    // Non-recoverable error so the generic exec-like rule still surfaces a warning
    // for this no-reply formatting case (recoverable keywords would suppress it).
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "bash",
        meta: "show matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt (workspace)",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
      verboseLevel: "full",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ Bash failed: `show matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt` (workspace): Command exited with code 1",
      isError: true,
    });
  });

  it("keeps non-recoverable tool errors compact when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "connection timeout" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Browser",
      absentDetail: "connection timeout",
    });
  });

  it("includes non-recoverable tool error details when verbose mode is full", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "connection timeout" },
      verboseLevel: "full",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Browser",
      detail: "connection timeout",
    });
  });
});
