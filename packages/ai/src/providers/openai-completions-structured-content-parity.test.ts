import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { convertMessages } from "../openai-completions-messages.js";
import { resolveOpenAICompletionsCompat } from "../transports/openai-completions-compat.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { AssistantMessageEventStreamLike, Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const reasoningModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-completions">;

const context = {
  messages: [{ role: "user", content: "Reply exactly", timestamp: 1 }],
} satisfies Context;

type StructuredContentScenario = {
  name: string;
  choice: Record<string, unknown>;
  followupChoice?: Record<string, unknown>;
  expectedContent: Array<Record<string, unknown>>;
  reasoningEnabled?: boolean;
  reasoningEffort?: "medium" | "none";
};

const scenarios: StructuredContentScenario[] = [
  {
    name: "the unchanged scalar text contract",
    choice: { delta: { content: "Scalar answer" } },
    expectedContent: [{ type: "text", text: "Scalar answer" }],
  },
  {
    name: "a provider-compatible typed text object",
    choice: { delta: { content: { type: "text", text: "Visible object" } } },
    expectedContent: [{ type: "text", text: "Visible object" }],
  },
  {
    name: "nested typed text content",
    choice: { delta: { content: { type: "output_text", content: { text: "Nested answer" } } } },
    expectedContent: [{ type: "text", text: "Nested answer" }],
  },
  {
    name: "mixed private reasoning and visible text",
    choice: {
      delta: {
        content: [
          { type: "reasoning", text: "Private thought" },
          { type: "text", text: "Visible answer" },
        ],
      },
    },
    expectedContent: [
      { type: "thinking", thinking: "Private thought" },
      { type: "text", text: "Visible answer" },
    ],
  },
  ...(["reasoning_content", "reasoning", "reasoning_text"] as const).map((field) => ({
    name: `private reasoning mirrored in ${field} and structured content`,
    choice: {
      delta: {
        [field]: "Private thought",
        content: [
          { type: "reasoning", text: "Private thought" },
          { type: "text", text: "Visible answer" },
        ],
      },
    },
    expectedContent: [
      { type: "thinking", thinking: "Private thought", thinkingSignature: field },
      { type: "text", text: "Visible answer" },
    ],
  })),
  ...(["reasoning_content", "reasoning", "reasoning_text"] as const).map((field) => ({
    name: `distinct private reasoning in ${field} and structured content`,
    choice: {
      delta: {
        [field]: "Dedicated private thought.",
        content: [
          { type: "reasoning", text: "Distinct structured private thought." },
          { type: "text", text: "Visible answer" },
        ],
      },
    },
    expectedContent: [
      {
        type: "thinking",
        thinking: "Dedicated private thought.Distinct structured private thought.",
        thinkingSignature: field,
      },
      { type: "text", text: "Visible answer" },
    ],
  })),
  {
    name: "split structured reasoning mirrored in the dedicated field",
    choice: {
      delta: {
        reasoning_content: "Private thought",
        content: [
          { type: "reasoning", text: "Private " },
          { type: "reasoning", text: "thought" },
          { type: "text", text: "Visible answer" },
        ],
      },
    },
    expectedContent: [
      { type: "thinking", thinking: "Private thought", thinkingSignature: "reasoning_content" },
      { type: "text", text: "Visible answer" },
    ],
  },
  {
    name: "standalone dedicated reasoning alongside visible structured text",
    choice: {
      delta: {
        reasoning_content: "Private thought",
        content: [{ type: "text", text: "Visible answer" }],
      },
    },
    expectedContent: [
      { type: "thinking", thinking: "Private thought", thinkingSignature: "reasoning_content" },
      { type: "text", text: "Visible answer" },
    ],
  },
  {
    name: "structured reasoning that is disabled",
    reasoningEnabled: false,
    choice: {
      delta: {
        content: [
          { type: "thinking", thinking: [{ type: "text", text: "Do not expose this" }] },
          { type: "text", text: "Visible answer" },
        ],
      },
    },
    expectedContent: [{ type: "text", text: "Visible answer" }],
  },
  {
    name: "dedicated and structured mirrored reasoning that is disabled",
    reasoningEnabled: false,
    choice: {
      delta: {
        reasoning_content: "Do not expose this",
        content: [
          { type: "reasoning", text: "Do not expose this" },
          { type: "text", text: "Visible answer" },
        ],
      },
    },
    expectedContent: [{ type: "text", text: "Visible answer" }],
  },
  {
    name: "structured reasoning explicitly disabled on a capable model",
    reasoningEffort: "none",
    choice: {
      delta: {
        content: [
          { type: "reasoning", text: "Do not expose this" },
          { type: "text", text: "Visible answer" },
        ],
      },
    },
    expectedContent: [{ type: "text", text: "Visible answer" }],
  },
  {
    name: "pending partial inline reasoning remains private after a structured thought",
    choice: { delta: { content: "<thi" } },
    followupChoice: {
      delta: {
        content: [
          { type: "reasoning", text: "Structured private thought" },
          { type: "text", text: "nk>SECRET</think>SAFE" },
        ],
      },
    },
    expectedContent: [
      { type: "thinking", thinking: "Structured private thought" },
      { type: "text", text: "SAFE" },
    ],
  },
  {
    name: "dedicated and structured reasoning explicitly disabled on a capable model",
    reasoningEffort: "none",
    choice: {
      delta: {
        reasoning_content: "Do not expose this",
        content: [
          { type: "reasoning", text: "Another private thought" },
          { type: "text", text: "Visible answer" },
        ],
      },
    },
    expectedContent: [{ type: "text", text: "Visible answer" }],
  },
  {
    name: "a documented refusal content part",
    choice: {
      delta: { content: [{ type: "refusal", refusal: "I cannot help with that." }] },
    },
    expectedContent: [{ type: "text", text: "I cannot help with that." }],
  },
  {
    name: "the same refusal mirrored in structured and top-level fields",
    choice: {
      delta: {
        content: [{ type: "refusal", refusal: "Safety refusal." }],
        refusal: "Safety refusal.",
      },
    },
    expectedContent: [{ type: "text", text: "Safety refusal." }],
  },
  {
    name: "distinct structured and top-level refusals",
    choice: {
      delta: {
        content: [{ type: "refusal", refusal: "Provider refusal. " }],
        refusal: "Operator guidance.",
      },
    },
    expectedContent: [{ type: "text", text: "Provider refusal. Operator guidance." }],
  },
  {
    name: "split structured refusal mirrored in the top-level field",
    choice: {
      delta: {
        content: [
          { type: "refusal", refusal: "Safety " },
          { type: "refusal", refusal: "refusal." },
        ],
        refusal: "Safety refusal.",
      },
    },
    expectedContent: [{ type: "text", text: "Safety refusal." }],
  },
  {
    name: "identical refusals intentionally repeated across separate chunks",
    choice: { delta: { refusal: "Safety refusal." } },
    followupChoice: { delta: { refusal: "Safety refusal." } },
    expectedContent: [{ type: "text", text: "Safety refusal.Safety refusal." }],
  },
  {
    name: "documented mixed assistant text and refusal parts",
    choice: {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Visible prefix. " },
          { type: "refusal", refusal: "Safety refusal." },
        ],
      },
    },
    expectedContent: [{ type: "text", text: "Visible prefix. Safety refusal." }],
  },
  {
    name: "an existing top-level refusal without duplication",
    choice: {
      delta: {
        content: [{ type: "text", text: "Visible prefix. " }],
        refusal: "Safety refusal.",
      },
    },
    expectedContent: [{ type: "text", text: "Visible prefix. Safety refusal." }],
  },
  {
    name: "unknown structured parts without object coercion",
    choice: {
      delta: { content: [{ type: "unknown", text: "Do not expose this" }] },
    },
    expectedContent: [],
  },
];

