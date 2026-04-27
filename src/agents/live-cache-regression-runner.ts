import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { AssistantMessage, Message, Tool } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  LIVE_CACHE_REGRESSION_BASELINE,
  type LiveCacheFloor,
} from "./live-cache-regression-baseline.js";
import {
  buildAssistantHistoryTurn,
  buildStableCachePrefix,
  completeSimpleWithLiveTimeout,
  computeCacheHitRate,
  extractAssistantText,
  logLiveCache,
  resolveLiveDirectModel,
} from "./live-cache-test-support.js";

const OPENAI_TIMEOUT_MS = 120_000;
const ANTHROPIC_TIMEOUT_MS = 120_000;
const OPENAI_PREFIX = buildStableCachePrefix("openai");
const OPENAI_MCP_PREFIX = buildStableCachePrefix("openai-mcp-style");
const ANTHROPIC_PREFIX = buildStableCachePrefix("anthropic");
const LIVE_TEST_PNG_URL = new URL(
  "../../apps/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
  import.meta.url,
);

type LiveResolvedModel = Awaited<ReturnType<typeof resolveLiveDirectModel>>;
type ProviderKey = keyof typeof LIVE_CACHE_REGRESSION_BASELINE;
type CacheLane = "image" | "mcp" | "stable" | "tool";
type CacheUsage = {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
};
type BaselineLane = CacheLane | "disabled";
type CacheRun = {
  hitRate: number;
  suffix: string;
  text: string;
  usage: CacheUsage;
};
type LaneResult = {
  best?: CacheRun;
  disabled?: CacheRun;
  warmup?: CacheRun;
};

export type LiveCacheRegressionResult = {
  regressions: string[];
  summary: Record<string, Record<string, unknown>>;
};

const NOOP_TOOL: Tool = {
  name: "noop",
  description: "Return ok.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

const MCP_TOOL: Tool = {
  name: "bundleProbe__bundle_probe",
  description: "Return bundle MCP probe text.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

function makeUserTurn(content: Extract<Message, { role: "user" }>["content"]): Message {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function makeImageUserTurn(text: string, pngBase64: string): Message {
  return makeUserTurn([
    { type: "text", text },
    { type: "image", mimeType: "image/png", data: pngBase64 },
  ]);
}

function makeToolResultMessage(
  toolCallId: string,
  toolName: string,
  text: string,
): Extract<Message, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function extractFirstToolCall(message: AssistantMessage) {
  return message.content.find((block) => block.type === "toolCall");
}

function normalizeCacheUsage(usage: AssistantMessage["usage"] | undefined): CacheUsage {
  const value = usage as Record<string, unknown> | null | undefined;
  const readNumber = (key: keyof CacheUsage): number | undefined =>
    typeof value?.[key] === "number" ? value[key] : undefined;
  return {
    input: readNumber("input"),
    cacheRead: readNumber("cacheRead"),
    cacheWrite: readNumber("cacheWrite"),
  };
}

function resolveBaselineFloor(provider: ProviderKey, lane: string): LiveCacheFloor | undefined {
  return LIVE_CACHE_REGRESSION_BASELINE[provider][
    lane as keyof (typeof LIVE_CACHE_REGRESSION_BASELINE)[typeof provider]
  ] as LiveCacheFloor | undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function runToolOnlyTurn(params: {
  apiKey: string;
  cacheRetention: "none" | "short" | "long";
  model: LiveResolvedModel["model"];
  providerTag: "anthropic" | "openai";
  sessionId: string;
  systemPrompt: string;
  tool: Tool;
}) {
  const timeoutMs = params.providerTag === "openai" ? OPENAI_TIMEOUT_MS : ANTHROPIC_TIMEOUT_MS;
  const options = {
    apiKey: params.apiKey,
    cacheRetention: params.cacheRetention,
    sessionId: params.sessionId,
    maxTokens: 128,
    temperature: 0,
    ...(params.providerTag === "openai" ? { reasoning: "none" as unknown as never } : {}),
  };
  let prompt = `Call the tool \`${params.tool.name}\` with {}. IMPORTANT: respond ONLY with the tool call and no other text.`;
  let response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: params.systemPrompt,
      messages: [makeUserTurn(prompt)],
      tools: [params.tool],
    },
    options,
    `${params.providerTag} ${params.tool.name} tool-only turn`,
    timeoutMs,
  );

  let toolCall = extractFirstToolCall(response);
  let text = extractAssistantText(response);
  for (let attempt = 0; attempt < 2 && (!toolCall || text.length > 0); attempt += 1) {
    prompt = `Return only a tool call for \`${params.tool.name}\` with {}. No text.`;
    response = await completeSimpleWithLiveTimeout(
      params.model,
      {
        systemPrompt: params.systemPrompt,
        messages: [makeUserTurn(prompt)],
        tools: [params.tool],
      },
      options,
      `${params.providerTag} ${params.tool.name} tool-only retry ${attempt + 1}`,
      timeoutMs,
    );
    toolCall = extractFirstToolCall(response);
    text = extractAssistantText(response);
  }

  assert(toolCall, `expected tool call for ${params.tool.name}`);
  assert(
    text.length === 0,
    `expected tool-only response for ${params.tool.name}, got ${JSON.stringify(text)}`,
  );
  assert(toolCall.type === "toolCall", `expected toolCall block for ${params.tool.name}`);

  return {
    prompt,
    response,
    toolCall,
  };
}

async function completeCacheProbe(params: {
  apiKey: string;
  cacheRetention: "none" | "short" | "long";
  messages: Message[];
  model: LiveResolvedModel["model"];
  providerTag: "anthropic" | "openai";
  sessionId: string;
  suffix: string;
  systemPrompt: string;
  tools?: Tool[];
  maxTokens?: number;
}): Promise<CacheRun> {
  const timeoutMs = params.providerTag === "openai" ? OPENAI_TIMEOUT_MS : ANTHROPIC_TIMEOUT_MS;
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
    },
    {
      apiKey: params.apiKey,
      cacheRetention: params.cacheRetention,
      sessionId: params.sessionId,
      maxTokens: params.maxTokens ?? 64,
      temperature: 0,
      ...(params.providerTag === "openai" ? { reasoning: "none" as unknown as never } : {}),
    },
    `${params.providerTag} cache lane ${params.suffix}`,
    timeoutMs,
  );
  const text = extractAssistantText(response);
  const responseTextLower = normalizeLowercaseStringOrEmpty(text);
  const suffixLower = normalizeLowercaseStringOrEmpty(params.suffix);
  assert(
    responseTextLower.includes(suffixLower),
    `expected response to contain ${params.suffix}, got ${JSON.stringify(text)}`,
  );
  const usage = normalizeCacheUsage(response.usage);
  return {
    suffix: params.suffix,
    text,
    usage,
    hitRate: computeCacheHitRate(usage),
  };
}

