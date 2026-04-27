import { describe, expect, it } from "vitest";
import {
  filterHeartbeatPairs,
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
} from "./heartbeat-filter.js";
import { HEARTBEAT_PROMPT, HEARTBEAT_TRANSCRIPT_PROMPT } from "./heartbeat.js";

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

describe("filterHeartbeatPairs", () => {
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

    expect(filterHeartbeatPairs(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ]);
  });

  it("keeps meaningful heartbeat results and non-text assistant turns", () => {
    const meaningfulMessages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "Status HEARTBEAT_OK due to watchdog failure" },
    ];
    expect(filterHeartbeatPairs(meaningfulMessages, undefined, HEARTBEAT_PROMPT)).toEqual(
      meaningfulMessages,
    );

    const nonTextMessages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "search", input: {} }],
      },
    ];
    expect(filterHeartbeatPairs(nonTextMessages, undefined, HEARTBEAT_PROMPT)).toEqual(
      nonTextMessages,
    );
  });

  it("keeps ordinary chats that mention the token", () => {
    const messages = [
      { role: "user", content: "Please reply HEARTBEAT_OK so I can test something." },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ];

    expect(filterHeartbeatPairs(messages, undefined, HEARTBEAT_PROMPT)).toEqual(messages);
  });
});
