import type { AssistantMessage, Context, Model, ToolResultMessage } from "@openclaw/llm-core";
import type { ResponseOutputItem } from "openai/resources/responses/responses.js";
import { expect, it } from "vitest";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import { resolveResponsesContinuationRequest } from "./openai-responses-continuation.js";
import {
  responsesInputFingerprint,
  recordResponsesInputReplay,
} from "./openai-responses-input-replay.js";
import {
  convertProviderResponsesMessages,
  convertResponsesMessages,
  createOpenAIResponsesAssistantOutput,
  encodeTextSignatureV1,
} from "./openai-responses-replay-messages-internal.js";

const model: Model = {
  id: "async-model",
  name: "Async Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

it.each([
  ["provider early result", convertProviderResponsesMessages, true, false],
  ["provider late result", convertProviderResponsesMessages, false, false],
  ["transport early result", convertResponsesMessages, true, false],
  ["transport late result", convertResponsesMessages, false, false],
  ["provider terminal response identity", convertProviderResponsesMessages, true, true],
  ["transport terminal response identity", convertResponsesMessages, true, true],
] as const)(
  "%s replay preserves one async result and the incremental response prefix",
  (_name, convert, earlyResult, terminalIdentity) => {
    const prefix: AssistantMessage = {
      ...createOpenAIResponsesAssistantOutput(model),
      responseId: terminalIdentity ? undefined : "resp_async",
      turnId: terminalIdentity ? "streamed_turn" : undefined,
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "call_async|fc_async", name: "lookup", arguments: {}, async: true },
      ],
    };
    const tail: AssistantMessage = {
      ...createOpenAIResponsesAssistantOutput(model),
      responseId: "resp_async",
      turnId: terminalIdentity ? "streamed_turn" : undefined,
      content: [
        {
          type: "text",
          text: "independent answer",
          textSignature: encodeTextSignatureV1("msg_tail"),
        },
      ],
    };
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_async|fc_async",
      toolName: "lookup",
      content: [{ type: "text", text: "found" }],
      isError: false,
      timestamp: 2,
    };
    const context: Context = {
      messages: [
        { role: "user", content: "look up", timestamp: 1 },
        prefix,
        ...(earlyResult ? [toolResult, tail] : [tail, toolResult]),
      ],
    };
    const original = structuredClone(context);
    const input = convert(model, context, new Set(["openai"]));
    expect(input.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "message",
      "function_call_output",
    ]);
    expect(input[1]).toMatchObject({ type: "function_call", async: true, call_id: "call_async" });
    const completedCall = {
      type: "function_call",
      id: "fc_async",
      call_id: "call_async",
      name: "lookup",
      arguments: "{}",
      status: "completed",
      async: true,
    } satisfies Extract<ResponseOutputItem, { type: "function_call" }> & { async: true };
    const result = resolveResponsesContinuationRequest(
      {
        lastRequest: { model: model.id, input: input.slice(0, 1) },
        lastResponseId: "resp_async",
        lastResponseItems: [
          completedCall,
          {
            type: "message",
            id: "msg_tail",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "independent answer", annotations: [], logprobs: [] },
            ],
          },
        ],
      },
      { model: model.id, input },
    );
    expect(result.continuationStatus).toBe("continued");
    expect(result.request).toMatchObject({
      previous_response_id: "resp_async",
      input: [{ type: "function_call_output", call_id: "call_async", output: "found" }],
    });
    expect(context).toEqual(original);

    for (const target of [
      { ...model, id: "gpt-5.6-luna" },
      { ...model, id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    ]) {
      const switched = transformProviderMessages(context.messages, target);
      expect(switched.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(switched[1]).toMatchObject({
        content: [{ type: "toolCall", id: "call_async|fc_async" }],
      });
      expect(switched[1]?.content[0]).not.toHaveProperty("async");
      expect(switched[2]).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "found" }],
      });
    }
    const switchedInput = convert({ ...model, id: "gpt-5.6-luna" }, context, new Set(["openai"]));
    expect(switchedInput.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(switchedInput[1]).not.toHaveProperty("async");

    const brokenTail: AssistantMessage = {
      ...tail,
      content: [],
      stopReason: "error",
      errorMessage: "stream failed",
    };
    const interrupted = convert(
      model,
      {
        ...context,
        messages: context.messages.map((message) => (message === tail ? brokenTail : message)),
      },
      new Set(["openai"]),
    );
    expect(interrupted.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(interrupted[2]).toMatchObject({ call_id: "call_async", output: "found" });
  },
);

it.each(["before", "after"] as const)(
  "replays saved steering input %s its response after session recovery",
  (position) => {
    const call: AssistantMessage = {
      ...createOpenAIResponsesAssistantOutput(model),
      responseId: "resp_parent",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "call_1|fc_1", name: "lookup", arguments: {}, async: true },
      ],
    };
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1|fc_1",
      toolName: "lookup",
      content: [{ type: "text", text: "found" }],
      isError: false,
      timestamp: 2,
    };
    const input = { type: "function_call_output", call_id: "call_1", output: "found" };
    const response: AssistantMessage = {
      ...createOpenAIResponsesAssistantOutput(model),
      responseId: "resp_steered",
      content: [
        { type: "text", text: "steered answer", textSignature: encodeTextSignatureV1("msg_2") },
      ],
    };
    recordResponsesInputReplay(response, {
      afterResponseId: "resp_parent",
      before: [],
      after: [],
      [position]: [responsesInputFingerprint(input)],
    });
    const serialized = JSON.stringify({
      messages: [
        { role: "user", content: "original", timestamp: 0 },
        call,
        result,
        { role: "user", content: "update", timestamp: 3 },
        response,
      ],
    });
    const context: Context = JSON.parse(serialized);
    for (const convert of [convertProviderResponsesMessages, convertResponsesMessages]) {
      const replay = convert(model, context, new Set(["openai"]));
      expect(replay.map((item) => item.type)).toEqual([
        "message",
        "function_call",
        "message",
        ...(position === "before"
          ? ["function_call_output", "message"]
          : ["message", "function_call_output"]),
      ]);
      expect(replay[2]).toMatchObject({
        role: "user",
        content: [{ type: "input_text", text: "update" }],
      });
      expect(replay.filter((item) => item.type === "function_call_output")).toEqual([input]);
    }
  },
);