async function runRepeatedLane(params: {
  lane: CacheLane;
  providerTag: "anthropic" | "openai";
  fixture: LiveResolvedModel;
  runToken: string;
  sessionId: string;
  pngBase64: string;
}): Promise<LaneResult> {
  const suffixBase = `${params.providerTag}-${params.lane}`;
  const systemPromptBase =
    params.providerTag === "openai"
      ? params.lane === "mcp"
        ? OPENAI_MCP_PREFIX
        : OPENAI_PREFIX
      : ANTHROPIC_PREFIX;
  const systemPrompt = `${systemPromptBase}\nRun token: ${params.runToken}\nLane: ${params.providerTag}-${params.lane}\n`;

  const run =
    params.lane === "stable"
      ? (suffix: string) =>
          completeCacheProbe({
            apiKey: params.fixture.apiKey,
            cacheRetention: "short",
            messages: [makeUserTurn(`Reply with exactly CACHE-OK ${suffix}.`)],
            model: params.fixture.model,
            providerTag: params.providerTag,
            sessionId: params.sessionId,
            suffix,
            systemPrompt,
            maxTokens: 32,
          })
      : params.lane === "image"
        ? (suffix: string) =>
            completeCacheProbe({
              apiKey: params.fixture.apiKey,
              cacheRetention: "short",
              messages: [
                makeImageUserTurn(
                  "An image is attached. Ignore image semantics but keep the bytes in history.",
                  params.pngBase64,
                ),
                buildAssistantHistoryTurn("IMAGE HISTORY ACKNOWLEDGED", params.fixture.model),
                makeUserTurn("Keep the earlier image turn stable in context."),
                buildAssistantHistoryTurn("IMAGE HISTORY PRESERVED", params.fixture.model),
                makeUserTurn(`Reply with exactly CACHE-OK ${suffix}.`),
              ],
              model: params.fixture.model,
              providerTag: params.providerTag,
              sessionId: params.sessionId,
              suffix,
              systemPrompt,
            })
        : async (suffix: string) => {
            const tool = params.lane === "mcp" ? MCP_TOOL : NOOP_TOOL;
            const toolText = params.lane === "mcp" ? "FROM-BUNDLE" : "ok";
            const historyPrefix = params.lane === "mcp" ? "MCP TOOL HISTORY" : "TOOL HISTORY";
            const toolTurn = await runToolOnlyTurn({
              apiKey: params.fixture.apiKey,
              cacheRetention: "short",
              model: params.fixture.model,
              providerTag: params.providerTag,
              sessionId: params.sessionId,
              systemPrompt,
              tool,
            });
            return await completeCacheProbe({
              apiKey: params.fixture.apiKey,
              cacheRetention: "short",
              messages: [
                makeUserTurn(toolTurn.prompt),
                toolTurn.response,
                makeToolResultMessage(toolTurn.toolCall.id, tool.name, toolText),
                buildAssistantHistoryTurn(`${historyPrefix} ACKNOWLEDGED`, params.fixture.model),
                makeUserTurn(
                  params.lane === "mcp"
                    ? "Keep the MCP tool output stable in history."
                    : "Keep the tool output stable in history.",
                ),
                buildAssistantHistoryTurn(`${historyPrefix} PRESERVED`, params.fixture.model),
                makeUserTurn(`Reply with exactly CACHE-OK ${suffix}.`),
              ],
              model: params.fixture.model,
              providerTag: params.providerTag,
              sessionId: params.sessionId,
              suffix,
              systemPrompt,
              tools: [tool],
            });
          };

  const warmup = await run(`${suffixBase}-warmup`);
  const hitA = await run(`${suffixBase}-hit-a`);
  const hitB = await run(`${suffixBase}-hit-b`);
  const best = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
  return { best, warmup };
}

