/** Tests transcript replay conversion into ACP session update chunks. */
import { describe, expect, it } from "vitest";
import { extractReplayChunks } from "./translator.replay.js";

describe("ACP translator replay helpers", () => {
  it("maps plain user and assistant text into replay chunks", () => {
    expect(extractReplayChunks({ role: "user", content: "Question" })).toEqual([
      { sessionUpdate: "user_message_chunk", text: "Question" },
    ]);
    expect(extractReplayChunks({ role: "assistant", content: "Answer" })).toEqual([
      { sessionUpdate: "agent_message_chunk", text: "Answer" },
    ]);
  });

  it("preserves assistant thinking as hidden thought chunks", () => {
    expect(
      extractReplayChunks({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Internal reasoning" },
          { type: "text", text: "Visible answer" },
        ],
      }),
    ).toEqual([
      { sessionUpdate: "agent_thought_chunk", text: "Internal reasoning" },
      { sessionUpdate: "agent_message_chunk", text: "Visible answer" },
    ]);
  });

  it("drops unsupported roles, empty text, and non-text content", () => {
    expect(extractReplayChunks({ role: "system", content: "ignore" })).toEqual([]);
    expect(extractReplayChunks({ role: "assistant", content: "" })).toEqual([]);
    expect(
      extractReplayChunks({
        role: "assistant",
        content: [{ type: "image", image: "skip" }, null, []],
      }),
    ).toEqual([]);
  });
});
