/**
 * Live prompt-cache regression runner.
 *
 * This orchestrates provider cache lanes, baseline comparisons, and live drift
 * handling for expensive provider-backed cache validation.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type { AssistantMessage, Message, Tool } from "../llm/types.js";
import { extractAssistantText } from "./embedded-agent-utils.js";
import {
  assertAgainstBaseline,
  type BaselineFindings,
  type CacheLane,
  type CacheRun,
  type CacheUsage,
  evaluateAgainstBaseline,
  isAnthropicToolProbeDrift,
  type LaneResult,
  LIVE_CACHE_RESPONSE_RETRIES,
  resolveCacheProbeMaxTokens,
  resolveLiveCacheProviderPool,
  shouldAcceptEmptyCacheProbe,
  shouldRetryBaselineFindings,
  shouldRetryCacheProbeText,
} from "./live-cache-regression-policy.js";
import {
  buildAssistantHistoryTurn,
  buildStableCachePrefix,
  completeSimpleWithLiveTimeout,
  computeCacheHitRate,
  type LiveResolvedModel,
  logLiveCache,
  withLiveDirectModelApiKey,
} from "./live-cache-test-support.js";
import { shouldSkipLiveProviderDrift } from "./live-test-provider-drift.js";

const OPENAI_TIMEOUT_MS = 120_000;
const ANTHROPIC_TIMEOUT_MS = 120_000;
const LIVE_CACHE_LANE_RETRIES = 1;
const OPENAI_CACHE_REASONING = "none" as unknown as never;
const OPENAI_PREFIX = buildStableCachePrefix("openai");
const OPENAI_MCP_PREFIX = buildStableCachePrefix("openai-mcp-style");
const ANTHROPIC_PREFIX = buildStableCachePrefix("anthropic");
const LIVE_TEST_PNG_URL = new URL(
  "../../apps/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
  import.meta.url,
);

type LiveCacheRegressionResult = {
  regressions: string[];
  summary: Record<string, Record<string, unknown>>;
  warnings: string[];
};
class CacheProbeTextMismatchError extends Error {
  constructor(
    readonly suffix: string,
    readonly text: string,
  ) {
    super(`expected response to contain CACHE-OK ${suffix}, got ${JSON.stringify(text)}`);
  }
}

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
    output: readNumber("output"),
    cacheRead: readNumber("cacheRead"),
    cacheWrite: readNumber("cacheWrite"),
  };
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
    ...(params.providerTag === "openai" ? { reasoning: OPENAI_CACHE_REASONING } : {}),
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
  for (let attempt = 1; attempt <= 1 + LIVE_CACHE_RESPONSE_RETRIES; attempt += 1) {
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
        maxTokens: resolveCacheProbeMaxTokens({
          maxTokens: params.maxTokens,
          providerTag: params.providerTag,
        }),
        temperature: 0,
        ...(params.providerTag === "openai" ? { reasoning: OPENAI_CACHE_REASONING } : {}),
      },
      `${params.providerTag} cache lane ${params.suffix}`,
      timeoutMs,
    );
    const text = extractAssistantText(response);
    const usage = normalizeCacheUsage(response.usage);
    if (
      shouldAcceptEmptyCacheProbe({
        providerTag: params.providerTag,
        text,
        usage,
      })
    ) {
      logLiveCache(
        `${params.providerTag} cache lane ${params.suffix} accepted empty text with usage ${formatUsage(usage)}`,
      );
      return {
        suffix: params.suffix,
        text,
        usage,
        hitRate: computeCacheHitRate(usage),
      };
    }
    if (shouldRetryCacheProbeText({ attempt, suffix: params.suffix, text })) {
      logLiveCache(
        `${params.providerTag} cache lane ${params.suffix} response mismatch; retrying: ${JSON.stringify(text)} stop=${response.stopReason} error=${response.errorMessage ?? ""} ${formatUsage(usage)}`,
      );
      continue;
    }
    const responseTextLower = normalizeLowercaseStringOrEmpty(text);
    const suffixLower = normalizeLowercaseStringOrEmpty(params.suffix);
    const markerLower = `cache-ok ${suffixLower}`;
    if (!responseTextLower.includes(markerLower)) {
      throw new CacheProbeTextMismatchError(params.suffix, text);
    }
    return {
      suffix: params.suffix,
      text,
      usage,
      hitRate: computeCacheHitRate(usage),
    };
  }
  throw new Error(`expected response to contain CACHE-OK ${params.suffix}`);
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
  // Keep the stronger hit sample; live provider cache accounting can vary by call.
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
  return `cacheRead=${usage?.cacheRead ?? 0} cacheWrite=${usage?.cacheWrite ?? 0} input=${usage?.input ?? 0} output=${usage?.output ?? 0}`;
}

async function runRepeatedLaneWithBaselineRetry(params: {
  lane: CacheLane;
  providerTag: "anthropic" | "openai";
  fixture: LiveResolvedModel;
  runToken: string;
  pngBase64: string;
}): Promise<{ result: LaneResult; findings: BaselineFindings; attempts: number }> {
  let result: LaneResult | undefined;
  let findings: BaselineFindings = { regressions: [], warnings: [] };
  let attempts = 0;
  for (let attempt = 1; attempt <= 1 + LIVE_CACHE_LANE_RETRIES; attempt += 1) {
    attempts = attempt;
    try {
      result = await runRepeatedLane({
        ...params,
        sessionId: `live-cache-regression-${params.runToken}-${params.providerTag}-${params.lane}${
          attempt > 1 ? `-retry-${attempt}` : ""
        }`,
      });
    } catch (error) {
      if (error instanceof CacheProbeTextMismatchError && attempt <= LIVE_CACHE_LANE_RETRIES) {
        // Retry a whole lane once so response-text drift does not hide cache regressions.
        logLiveCache(
          `${params.providerTag} ${params.lane} response mismatch; retrying lane once: ${error.message}`,
        );
        continue;
      }
      throw error;
    }
    findings = evaluateAgainstBaseline({
      lane: params.lane,
      provider: params.providerTag,
      result,
    });
    if (!shouldRetryBaselineFindings(findings, attempt)) {
      break;
    }
    logLiveCache(
      `${params.providerTag} ${params.lane} baseline miss; retrying lane once: ${JSON.stringify(
        findings.regressions,
      )}`,
    );
  }

  assert(result, `expected ${params.providerTag} ${params.lane} cache lane result`);
  return { result, findings, attempts };
}

function appendBaselineFindings(target: BaselineFindings, source: BaselineFindings) {
  target.regressions.push(...source.regressions);
  target.warnings.push(...source.warnings);
}

function isAnthropicEmptyCacheProbe(error: unknown): boolean {
  return error instanceof CacheProbeTextMismatchError && error.text.trim().length === 0;
}

function shouldSkipAnthropicCacheProviderDrift(error: unknown): boolean {
  return Boolean(
    shouldSkipLiveProviderDrift({
      error,
      allowAuth: true,
      allowBilling: true,
    }),
  );
}

async function runAnthropicCacheLane(params: {
  apiKeys: readonly string[];
  fixture: LiveResolvedModel;
  lane: CacheLane;
  pngBase64: string;
  runToken: string;
  warnings: string[];
}): Promise<{ attempt?: Awaited<ReturnType<typeof runRepeatedLaneWithBaselineRetry>> }> {
  const keys = params.apiKeys.length > 0 ? params.apiKeys : [params.fixture.apiKey];
  let lastError: unknown;
  for (const [index, apiKey] of keys.entries()) {
    try {
      return {
        attempt: await runRepeatedLaneWithBaselineRetry({
          lane: params.lane,
          providerTag: "anthropic",
          fixture: withLiveDirectModelApiKey(params.fixture, apiKey),
          runToken: params.runToken,
          pngBase64: params.pngBase64,
        }),
      };
    } catch (error) {
      lastError = error;
      if (shouldSkipAnthropicCacheProviderDrift(error) && index + 1 < keys.length) {
        // Anthropic keys can drift independently; try the next live key before skipping.
        logLiveCache(`anthropic ${params.lane} account drift; retrying with next key`);
        continue;
      }
      break;
    }
  }

  if (
    shouldSkipAnthropicCacheProviderDrift(lastError) ||
    isAnthropicEmptyCacheProbe(lastError) ||
    isAnthropicToolProbeDrift(lastError)
  ) {
    const reason = isAnthropicEmptyCacheProbe(lastError)
      ? "empty response"
      : isAnthropicToolProbeDrift(lastError)
        ? "tool probe drift"
        : "account drift";
    const warning = `anthropic ${params.lane} skipped: ${reason}`;
    params.warnings.push(warning);
    logLiveCache(warning);
    return {};
  }
  throw lastError;
}

async function runAnthropicDisabledCacheLane(params: {
  fixture: LiveResolvedModel;
  runToken: string;
  warnings: string[];
}): Promise<LaneResult | undefined> {
  try {
    return await runAnthropicDisabledLane({
      fixture: params.fixture,
      runToken: params.runToken,
      sessionId: `live-cache-regression-${params.runToken}-anthropic-disabled`,
    });
  } catch (error) {
    if (shouldSkipAnthropicCacheProviderDrift(error) || isAnthropicEmptyCacheProbe(error)) {
      const warning = "anthropic disabled skipped: account drift";
      params.warnings.push(warning);
      logLiveCache(warning);
      return undefined;
    }
    throw error;
  }
}

/** Runs all live prompt-cache lanes and returns hard regressions plus warn-only drift. */
export async function runLiveCacheRegression(): Promise<LiveCacheRegressionResult> {
  const pngBase64 = (await fs.readFile(LIVE_TEST_PNG_URL)).toString("base64");
  const runToken = randomUUID().slice(0, 13);
  const regressions: string[] = [];
  const warnings: string[] = [];
  const summary: Record<string, Record<string, unknown>> = {
    anthropic: {},
    openai: {},
  };
  const openaiSummary = summary.openai;
  const anthropicSummary = summary.anthropic;
  if (!openaiSummary || !anthropicSummary) {
    throw new Error("Live cache summary providers were not initialized");
  }
  const openai = await resolveLiveCacheProviderPool({
    config: {
      provider: "openai",
      api: "openai-responses",
      envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
      preferredModelIds: ["gpt-4.1", "gpt-5.2", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
    },
    regressions,
    summary,
    warnings,
  });
  const anthropic = await resolveLiveCacheProviderPool({
    config: {
      provider: "anthropic",
      api: "anthropic-messages",
      envVar: "OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL",
      preferredModelIds: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-3-5"],
    },
    regressions,
    summary,
    warnings,
  });

  for (const lane of ["stable", "tool", "image", "mcp"] as const) {
    if (openai) {
      const openaiAttempt = await runRepeatedLaneWithBaselineRetry({
        lane,
        providerTag: "openai",
        fixture: openai.fixture,
        runToken,
        pngBase64,
      });
      const openaiResult = openaiAttempt.result;
      logLiveCache(
        `openai ${lane} warmup ${formatUsage(openaiResult.warmup?.usage ?? {})} rate=${openaiResult.warmup?.hitRate.toFixed(3) ?? "0.000"}`,
      );
      logLiveCache(
        `openai ${lane} best ${formatUsage(openaiResult.best?.usage ?? {})} rate=${openaiResult.best?.hitRate.toFixed(3) ?? "0.000"}`,
      );
      openaiSummary[lane] = {
        best: openaiResult.best?.usage,
        hitRate: openaiResult.best?.hitRate,
        attempts: openaiAttempt.attempts,
        warmup: openaiResult.warmup?.usage,
      };
      appendBaselineFindings({ regressions, warnings }, openaiAttempt.findings);
    } else {
      openaiSummary[lane] = { skipped: true };
    }

    if (!anthropic) {
      anthropicSummary[lane] = { skipped: true };
      continue;
    }
    const { attempt: anthropicAttempt } = await runAnthropicCacheLane({
      apiKeys: anthropic.apiKeys,
      lane,
      fixture: anthropic.fixture,
      runToken,
      pngBase64,
      warnings,
    });
    if (!anthropicAttempt) {
      anthropicSummary[lane] = { skipped: true };
      continue;
    }
    const anthropicResult = anthropicAttempt.result;
    logLiveCache(
      `anthropic ${lane} warmup ${formatUsage(anthropicResult.warmup?.usage ?? {})} rate=${anthropicResult.warmup?.hitRate.toFixed(3) ?? "0.000"}`,
    );
    logLiveCache(
      `anthropic ${lane} best ${formatUsage(anthropicResult.best?.usage ?? {})} rate=${anthropicResult.best?.hitRate.toFixed(3) ?? "0.000"}`,
    );
    anthropicSummary[lane] = {
      best: anthropicResult.best?.usage,
      hitRate: anthropicResult.best?.hitRate,
      attempts: anthropicAttempt.attempts,
      warmup: anthropicResult.warmup?.usage,
    };
    appendBaselineFindings({ regressions, warnings }, anthropicAttempt.findings);
  }

  const disabled = anthropic
    ? await runAnthropicDisabledCacheLane({
        fixture: anthropic.fixture,
        runToken,
        warnings,
      })
    : undefined;
  if (disabled) {
    logLiveCache(`anthropic disabled ${formatUsage(disabled.disabled?.usage ?? {})}`);
    anthropicSummary.disabled = {
      disabled: disabled.disabled?.usage,
    };
    assertAgainstBaseline({
      lane: "disabled",
      provider: "anthropic",
      result: disabled,
      regressions,
      warnings,
    });
  } else {
    anthropicSummary.disabled = { skipped: true };
  }

  logLiveCache(`cache regression summary ${JSON.stringify(summary)}`);
  if (warnings.length > 0) {
    logLiveCache(`cache regression warnings ${JSON.stringify(warnings)}`);
  }
  return { regressions, summary, warnings };
}
