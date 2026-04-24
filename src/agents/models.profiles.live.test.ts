import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/config.js";
import { parseLiveCsvFilter } from "../media-generation/live-test-helpers.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  collectAnthropicApiKeys,
  isAnthropicBillingError,
  isAnthropicRateLimitError,
} from "./live-auth-keys.js";
import { isModelNotFoundErrorMessage } from "./live-model-errors.js";
import {
  isHighSignalLiveModelRef,
  resolveHighSignalLiveModelLimit,
  selectHighSignalLiveItems,
  shouldExcludeProviderFromDefaultHighSignalLiveSweep,
} from "./live-model-filter.js";
import {
  buildLiveModelFileProbeContext,
  buildLiveModelFileProbeRetryContext,
  buildLiveModelImageProbeContext,
  extractAssistantText,
  fileProbeTextMatches,
  imageProbeTextMatches,
  isLiveModelProbeEnabled,
  LIVE_MODEL_FILE_PROBE_ENV,
  LIVE_MODEL_FILE_PROBE_TOKEN,
  LIVE_MODEL_IMAGE_PROBE_ENV,
  modelSupportsImageInput,
  shouldSkipLiveModelExtraProbes,
  shouldSkipLiveModelFileProbe,
  shouldSkipLiveModelImageProbe,
} from "./live-model-turn-probes.js";
import { createLiveTargetMatcher } from "./live-target-matcher.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "./live-test-helpers.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { shouldSuppressBuiltInModel } from "./model-suppression.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import {
  isCloudflareOrHtmlErrorPage,
  isRateLimitErrorMessage,
} from "./pi-embedded-helpers/errors.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

const LIVE = isLiveTestEnabled();
const DIRECT_ENABLED = Boolean(process.env.OPENCLAW_LIVE_MODELS?.trim());
const REQUIRE_PROFILE_KEYS = isLiveProfileKeyModeEnabled();
const LIVE_CREDENTIAL_PRECEDENCE = REQUIRE_PROFILE_KEYS ? "profile-first" : "env-first";
const LIVE_HEARTBEAT_MS = Math.max(1_000, toInt(process.env.OPENCLAW_LIVE_HEARTBEAT_MS, 30_000));
const LIVE_SETUP_TIMEOUT_MS = Math.max(
  1_000,
  toInt(process.env.OPENCLAW_LIVE_SETUP_TIMEOUT_MS, 45_000),
);
const LIVE_TEST_TIMEOUT_MS = Math.max(
  1_000,
  toInt(process.env.OPENCLAW_LIVE_TEST_TIMEOUT_MS, 60 * 60 * 1000),
);
const DEFAULT_LIVE_MODEL_CONCURRENCY = 20;
const LIVE_MODEL_CONCURRENCY = resolveLiveModelConcurrency();
const LIVE_MODELS_JSON_TIMEOUT_MS = resolveLiveModelsJsonTimeoutMs();
const LIVE_FILE_PROBE_ENABLED = isLiveModelProbeEnabled(process.env, LIVE_MODEL_FILE_PROBE_ENV);
const LIVE_IMAGE_PROBE_ENABLED = isLiveModelProbeEnabled(process.env, LIVE_MODEL_IMAGE_PROBE_ENV);

const describeLive = LIVE ? describe : describe.skip;

function parseCsvFilter(raw?: string): Set<string> | null {
  return parseLiveCsvFilter(raw, { lowercase: false });
}

function parseProviderFilter(raw?: string): Set<string> | null {
  return parseCsvFilter(raw);
}

function parseModelFilter(raw?: string): Set<string> | null {
  return parseCsvFilter(raw);
}

function logProgress(message: string): void {
  process.stderr.write(`[live] ${message}\n`);
}

function formatElapsedSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1_000))}s`;
}

async function withLiveHeartbeat<T>(operation: Promise<T>, context: string): Promise<T> {
  const startedAt = Date.now();
  let heartbeatCount = 0;
  const timer = setInterval(() => {
    heartbeatCount += 1;
    logProgress(`${context}: still running (${formatElapsedSeconds(Date.now() - startedAt)})`);
  }, LIVE_HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await operation;
  } finally {
    clearInterval(timer);
    if (heartbeatCount > 0) {
      logProgress(`${context}: completed after ${formatElapsedSeconds(Date.now() - startedAt)}`);
    }
  }
}

async function withLiveStageTimeout<T>(
  operation: Promise<T>,
  context: string,
  timeoutMs = LIVE_SETUP_TIMEOUT_MS,
): Promise<T> {
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await withLiveHeartbeat(
      Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          hardTimer = setTimeout(() => {
            reject(new Error(`${context} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          hardTimer.unref?.();
        }),
      ]),
      context,
    );
  } finally {
    if (hardTimer) {
      clearTimeout(hardTimer);
    }
  }
}

function formatFailurePreview(
  failures: Array<{ model: string; error: string }>,
  maxItems: number,
): string {
  const limit = Math.max(1, maxItems);
  const lines = failures.slice(0, limit).map((failure, index) => {
    const normalized = failure.error.replace(/\s+/g, " ").trim();
    const clipped = normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
    return `${index + 1}. ${failure.model}: ${clipped}`;
  });
  const remaining = failures.length - limit;
  if (remaining > 0) {
    lines.push(`... and ${remaining} more`);
  }
  return lines.join("\n");
}

function isGoogleModelNotFoundError(err: unknown): boolean {
  const msg = String(err);
  if (!/not found/i.test(msg)) {
    return false;
  }
  if (/\b404\b/.test(msg)) {
    return true;
  }
  if (/models\/.+ is not found for api version/i.test(msg)) {
    return true;
  }
  if (/"status"\\s*:\\s*"NOT_FOUND"/.test(msg)) {
    return true;
  }
  if (/"code"\\s*:\\s*404/.test(msg)) {
    return true;
  }
  return false;
}

describe("isModelNotFoundErrorMessage", () => {
  it("matches whitespace-separated not found errors", () => {
    expect(isModelNotFoundErrorMessage("404 model not found")).toBe(true);
    expect(isModelNotFoundErrorMessage("model: minimax-text-01 not found")).toBe(true);
  });

  it("still matches underscore and hyphen variants", () => {
    expect(isModelNotFoundErrorMessage("404 model not_found")).toBe(true);
    expect(isModelNotFoundErrorMessage("404 model not-found")).toBe(true);
  });

  it("matches deprecated free model transition messages", () => {
    expect(
      isModelNotFoundErrorMessage(
        "404 The free model has been deprecated. Transition to qwen/qwen3.6-plus for continued paid access.",
      ),
    ).toBe(true);
  });

  it("matches OpenRouter no-endpoints wording", () => {
    expect(
      isModelNotFoundErrorMessage("404 No endpoints found for deepseek/deepseek-r1:free."),
    ).toBe(true);
  });
});

describe("isProviderUnavailableErrorMessage", () => {
  it("matches raw HTML provider error pages from transient upstreams", () => {
    expect(
      isProviderUnavailableErrorMessage(
        "Error: <html><head><title>Service Unavailable</title></head><body>try again</body></html>",
      ),
    ).toBe(true);
  });

  it("matches status-prefixed Cloudflare HTML pages", () => {
    expect(
      isProviderUnavailableErrorMessage(
        "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      ),
    ).toBe(true);
  });

  it("matches transient upstream 502 errors", () => {
    expect(isProviderUnavailableErrorMessage("502 internal server error")).toBe(true);
    expect(
      isProviderUnavailableErrorMessage("provider returned error: 502 Internal Server Error"),
    ).toBe(true);
  });
});

function isChatGPTUsageLimitErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return msg.includes("hit your chatgpt usage limit") && msg.includes("try again in");
}

function isRefreshTokenReused(raw: string): boolean {
  return /refresh_token_reused/i.test(raw);
}

function isAccountIdExtractionError(raw: string): boolean {
  return /failed to extract accountid from token/i.test(raw);
}

function isInstructionsRequiredError(raw: string): boolean {
  return /instructions are required/i.test(raw);
}

