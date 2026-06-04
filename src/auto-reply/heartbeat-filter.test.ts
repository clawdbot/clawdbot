/** Tests heartbeat filtering and skip behavior for empty heartbeat context. */
import { describe, expect, it } from "vitest";
import {
  filterHeartbeatTranscriptArtifacts,
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
} from "./heartbeat-filter.js";
import {
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TRANSCRIPT_PROMPT,
  resolveHeartbeatPromptForResponseTool,
} from "./heartbeat.js";

describe("isHeartbeatUserMessage", () => {
  it("matches heartbeat prompts", () => {
    expect(
      isHeartbeatUserMessage(
        {
          role: "user",
          content: `${HEARTBEAT_PROMPT}\nWhen reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md (exact case). Do not read docs/heartbeat.md.`,
        },
        HEARTBEAT_PROMPT,
      ),
    ).toBe(true);

    expect(
      isHeartbeatUserMessage({
        role: "user",
        content:
          "Run the following periodic tasks (only those due based on their intervals):\n\n- email-check: Check for urgent unread emails\n\nAfter completing all due tasks, reply HEARTBEAT_OK.",
      }),
    ).toBe(true);

    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: HEARTBEAT_TRANSCRIPT_PROMPT,
      }),
    ).toBe(true);

    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: HEARTBEAT_RESPONSE_TOOL_PROMPT,
      }),
    ).toBe(true);

    const customHeartbeatPrompt = "Check the handoff queue.";
    expect(
      isHeartbeatUserMessage(
        {
          role: "user",
          content: `${resolveHeartbeatPromptForResponseTool(customHeartbeatPrompt)}\n\nUse workspace notes only.`,
        },
        customHeartbeatPrompt,
      ),
    ).toBe(true);
  });

  it("ignores quoted or non-user token mentions", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: "Please reply HEARTBEAT_OK so I can test something.",
      }),
    ).toBe(false);

    expect(
      isHeartbeatUserMessage({
        role: "assistant",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(false);
  });
});

describe("isHeartbeatOkResponse", () => {
  it("matches no-op heartbeat acknowledgements", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "**HEARTBEAT_OK**",
      }),
    ).toBe(true);

    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "You have 3 unread urgent emails. HEARTBEAT_OK",
      }),
    ).toBe(true);
  });

  it("preserves meaningful or non-text responses", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "Status HEARTBEAT_OK due to watchdog failure",
      }),
    ).toBe(false);

    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "search", input: {} }],
      }),
    ).toBe(false);

    const toolCallOnlyMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_heartbeat",
          function: {
            name: "heartbeat_respond",
            arguments: '{"notify":true}',
          },
        },
      ],
    } as { role: string; content?: unknown };
    expect(isHeartbeatOkResponse(toolCallOnlyMessage)).toBe(false);
  });

  it("respects ackMaxChars overrides", () => {
    expect(
      isHeartbeatOkResponse(
        {
          role: "assistant",
          content: "HEARTBEAT_OK all good",
        },
        0,
      ),
    ).toBe(false);
  });
});

