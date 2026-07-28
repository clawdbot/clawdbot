import { describe, expect, it, vi } from "vitest";
import {
  createAzureResponsesModel,
  createResponsesAssistantOutput,
  streamChunks,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

// Terminal backfill for an incomplete turn is only safe while it stays a recovery path for
// streams that emitted nothing. These cover the two sides of that guard: an incomplete turn
// whose text arrived only on the terminal event, and one whose text already streamed.
describe("incomplete Responses terminal output", () => {
  it("does not replay terminal text that already streamed", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_streamed" },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg_streamed",
          delta: "STREAMED_HALF_SENTENCE",
        },
        {
          type: "response.incomplete",
          response: {
            id: "resp-streamed",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            // The terminal payload repeats what the stream already delivered; replaying it
            // would persist the same text twice in the assistant turn.
            output: [
              {
                type: "message",
                id: "msg_streamed",
                role: "assistant",
                content: [{ type: "text", text: "STREAMED_HALF_SENTENCE" }],
              },
            ],
            usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expect(output.content).toMatchObject([{ type: "text", text: "STREAMED_HALF_SENTENCE" }]);
    expect(output.stopReason).toBe("length");
  });

  it("keeps terminal-only text out of turns that stop for a non-length reason", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.incomplete",
          response: {
            id: "resp-filtered",
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            output: [
              {
                type: "message",
                id: "msg_filtered",
                role: "assistant",
                content: [{ type: "text", text: "FILTERED_PARTIAL" }],
              },
            ],
            usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12 },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    // A filtered turn is surfaced as an error, so its partial text is not a recoverable answer.
    expect(output.content).toEqual([]);
    expect(output.stopReason).toBe("error");
  });
});
