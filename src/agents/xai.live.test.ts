import { completeSimple, getModel, streamSimple } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";
import { applyExtraParamsToAgent } from "./pi-embedded-runner.js";
import { createWebSearchTool } from "./tools/web-search.js";

const XAI_KEY = process.env.XAI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["XAI_LIVE_TEST"]);

const describeLive = LIVE && XAI_KEY ? describe : describe.skip;

type AssistantLikeMessage = {
  content: Array<{
    type?: string;
    text?: string;
    id?: string;
    function?: {
      strict?: unknown;
    };
  }>;
};

function resolveLiveXaiModel() {
  return getModel("xai", "grok-4-1-fast-reasoning" as never) ?? getModel("xai", "grok-4");
}

async function collectDoneMessage(
  stream: AsyncIterable<{ type: string; message?: AssistantLikeMessage }>,
): Promise<AssistantLikeMessage> {
  let doneMessage: AssistantLikeMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") {
      doneMessage = event.message;
    }
  }
  expect(doneMessage).toBeDefined();
  return doneMessage!;
}

function extractFirstToolCallId(message: AssistantLikeMessage): string | undefined {
  const toolCall = message.content.find((block) => block.type === "toolCall");
  return toolCall?.id;
}

describeLive("xai live", () => {
  it("returns assistant text for Grok 4.1 Fast Reasoning", async () => {
    const model = resolveLiveXaiModel();
    expect(model).toBeDefined();
    const res = await completeSimple(
      model,
      {
        messages: createSingleUserPromptMessage(),
      },
      {
        apiKey: XAI_KEY,
        maxTokens: 64,
        reasoning: "medium",
      },
    );

    expect(extractNonEmptyAssistantText(res.content).length).toBeGreaterThan(0);
  }, 30_000);

  it("applies xAI tool wrappers on live tool calls", async () => {
    const model = resolveLiveXaiModel();
    expect(model).toBeDefined();
    const agent = { streamFn: streamSimple };
    applyExtraParamsToAgent(agent, undefined, "xai", model.id);

    const noopTool = {
      name: "noop",
      description: "Return ok.",
      parameters: Type.Object({}, { additionalProperties: false }),
    };

    const prompts = [
      "Call the tool `noop` with {}. Do not write any other text.",
      "IMPORTANT: Call the tool `noop` with {} and respond only with the tool call.",
      "Return only a tool call for `noop` with {}.",
    ];

    let doneMessage: AssistantLikeMessage | undefined;
    let capturedPayload: Record<string, unknown> | undefined;

    for (const prompt of prompts) {
      capturedPayload = undefined;
      const stream = agent.streamFn(
        model,
        {
          messages: createSingleUserPromptMessage(prompt),
          tools: [noopTool],
        },
        {
          apiKey: XAI_KEY,
          maxTokens: 128,
          reasoning: "medium",
          onPayload: (payload) => {
            capturedPayload = payload as Record<string, unknown>;
          },
        },
      );

      doneMessage = await collectDoneMessage(
        stream as AsyncIterable<{ type: string; message?: AssistantLikeMessage }>,
      );
      if (extractFirstToolCallId(doneMessage)) {
        break;
      }
    }

    expect(doneMessage).toBeDefined();
    expect(extractFirstToolCallId(doneMessage!)).toBeDefined();
    expect(capturedPayload?.tool_stream).toBe(true);

    const payloadTools = Array.isArray(capturedPayload?.tools)
      ? (capturedPayload.tools as Array<Record<string, unknown>>)
      : [];
    const firstFunction = payloadTools[0]?.function;
    if (firstFunction && typeof firstFunction === "object") {
      expect((firstFunction as Record<string, unknown>).strict).toBeUndefined();
    }
  }, 45_000);

  it("runs Grok web_search live", async () => {
    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              provider: "grok",
              grok: {
                model: "grok-4-1-fast",
              },
            },
          },
        },
      },
    });

    expect(tool).toBeTruthy();
    const result = await tool!.execute("web-search:grok-live", {
      query: "OpenClaw GitHub",
      count: 3,
    });

    const details = (result.details ?? {}) as {
      provider?: string;
      content?: string;
      citations?: string[];
      inlineCitations?: Array<unknown>;
      error?: string;
      message?: string;
    };

    expect(details.error, details.message).toBeUndefined();
    expect(details.provider).toBe("grok");
    expect(details.content?.trim().length ?? 0).toBeGreaterThan(0);

    const citationCount =
      (Array.isArray(details.citations) ? details.citations.length : 0) +
      (Array.isArray(details.inlineCitations) ? details.inlineCitations.length : 0);
    expect(citationCount).toBeGreaterThan(0);
  }, 45_000);
});