function isOpenAiCodexHtmlInterruption(raw: string): boolean {
  const trimmed = raw.trim().replace(/^Error:\s*/i, "");
  return (
    /^(?:<!doctype\s+html\b|<html\b)/i.test(trimmed) &&
    (/<meta\s+name=["']viewport["']/i.test(trimmed) || /<body\b/i.test(trimmed))
  );
}

function isModelTimeoutError(raw: string): boolean {
  return /model call timed out after \d+ms/i.test(raw);
}

function isProviderUnavailableErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    isRawHtmlProviderErrorPage(raw) ||
    isCloudflareOrHtmlErrorPage(raw) ||
    msg.includes("no allowed providers are available") ||
    msg.includes("provider unavailable") ||
    msg.includes("upstream provider unavailable") ||
    msg.includes("upstream error from google") ||
    msg.includes("temporarily rate-limited upstream") ||
    msg.includes("unable to access non-serverless model") ||
    msg.includes("create and start a new dedicated endpoint") ||
    msg.includes("no available capacity was found for the model") ||
    (msg.includes("502") && msg.includes("internal server error"))
  );
}

function isRawHtmlProviderErrorPage(raw: string): boolean {
  const normalized = raw
    .trim()
    .replace(/^error:\s*/i, "")
    .trim();
  return /^(?:<!doctype\s+html\b|<html\b)/i.test(normalized) && /<\/html>/i.test(normalized);
}

function isOllamaUnavailableErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("ollama could not be reached") ||
    (msg.includes("127.0.0.1:11434") && msg.includes("econnrefused")) ||
    (msg.includes("localhost:11434") && msg.includes("econnrefused"))
  );
}

function isAudioOnlyModelErrorMessage(raw: string): boolean {
  return /requires that either input content or output modality contain audio/i.test(raw);
}

function isUnsupportedReasoningEffortErrorMessage(raw: string): boolean {
  return (
    /does not support parameter reasoningeffort/i.test(raw) ||
    /unsupported value:\s*'low'.*reasoning\.effort.*supported values are:\s*'medium'/i.test(raw)
  );
}

function isUnsupportedThinkingToggleErrorMessage(raw: string): boolean {
  return /does not support parameter [`"]?enable_thinking[`"]?/i.test(raw);
}

function isUnsupportedPlanErrorMessage(raw: string): boolean {
  return /current token plan (?:does )?not support (?:this )?model/i.test(raw);
}

describe("isUnsupportedPlanErrorMessage", () => {
  it("matches provider plan-gated models", () => {
    expect(isUnsupportedPlanErrorMessage("current token plan does not support this model")).toBe(
      true,
    );
    expect(isUnsupportedPlanErrorMessage("your current token plan not support model")).toBe(true);
    expect(isUnsupportedPlanErrorMessage("model not found")).toBe(false);
  });
});

function toInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveLiveModelConcurrency(raw = process.env.OPENCLAW_LIVE_MODEL_CONCURRENCY): number {
  return Math.max(1, toInt(raw, DEFAULT_LIVE_MODEL_CONCURRENCY));
}

describe("resolveLiveModelConcurrency", () => {
  it("defaults direct-model probes to 20-way concurrency", () => {
    expect(resolveLiveModelConcurrency(undefined)).toBe(20);
  });

  it("accepts explicit concurrency overrides", () => {
    expect(resolveLiveModelConcurrency("7")).toBe(7);
    expect(resolveLiveModelConcurrency("0")).toBe(1);
  });
});

function resolveLiveModelsJsonTimeoutMs(
  modelsJsonTimeoutRaw = process.env.OPENCLAW_LIVE_MODELS_JSON_TIMEOUT_MS,
  setupTimeoutMs = LIVE_SETUP_TIMEOUT_MS,
): number {
  return Math.max(setupTimeoutMs, toInt(modelsJsonTimeoutRaw, 120_000));
}

describe("resolveLiveModelsJsonTimeoutMs", () => {
  it("defaults models.json preparation to a longer setup timeout", () => {
    expect(resolveLiveModelsJsonTimeoutMs(undefined, 45_000)).toBe(120_000);
  });

  it("never goes below the shared live setup timeout", () => {
    expect(resolveLiveModelsJsonTimeoutMs("30000", 45_000)).toBe(45_000);
  });
});

function resolveTestReasoning(
  model: Model<Api>,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  const id = model.id.toLowerCase();
  if (id.includes("deep-research")) {
    return "medium";
  }
  if (model.provider === "openrouter" && id.startsWith("qwq")) {
    return undefined;
  }
  if (model.provider === "xai" && id.startsWith("grok-4")) {
    return undefined;
  }
  if (model.provider === "openai" || model.provider === "openai-codex") {
    if (id.includes("pro")) {
      return "high";
    }
    return "medium";
  }
  return "low";
}

function resolveLiveSystemPrompt(model: Model<Api>): string | undefined {
  if (model.provider === "openai-codex") {
    return "You are a concise assistant. Follow the user's instruction exactly.";
  }
  return undefined;
}

describe("resolveLiveSystemPrompt", () => {
  it("adds instructions for openai-codex probes", () => {
    expect(
      resolveLiveSystemPrompt({
        provider: "openai-codex",
      } as Model<Api>),
    ).toContain("Follow the user's instruction exactly.");
  });

  it("keeps other providers unchanged", () => {
    expect(
      resolveLiveSystemPrompt({
        provider: "openai",
      } as Model<Api>),
    ).toBeUndefined();
  });

  it("matches OpenAI Codex HTML interruption pages", () => {
    expect(
      isOpenAiCodexHtmlInterruption(
        'Error: <html><head><meta name="viewport" content="width=device-width" /></head><body>Try again</body></html>',
      ),
    ).toBe(true);
    expect(isOpenAiCodexHtmlInterruption("Error: connection reset")).toBe(false);
  });
});

async function completeSimpleWithTimeout<TApi extends Api>(
  model: Model<TApi>,
  context: Parameters<typeof completeSimple<TApi>>[1],
  options: Parameters<typeof completeSimple<TApi>>[2],
  timeoutMs: number,
  progressContext: string,
) {
  const maxTimeoutMs = Math.max(1, timeoutMs);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => {
    controller.abort();
  }, maxTimeoutMs);
  abortTimer.unref?.();
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => {
      reject(new Error(`model call timed out after ${maxTimeoutMs}ms`));
    }, maxTimeoutMs);
    hardTimer.unref?.();
  });
  try {
    return await withLiveHeartbeat(
      Promise.race([
        completeSimple(model, context, {
          ...options,
          signal: controller.signal,
        }),
        timeout,
      ]),
      progressContext,
    );
  } finally {
    clearTimeout(abortTimer);
    if (hardTimer) {
      clearTimeout(hardTimer);
    }
  }
}