async function runAnthropicDisabledLane(params: {
  fixture: LiveResolvedModel;
  runToken: string;
  sessionId: string;
}): Promise<LaneResult> {
  const disabled = await completeCacheProbe({
    apiKey: params.fixture.apiKey,
    cacheRetention: "none",
    messages: [makeUserTurn("Reply with exactly CACHE-OK anthropic-disabled.")],
    model: params.fixture.model,
    providerTag: "anthropic",
    sessionId: params.sessionId,
    suffix: "anthropic-disabled",
    systemPrompt: `${ANTHROPIC_PREFIX}\nRun token: ${params.runToken}\nLane: anthropic-disabled\n`,
    maxTokens: 32,
  });
  return { disabled };
}

function formatUsage(usage: CacheUsage | undefined) {
  return `cacheRead=${usage?.cacheRead ?? 0} cacheWrite=${usage?.cacheWrite ?? 0} input=${usage?.input ?? 0}`;
}

function assertAgainstBaseline(params: {
  lane: BaselineLane;
  provider: ProviderKey;
  result: LaneResult;
  regressions: string[];
}) {
  const floor = resolveBaselineFloor(params.provider, params.lane);
  if (!floor) {
    params.regressions.push(`${params.provider}:${params.lane} missing baseline entry`);
    return;
  }

  if (params.result.best) {
    const usage = params.result.best.usage;
    if (floor.minCacheReadOrWrite !== undefined) {
      const cacheReadOrWrite = Math.max(usage.cacheRead ?? 0, usage.cacheWrite ?? 0);
      if (cacheReadOrWrite < floor.minCacheReadOrWrite) {
        params.regressions.push(
          `${params.provider}:${params.lane} cacheReadOrWrite=${cacheReadOrWrite} < min=${floor.minCacheReadOrWrite}`,
        );
      }
    } else if ((usage.cacheRead ?? 0) < (floor.minCacheRead ?? 0)) {
      params.regressions.push(
        `${params.provider}:${params.lane} cacheRead=${usage.cacheRead ?? 0} < min=${floor.minCacheRead}`,
      );
    }
    if (params.result.best.hitRate < (floor.minHitRate ?? 0)) {
      params.regressions.push(
        `${params.provider}:${params.lane} hitRate=${params.result.best.hitRate.toFixed(3)} < min=${floor.minHitRate?.toFixed(3)}`,
      );
    }
  }

  if (params.result.warmup) {
    const warmupUsage = params.result.warmup.usage;
    if ((warmupUsage.cacheWrite ?? 0) < (floor.minCacheWrite ?? 0)) {
      params.regressions.push(
        `${params.provider}:${params.lane} warmup cacheWrite=${warmupUsage.cacheWrite ?? 0} < min=${floor.minCacheWrite}`,
      );
    }
  }

  if (params.result.disabled) {
    const usage = params.result.disabled.usage;
    if ((usage.cacheRead ?? 0) > (floor.maxCacheRead ?? Number.POSITIVE_INFINITY)) {
      params.regressions.push(
        `${params.provider}:${params.lane} cacheRead=${usage.cacheRead ?? 0} > max=${floor.maxCacheRead}`,
      );
    }
    if ((usage.cacheWrite ?? 0) > (floor.maxCacheWrite ?? Number.POSITIVE_INFINITY)) {
      params.regressions.push(
        `${params.provider}:${params.lane} cacheWrite=${usage.cacheWrite ?? 0} > max=${floor.maxCacheWrite}`,
      );
    }
  }
}