describe("filterHeartbeatTranscriptArtifacts", () => {
  it("removes no-op heartbeat pairs", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ]);
  });

  it("removes OpenAI Responses input/output text heartbeat pairs", () => {
    for (const deliveryHint of [
      "Delivery: to send a message, use the `message` tool.",
      "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
    ]) {
      const messages = [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${deliveryHint} ${HEARTBEAT_TRANSCRIPT_PROMPT}`,
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "HEARTBEAT_OK" }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "what model are you" }],
        },
      ];

      expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
        {
          role: "user",
          content: [{ type: "input_text", text: "what model are you" }],
        },
      ]);
    }
  });

  it("removes prompt-only interrupted heartbeat spans", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes interrupted helper-only heartbeat spans", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash",
            name: "bash",
            arguments: { command: "cat HEARTBEAT.md" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked HEARTBEAT.md" }],
      },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes heartbeat response-tool spans and preserves the next real user message", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_bash", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked HEARTBEAT.md" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes full default response-tool prompt spans", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_RESPONSE_TOOL_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes native OpenAI Responses heartbeat function-call spans", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "call_bash",
            name: "bash",
            arguments: '{"command":"cat HEARTBEAT.md"}',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "function_call_output",
            call_id: "call_bash",
            output: "checked HEARTBEAT.md",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: '{"notify":false}',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "function_call_output",
            call_id: "call_heartbeat",
            output: '{"notify":false}',
          },
        ],
      },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes assistant continuations after heartbeat response-tool results", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      { role: "assistant", content: "No visible update. notify=false" },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("removes pre-terminal assistant text once a heartbeat ack arrives", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "assistant", content: "Checking heartbeat status..." },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
    ]);
  });

  it("preserves structured notify=true heartbeat response-tool alerts", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":true}' }],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves notify=true heartbeat response-tool alerts followed by a final ack", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":true}' }],
      },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves top-level notify=true heartbeat response-tool calls followed by a final ack", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_heartbeat",
            function: {
              name: "heartbeat_respond",
              arguments: JSON.stringify({
                outcome: "needs_attention",
                notify: true,
                summary: "Build is blocked.",
                notificationText: "Build is blocked on missing credentials.",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":true}' }],
      },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves OpenAI Responses notify=true heartbeat calls keyed by call_id", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            id: "fc_item_123",
            call_id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: JSON.stringify({
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            }),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "function_call_output",
            call_id: "call_heartbeat",
            output: '{"notify":true}',
          },
        ],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves Anthropic-style notify=true heartbeat calls keyed by tool_use_id", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_heartbeat",
            name: "heartbeat_respond",
            input: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_heartbeat",
            content: "recorded",
          },
        ],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves Anthropic-style notify=true heartbeat calls completed by mixed user turns", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_heartbeat",
            name: "heartbeat_respond",
            input: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_heartbeat",
            content: "recorded",
          },
          { type: "text", text: "heartbeat delivery recorded" },
        ],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("removes pending notify=true heartbeat response-tool calls without tool results", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what changed while I was away?" },
    ]);
  });

  it("removes failed notify=true heartbeat response-tool calls", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        isError: true,
        content: [{ type: "text", text: "heartbeat response rejected" }],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what changed while I was away?" },
    ]);
  });

  it("removes Anthropic-style failed notify=true heartbeat calls keyed by tool_use_id", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_heartbeat",
            name: "heartbeat_respond",
            input: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_heartbeat",
            is_error: true,
            content: "heartbeat response rejected",
          },
        ],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what changed while I was away?" },
    ]);
  });

  it("removes Anthropic-style error result heartbeat calls keyed by tool_use_id", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_heartbeat",
            name: "heartbeat_respond",
            input: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result_error",
            tool_use_id: "toolu_heartbeat",
            content: "heartbeat response rejected",
          },
        ],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what changed while I was away?" },
    ]);
  });

  it("does not treat unrelated helper tool results as completed notify=true responses", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash",
            name: "bash",
            arguments: { command: "cat HEARTBEAT.md" },
          },
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked HEARTBEAT.md" }],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what changed while I was away?" },
    ]);
  });

  it("removes heartbeat response-tool spans with notify=false even when alert fields are present", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: false,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":false}' }],
      },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what changed while I was away?" },
    ]);
  });

  it("preserves mixed user text after silent heartbeat response-tool spans", () => {
    const mixedUserMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_heartbeat",
          content: "recorded",
        },
        { type: "text", text: "what model are you" },
      ],
    };
    const assistantMessage = { role: "assistant", content: "I am OpenClaw." };
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_heartbeat",
            name: "heartbeat_respond",
            input: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
      },
      mixedUserMessage,
      assistantMessage,
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      mixedUserMessage,
      assistantMessage,
    ]);
  });

  it("stops a no-op span before a later visible heartbeat alert", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "assistant", content: "Build is blocked on a failing release check." },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "assistant", content: "Build is blocked on a failing release check." },
      { role: "user", content: "what changed while I was away?" },
    ]);
  });

  it("stops a prompt-only span before a later visible heartbeat alert", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "assistant", content: "Build is blocked on a failing release check." },
      { role: "user", content: "what changed while I was away?" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      { role: "assistant", content: "Build is blocked on a failing release check." },
      { role: "user", content: "what changed while I was away?" },
    ]);
  });

  it("does not remove across a real user message", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      { role: "user", content: "what model are you" },
      { role: "assistant", content: "notify=false" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "what model are you" },
      { role: "assistant", content: "notify=false" },
    ]);
  });

  it("preserves meaningful heartbeat output without terminal artifacts", () => {
    const meaningfulMessages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "Status HEARTBEAT_OK due to watchdog failure" },
    ];
    expect(
      filterHeartbeatTranscriptArtifacts(meaningfulMessages, undefined, HEARTBEAT_PROMPT),
    ).toEqual(meaningfulMessages);
  });

  it("preserves helper tool turns when the heartbeat produces a visible alert", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_bash", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked HEARTBEAT.md" }],
      },
      { role: "assistant", content: "Build is blocked on a failing release check." },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves top-level helper tool turns when the heartbeat produces a visible alert", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bash",
            function: {
              name: "bash",
              arguments: '{"command":"cat HEARTBEAT.md"}',
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked HEARTBEAT.md" }],
      },
      { role: "assistant", content: "Build is blocked on a failing release check." },
      { role: "user", content: "what model are you" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("keeps ordinary chats that mention the token", () => {
    const messages = [
      { role: "user", content: "Please reply HEARTBEAT_OK so I can test something." },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });
});
