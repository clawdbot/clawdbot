// xAI live tests verify Grok completions, tool payload wrapping, and Grok web
// search against the real provider when live credentials are enabled.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  isBillingErrorMessage,
  isOverloadedErrorMessage,
} from "./embedded-agent-helpers/failover-matches.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner.js";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-transport-stream.js";
import { createWebSearchTool } from "./tools/web-search.js";

const XAI_KEY = process.env.XAI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["XAI_LIVE_TEST"]);
const XAI_COMPLETE_LIVE_TIMEOUT_MS = 90_000;
const XAI_WEB_SEARCH_LIVE_TIMEOUT_SECONDS = 60;

const describeLive = LIVE && XAI_KEY ? describe : describe.skip;

type AssistantLikeMessage = {
  content: Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    function?: {
      strict?: unknown;
    };
  }>;
};

function getToolFunction(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = tool.function;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  if (tool.type === "function" && typeof tool.name === "string") {
    return tool;
  }
  return undefined;
}

function resolveLiveXaiModel(modelId: "grok-4.3" | "grok-4.5") {
  const isGrok45 = modelId === "grok-4.5";
  return {
    id: modelId,
    name: isGrok45 ? "Grok 4.5" : "Grok 4.3",
    api: "openai-responses",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: isGrok45
      ? { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }
      : { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: isGrok45 ? 500_000 : 1_000_000,
    maxTokens: 64_000,
    thinkingLevelMap: {
      off: isGrok45 ? null : "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    },
  } satisfies Model<"openai-responses">;
}

function requireLiveValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

async function runXaiLiveCase(label: string, run: () => Promise<void>): Promise<void> {
  // Live provider behavior can drift on billing/capacity; those environment
  // failures are skipped while real contract failures still throw.
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isBillingErrorMessage(message)) {
      console.warn(`[xai:live] skip ${label}: billing drift: ${message}`);
      return;
    }
    if (isOverloadedErrorMessage(message)) {
      console.warn(`[xai:live] skip ${label}: temporary provider capacity: ${message}`);
      return;
    }
    if (message.includes("web_search is disabled or no provider is available")) {
      console.warn(`[xai:live] skip ${label}: web_search unavailable in this environment`);
      return;
    }
    throw error;
  }
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
  return requireLiveValue(doneMessage, "done message");
}

describeLive("xai live", () => {
  for (const modelId of ["grok-4.3", "grok-4.5"] as const) {
    it(
      `returns assistant text for ${modelId}`,
      async () => {
        await runXaiLiveCase("complete", async () => {
          const model = requireLiveValue(resolveLiveXaiModel(modelId), "xAI model");
          const res = await completeSimple(
            model,
            {
              messages: createSingleUserPromptMessage(),
            },
            {
              apiKey: XAI_KEY,
              maxTokens: 64,
            },
          );

          expect(extractNonEmptyAssistantText(res.content).length).toBeGreaterThan(0);
        });
      },
      XAI_COMPLETE_LIVE_TIMEOUT_MS,
    );
  }

  for (const modelId of ["grok-4.3", "grok-4.5"] as const) {
    it(`sends wrapped ${modelId} tool payloads live`, async () => {
      await runXaiLiveCase("tool-call", async () => {
        const model = requireLiveValue(resolveLiveXaiModel(modelId), "xAI model");
        const agent = { streamFn: createOpenAIResponsesTransportStreamFn() };
        applyExtraParamsToAgent(agent, undefined, "xai", model.id);

        const noopTool = {
          name: "noop",
          description: "Return ok.",
          parameters: Type.Object({}, { additionalProperties: false }),
        };

        let capturedPayload: Record<string, unknown> | undefined;
        const streamOptions = {
          apiKey: XAI_KEY,
          maxTokens: 128,
          reasoning: "low",
          toolChoice: { type: "function", name: "noop" },
          onPayload: (payload: unknown) => {
            capturedPayload = payload as Record<string, unknown>;
          },
        } satisfies Parameters<typeof agent.streamFn>[2] & {
          reasoning: "low";
          toolChoice: { type: "function"; name: string };
        };
        const stream = agent.streamFn(
          model,
          {
            messages: createSingleUserPromptMessage(
              "You must call the tool `noop` exactly once with {}.",
            ),
            tools: [noopTool],
          },
          streamOptions,
        );

        const doneMessage = await collectDoneMessage(
          stream as AsyncIterable<{ type: string; message?: AssistantLikeMessage }>,
        );
        const content = requireLiveValue(doneMessage.content, "done message content");
        expect(Array.isArray(content)).toBe(true);
        expect(content.some((block) => block.type === "toolCall" && block.name === "noop")).toBe(
          true,
        );
        const payload = requireLiveValue(capturedPayload, "captured xAI payload");
        expect(payload.reasoning).toMatchObject({ effort: "low" });
        if ("tool_stream" in payload) {
          expect(payload.tool_stream).toBe(true);
        }

        const payloadTools = Array.isArray(payload.tools)
          ? (payload.tools as Array<Record<string, unknown>>)
          : [];
        expect(payloadTools.length).toBeGreaterThan(0);
        const firstFunction = requireLiveValue(
          payloadTools[0] ? getToolFunction(payloadTools[0]) : undefined,
          "first xAI tool function",
        );
        expect(typeof firstFunction).toBe("object");
        expect(Array.isArray(firstFunction)).toBe(false);
        expect([undefined, false]).toContain(firstFunction.strict);
      });
    }, 90_000);
  }

  it("runs Grok web_search live", async () => {
    await runXaiLiveCase("web-search", async () => {
      const tool = createWebSearchTool({
        config: {
          tools: {
            web: {
              search: {
                provider: "grok",
                timeoutSeconds: XAI_WEB_SEARCH_LIVE_TIMEOUT_SECONDS,
                grok: { model: "grok-4.3" },
              },
            },
          },
        },
      });

      const webSearchTool = requireLiveValue(tool, "grok web search tool");
      const result = await webSearchTool.execute("web-search:grok-live", {
        query: "OpenClaw GitHub",
        count: 3,
      });

      const details = (result.details ?? {}) as {
        provider?: string;
        model?: string;
        content?: string;
        citations?: string[];
        inlineCitations?: Array<unknown>;
        error?: string;
        message?: string;
      };

      const errorMessage =
        details.error && details.message
          ? `${details.error} ${details.message}`
          : details.error || details.message || "";
      if (isBillingErrorMessage(errorMessage)) {
        console.warn(`[xai:live] skip web-search: billing drift: ${errorMessage}`);
        return;
      }

      expect(details.error, details.message).toBeUndefined();
      expect(details.provider).toBe("grok");
      expect(details.model).toBe("grok-4.3");
      expect(details.content?.trim().length ?? 0).toBeGreaterThan(0);

      const citationCount =
        (Array.isArray(details.citations) ? details.citations.length : 0) +
        (Array.isArray(details.inlineCitations) ? details.inlineCitations.length : 0);
      expect(citationCount).toBeGreaterThan(0);
    });
  }, 90_000);
});
