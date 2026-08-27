import {
  completeSimple,
  type AssistantMessage,
  type Model,
  type Tool,
} from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  buildOpencodeZenLiveProviderConfig,
  listOpencodeZenModelCatalogEntries,
} from "./provider-catalog.js";

const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const OPENCODE_API_KEY =
  process.env.OPENCODE_API_KEY?.trim() || process.env.OPENCODE_ZEN_API_KEY?.trim() || "";
const LIVE_MODEL_ID =
  process.env.OPENCLAW_LIVE_OPENCODE_DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
const LIVE = isLiveTestEnabled(["OPENCODE_LIVE_TEST"]) && OPENCODE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

type OpencodeModelsResponse = {
  data?: Array<{ id?: unknown; object?: unknown }>;
};

async function resolveOpencodeDeepSeekLiveModel() {
  const provider = await buildOpencodeZenLiveProviderConfig({ apiKey: OPENCODE_API_KEY });
  const row = provider.models.find((model) => model.id === LIVE_MODEL_ID);
  if (
    !row ||
    row.api !== "openai-completions" ||
    !row.contextWindow ||
    !row.reasoning ||
    !row.compat?.supportsTools
  ) {
    throw new Error(`OpenCode catalog lacks a reasoning/tool-capable chat model: ${LIVE_MODEL_ID}`);
  }
  const input = row.input.filter((kind) => kind === "text" || kind === "image");
  expect(input).toEqual(row.input);
  const reasoning = (["low", "medium", "high", "max"] as const).find((effort) =>
    row.compat?.supportedReasoningEfforts?.includes(effort),
  );
  if (!reasoning) {
    throw new Error(`OpenCode catalog has no supported reasoning effort for ${LIVE_MODEL_ID}`);
  }
  const model: Model<"openai-completions"> = {
    ...row,
    api: row.api,
    contextWindow: row.contextWindow,
    provider: "opencode",
    baseUrl: row.baseUrl ?? provider.baseUrl,
    input,
  };
  return { model, reasoning };
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
    headers: {
      authorization: `Bearer ${OPENCODE_API_KEY}`,
      "accept-encoding": "identity",
    },
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

describeLive("opencode Zen live catalog drift", () => {
  it("discovers active live ids from authoritative metadata without hardcoding the catalog", async () => {
    const liveIds = await fetchOpencodeZenModelIds();
    const discovered = await buildOpencodeZenLiveProviderConfig({
      apiKey: OPENCODE_API_KEY,
      discoveryApiKey: OPENCODE_API_KEY,
    });
    const discoveredIds = discovered.models.map((model) => model.id).toSorted();
    expect(new Set(discoveredIds).size).toBe(discoveredIds.length);

    const trustedRows = listOpencodeZenModelCatalogEntries();
    const activeIds = new Set(
      trustedRows.filter((row) => !row.status).map((row) => row.id.toLowerCase()),
    );

    expect(discoveredIds.length).toBeGreaterThan(0);
    expect(discoveredIds).toEqual(liveIds.filter((id) => activeIds.has(id)));
  }, 30_000);
});

describeLive("opencode plugin live", () => {
  it("accepts discovered DeepSeek V4 thinking replay after a tool call", async () => {
    const { model, reasoning } = await resolveOpencodeDeepSeekLiveModel();
    const tool = liveEchoTool();
    const firstOptions = {
      apiKey: OPENCODE_API_KEY,
      reasoning,
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
        reasoning,
        maxTokens: 64,
      },
    );

    if (second.stopReason === "error") {
      throw new Error(second.errorMessage || "OpenCode DeepSeek replay returned an error");
    }

    expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);
});
