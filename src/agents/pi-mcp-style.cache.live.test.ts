import type { AssistantMessage, Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  buildAssistantHistoryTurn,
  buildStableCachePrefix,
  completeSimpleWithLiveTimeout,
  computeCacheHitRate,
  extractAssistantText,
  LIVE_CACHE_TEST_ENABLED,
  logLiveCache,
  resolveLiveDirectModel,
} from "./live-cache-test-support.js";

const describeCacheLive = LIVE_CACHE_TEST_ENABLED ? describe : describe.skip;
const OPENAI_TIMEOUT_MS = 120_000;
const OPENAI_SESSION_ID = "live-cache-openai-mcp-style-session";
const OPENAI_PREFIX = buildStableCachePrefix("openai-mcp-style");
const OPENAI_MCP_STYLE_MIN_CACHE_READ = 4_096;
const OPENAI_MCP_STYLE_MIN_HIT_RATE = 0.85;

const MCP_TOOL: Tool = {
  name: "bundleProbe__bundle_probe",
  description: "Return bundle MCP probe text.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

type CacheRun = {
  hitRate: number;
  suffix: string;
  text: string;
  usage: AssistantMessage["usage"];
};

function extractFirstToolCall(message: AssistantMessage) {
  return message.content.find((block) => block.type === "toolCall");
}

function buildToolResultMessage(toolCallId: string) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName: MCP_TOOL.name,
    content: [{ type: "text" as const, text: "FROM-BUNDLE" }],
    isError: false,
    timestamp: Date.now(),
  };
}

type ToolOnlyTurnParams = {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
};

async function completeToolOnlyTurn(params: ToolOnlyTurnParams, prompt: string, label: string) {
  return completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: OPENAI_PREFIX,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      tools: [MCP_TOOL],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: "short",
      sessionId: params.sessionId,
      maxTokens: 128,
      temperature: 0,
      reasoning: "none" as unknown as never,
    },
    label,
    OPENAI_TIMEOUT_MS,
  );
}

async function runToolOnlyTurn(params: ToolOnlyTurnParams) {
  let prompt = `Call the tool \`${MCP_TOOL.name}\` with {}. IMPORTANT: respond ONLY with the tool call and no other text.`;
  let response = await completeToolOnlyTurn(params, prompt, "openai mcp-style tool-only turn");

  let toolCall = extractFirstToolCall(response);
  let text = extractAssistantText(response);
  for (let attempt = 0; attempt < 2 && (!toolCall || text.length > 0); attempt += 1) {
    prompt = `Return only a tool call for \`${MCP_TOOL.name}\` with {}. No text.`;
    response = await completeToolOnlyTurn(
      params,
      prompt,
      `openai mcp-style tool-only retry ${attempt + 1}`,
    );
    toolCall = extractFirstToolCall(response);
    text = extractAssistantText(response);
  }

  expect(toolCall).toBeTruthy();
  expect(text.length).toBe(0);
  if (!toolCall || toolCall.type !== "toolCall") {
    throw new Error("expected tool call");
  }
  return {
    prompt,
    response,
    toolCall,
  };
}

async function runOpenAiMcpStyleCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
}): Promise<CacheRun> {
  const toolTurn = await runToolOnlyTurn(params);
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: OPENAI_PREFIX,
      messages: [
        { role: "user", content: toolTurn.prompt, timestamp: Date.now() },
        toolTurn.response,
        buildToolResultMessage(toolTurn.toolCall.id),
        buildAssistantHistoryTurn("MCP TOOL HISTORY ACKNOWLEDGED", params.model),
        {
          role: "user",
          content: "Keep the MCP tool output stable in history.",
          timestamp: Date.now(),
        },
        buildAssistantHistoryTurn("MCP TOOL HISTORY PRESERVED", params.model),
        {
          role: "user",
          content: `Reply with exactly CACHE-OK ${params.suffix}.`,
          timestamp: Date.now(),
        },
      ],
      tools: [MCP_TOOL],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: "short",
      sessionId: params.sessionId,
      maxTokens: 64,
      temperature: 0,
      reasoning: "none" as unknown as never,
    },
    `openai mcp-style cache probe ${params.suffix}`,
    OPENAI_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

describeCacheLive("MCP-style prompt caching (live)", () => {
  it(
    "keeps an OpenAI cache plateau across MCP-style followup turns",
    async () => {
      const fixture = await resolveLiveDirectModel({
        provider: "openai",
        api: "openai-responses",
        envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
        preferredModelIds: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4"],
      });
      logLiveCache(`openai mcp-style model=${fixture.model.provider}/${fixture.model.id}`);

      const warmup = await runOpenAiMcpStyleCacheProbe({
        ...fixture,
        sessionId: OPENAI_SESSION_ID,
        suffix: "mcp-warmup",
      });
      logLiveCache(
        `openai mcp-style warmup cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
      );

      const hitA = await runOpenAiMcpStyleCacheProbe({
        ...fixture,
        sessionId: OPENAI_SESSION_ID,
        suffix: "mcp-hit-a",
      });
      const hitB = await runOpenAiMcpStyleCacheProbe({
        ...fixture,
        sessionId: OPENAI_SESSION_ID,
        suffix: "mcp-hit-b",
      });
      const bestHit = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
      logLiveCache(
        `openai mcp-style plateau suffix=${bestHit.suffix} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
      );

      expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThanOrEqual(OPENAI_MCP_STYLE_MIN_CACHE_READ);
      expect(bestHit.hitRate).toBeGreaterThanOrEqual(OPENAI_MCP_STYLE_MIN_HIT_RATE);
    },
    10 * 60_000,
  );
});
