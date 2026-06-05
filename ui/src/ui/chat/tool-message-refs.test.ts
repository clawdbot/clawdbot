// Control UI tests cover tool message refs behavior.
import { describe, expect, it } from "vitest";
import { extractToolMessageRefs } from "./tool-message-refs.ts";

describe("extractToolMessageRefs", () => {
  it("extracts canonical toolResult ids", () => {
    expect(
      extractToolMessageRefs({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "shell",
      }),
    ).toEqual([{ id: "call_1" }]);
  });

  it("extracts snake-case tool ids from standalone tool messages", () => {
    expect(
      extractToolMessageRefs({
        role: "tool",
        tool_call_id: "call_2",
        tool_name: "shell",
      }),
    ).toEqual([{ id: "call_2" }]);
  });

  it("extracts assistant tool-call block ids", () => {
    expect(
      extractToolMessageRefs({
        role: "assistant",
        content: [{ type: "toolcall", id: "call_3", name: "shell", arguments: {} }],
      }),
    ).toEqual([{ id: "call_3" }]);
  });

  it("extracts assistant tool-result block ids", () => {
    expect(
      extractToolMessageRefs({
        role: "assistant",
        content: [{ type: "tool_result", tool_use_id: "call_4", name: "shell", content: "ok" }],
      }),
    ).toEqual([{ id: "call_4" }]);
  });

  it("ignores plain assistant and user messages", () => {
    expect(extractToolMessageRefs({ role: "assistant", content: "hello" })).toEqual([]);
    expect(extractToolMessageRefs({ role: "user", content: "hello" })).toEqual([]);
  });
});
