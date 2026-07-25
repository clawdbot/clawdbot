// Error payload tests ensure embedded runs convert provider/tool failures into
// concise user-facing replies without leaking raw provider bodies or secrets.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { formatBillingErrorMessage } from "../../embedded-agent-helpers.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import {
  buildPayloads,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads", () => {
  const OVERLOADED_FALLBACK_TEXT =
    "The AI service is temporarily overloaded. Please try again in a moment.";
  const errorJson =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
  const errorJsonPretty = `{
  "type": "error",
  "error": {
    "details": null,
    "type": "overloaded_error",
    "message": "Overloaded"
  },
  "request_id": "req_011CX7DwS7tSvggaNHmefwWg"
}`;
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

  const expectOverloadedFallback = (payloads: ReturnType<typeof buildPayloads>) => {
    // Overloaded JSON is normalized into stable copy rather than replayed as a
    // raw provider object.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(OVERLOADED_FALLBACK_TEXT);
  };

  const expectNoPayloadTextContaining = (
    payloads: ReturnType<typeof buildPayloads>,
    needle: string,
  ) => {
    expect(payloads.map((payload) => payload.text ?? "").join("\n")).not.toContain(needle);
  };

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
      toolMetas: [{ toolName: "write", meta: "/tmp/out.md" }],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
    });
  }

  it("suppresses raw API error JSON when the assistant errored", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJson],
      lastAssistant: makeAssistant({}),
    });

    expectOverloadedFallback(payloads);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.map((payload) => payload.text)).not.toContain(errorJson);
  });

  it("suppresses mutating tool warnings when an assistant error reply already covers the turn", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJson],
      lastAssistant: makeAssistant({}),
      lastToolError: { toolName: "edit", error: "file missing" },
      sessionKey: "agent:main:telegram:direct:u123",
    });

    expectOverloadedFallback(payloads);
    expect(payloads[0]?.isError).toBe(true);
    expectNoPayloadTextContaining(payloads, "Edit");
    expectNoPayloadTextContaining(payloads, "missing");
  });

  it("keeps mutating tool warnings when assistant error artifacts are not user-facing", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJson],
      lastAssistant: makeAssistant({}),
      lastToolError: { toolName: "edit", error: "file missing" },
      didSendDeterministicApprovalPrompt: true,
      sessionKey: "agent:main:telegram:direct:u123",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Edit",
      absentDetail: "missing",
    });
  });

  it("suppresses pretty-printed error JSON that differs from the errorMessage", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({ errorMessage: errorJson }),
      inlineToolResultsAllowed: true,
      verboseLevel: "on",
    });

    expectOverloadedFallback(payloads);
    expect(payloads.map((payload) => payload.text)).not.toContain(errorJsonPretty);
  });

  it("suppresses raw error JSON from fallback assistant text", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({ content: [{ type: "text", text: errorJsonPretty }] }),
    });

    expectOverloadedFallback(payloads);
    expectNoPayloadTextContaining(payloads, "request_id");
  });

  it("does not expose provider request ids from generic internal errors", () => {
    const rawError =
      "An error occurred while processing your request. Please include request ID req_synthetic_provider_request_001 in your message.";
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        errorMessage: rawError,
        content: [{ type: "text", text: rawError }],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "The AI service returned an internal error. Please try again in a moment.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "request ID");
    expectNoPayloadTextContaining(payloads, "req_synthetic_provider_request_001");
  });

  it("suppresses raw assistant error messages in user-facing reply payloads", () => {
    // Canary text proves raw provider error strings do not escape into channel
    // replies when the assistant stopped in an error state.
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: "SECRET_CANARY_69737",
        content: [],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request failed.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "SECRET_CANARY_69737");
  });

  it("surfaces a terminal error after only a message-tool progress update", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: "SECRET_PROGRESS_FAILURE",
        content: [],
      }),
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "discord",
          to: "channel:C1",
          sourceReplyFinal: false,
        },
      ],
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request failed.",
      isError: true,
    });
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
    expectNoPayloadTextContaining(payloads, "SECRET_PROGRESS_FAILURE");
  });

  it("keeps terminal errors suppressed after an explicit final message-tool reply", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: "SECRET_POST_FINAL_FAILURE",
        content: [],
      }),
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "discord",
          to: "channel:C1",
          sourceReplyFinal: true,
        },
      ],
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(payloads).toEqual([]);
  });

  it("suppresses structured provider error messages in user-facing reply payloads", () => {
    const rawError =
      '{"type":"error","error":{"type":"invalid_request_error","message":"SECRET_CANARY_69737"}}';
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: rawError,
        content: [{ type: "text", text: rawError }],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request failed: provider rejected the request schema or tool payload.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "SECRET_CANARY_69737");
    expectNoPayloadTextContaining(payloads, "LLM request rejected");
  });

  it("uses structured provider details for model-not-found reply payloads", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: "400 Param Incorrect",
        errorCode: "400",
        errorBody:
          '{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}',
        content: [],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "The selected model was not found by the provider. Check the model id or choose a different model.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "some-model-id");
    expectNoPayloadTextContaining(payloads, "Param Incorrect");
  });

  it("suppresses escaped structured provider error messages in user-facing reply payloads", () => {
    const rawError =
      '{"type":"error","error":{"type":"invalid_request_error","message":"SECRET\\nCANARY_69737"}}';
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: rawError,
        content: [{ type: "text", text: rawError }],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request failed: provider rejected the request schema or tool payload.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "SECRET");
    expectNoPayloadTextContaining(payloads, "CANARY_69737");
    expectNoPayloadTextContaining(payloads, "LLM request rejected");
  });

  it("surfaces OpenAI model capacity errors instead of generic empty-response copy", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        errorMessage: "Selected model is at capacity. Please try a different model.",
        content: [],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
      isError: true,
    });
  });

  it("suppresses aborted assistant partial text and surfaces a clean timeout error", () => {
    const payloads = buildPayloads({
      runAborted: true,
      assistantTexts: [
        "Need answer concise mention not fully E2E tested tomorrow.\n[[reply_to_current]] Final draft",
      ],
      lastAssistant: makeAssistant({
        stopReason: "aborted",
        errorMessage: "request timed out",
        content: [
          {
            type: "text",
            text: "Need answer concise mention not fully E2E tested tomorrow.\n[[reply_to_current]] Final draft",
          },
        ],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request timed out.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "Need answer concise");
    expectNoPayloadTextContaining(payloads, "[[reply_to_current]]");
  });

  it("suppresses raw aborted assistant error messages in user-facing reply payloads", () => {
    const payloads = buildPayloads({
      runAborted: true,
      assistantTexts: [],
      lastAssistant: makeAssistant({
        stopReason: "aborted",
        errorMessage: "SECRET_CANARY_69737",
        content: [],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request failed.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "SECRET_CANARY_69737");
  });

  it("suppresses aborted assistant reasoning text as well as partial answer text", () => {
    const payloads = buildPayloads({
      runAborted: true,
      assistantTexts: ["partial answer that should not leak"],
      lastAssistant: makeAssistant({
        stopReason: "aborted",
        errorMessage: "request timed out",
        content: [
          { type: "thinking", thinking: "partial hidden reasoning" },
          { type: "text", text: "partial answer that should not leak" },
        ],
      }),
      reasoningLevel: "on",
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request timed out.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "partial hidden reasoning");
    expectNoPayloadTextContaining(payloads, "partial answer that should not leak");
  });

  it("preserves aborted-without-error behavior without adding a generic error payload", () => {
    const payloads = buildPayloads({
      runAborted: true,
      assistantTexts: [],
      lastAssistant: makeAssistant({
        stopReason: "aborted",
        errorMessage: undefined,
        content: [],
      }),
    });

    expect(payloads).toHaveLength(0);
  });

  it("does not replay a stale previous assistant when an aborted run has no new text", () => {
    const payloads = buildPayloads({
      runAborted: true,
      assistantTexts: [],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "Previous completed assistant reply" }],
      }),
    });

    expect(payloads).toHaveLength(0);
  });

  it("includes provider and model context for billing errors", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        model: "claude-3-5-sonnet",
        errorMessage: "insufficient credits",
        content: [{ type: "text", text: "insufficient credits" }],
      }),
      provider: "Anthropic",
      model: "claude-3-5-sonnet",
    });

    expectSinglePayloadSummary(payloads, {
      text: formatBillingErrorMessage("Anthropic", "claude-3-5-sonnet"),
      isError: true,
    });
  });

  it("does not emit a synthetic billing error for successful turns with stale errorMessage", () => {
    // Some providers leave stale errorMessage fields on otherwise successful
    // assistant messages; stopReason/content decide user-facing output.
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: "insufficient credits for embedding model",
        content: [{ type: "text", text: "Handle payment required errors in your API." }],
      }),
    });

    expectSinglePayloadText(payloads, "Handle payment required errors in your API.");
  });

  it("suppresses raw error JSON even when errorMessage is missing", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({ errorMessage: undefined }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expectNoPayloadTextContaining(payloads, "request_id");
  });

  it("does not suppress error-shaped JSON when the assistant did not error", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeStoppedAssistant(),
    });

    expectSinglePayloadText(payloads, errorJsonPretty.trim());
  });

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

  it("does not add synthetic completion text when tools run without final assistant text", () => {
    expectNoPayloads({
      sessionKey: "agent:main:discord:direct:u123",
      toolMetas: [{ toolName: "write", meta: "/tmp/out.md" }],
      lastAssistant: makeStoppedAssistant(),
    });
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
      toolMetas: [{ toolName: "message_send", meta: "sent to #ops" }],
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
      toolMetas: [{ toolName: "browser", meta: "open https://example.com" }],
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

  it("keeps exec failure labels outside markdown command text", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 /path/to/daily-cost-audit.py",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ 🛠️ Exec failed: `python3 /path/to/daily-cost-audit.py` (exit 1)",
      isError: true,
    });
    expect(payloads[0]?.text).not.toContain("`run python3");
  });

  it("prefers raw exec metadata when tool progress detail includes it", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 /tmp/audit.py · `python3 /tmp/audit.py`",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ 🛠️ Exec failed: `python3 /tmp/audit.py` (exit 1)",
      isError: true,
    });
  });

  it("prefers raw exec metadata when the literal command contains backticks", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run node inline script, `node -e 'console.log(1, `x`)'`",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ 🛠️ Exec failed: ``node -e 'console.log(1, `x`)'`` (exit 1)",
      isError: true,
    });
  });

  it("preserves raw exec context before trailing raw command metadata", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 /tmp/audit.py, node: mac-1, `python3 /tmp/audit.py`",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ 🛠️ Exec failed: `node: mac-1 · python3 /tmp/audit.py` (exit 1)",
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
    });
    const workspaceNodePayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 audit.py (workspace), node: mac-1, `python3 audit.py`",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });
    const semanticCompactPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "check git status (repo), `git status`",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(cwdPayloads, {
      text: "⚠️ 🛠️ Exec failed: `python3 audit.py (in /tmp/build)` (exit 1)",
      isError: true,
    });
    expectSinglePayloadSummary(workspaceNodePayloads, {
      text: "⚠️ 🛠️ Exec failed: `node: mac-1 · python3 audit.py (workspace)` (exit 1)",
      isError: true,
    });
    expectSinglePayloadSummary(semanticCompactPayloads, {
      text: "⚠️ 🛠️ Exec failed: `git status (repo)` (exit 1)",
      isError: true,
    });
  });

  it("does not promote display-summary commas into raw exec context", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: 'search "foo,bar" in src, `rg "foo,bar" src`',
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(payloads, {
      text: '⚠️ 🛠️ Exec failed: `rg "foo,bar" src` (exit 1)',
      isError: true,
    });
  });

  it("does not treat parenthesized raw command arguments as cwd context", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: 'list files in (in progress) · `ls "(in progress)"`',
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(payloads, {
      text: '⚠️ 🛠️ Exec failed: `ls "(in progress)"` (exit 1)',
      isError: true,
    });
  });

  it("does not duplicate compact cwd labels already present in raw command arguments", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: 'print text (repo) · `printf "%s" "(repo)"`',
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(payloads, {
      text: '⚠️ 🛠️ Exec failed: `printf "%s" "(repo)"` (exit 1)',
      isError: true,
    });
  });

  it("strips literal synthetic run prefixes without stripping semantic run summaries", () => {
    const genericPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run make build",
        error: "Command failed with exit code 2",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });
    const semanticPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run tests",
        error: "Command failed with exit code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });
    const scriptPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run deploy",
        error: "Command failed with exit code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });
    const compoundPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run tests → install dependencies",
        error: "Command failed with exit code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });
    const inlineScriptPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run node inline script",
        error: "Command failed with exit code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });
    const heredocPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 inline script (heredoc)",
        error: "Command failed with exit code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });
    const sedSummaryPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run sed on file",
        error: "Command failed with exit code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });
    const pipelineSummaryPayloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run tests -> show first 3 lines",
        error: "Command failed with exit code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(genericPayloads, {
      text: "⚠️ 🛠️ Exec failed: `make build` (exit 2)",
      isError: true,
    });
    expectSinglePayloadSummary(semanticPayloads, {
      text: "⚠️ 🛠️ Exec failed: `run tests` (exit 1)",
      isError: true,
    });
    expectSinglePayloadSummary(scriptPayloads, {
      text: "⚠️ 🛠️ Exec failed: `run deploy` (exit 1)",
      isError: true,
    });
    expectSinglePayloadSummary(compoundPayloads, {
      text: "⚠️ 🛠️ Exec failed: `run tests → install dependencies` (exit 1)",
      isError: true,
    });
    expectSinglePayloadSummary(inlineScriptPayloads, {
      text: "⚠️ 🛠️ Exec failed: `run node inline script` (exit 1)",
      isError: true,
    });
    expectSinglePayloadSummary(heredocPayloads, {
      text: "⚠️ 🛠️ Exec failed: `run python3 inline script (heredoc)` (exit 1)",
      isError: true,
    });
    expectSinglePayloadSummary(sedSummaryPayloads, {
      text: "⚠️ 🛠️ Exec failed: `run sed on file` (exit 1)",
      isError: true,
    });
    expectSinglePayloadSummary(pipelineSummaryPayloads, {
      text: "⚠️ 🛠️ Exec failed: `run tests -> show first 3 lines` (exit 1)",
      isError: true,
    });
  });

  it("keeps arbitrary exec cwd suffixes inside markdown command text", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "run python3 /tmp/audit.py (in /tmp/build @everyone)",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ 🛠️ Exec failed: `python3 /tmp/audit.py (in /tmp/build @everyone)` (exit 1)",
      isError: true,
    });
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
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ 🛠️ Bash failed: `show matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt` (workspace) (exit 1)",
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