async function completeOkWithRetry(params: {
  model: Model<Api>;
  apiKey: string;
  timeoutMs: number;
  progressLabel: string;
}) {
  const runOnce = async (maxTokens: number) => {
    const res = await completeSimpleWithTimeout(
      params.model,
      {
        systemPrompt: resolveLiveSystemPrompt(params.model),
        messages: [
          {
            role: "user",
            content: "Reply with the word ok.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: params.apiKey,
        reasoning: resolveTestReasoning(params.model),
        maxTokens,
      },
      params.timeoutMs,
      `${params.progressLabel}: prompt call (maxTokens=${maxTokens})`,
    );
    const text = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ");
    return { res, text };
  };

  const first = await runOnce(64);
  if (first.text.length > 0) {
    return first;
  }
  // Some providers (for example Moonshot Kimi and MiniMax M2.5) may emit
  // reasoning blocks first and only return text once token budget is higher.
  return await runOnce(256);
}

async function runExtraTurnProbes(params: {
  model: Model<Api>;
  apiKey: string;
  timeoutMs: number;
  progressLabel: string;
}) {
  if (shouldSkipLiveModelExtraProbes(params.model)) {
    logProgress(`${params.progressLabel}: extra probes skipped (known empty route)`);
    return;
  }
  const options = {
    apiKey: params.apiKey,
    reasoning: resolveTestReasoning(params.model),
    maxTokens: 128,
  };
  if (LIVE_FILE_PROBE_ENABLED && !shouldSkipLiveModelFileProbe(params.model)) {
    logProgress(`${params.progressLabel}: file-read probe`);
    const file = await completeSimpleWithTimeout(
      params.model,
      buildLiveModelFileProbeContext({ systemPrompt: resolveLiveSystemPrompt(params.model) }),
      options,
      params.timeoutMs,
      `${params.progressLabel}: file-read probe`,
    );
    if (file.stopReason === "error") {
      throw new Error(file.errorMessage || "file-read probe returned error with no message");
    }
    let fileText = extractAssistantText(file);
    if (!fileProbeTextMatches(fileText)) {
      logProgress(`${params.progressLabel}: file-read probe retry`);
      const retry = await completeSimpleWithTimeout(
        params.model,
        buildLiveModelFileProbeRetryContext({
          systemPrompt: resolveLiveSystemPrompt(params.model),
        }),
        options,
        params.timeoutMs,
        `${params.progressLabel}: file-read probe retry`,
      );
      if (retry.stopReason === "error") {
        throw new Error(
          retry.errorMessage || "file-read probe retry returned error with no message",
        );
      }
      fileText = extractAssistantText(retry);
    }
    if (!fileProbeTextMatches(fileText)) {
      if (fileText.length === 0) {
        logProgress(`${params.progressLabel}: file-read probe skipped (empty response)`);
      } else {
        throw new Error(
          `file-read probe did not return ${LIVE_MODEL_FILE_PROBE_TOKEN}: ${fileText}`,
        );
      }
    }
  } else if (LIVE_FILE_PROBE_ENABLED) {
    logProgress(`${params.progressLabel}: file-read probe skipped (known empty route)`);
  }

  if (!LIVE_IMAGE_PROBE_ENABLED) {
    return;
  }
  if (!modelSupportsImageInput(params.model)) {
    logProgress(`${params.progressLabel}: image probe skipped (no image input)`);
    return;
  }
  if (shouldSkipLiveModelImageProbe(params.model)) {
    logProgress(`${params.progressLabel}: image probe skipped (known empty route)`);
    return;
  }

  logProgress(`${params.progressLabel}: image probe`);
  const image = await completeSimpleWithTimeout(
    params.model,
    buildLiveModelImageProbeContext({ systemPrompt: resolveLiveSystemPrompt(params.model) }),
    options,
    params.timeoutMs,
    `${params.progressLabel}: image probe`,
  );
  if (image.stopReason === "error") {
    throw new Error(image.errorMessage || "image probe returned error with no message");
  }
  const imageText = extractAssistantText(image);
  if (!imageProbeTextMatches(imageText)) {
    if (imageText.length === 0) {
      logProgress(`${params.progressLabel}: image probe skipped (empty response)`);
      return;
    }
    throw new Error(`image probe did not return ok: ${imageText}`);
  }
}

describeLive("live models (profile keys)", () => {
  it(
    "completes across selected models",
    async () => {
      logProgress("[live-models] loading config");
      const cfg = await withLiveStageTimeout(
        Promise.resolve().then(() => loadConfig()),
        "[live-models] load config",
      );
      logProgress("[live-models] preparing models.json");
      await withLiveStageTimeout(
        ensureOpenClawModelsJson(cfg),
        "[live-models] prepare models.json",
        LIVE_MODELS_JSON_TIMEOUT_MS,
      );
      if (!DIRECT_ENABLED) {
        logProgress(
          "[live-models] skipping (set OPENCLAW_LIVE_MODELS=modern|all|<list>; all=modern)",
        );
        return;
      }
      const anthropicKeys = collectAnthropicApiKeys();
      if (anthropicKeys.length > 0) {
        process.env.ANTHROPIC_API_KEY = anthropicKeys[0];
        logProgress(`[live-models] anthropic keys loaded: ${anthropicKeys.length}`);
      }

      const agentDir = resolveOpenClawAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      logProgress("[live-models] loading model registry");
      const models = await withLiveStageTimeout(
        Promise.resolve().then(() => discoverModels(authStorage, agentDir).getAll()),
        "[live-models] load model registry",
      );

      const rawModels = process.env.OPENCLAW_LIVE_MODELS?.trim();
      const useModern = rawModels === "modern" || rawModels === "all";
      const useExplicit = Boolean(rawModels) && !useModern;
      const filter = useExplicit ? parseModelFilter(rawModels) : null;
      const allowNotFoundSkip = useModern;
      const providers = parseProviderFilter(process.env.OPENCLAW_LIVE_PROVIDERS);
      const perModelTimeoutMs = toInt(process.env.OPENCLAW_LIVE_MODEL_TIMEOUT_MS, 30_000);
      const maxModels = resolveHighSignalLiveModelLimit({
        rawMaxModels: process.env.OPENCLAW_LIVE_MAX_MODELS,
        useExplicitModels: useExplicit,
      });
      const targetMatcher = createLiveTargetMatcher({
        providerFilter: providers,
        modelFilter: filter,
        config: cfg,
        env: process.env,
      });

      const failures: Array<{ model: string; error: string }> = [];
      const skipped: Array<{ model: string; reason: string }> = [];
      const candidates: Array<{
        model: Model<Api>;
        apiKeyInfo: Awaited<ReturnType<typeof getApiKeyForModel>>;
      }> = [];

      for (const model of models) {
        if (shouldSuppressBuiltInModel({ provider: model.provider, id: model.id })) {
          continue;
        }
        if (!targetMatcher.matchesProvider(model.provider)) {
          continue;
        }
        const id = `${model.provider}/${model.id}`;
        if (!targetMatcher.matchesModel(model.provider, model.id)) {
          continue;
        }
        if (!filter && useModern) {
          if (
            shouldExcludeProviderFromDefaultHighSignalLiveSweep({
              provider: model.provider,
              useExplicitModels: useExplicit,
              providerFilter: providers,
              config: cfg,
              env: process.env,
            })
          ) {
            continue;
          }
          if (!isHighSignalLiveModelRef({ provider: model.provider, id: model.id })) {
            continue;
          }
        }
        try {
          const apiKeyInfo = await getApiKeyForModel({
            model,
            cfg,
            credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
          });
          if (REQUIRE_PROFILE_KEYS && !apiKeyInfo.source.startsWith("profile:")) {
            skipped.push({
              model: id,
              reason: `non-profile credential source: ${apiKeyInfo.source}`,
            });
            continue;
          }
          candidates.push({ model, apiKeyInfo });
        } catch (err) {
          skipped.push({ model: id, reason: String(err) });
        }
      }

      if (candidates.length === 0) {
        logProgress("[live-models] no API keys found; skipping");
        return;
      }

      const selectedCandidates = selectHighSignalLiveItems(
        candidates,
        maxModels > 0 ? maxModels : candidates.length,
        (entry) => ({ provider: entry.model.provider, id: entry.model.id }),
        (entry) => entry.model.provider,
      );
      logProgress(`[live-models] selection=${useExplicit ? "explicit" : "high-signal"}`);
      if (selectedCandidates.length < candidates.length) {
        logProgress(
          `[live-models] capped to ${selectedCandidates.length}/${candidates.length} via OPENCLAW_LIVE_MAX_MODELS=${maxModels}`,
        );
      }
      logProgress(`[live-models] running ${selectedCandidates.length} models`);
      logProgress(
        `[live-models] heartbeat=${formatElapsedSeconds(LIVE_HEARTBEAT_MS)} timeout=${formatElapsedSeconds(perModelTimeoutMs)} concurrency=${LIVE_MODEL_CONCURRENCY}`,
      );
      const total = selectedCandidates.length;

      const tasks = selectedCandidates.map((entry, index) => async () => {
        const { model, apiKeyInfo } = entry;
        const id = `${model.provider}/${model.id}`;
        const progressLabel = `[live-models] ${index + 1}/${total} ${id}`;
        const attemptMax =
          model.provider === "anthropic" && anthropicKeys.length > 0 ? anthropicKeys.length : 1;
        for (let attempt = 0; attempt < attemptMax; attempt += 1) {
          if (model.provider === "anthropic" && anthropicKeys.length > 0) {
            process.env.ANTHROPIC_API_KEY = anthropicKeys[attempt];
          }
          const apiKey =
            model.provider === "anthropic" && anthropicKeys.length > 0
              ? anthropicKeys[attempt]
              : requireApiKey(apiKeyInfo, model.provider);
          try {
            // Special regression: OpenAI requires replayed `reasoning` items for tool-only turns.
            if (
              model.provider === "openai" &&
              model.api === "openai-responses" &&
              model.id === "gpt-5.2"
            ) {
              logProgress(`${progressLabel}: tool-only regression`);
              const noopTool = {
                name: "noop",
                description: "Return ok.",
                parameters: Type.Object({}, { additionalProperties: false }),
              };

              let firstUserContent = "Call the tool `noop` with {}. Do not write any other text.";
              let firstUser = {
                role: "user" as const,
                content: firstUserContent,
                timestamp: Date.now(),
              };

              let first = await completeSimpleWithTimeout(
                model,
                { messages: [firstUser], tools: [noopTool] },
                {
                  apiKey,
                  reasoning: resolveTestReasoning(model),
                  maxTokens: 128,
                },
                perModelTimeoutMs,
                `${progressLabel}: tool-only regression first call`,
              );

              let toolCall = first.content.find((b) => b.type === "toolCall");
              let firstText = first.content
                .filter((b) => b.type === "text")
                .map((b) => b.text.trim())
                .join(" ")
                .trim();

              // Occasional flake: model answers in text instead of tool call (or adds text).
              // Retry a couple times with a stronger instruction so we still exercise the tool-only replay path.
              for (let i = 0; i < 2 && (!toolCall || firstText.length > 0); i += 1) {
                firstUserContent =
                  "Call the tool `noop` with {}. IMPORTANT: respond ONLY with the tool call; no other text.";
                firstUser = {
                  role: "user" as const,
                  content: firstUserContent,
                  timestamp: Date.now(),
                };

                first = await completeSimpleWithTimeout(
                  model,
                  { messages: [firstUser], tools: [noopTool] },
                  {
                    apiKey,
                    reasoning: resolveTestReasoning(model),
                    maxTokens: 128,
                  },
                  perModelTimeoutMs,
                  `${progressLabel}: tool-only regression retry ${i + 1}`,
                );

                toolCall = first.content.find((b) => b.type === "toolCall");
                firstText = first.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text.trim())
                  .join(" ")
                  .trim();
              }

              expect(toolCall).toBeTruthy();
              expect(firstText.length).toBe(0);
              if (!toolCall || toolCall.type !== "toolCall") {
                throw new Error("expected tool call");
              }

              const second = await completeSimpleWithTimeout(
                model,
                {
                  messages: [
                    firstUser,
                    first,
                    {
                      role: "toolResult",
                      toolCallId: toolCall.id,
                      toolName: "noop",
                      content: [{ type: "text", text: "ok" }],
                      isError: false,
                      timestamp: Date.now(),
                    },
                    {
                      role: "user",
                      content: "Reply with the word ok.",
                      timestamp: Date.now(),
                    },
                  ],
                },
                {
                  apiKey,
                  reasoning: resolveTestReasoning(model),
                  // Headroom: reasoning summary can consume most of the output budget.
                  maxTokens: 256,
                },
                perModelTimeoutMs,
                `${progressLabel}: tool-only regression followup`,
              );

              const secondText = second.content
                .filter((b) => b.type === "text")
                .map((b) => b.text.trim())
                .join(" ");
              expect(secondText.length).toBeGreaterThan(0);
              await runExtraTurnProbes({
                model,
                apiKey,
                timeoutMs: perModelTimeoutMs,
                progressLabel,
              });
              logProgress(`${progressLabel}: done`);
              break;
            }

            logProgress(`${progressLabel}: prompt`);
            const ok = await completeOkWithRetry({
              model,
              apiKey,
              timeoutMs: perModelTimeoutMs,
              progressLabel,
            });

            if (ok.res.stopReason === "error") {
              const msg = ok.res.errorMessage ?? "";
              if (allowNotFoundSkip && isModelNotFoundErrorMessage(msg)) {
                skipped.push({ model: id, reason: msg });
                logProgress(`${progressLabel}: skip (model not found)`);
                break;
              }
              throw new Error(msg || "model returned error with no message");
            }

            if (
              ok.text.length === 0 &&
              (model.provider === "google" || model.provider === "google-gemini-cli")
            ) {
              skipped.push({
                model: id,
                reason: "no text returned (likely unavailable model id)",
              });
              logProgress(`${progressLabel}: skip (google model not found)`);
              break;
            }
            if (
              ok.text.length === 0 &&
              (model.provider === "openrouter" ||
                model.provider === "opencode" ||
                model.provider === "opencode-go")
            ) {
              skipped.push({
                model: id,
                reason: "no text returned (provider returned empty content)",
              });
              logProgress(`${progressLabel}: skip (empty response)`);
              break;
            }
            if (
              ok.text.length === 0 &&
              allowNotFoundSkip &&
              (model.provider === "fireworks" ||
                model.provider === "google-antigravity" ||
                model.provider === "minimax" ||
                model.provider === "openai-codex" ||
                model.provider === "xai" ||
                model.provider === "zai")
            ) {
              skipped.push({
                model: id,
                reason: "no text returned (provider returned empty content)",
              });
              logProgress(`${progressLabel}: skip (empty response)`);
              break;
            }
            expect(ok.text.length).toBeGreaterThan(0);
            await runExtraTurnProbes({
              model,
              apiKey,
              timeoutMs: perModelTimeoutMs,
              progressLabel,
            });
            logProgress(`${progressLabel}: done`);
            break;
          } catch (err) {
            const message = String(err);
            if (
              model.provider === "anthropic" &&
              isAnthropicRateLimitError(message) &&
              attempt + 1 < attemptMax
            ) {
              logProgress(`${progressLabel}: rate limit, retrying with next key`);
              continue;
            }
            if (model.provider === "anthropic" && isAnthropicRateLimitError(message)) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (anthropic rate limit)`);
              break;
            }
            if (model.provider === "anthropic" && isAnthropicBillingError(message)) {
              if (attempt + 1 < attemptMax) {
                logProgress(`${progressLabel}: billing issue, retrying with next key`);
                continue;
              }
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (anthropic billing)`);
              break;
            }
            if (
              (model.provider === "google" || model.provider === "google-gemini-cli") &&
              isGoogleModelNotFoundError(err)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (google model not found)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              model.provider === "minimax" &&
              message.includes("request ended without sending any chunks")
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (minimax empty response)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              (model.provider === "minimax" ||
                model.provider === "zai" ||
                model.provider === "openrouter") &&
              isRateLimitErrorMessage(message)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (rate limit)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              (model.provider === "opencode" || model.provider === "opencode-go") &&
              isRateLimitErrorMessage(message)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (rate limit)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              model.provider === "openai-codex" &&
              isRefreshTokenReused(message)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (codex refresh token reused)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              model.provider === "openai-codex" &&
              isAccountIdExtractionError(message)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (codex account id extraction)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              model.provider === "openai-codex" &&
              isChatGPTUsageLimitErrorMessage(message)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (chatgpt usage limit)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              model.provider === "openai-codex" &&
              isInstructionsRequiredError(message)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (instructions required)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              model.provider === "openai-codex" &&
              isOpenAiCodexHtmlInterruption(message)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (codex html interruption)`);
              break;
            }
            if (allowNotFoundSkip && isModelTimeoutError(message)) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (timeout)`);
              break;
            }
            if (allowNotFoundSkip && isProviderUnavailableErrorMessage(message)) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (provider unavailable)`);
              break;
            }
            if (allowNotFoundSkip && isModelNotFoundErrorMessage(message)) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (model not found)`);
              break;
            }
            if (allowNotFoundSkip && isAudioOnlyModelErrorMessage(message)) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (audio-only model)`);
              break;
            }
            if (allowNotFoundSkip && isUnsupportedReasoningEffortErrorMessage(message)) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (reasoning unsupported)`);
              break;
            }
            if (allowNotFoundSkip && isUnsupportedThinkingToggleErrorMessage(message)) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (thinking toggle unsupported)`);
              break;
            }
            if (allowNotFoundSkip && isUnsupportedPlanErrorMessage(message)) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (plan unsupported)`);
              break;
            }
            if (
              allowNotFoundSkip &&
              model.provider === "ollama" &&
              isOllamaUnavailableErrorMessage(message)
            ) {
              skipped.push({ model: id, reason: message });
              logProgress(`${progressLabel}: skip (ollama unavailable)`);
              break;
            }
            logProgress(`${progressLabel}: failed`);
            failures.push({ model: id, error: message });
            break;
          }
        }
      });

      await runTasksWithConcurrency({
        tasks,
        limit: LIVE_MODEL_CONCURRENCY,
      });

      if (failures.length > 0) {
        const preview = formatFailurePreview(failures, 20);
        throw new Error(
          `live model failures (${failures.length}, showing ${Math.min(failures.length, 20)}):\n${preview}`,
        );
      }

      void skipped;
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
