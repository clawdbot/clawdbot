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

  it("suppresses raw API error JSON when the assistant errored", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJson],
      lastAssistant: makeAssistant({}),
    });

    expectOverloadedFallback(payloads);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.map((payload) => payload.text)).not.toContain(errorJson);
  });

  it("turns returned OpenAI refresh failures into Codex login recovery", () => {
    const payloads = buildPayloads({
      provider: "openai",
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: "OAuth token refresh failed for openai: refresh_token_invalidated",
        content: [],
      }),
    });

    expect(payloads).toEqual([
      {
        text: expect.stringContaining("/login codex"),
        isError: true,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Log in to Codex",
                  action: { type: "command", command: "/login codex" },
                },
              ],
            },
          ],
        },
      },
    ]);
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

  it("suppresses streamed assistant text and reasoning when the assistant errored", () => {
    const payloads = buildPayloads({
      assistantTexts: ["provider error details"],
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: "provider failed",
        content: [
          { type: "thinking", thinking: "partial hidden reasoning" },
          { type: "text", text: "provider error details" },
        ],
      }),
      reasoningLevel: "on",
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request failed.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "provider error details");
    expectNoPayloadTextContaining(payloads, "partial hidden reasoning");
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

  it("surfaces actionable numeric provider limits without replaying the raw error", () => {
    const rawError =
      "400 max_tokens (384000) exceeds model's maximum output tokens (65536) for model deepseek-v4-flash:0731";
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: rawError,
        content: [{ type: "text", text: rawError }],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "LLM request rejected: max_tokens is 384000, above the provider maximum of 65536. Lower max_tokens and try again.",
      isError: true,
    });
    expectNoPayloadTextContaining(payloads, "deepseek-v4-flash:0731");
  });

  it("keeps numeric limits generic for non-token parameters", () => {
    const rawError = "400 account_id (1234567890123456) exceeds maximum length (8)";
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
    expectNoPayloadTextContaining(payloads, "1234567890123456");
  });

  it("does not infer a token maximum from unrelated trailing digits", () => {
    const rawError = "400 max_tokens 384000 exceeds maximum for model gpt-5";
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
    expectNoPayloadTextContaining(payloads, "provider maximum of 5");
  });

  it("surfaces /new guidance for terminal thinking-signature replay failures", () => {
    const rawError =
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}';
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "error",
        errorMessage: rawError,
        content: [],
      }),
    });

    expectSinglePayloadSummary(payloads, {
      text: "Session history or replay state is invalid. Use /new to start a fresh session and try again.",
      isError: true,
    });
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

  it.each(["request timed out", "LLM request timed out."])(
    "defers assistant timeout %j to its terminal owner without changing tool-warning policy",
    (errorMessage) => {
      const payloads = buildPayloads({
        deferAssistantTimeoutError: true,
        runAborted: true,
        assistantTexts: [],
        lastAssistant: makeAssistant({
          stopReason: "aborted",
          errorMessage,
          content: [],
        }),
        lastToolError: {
          toolName: "exec",
          error: "command exited with code 1",
          middlewareError: true,
        },
      });

      expect(payloads).toEqual([]);
    },
  );

  it.each([
    {
      label: "connection failures",
      rawError: "connect ECONNREFUSED 127.0.0.1:443",
      visibleError: "connection refused",
    },
    {
      label: "authentication refresh timeouts",
      rawError:
        'OAuth refresh call "refreshProviderOAuthCredentialWithPlugin(openai)" exceeded hard timeout (120000ms)',
      visibleError: "Authentication refresh timed out",
    },
  ])(
    "preserves $label while terminal timeout handling is deferred",
    ({ rawError, visibleError }) => {
      const payloads = buildPayloads({
        deferAssistantTimeoutError: true,
        runAborted: true,
        assistantTexts: [],
        lastAssistant: makeAssistant({
          stopReason: "aborted",
          errorMessage: rawError,
          content: [],
        }),
      });

      expect(payloads).toEqual([{ text: expect.stringContaining(visibleError), isError: true }]);
    },
  );

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
});