function installChatChunk(scenario: StructuredContentScenario, model: Model): void {
  const choices = [scenario.choice, ...(scenario.followupChoice ? [scenario.followupChoice] : [])];
  const body = `${choices
    .map(
      (choice, index) =>
        `data: ${JSON.stringify({
          id: `chatcmpl-${scenario.name.replaceAll(" ", "-")}`,
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [
            {
              index: 0,
              ...choice,
              finish_reason: index === choices.length - 1 ? "stop" : null,
            },
          ],
        })}\n\n`,
    )
    .join("")}data: [DONE]\n\n`;
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
}

function installDeferredStructuredChatChunks(model: Model): () => void {
  let releaseTerminal: (() => void) | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encodeChunk = (delta: Record<string, unknown>, finishReason: "stop" | null) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id: "chatcmpl-incremental-structured-content",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      controller.enqueue(
        encodeChunk(
          {
            content: [
              { type: "reasoning", text: "Private thought" },
              { type: "text", text: "VISIBLE_ONE" },
            ],
          },
          null,
        ),
      );
      releaseTerminal = () => {
        controller.enqueue(encodeChunk({ content: "VISIBLE_TWO" }, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };
    },
  });
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  return () => releaseTerminal?.();
}

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createManagedFixtureStream(
  model: Model,
  scenario: StructuredContentScenario,
): AssistantMessageEventStreamLike {
  const options = {
    apiKey: "fixture-token",
    reasoningEffort: scenario.reasoningEffort ?? "medium",
  };
  const stream = createManagedStream(model, context, options);
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat Completions transport must return its stream synchronously");
  }
  return stream;
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