export async function runLiveCacheRegression(): Promise<LiveCacheRegressionResult> {
  const pngBase64 = (await fs.readFile(LIVE_TEST_PNG_URL)).toString("base64");
  const runToken = randomUUID().slice(0, 13);
  const openai = await resolveLiveDirectModel({
    provider: "openai",
    api: "openai-responses",
    envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
    preferredModelIds: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4", "gpt-5.2"],
  });
  const anthropic = await resolveLiveDirectModel({
    provider: "anthropic",
    api: "anthropic-messages",
    envVar: "OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL",
    preferredModelIds: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-3-5"],
  });

  const regressions: string[] = [];
  const summary: Record<string, Record<string, unknown>> = {
    anthropic: {},
    openai: {},
  };

  for (const lane of ["stable", "tool", "image", "mcp"] as const) {
    const openaiResult = await runRepeatedLane({
      lane,
      providerTag: "openai",
      fixture: openai,
      runToken,
      sessionId: `live-cache-regression-${runToken}-openai-${lane}`,
      pngBase64,
    });
    logLiveCache(
      `openai ${lane} warmup ${formatUsage(openaiResult.warmup?.usage ?? {})} rate=${openaiResult.warmup?.hitRate.toFixed(3) ?? "0.000"}`,
    );
    logLiveCache(
      `openai ${lane} best ${formatUsage(openaiResult.best?.usage ?? {})} rate=${openaiResult.best?.hitRate.toFixed(3) ?? "0.000"}`,
    );
    summary.openai[lane] = {
      best: openaiResult.best?.usage,
      hitRate: openaiResult.best?.hitRate,
      warmup: openaiResult.warmup?.usage,
    };
    assertAgainstBaseline({
      lane,
      provider: "openai",
      result: openaiResult,
      regressions,
    });

    const anthropicResult = await runRepeatedLane({
      lane,
      providerTag: "anthropic",
      fixture: anthropic,
      runToken,
      sessionId: `live-cache-regression-${runToken}-anthropic-${lane}`,
      pngBase64,
    });
    logLiveCache(
      `anthropic ${lane} warmup ${formatUsage(anthropicResult.warmup?.usage ?? {})} rate=${anthropicResult.warmup?.hitRate.toFixed(3) ?? "0.000"}`,
    );
    logLiveCache(
      `anthropic ${lane} best ${formatUsage(anthropicResult.best?.usage ?? {})} rate=${anthropicResult.best?.hitRate.toFixed(3) ?? "0.000"}`,
    );
    summary.anthropic[lane] = {
      best: anthropicResult.best?.usage,
      hitRate: anthropicResult.best?.hitRate,
      warmup: anthropicResult.warmup?.usage,
    };
    assertAgainstBaseline({
      lane,
      provider: "anthropic",
      result: anthropicResult,
      regressions,
    });
  }

  const disabled = await runAnthropicDisabledLane({
    fixture: anthropic,
    runToken,
    sessionId: `live-cache-regression-${runToken}-anthropic-disabled`,
  });
  logLiveCache(`anthropic disabled ${formatUsage(disabled.disabled?.usage ?? {})}`);
  summary.anthropic.disabled = {
    disabled: disabled.disabled?.usage,
  };
  assertAgainstBaseline({
    lane: "disabled",
    provider: "anthropic",
    result: disabled,
    regressions,
  });

  logLiveCache(`cache regression summary ${JSON.stringify(summary)}`);
  return { regressions, summary };
}
