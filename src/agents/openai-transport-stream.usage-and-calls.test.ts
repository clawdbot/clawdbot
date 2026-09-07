import { describe, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  makeResponsesModel,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

describe("openai transport stream", () => {
  it("serializes raw string tool-call arguments without double-encoding them", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.4",
            usage: createZeroUsageFixture(),
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "toolCall",
                id: "call_abc|fc_item1",
                name: "my_tool",
                arguments: "not valid json",
              },
            ],
          },
        ],
        tools: [],
      } as never,
      undefined,
    ) as {
      input?: Array<{ type?: string; arguments?: string }>;
    };

    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      arguments: "not valid json",
    });
  });
});
