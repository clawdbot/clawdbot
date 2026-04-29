import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { formatBillingErrorMessage } from "../../pi-embedded-helpers.js";
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
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(OVERLOADED_FALLBACK_TEXT);
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
    expect(payloads.some((payload) => payload.text === errorJson)).toBe(false);
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
    expect(payloads.some((payload) => payload.text?.includes("Edit"))).toBe(false);
    expect(payloads.some((payload) => payload.text?.includes("missing"))).toBe(false);
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
    expect(payloads.some((payload) => payload.text === errorJsonPretty)).toBe(false);
  });

  it("suppresses raw error JSON from fallback assistant text", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({ content: [{ type: "text", text: errorJsonPretty }] }),
    });

    expectOverloadedFallback(payloads);
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
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
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
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

  it("adds tool error fallback when the assistant only invoked tools and verbose mode is on", () => {
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
      detail: "code 1",
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
      name: "still shows mutating tool errors when messages.suppressToolErrors is enabled",
      payload: {
        lastToolError: { toolName: "write", error: "connection timeout" },
        config: { messages: { suppressToolErrors: true } },
      },
      title: "Write",
      absentDetail: "connection timeout",
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
  ])("$name", ({ payload, title, absentDetail }) => {
    const payloads = buildPayloads(payload);
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
    expect(warningText).toBeTruthy();

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

  it("includes non-recoverable tool error details when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "connection timeout" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Browser",
      detail: "connection timeout",
    });
  });
});
