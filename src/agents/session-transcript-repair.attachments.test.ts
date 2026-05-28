import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, it, expect } from "vitest";
import { sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

function mkSessionsSpawnToolCall(content: string): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "sessions_spawn",
        arguments: {
          task: "do thing",
          attachments: [
            {
              name: "README.md",
              encoding: "utf8",
              content,
            },
          ],
        },
      },
    ],
    timestamp: 0,
  });
}

describe("sanitizeToolCallInputs preserves sessions_spawn payloads", () => {
  it("keeps attachment content in transcript-owned tool calls", () => {
    const content = "LOCAL_ATTACHMENT_CONTENT";
    const input = [mkSessionsSpawnToolCall(content)];
    const out = sanitizeToolCallInputs(input);

    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(content);
  });

  it("keeps attachment content from tool input payloads too", () => {
    const content = "INPUT_ATTACHMENT_CONTENT";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_2",
            name: "sessions_spawn",
            input: {
              task: "do thing",
              attachments: [{ name: "x.txt", content }],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(content);
  });

  it("keeps non-content attachment payload fields unchanged", () => {
    const nestedValue = "NESTED_ATTACHMENT_VALUE";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_3",
            name: "sessions_spawn",
            input: {
              task: "do thing",
              attachments: [
                {
                  name: "payload.json",
                  mimeType: "application/json",
                  encoding: "utf8",
                  data: nestedValue,
                  nested: { value: nestedValue },
                },
              ],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(nestedValue);
  });

  it("keeps ACP routing fields unchanged", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_4",
            name: "sessions_spawn",
            arguments: {
              task: "do thing",
              resumeSessionId: "argument-session",
              streamTo: "parent",
            },
          },
          {
            type: "toolUse",
            id: "call_5",
            name: "sessions_spawn",
            input: {
              task: "do other thing",
              resumeSessionId: "input-session",
              streamTo: "parent",
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
  });
});
