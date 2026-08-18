// Tool warning tests ensure failed actions remain visible without exposing
// verbose execution details unless the operator explicitly requests them.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
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

  it("does not add synthetic completion text when the run still has a tool error", () => {
    expectNoPayloads({
      lastToolError: { toolName: "browser", error: "url required" },
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

  it.each(["url required", "url missing", "invalid parameter: url"])(
    "suppresses recoverable non-mutating tool error: %s",
    (error) => {
      expectNoPayloads({
        lastToolError: { toolName: "browser", error },
      });
    },
  );

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

  it.each([
    {
      name: "suppresses mutating tool errors when messages.suppressToolErrors is enabled",
      payload: {
        lastToolError: { toolName: "write", error: "connection timeout" },
        config: { messages: { suppressToolErrors: true } },
      },
      title: "Write",
      absentDetail: "connection timeout",
      suppressed: true,
    },
    {
      name: "shows recoverable tool errors for mutating tools",
      payload: {
        lastToolError: { toolName: "message", meta: "reply", error: "text required" },
      },
      title: "Message",
      absentDetail: "required",
    },
    {
      name: "shows non-recoverable tool failure summaries to the user",
      payload: {
        lastToolError: { toolName: "browser", error: "connection timeout" },
      },
      title: "Browser",
      absentDetail: "connection timeout",
    },
  ])("$name", ({ payload, title, absentDetail, suppressed }) => {
    const payloads = buildPayloads(payload);
    if (suppressed) {
      expect(payloads).toEqual([]);
      return;
    }
    expectSingleToolErrorPayload(payloads, { title, absentDetail });
  });

  it("shows mutating tool errors when assistant output claims success", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Done."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { toolName: "write", error: "file missing" },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.text).toBe("Done.");
    expect(payloads[1]?.isError).toBe(true);
    expect(payloads[1]?.text).toContain("Write");
    expect(payloads[1]?.text).not.toContain("missing");
    expect(getReplyPayloadMetadata(payloads[1] as object)?.nonTerminalToolErrorWarning).toBe(
      undefined,
    );
  });

  it("still shows write tool errors when timedOut is true but no fileTarget was recorded", () => {
    // Without `fileTarget` we cannot distinguish a confirmed file write from
    // an unrelated mutating-tool timeout, so the default-visible warning is
    // preserved to avoid hiding real failures.
    const payloads = buildPayloads({
      assistantTexts: ["Done."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "write",
        error: "invoke timed out",
        timedOut: true,
        mutatingAction: true,
      },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[1]?.isError).toBe(true);
    expect(payloads[1]?.text).toContain("Write");
  });

  it("still shows write tool errors when timedOut and fileTarget only prove the attempted path", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Done."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "write",
        error: "invoke timed out",
        timedOut: true,
        mutatingAction: true,
        fileTarget: { path: "/tmp/openclaw/output.md" },
      },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[1]?.isError).toBe(true);
    expect(payloads[1]?.text).toContain("Write");
  });

  it("does not warn for timed-out exec errors when a successful user-facing reply exists", () => {
    // Exec/bash use the generic recovery rule, not the mutating-tool branch:
    // a successful final reply is proof the agent recovered (#103574).
    const payloads = buildPayloads({
      assistantTexts: ["The script is ready."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "exec",
        error: "command timed out",
        timedOut: true,
        mutatingAction: true,
      },
    });

    expectSinglePayloadSummary(payloads, { text: "The script is ready." });
  });

  it("does not warn for exec-like tool errors when a successful user-facing reply exists", () => {
    // Production repro: mid-run bash/exec failure recovered with a correct final answer.
    const payloads = buildPayloads({
      assistantTexts: ["The script is ready to use and saved in your workspace."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "exec",
        error: "/bin/bash: line 1: python: command not found",
        mutatingAction: true,
      },
    });

    expectSinglePayloadSummary(payloads, {
      text: "The script is ready to use and saved in your workspace.",
    });
  });

  it("does not warn for bash tool errors when a successful user-facing reply exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Recovered after the command failed."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "bash",
        error: "exit code 1",
        mutatingAction: true,
      },
    });

    expectSinglePayloadSummary(payloads, { text: "Recovered after the command failed." });
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

  it("keeps exec-like tool error warnings for recoverable-looking errors when there is no reply", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "bash",
        error: "invalid argument: missing required flag --agent",
        mutatingAction: true,
      },
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Bash",
      absentDetail: "missing required flag",
    });
  });

  it("suppresses exec-like tool errors when messages.suppressToolErrors is enabled", () => {
    expectNoPayloads({
      lastToolError: {
        toolName: "bash",
        error: "command not found",
        mutatingAction: true,
      },
      config: { messages: { suppressToolErrors: true } },
    });
  });

  it("shows mutating tool errors when assistant output does not acknowledge the failure", () => {
    const payloads = buildPayloads({
      assistantTexts: ["No issues found. The update is complete."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { toolName: "edit", error: "file missing" },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.text).toBe("No issues found. The update is complete.");
    expect(payloads[1]?.isError).toBe(true);
    expect(payloads[1]?.text).toContain("Edit");
    expect(payloads[1]?.text).not.toContain("missing");
  });

  it("shows mutating tool errors when assistant says it did not find issues in the file", () => {
    const text = "I did not find any issues in the file. The update is complete.";
    const payloads = buildPayloads({
      assistantTexts: [text],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { toolName: "edit", error: "file missing" },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.text).toBe(text);
    expect(payloads[1]?.isError).toBe(true);
    expect(payloads[1]?.text).toContain("Edit");
    expect(payloads[1]?.text).not.toContain("missing");
  });

  it.each([
    "I did not need to update the file; it is already correct.",
    "I did not have to edit the file because it was already correct.",
  ])("shows mutating tool errors when assistant output uses no-op phrasing: %s", (text) => {
    const payloads = buildPayloads({
      assistantTexts: [text],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { toolName: "edit", error: "file missing" },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.text).toBe(text);
    expect(payloads[1]?.isError).toBe(true);
    expect(payloads[1]?.text).toContain("Edit");
    expect(payloads[1]?.text).not.toContain("missing");
  });

  it("suppresses mutating tool errors when assistant output explicitly acknowledges the failed action", () => {
    const text = "I couldn't update the file, so no changes were applied.";
    const payloads = buildPayloads({
      assistantTexts: [text],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { toolName: "edit", error: "file missing" },
    });

    expectSinglePayloadSummary(payloads, { text });
  });

  it("suppresses exec warnings when assistant output explicitly acknowledges the command failure", () => {
    const text = "I couldn't run the command because python was not found.";
    const payloads = buildPayloads({
      assistantTexts: [text],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { toolName: "exec", error: "/bin/bash: line 1: python: command not found" },
    });

    expectSinglePayloadSummary(payloads, { text });
  });

  it("does not treat session_status read failures as mutating when explicitly flagged", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Status loaded."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "session_status",
        error: "model required",
        mutatingAction: false,
      },
    });

    expectSinglePayloadSummary(payloads, { text: "Status loaded." });
  });

  it("dedupes identical tool warning text already present in assistant output", () => {
    const seed = buildPayloads({
      lastToolError: {
        toolName: "write",
        error: "file missing",
        mutatingAction: true,
      },
    });
    const warningText = seed[0]?.text;
    expect(warningText).toBe("⚠️ ✍️ Write failed");

    const payloads = buildPayloads({
      assistantTexts: [warningText ?? ""],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "write",
        error: "file missing",
        mutatingAction: true,
      },
    });

    expectSinglePayloadSummary(payloads, { text: warningText ?? "" });
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
      text: "⚠️ 🛠️ Exec failed (exit 1)",
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
      text: "⚠️ 🛠️ Exec failed: `python3 /path/to/daily-cost-audit.py`: Command exited with code 1",
      isError: true,
    });
    expect(payloads[0]?.text).not.toContain("`run python3");
  });

  it.each([
    {
      title: "prefers raw exec metadata when tool progress detail includes it",
      meta: "run python3 /tmp/audit.py · `python3 /tmp/audit.py`",
      toolResultFormat: "markdown",
      expected: "⚠️ 🛠️ Exec failed: `python3 /tmp/audit.py`: Command exited with code 1",
    },
    {
      title: "prefers raw exec metadata when the literal command contains backticks",
      meta: "run node inline script, `node -e 'console.log(1, `x`)'`",
      toolResultFormat: "markdown",
      expected: "⚠️ 🛠️ Exec failed: ``node -e 'console.log(1, `x`)'``: Command exited with code 1",
    },
    {
      title: "leaves exec metadata unwrapped for plain tool results",
      meta: "run node inline script, `node -e 'console.log(1, `x`)'`",
      toolResultFormat: "plain",
      expected: "⚠️ 🛠️ Exec failed: node -e 'console.log(1, `x`)': Command exited with code 1",
    },
    {
      title: "preserves raw exec context before trailing raw command metadata",
      meta: "run python3 /tmp/audit.py, node: mac-1, `python3 /tmp/audit.py`",
      toolResultFormat: "markdown",
      expected:
        "⚠️ 🛠️ Exec failed: `node: mac-1 · python3 /tmp/audit.py`: Command exited with code 1",
    },
    {
      title: "does not promote display-summary commas into raw exec context",
      meta: 'search "foo,bar" in src, `rg "foo,bar" src`',
      toolResultFormat: "markdown",
      expected: '⚠️ 🛠️ Exec failed: `rg "foo,bar" src`: Command exited with code 1',
    },
    {
      title: "does not treat parenthesized raw command arguments as cwd context",
      meta: 'list files in (in progress) · `ls "(in progress)"`',
      toolResultFormat: "markdown",
      expected: '⚠️ 🛠️ Exec failed: `ls "(in progress)"`: Command exited with code 1',
    },
    {
      title: "does not duplicate compact cwd labels already present in raw command arguments",
      meta: 'print text (repo) · `printf "%s" "(repo)"`',
      toolResultFormat: "markdown",
      expected: '⚠️ 🛠️ Exec failed: `printf "%s" "(repo)"`: Command exited with code 1',
    },
    {
      title: "keeps arbitrary exec cwd suffixes inside markdown command text",
      meta: "run python3 /tmp/audit.py (in /tmp/build @everyone)",
      toolResultFormat: "markdown",
      expected:
        "⚠️ 🛠️ Exec failed: `python3 /tmp/audit.py (in /tmp/build @everyone)`: Command exited with code 1",
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
      text: "⚠️ 🛠️ Exec failed: `python3 audit.py (in /tmp/build)`: Command exited with code 1",
      isError: true,
    });
    expectSinglePayloadSummary(workspaceNodePayloads, {
      text: "⚠️ 🛠️ Exec failed: `node: mac-1 · python3 audit.py (workspace)`: Command exited with code 1",
      isError: true,
    });
    expectSinglePayloadSummary(semanticCompactPayloads, {
      text: "⚠️ 🛠️ Exec failed: `git status (repo)`: Command exited with code 1",
      isError: true,
    });
  });

  it.each([
    {
      name: "strips a literal synthetic run prefix",
      meta: "run make build",
      error: "Command failed with exit code 2",
      expected: "⚠️ 🛠️ Exec failed: `make build`: Command failed with exit code 2",
    },
    {
      name: "preserves a semantic test summary",
      meta: "run tests",
      error: "Command failed with exit code 1",
      expected: "⚠️ 🛠️ Exec failed: `run tests`: Command failed with exit code 1",
    },
    {
      name: "preserves a semantic deploy summary",
      meta: "run deploy",
      error: "Command failed with exit code 1",
      expected: "⚠️ 🛠️ Exec failed: `run deploy`: Command failed with exit code 1",
    },
    {
      name: "preserves a compound summary",
      meta: "run tests → install dependencies",
      error: "Command failed with exit code 1",
      expected:
        "⚠️ 🛠️ Exec failed: `run tests → install dependencies`: Command failed with exit code 1",
    },
    {
      name: "preserves an inline-script summary",
      meta: "run node inline script",
      error: "Command failed with exit code 1",
      expected: "⚠️ 🛠️ Exec failed: `run node inline script`: Command failed with exit code 1",
    },
    {
      name: "preserves a heredoc summary",
      meta: "run python3 inline script (heredoc)",
      error: "Command failed with exit code 1",
      expected:
        "⚠️ 🛠️ Exec failed: `run python3 inline script (heredoc)`: Command failed with exit code 1",
    },
    {
      name: "preserves a sed summary",
      meta: "run sed on file",
      error: "Command failed with exit code 1",
      expected: "⚠️ 🛠️ Exec failed: `run sed on file`: Command failed with exit code 1",
    },
    {
      name: "preserves a pipeline summary",
      meta: "run tests -> show first 3 lines",
      error: "Command failed with exit code 1",
      expected:
        "⚠️ 🛠️ Exec failed: `run tests -> show first 3 lines`: Command failed with exit code 1",
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
      text: "⚠️ 🛠️ Bash failed: `show matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt` (workspace): Command exited with code 1",
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
