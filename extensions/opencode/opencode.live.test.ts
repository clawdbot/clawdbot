// Opencode tests cover opencode plugin behavior.
import {
  completeSimple,
  type AssistantMessage,
  type Model,
  type Tool,
} from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildStaticOpencodeZenProviderConfig } from "./provider-catalog.js";

const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const OPENCODE_API_KEY =
  process.env.OPENCODE_API_KEY?.trim() || process.env.OPENCODE_ZEN_API_KEY?.trim() || "";
const LIVE_MODEL_ID =
  process.env.OPENCLAW_LIVE_OPENCODE_DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash-free";
const LIVE = isLiveTestEnabled(["OPENCODE_LIVE_TEST"]) && OPENCODE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;
const describeCatalogLive = isLiveTestEnabled(["OPENCODE_LIVE_TEST"]) ? describe : describe.skip;

type OpencodeModelsResponse = {
  data?: Array<{ id?: unknown; object?: unknown }>;
};

function resolveOpencodeDeepSeekLiveModel(): Model<"openai-completions"> {
  return {
    id: LIVE_MODEL_ID,
    name: LIVE_MODEL_ID,
    api: "openai-completions",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65_536,
    maxTokens: 8192,
  };
}

function liveEchoTool(): Tool {
  return {
    name: "live_echo",
    description: "Return the supplied value.",
    parameters: Type.Object(
      {
        value: Type.String(),
      },
      { additionalProperties: false },
    ),
  };
}

function requireToolCall(message: AssistantMessage) {
  const toolCall = message.content.find((block) => block.type === "toolCall");
  if (toolCall?.type !== "toolCall") {
    throw new Error(`OpenCode DeepSeek live model did not call a tool: ${message.stopReason}`);
  }
  return toolCall;
}

function hasReasoningContentReplay(message: AssistantMessage): boolean {
  return message.content.some(
    (block) => block.type === "thinking" && block.thinkingSignature === "reasoning_content",
  );
}

async function fetchOpencodeZenModelIds(): Promise<string[]> {
  const response = await fetch(OPENCODE_ZEN_MODELS_URL, {
    headers: { "accept-encoding": "identity" },
  });
  expect(response.ok).toBe(true);
  const json = (await response.json()) as OpencodeModelsResponse;
  expect(Array.isArray(json.data)).toBe(true);
  const modelIds = (json.data ?? [])
    .filter((model) => model.object === undefined || model.object === "model")
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim().toLowerCase())
    .toSorted();
  expect(new Set(modelIds).size).toBe(modelIds.length);
  return modelIds;
}

function listStaticOpencodeZenModelIds(): string[] {
  return buildStaticOpencodeZenProviderConfig()
    .models.map((model) => model.id)
    .toSorted();
}

describeCatalogLive("opencode Zen live catalog drift", () => {
  it("keeps the provider-owned static seed aligned with the live model ids", async () => {
    const liveIds = await fetchOpencodeZenModelIds();
    const staticIds = listStaticOpencodeZenModelIds();
    expect(new Set(staticIds).size).toBe(staticIds.length);

    const staticIdSet = new Set(staticIds);
    const liveIdSet = new Set(liveIds);
    const missingStaticMetadata = liveIds.filter((id) => !staticIdSet.has(id));
    const staleStaticRows = staticIds.filter((id) => !liveIdSet.has(id));

    expect(
      { missingStaticMetadata, staleStaticRows },
      [
        "OpenCode Zen live catalog drifted from the provider-owned static seed.",
        "Add routing/baseUrl/cost/context/capability metadata for missing live ids,",
        "or remove stale static rows if OpenCode retired them.",
      ].join(" "),
    ).toEqual({ missingStaticMetadata: [], staleStaticRows: [] });
  }, 30_000);
});

describeLive("opencode plugin live", () => {
  it("accepts DeepSeek V4 tier-suffixed thinking replay after a tool call", async () => {
    const model = resolveOpencodeDeepSeekLiveModel();
    const tool = liveEchoTool();
    const firstOptions = {
      apiKey: OPENCODE_API_KEY,
      reasoning: "low",
      maxTokens: 128,
    } as const;

    const first = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "You must call the live_echo tool with value ok. Do not answer directly.",
            timestamp: Date.now(),
          },
        ],
        tools: [tool],
      },
      firstOptions,
    );

    if (first.stopReason === "error") {
      throw new Error(first.errorMessage || "OpenCode DeepSeek first turn returned an error");
    }

    const toolCall = requireToolCall(first);
    expect(hasReasoningContentReplay(first)).toBe(true);

    const second = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "You must call the live_echo tool with value ok. Do not answer directly.",
            timestamp: Date.now() - 3,
          },
          first,
          {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: Date.now() - 1,
          },
          {
            role: "user",
            content: "Reply with exactly: ok",
            timestamp: Date.now(),
          },
        ],
        tools: [tool],
      },
      {
        apiKey: OPENCODE_API_KEY,
        reasoning: "low",
        maxTokens: 64,
      },
    );

    if (second.stopReason === "error") {
      throw new Error(second.errorMessage || "OpenCode DeepSeek replay returned an error");
    }

    expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);
});