afterEach(() => {
  configureAiTransportHost(previousHost);
});

describe.each([
  {
    name: "package",
    createStream: (model: Model<"openai-completions">, scenario: StructuredContentScenario) =>
      streamOpenAICompletions(model, context, {
        apiKey: "fixture-token",
        reasoningEffort: scenario.reasoningEffort ?? "medium",
      }),
  },
  { name: "managed", createStream: createManagedFixtureStream },
])("$name Chat Completions structured content", ({ createStream }) => {
  it.each(scenarios)("preserves $name", async (scenario) => {
    const model = {
      ...reasoningModel,
      reasoning: scenario.reasoningEnabled ?? true,
    } satisfies Model<"openai-completions">;
    installChatChunk(scenario, model);

    const result = await createStream(model, scenario).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual(scenario.expectedContent);
    expect(JSON.stringify(result.content)).not.toContain("[object Object]");

    const visibleAnswer = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (visibleAnswer && result.content.some((block) => block.type === "thinking")) {
      const assistantReplay = convertMessages(
        model,
        { messages: [...context.messages, result] },
        resolveOpenAICompletionsCompat(model),
      ).find((message) => message.role === "assistant");
      expect(assistantReplay?.content).toBe(visibleAnswer);
    }
  });

  it.each(["medium", "none"] as const)(
    "streams visible structured content before terminal when reasoning is %s",
    async (reasoningEffort) => {
      const releaseTerminal = installDeferredStructuredChatChunks(reasoningModel);
      const scenario: StructuredContentScenario = {
        name: "incremental structured reasoning",
        choice: {},
        expectedContent: [],
        reasoningEffort,
      };
      const stream = createStream(reasoningModel, scenario);
      let resolveFirstVisible: ((value: string) => void) | undefined;
      const firstVisible = new Promise<string>((resolve) => {
        resolveFirstVisible = resolve;
      });
      const textDeltas: string[] = [];
      const consumeEvents = (async () => {
        for await (const event of stream as AsyncIterable<{ type: string; delta?: string }>) {
          if (event.type === "text_delta" && typeof event.delta === "string") {
            textDeltas.push(event.delta);
            resolveFirstVisible?.(event.delta);
            resolveFirstVisible = undefined;
          }
        }
      })();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const firstDelta = await Promise.race([
          firstVisible,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Visible content was buffered until the terminal chunk")),
              500,
            );
          }),
        ]);
        expect(firstDelta).toBe("VISIBLE_ONE");
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        releaseTerminal();
      }
      await consumeEvents;
      await stream.result();
      expect(textDeltas).toEqual(["VISIBLE_ONE", "VISIBLE_TWO"]);
    },
  );
});
