import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  collectAnthropicApiKeys,
  isAnthropicBillingError,
  isAnthropicRateLimitError,
} from "../agents/live-auth-keys.js";
import { isModelNotFoundErrorMessage } from "../agents/live-model-errors.js";
import {
  DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  getHighSignalLiveModelPriorityIndex,
  isHighSignalLiveModelRef,
  resolveHighSignalLiveModelLimit,
  selectHighSignalLiveItems,
  shouldExcludeProviderFromDefaultHighSignalLiveSweep,
} from "../agents/live-model-filter.js";
import { createLiveTargetMatcher } from "../agents/live-target-matcher.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { getApiKeyForModel, resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { shouldSuppressBuiltInModel } from "../agents/model-suppression.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { isRateLimitErrorMessage } from "../agents/pi-embedded-helpers/errors.js";
import { discoverAuthStorage, discoverModels } from "../agents/pi-model-discovery.js";
import { clearRuntimeConfigSnapshot, loadConfig } from "../config/io.js";
import type { ModelsConfig, ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { normalizeGoogleModelId } from "../plugin-sdk/google-model-id.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { stripAssistantInternalScaffolding } from "../shared/text/assistant-visible-text.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { renderCatNoncePngBase64 } from "./live-image-probe.js";
import {
  hasExpectedSingleNonce,
  hasExpectedToolNonce,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe-utils.js";
import { startGatewayServer } from "./server.impl.js";
import { loadSessionEntry, readSessionMessages } from "./session-utils.js";

const ZAI_FALLBACK = isTruthyEnvValue(process.env.OPENCLAW_LIVE_GATEWAY_ZAI_FALLBACK);
const REQUIRE_PROFILE_KEYS = isLiveProfileKeyModeEnabled();
const LIVE_CREDENTIAL_PRECEDENCE = REQUIRE_PROFILE_KEYS ? "profile-first" : "env-first";
const PROVIDERS = parseFilter(process.env.OPENCLAW_LIVE_GATEWAY_PROVIDERS);
const GATEWAY_LIVE_SMOKE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_GATEWAY_SMOKE);
const THINKING_LEVEL = GATEWAY_LIVE_SMOKE ? "low" : "high";
const ENABLE_EXTRA_TOOL_PROBES = !GATEWAY_LIVE_SMOKE;
const ENABLE_EXTRA_IMAGE_PROBES = !GATEWAY_LIVE_SMOKE;
const THINKING_TAG_RE = /<\s*\/?\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\s*>/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/i;
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const GATEWAY_LIVE_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS = 60 * 60 * 1000;
const GATEWAY_LIVE_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const GATEWAY_LIVE_PROBE_TIMEOUT_MS = Math.max(
  30_000,
  toInt(process.env.OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS, 90_000),
);
const GATEWAY_LIVE_MODEL_TIMEOUT_MS = resolveGatewayLiveModelTimeoutMs();
const GATEWAY_LIVE_HEARTBEAT_MS = Math.max(
  1_000,
  toInt(process.env.OPENCLAW_LIVE_GATEWAY_HEARTBEAT_MS, 30_000),
);
const GATEWAY_LIVE_STRIP_SCAFFOLDING_MODEL_KEYS = new Set([
  "google/gemini-3-flash-preview",
  "google/gemini-3-pro-preview",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview-customtools",
  "openai/gpt-5.4-pro",
]);
const GATEWAY_LIVE_EXEC_READ_NONCE_MISS_SKIP_MODEL_KEYS = new Set([
  "google/gemini-3.1-flash-lite-preview",
]);
const GATEWAY_LIVE_TOOL_NONCE_MISS_SKIP_MODEL_KEYS = new Set(["google/gemini-3-flash-preview"]);
const GATEWAY_LIVE_MAX_MODELS = resolveGatewayLiveMaxModels();
const GATEWAY_LIVE_SUITE_TIMEOUT_MS = resolveGatewayLiveSuiteTimeoutMs(GATEWAY_LIVE_MAX_MODELS);
const QUIET_LIVE_LOGS = process.env.OPENCLAW_LIVE_TEST_QUIET !== "0";

const describeLive = isLiveTestEnabled(["OPENCLAW_LIVE_GATEWAY"]) ? describe : describe.skip;

function parseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") {
    return null;
  }
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function shouldSuppressGatewayLiveOllamaWarnings(): boolean {
  return PROVIDERS !== null && !PROVIDERS.has("ollama");
}

async function withSuppressedGatewayLiveWarnings<T>(run: () => Promise<T>): Promise<T> {
  if (!shouldSuppressGatewayLiveOllamaWarnings()) {
    return await run();
  }
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args.some((arg) => typeof arg === "string" && isOllamaUnavailableErrorMessage(arg))) {
      return;
    }
    originalWarn(...args);
  };
  try {
    return await run();
  } finally {
    console.warn = originalWarn;
  }
}

function toInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveGatewayLiveMaxModels(): number {
  const gatewayRaw = process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS?.trim();
  if (gatewayRaw) {
    return Math.max(0, toInt(gatewayRaw, 0));
  }
  const rawModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS?.trim();
  const useExplicitModels = Boolean(rawModels) && rawModels !== "modern" && rawModels !== "all";
  return resolveHighSignalLiveModelLimit({
    rawMaxModels: process.env.OPENCLAW_LIVE_MAX_MODELS,
    useExplicitModels,
    defaultLimit: DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  });
}

function resolveGatewayLiveSuiteTimeoutMs(maxModels: number): number {
  if (maxModels <= 0) {
    return GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS;
  }
  // Gateway live runs multiple probes per model; scale timeout by model cap.
  const estimated = 5 * 60 * 1000 + maxModels * 90 * 1000;
  return Math.max(
    GATEWAY_LIVE_DEFAULT_TIMEOUT_MS,
    Math.min(GATEWAY_LIVE_MAX_TIMEOUT_MS, estimated),
  );
}

function resolveGatewayLiveModelTimeoutMs(
  gatewayModelTimeoutRaw = process.env.OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS,
  liveModelTimeoutRaw = process.env.OPENCLAW_LIVE_MODEL_TIMEOUT_MS,
  stepTimeoutMs = GATEWAY_LIVE_PROBE_TIMEOUT_MS,
): number {
  const requested = toInt(gatewayModelTimeoutRaw, toInt(liveModelTimeoutRaw, 120_000));
  return Math.max(stepTimeoutMs, requested);
}

function isGatewayLiveProbeTimeout(error: string): boolean {
  return /probe timeout after \d+ms/i.test(error);
}

function isGatewayLiveModelTimeout(error: string): boolean {
  return /model timeout after \d+ms/i.test(error);
}

async function withGatewayLiveTimeout<T>(params: {
  operation: Promise<T>;
  timeoutMs: number;
  timeoutLabel: "probe" | "model";
  context: string;
}): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    heartbeatCount += 1;
    logProgress(
      `${params.context}: still running (${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))}s)`,
    );
  }, GATEWAY_LIVE_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await Promise.race([
      params.operation,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(
              `${params.timeoutLabel} timeout after ${params.timeoutMs}ms (${params.context})`,
            ),
          );
        }, params.timeoutMs);
      }),
    ]);
  } finally {
    clearInterval(heartbeat);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (heartbeatCount > 0) {
      logProgress(
        `${params.context}: completed after ${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))}s`,
      );
    }
  }
}

async function withGatewayLiveProbeTimeout<T>(operation: Promise<T>, context: string): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs: GATEWAY_LIVE_PROBE_TIMEOUT_MS,
    timeoutLabel: "probe",
    context,
  });
}

async function withGatewayLiveModelTimeout<T>(operation: Promise<T>, context: string): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs: GATEWAY_LIVE_MODEL_TIMEOUT_MS,
    timeoutLabel: "model",
    context,
  });
}

function logProgress(message: string): void {
  process.stderr.write(`[live] ${message}\n`);
}

function enterProductionEnvForLiveRun() {
  const previous = {
    vitest: process.env.VITEST,
    nodeEnv: process.env.NODE_ENV,
  };
  delete process.env.VITEST;
  process.env.NODE_ENV = "production";
  return previous;
}

function restoreProductionEnvForLiveRun(previous: {
  vitest: string | undefined;
  nodeEnv: string | undefined;
}) {
  if (previous.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = previous.vitest;
  }
  if (previous.nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previous.nodeEnv;
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

function assertNoReasoningTags(params: {
  text: string;
  model: string;
  phase: string;
  label: string;
}): void {
  if (!params.text) {
    return;
  }
  if (THINKING_TAG_RE.test(params.text) || FINAL_TAG_RE.test(params.text)) {
    const snippet = params.text.length > 200 ? `${params.text.slice(0, 200)}…` : params.text;
    throw new Error(
      `[${params.label}] reasoning tag leak (${params.model} / ${params.phase}): ${snippet}`,
    );
  }
}

function isMeaningful(text: string): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "ok") {
    return false;
  }
  if (trimmed.length < 60) {
    return false;
  }
  const words = trimmed.split(/\s+/g).filter(Boolean);
  if (words.length < 12) {
    return false;
  }
  return true;
}

function hasEventLoopPromptKeywords(text: string): boolean {
  return /\bmicro\s*-?\s*tasks?\b/i.test(text) && /\bmacro\s*-?\s*tasks?\b/i.test(text);
}

function shouldStripAssistantScaffoldingForLiveModel(modelKey?: string): boolean {
  if (!modelKey) {
    return false;
  }
  if (GATEWAY_LIVE_STRIP_SCAFFOLDING_MODEL_KEYS.has(modelKey)) {
    return true;
  }
  const [provider, ...rest] = modelKey.split("/");
  const modelId = rest.join("/");
  if (provider === "anthropic") {
    return true;
  }
  if (provider === "minimax" || provider === "minimax-portal") {
    // MiniMax transcript persistence can mirror our <final> wrapper style even
    // though user-visible surfaces already strip it. Keep the live reader
    // aligned with the runtime-facing sanitizers for the whole provider family.
    return true;
  }
  if (provider !== "google" || rest.length === 0) {
    return false;
  }
  const normalizedKey = `${provider}/${normalizeGoogleModelId(modelId)}`;
  return GATEWAY_LIVE_STRIP_SCAFFOLDING_MODEL_KEYS.has(normalizedKey);
}

function maybeStripAssistantScaffoldingForLiveModel(text: string, modelKey?: string): string {
  if (!shouldStripAssistantScaffoldingForLiveModel(modelKey)) {
    return text;
  }
  return stripAssistantInternalScaffolding(stripKnownLiveReasoningWrappers(text)).trim();
}

function stripKnownLiveReasoningWrappers(text: string): string {
  return text
    .replace(/<\s*think\b[^<>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
    .replace(/^[\s\S]*?<\s*\/\s*think\s*>\s*/i, "")
    .replace(/<\s*final\b[^<>]*>([\s\S]*?)<\s*\/\s*final\s*>/gi, "$1");
}

function shouldSkipExecReadNonceMissForLiveModel(modelKey?: string): boolean {
  if (!modelKey) {
    return false;
  }
  if (GATEWAY_LIVE_EXEC_READ_NONCE_MISS_SKIP_MODEL_KEYS.has(modelKey)) {
    return true;
  }
  const [provider, ...rest] = modelKey.split("/");
  if (provider !== "google" || rest.length === 0) {
    return false;
  }
  const normalizedKey = `${provider}/${normalizeGoogleModelId(rest.join("/"))}`;
  return GATEWAY_LIVE_EXEC_READ_NONCE_MISS_SKIP_MODEL_KEYS.has(normalizedKey);
}

function shouldSkipEmptyResponseForLiveModel(params: {
  provider: string;
  allowNotFoundSkip: boolean;
}): boolean {
  if (isGoogleishProvider(params.provider)) {
    return true;
  }
  if (params.provider === "openrouter" || params.provider === "opencode") {
    return true;
  }
  if (params.provider === "opencode-go") {
    return true;
  }
  if (!params.allowNotFoundSkip) {
    return false;
  }
  return (
    params.provider === "google-antigravity" ||
    params.provider === "minimax" ||
    params.provider === "openai-codex" ||
    params.provider === "zai"
  );
}

describe("maybeStripAssistantScaffoldingForLiveModel", () => {
  it("strips scaffolding for Gemini preview models with known transcript wrappers", () => {
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<final>Visible</final>",
        "google/gemini-3-flash-preview",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<think>hidden</think>Visible",
        "google/gemini-3.1-flash-preview",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<think>hidden</think>Visible",
        "google/gemini-3.1-flash-lite-preview",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<think>hidden</think>Visible",
        "google/gemini-3.1-pro-preview",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<think>hidden</think>Visible",
        "google/gemini-3.1-pro-preview-customtools",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        [
          "<think>",
          "1. Inspect",
          "```",
          "draft",
          "```",
          "2. Draft the explanation",
          "</think>The event loop drains the microtask queue before the next macrotask.",
        ].join("\n"),
        "google/gemini-3-flash-preview",
      ),
    ).toBe("The event loop drains the microtask queue before the next macrotask.");
  });

  it("strips scaffolding for known OpenAI transcript wrappers", () => {
    expect(
      maybeStripAssistantScaffoldingForLiveModel("<final>Visible</final>", "openai/gpt-5.4-pro"),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel("<final>Visible</final>", "openai/gpt-5.4"),
    ).toBe("<final>Visible</final>");
  });

  it("strips Anthropic antml transcript wrappers", () => {
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<antml:thinking>hidden</thinking>Visible",
        "anthropic/claude-opus-4-6",
      ),
    ).toBe("Visible");
  });

  it("strips scaffolding for MiniMax transcript wrappers", () => {
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<final>Visible</final>",
        "minimax/MiniMax-M2.5-highspeed",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<final>Visible</final>",
        "minimax-portal/MiniMax-M2.7-highspeed",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel("<final>Visible</final>", "minimax/MiniMax-M2.7"),
    ).toBe("Visible");
  });
});

describe("shouldSkipExecReadNonceMissForLiveModel", () => {
  it("matches the known Gemini lite exec/read isolation case", () => {
    expect(shouldSkipExecReadNonceMissForLiveModel("google/gemini-3.1-flash-lite-preview")).toBe(
      true,
    );
    expect(shouldSkipExecReadNonceMissForLiveModel("google/gemini-3.1-flash-lite")).toBe(true);
    expect(shouldSkipExecReadNonceMissForLiveModel("google/gemini-3.1-flash-preview")).toBe(false);
  });
});

describe("resolveGatewayLiveModelTimeoutMs", () => {
  it("prefers gateway-specific timeout when provided", () => {
    expect(resolveGatewayLiveModelTimeoutMs("180000", "45000", 90_000)).toBe(180_000);
  });

  it("falls back to the shared live timeout", () => {
    expect(resolveGatewayLiveModelTimeoutMs("", "45000", 30_000)).toBe(45_000);
  });

  it("never goes below the probe timeout", () => {
    expect(resolveGatewayLiveModelTimeoutMs("45000", undefined, 90_000)).toBe(90_000);
  });
});

describe("resolveGatewayLiveMaxModels", () => {
  const originalGatewayModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS;
  const originalGatewayMax = process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
  const originalSharedMax = process.env.OPENCLAW_LIVE_MAX_MODELS;
  function restoreEnvValue(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  afterEach(() => {
    restoreEnvValue("OPENCLAW_LIVE_GATEWAY_MODELS", originalGatewayModels);
    restoreEnvValue("OPENCLAW_LIVE_GATEWAY_MAX_MODELS", originalGatewayMax);
    restoreEnvValue("OPENCLAW_LIVE_MAX_MODELS", originalSharedMax);
  });

  it("defaults modern gateway sweeps to the curated high-signal cap", () => {
    delete process.env.OPENCLAW_LIVE_GATEWAY_MODELS;
    delete process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
    delete process.env.OPENCLAW_LIVE_MAX_MODELS;

    expect(resolveGatewayLiveMaxModels()).toBe(DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT);
  });

  it("keeps explicit gateway model lists uncapped unless a cap is provided", () => {
    process.env.OPENCLAW_LIVE_GATEWAY_MODELS = "openai/gpt-5.5,anthropic/claude-opus-4-6";
    delete process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
    delete process.env.OPENCLAW_LIVE_MAX_MODELS;

    expect(resolveGatewayLiveMaxModels()).toBe(0);

    process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS = "2";
    expect(resolveGatewayLiveMaxModels()).toBe(2);
  });
});

function isGoogleModelNotFoundText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (!/not found/i.test(trimmed)) {
    return false;
  }
  if (/models\/.+ is not found for api version/i.test(trimmed)) {
    return true;
  }
  if (/"status"\s*:\s*"NOT_FOUND"/.test(trimmed)) {
    return true;
  }
  if (/"code"\s*:\s*404/.test(trimmed)) {
    return true;
  }
  return false;
}

function isGoogleishProvider(provider: string): boolean {
  return provider === "google" || provider.startsWith("google-");
}

function isRefreshTokenReused(error: string): boolean {
  return /refresh_token_reused/i.test(error);
}

function isAccountIdExtractionError(error: string): boolean {
  return /failed to extract accountid from token/i.test(error);
}

function isChatGPTUsageLimitErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return msg.includes("hit your chatgpt usage limit") && msg.includes("try again in");
}

function isProviderUnavailableErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("no allowed providers are available") ||
    msg.includes("provider unavailable") ||
    msg.includes("upstream provider unavailable") ||
    msg.includes("upstream error from google") ||
    msg.includes("temporarily rate-limited upstream") ||
    msg.includes("unable to access non-serverless model") ||
    msg.includes("create and start a new dedicated endpoint") ||
    msg.includes("no available capacity was found for the model")
  );
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

function isInstructionsRequiredError(error: string): boolean {
  return /instructions are required/i.test(error);
}

function isOpenAIReasoningSequenceError(error: string): boolean {
  const msg = error.toLowerCase();
  return msg.includes("required following item") && msg.includes("reasoning");
}

function isToolNonceRefusal(error: string): boolean {
  const msg = error.toLowerCase();
  if (!msg.includes("nonce")) {
    return false;
  }
  return (
    msg.includes("token") ||
    msg.includes("secret") ||
    msg.includes("local file") ||
    msg.includes("disclose") ||
    msg.includes("can't help") ||
    msg.includes("can’t help") ||
    msg.includes("can't comply") ||
    msg.includes("can’t comply")
  );
}

function isToolNonceProbeMiss(error: string): boolean {
  const msg = error.toLowerCase();
  return msg.includes("tool probe missing nonce") || msg.includes("exec+read probe missing nonce");
}

function isExecReadNonceProbeMiss(error: string): boolean {
  return error.toLowerCase().includes("exec+read probe missing nonce");
}

function isPromptProbeMiss(error: string): boolean {
  const msg = error.toLowerCase();
  return msg.includes("not meaningful:") || msg.includes("missing required keywords:");
}

function shouldSkipToolNonceProbeMissForLiveModel(modelKey?: string): boolean {
  if (!modelKey) {
    return false;
  }
  if (GATEWAY_LIVE_TOOL_NONCE_MISS_SKIP_MODEL_KEYS.has(modelKey)) {
    return true;
  }
  const [provider, ...rest] = modelKey.split("/");
  if (
    provider === "anthropic" ||
    provider === "minimax" ||
    provider === "opencode" ||
    provider === "opencode-go" ||
    provider === "xai" ||
    provider === "zai"
  ) {
    return true;
  }
  if (provider !== "google" || rest.length === 0) {
    return false;
  }
  const normalizedKey = `${provider}/${normalizeGoogleModelId(rest.join("/"))}`;
  return GATEWAY_LIVE_TOOL_NONCE_MISS_SKIP_MODEL_KEYS.has(normalizedKey);
}

describe("shouldSkipToolNonceProbeMissForLiveModel", () => {
  it.each([
    { modelKey: "anthropic/claude-opus-4-6", expected: true },
    { modelKey: "minimax/minimax-m1", expected: true },
    { modelKey: "opencode/big-pickle", expected: true },
    { modelKey: "opencode-go/glm-5", expected: true },
    { modelKey: "xai/grok-4.1-fast", expected: true },
    { modelKey: "zai/glm-4.7", expected: true },
    { modelKey: "google/gemini-3-flash-preview", expected: true },
    { modelKey: "openai/gpt-5.4", expected: false },
  ])("returns $expected for $modelKey", ({ modelKey, expected }) => {
    expect(shouldSkipToolNonceProbeMissForLiveModel(modelKey)).toBe(expected);
  });
});

describe("getHighSignalLiveModelPriorityIndex", () => {
  it("prefers curated Google replacements over big-pickle", () => {
    expect(
      getHighSignalLiveModelPriorityIndex({ provider: "google", id: "gemini-3.1-pro-preview" }),
    ).toBe(3);
    expect(
      getHighSignalLiveModelPriorityIndex({ provider: "google", id: "gemini-3-flash-preview" }),
    ).toBe(4);
    expect(getHighSignalLiveModelPriorityIndex({ provider: "opencode", id: "big-pickle" })).toBe(
      null,
    );
  });
});

describe("shouldSkipEmptyResponseForLiveModel", () => {
  it.each([
    { provider: "google", allowNotFoundSkip: false, expected: true },
    { provider: "google-antigravity", allowNotFoundSkip: false, expected: true },
    { provider: "openrouter", allowNotFoundSkip: false, expected: true },
    { provider: "opencode", allowNotFoundSkip: false, expected: true },
    { provider: "opencode-go", allowNotFoundSkip: false, expected: true },
    { provider: "minimax", allowNotFoundSkip: false, expected: false },
    { provider: "minimax", allowNotFoundSkip: true, expected: true },
    { provider: "zai", allowNotFoundSkip: true, expected: true },
    { provider: "openai-codex", allowNotFoundSkip: true, expected: true },
    { provider: "xai", allowNotFoundSkip: true, expected: false },
  ])(
    "returns $expected for $provider (allowNotFoundSkip=$allowNotFoundSkip)",
    ({ provider, allowNotFoundSkip, expected }) => {
      expect(shouldSkipEmptyResponseForLiveModel({ provider, allowNotFoundSkip })).toBe(expected);
    },
  );
});

describe("isPromptProbeMiss", () => {
  it.each([
    { error: "not meaningful: let me think", expected: true },
    { error: "missing required keywords: event loop summary", expected: true },
    { error: "tool probe missing nonce: nonce-a", expected: false },
  ])("returns $expected for $error", ({ error, expected }) => {
    expect(isPromptProbeMiss(error)).toBe(expected);
  });
});

describe("hasEventLoopPromptKeywords", () => {
  it.each([
    {
      text: "The event loop drains the microtask queue before running the next macrotask.",
      expected: true,
    },
    { text: "Micro-tasks run before macro-tasks.", expected: true },
    { text: "Promise callbacks run before timer callbacks.", expected: false },
  ])("returns $expected for $text", ({ text, expected }) => {
    expect(hasEventLoopPromptKeywords(text)).toBe(expected);
  });
});
function isMissingProfileError(error: string): boolean {
  return /no credentials found for profile/i.test(error);
}

function isEmptyStreamText(text: string): boolean {
  return text.includes("request ended without sending any chunks");
}

function buildAnthropicRefusalToken(): string {
  const suffix = randomUUID().replace(/-/g, "");
  return `${ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL}_${suffix}`;
}

async function runAnthropicRefusalProbe(params: {
  client: GatewayClient;
  sessionKey: string;
  modelKey: string;
  label: string;
  thinkingLevel: string;
}): Promise<void> {
  logProgress(`${params.label}: refusal-probe`);
  const magic = buildAnthropicRefusalToken();
  const probeText = await requestGatewayAgentText({
    client: params.client,
    sessionKey: params.sessionKey,
    idempotencyKey: `idem-${randomUUID()}-refusal`,
    message: `Reply with the single word ok. Test token: ${magic}`,
    thinkingLevel: params.thinkingLevel,
    context: `${params.label}: refusal-probe`,
    modelKey: params.modelKey,
  });
  assertNoReasoningTags({
    text: probeText,
    model: params.modelKey,
    phase: "refusal-probe",
    label: params.label,
  });
  if (!/\bok\b/i.test(probeText)) {
    throw new Error(`refusal probe missing ok: ${probeText}`);
  }

  const followupText = await requestGatewayAgentText({
    client: params.client,
    sessionKey: params.sessionKey,
    idempotencyKey: `idem-${randomUUID()}-refusal-followup`,
    message: "Now reply with exactly: still ok.",
    thinkingLevel: params.thinkingLevel,
    context: `${params.label}: refusal-followup`,
    modelKey: params.modelKey,
  });
  assertNoReasoningTags({
    text: followupText,
    model: params.modelKey,
    phase: "refusal-followup",
    label: params.label,
  });
  if (!/\bstill\b/i.test(followupText) || !/\bok\b/i.test(followupText)) {
    throw new Error(`refusal followup missing expected text: ${followupText}`);
  }
}

function randomImageProbeCode(len = 6): string {
  // Chosen to avoid common OCR confusions in our 5x7 bitmap font.
  // Notably: 0↔8, B↔8, 6↔9, 3↔B, D↔0.
  // Must stay within the glyph set in `src/gateway/live-image-probe.ts`.
  const alphabet = "24567ACEF";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) {
    return bLen;
  }
  if (bLen === 0) {
    return aLen;
  }

  let prev = Array.from({ length: bLen + 1 }, (_v, idx) => idx);
  let curr = Array.from({ length: bLen + 1 }, () => 0);

  for (let i = 1; i <= aLen; i += 1) {
    curr[0] = i;
    const aCh = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j += 1) {
      const cost = aCh === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // delete
        curr[j - 1] + 1, // insert
        prev[j - 1] + cost, // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[bLen] ?? Number.POSITIVE_INFINITY;
}
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to acquire free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return false;
  }
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreeGatewayPort(): Promise<number> {
  // Gateway uses derived ports (browser/canvas). Avoid flaky collisions by
  // ensuring the common derived offsets are free too.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getFreePort();
    const candidates = [port, port + 1, port + 2, port + 4];
    const ok = (await Promise.all(candidates.map((candidate) => isPortFree(candidate)))).every(
      Boolean,
    );
    if (ok) {
      return port;
    }
  }
  throw new Error("failed to acquire a free gateway port block");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeAuthProfileStoreForLiveGateway(store: AuthProfileStore): AuthProfileStore {
  if (REQUIRE_PROFILE_KEYS) {
    return store;
  }

  const envBackedProviders = new Set<string>();
  for (const profile of Object.values(store.profiles)) {
    if (resolveEnvApiKey(profile.provider)?.apiKey) {
      envBackedProviders.add(normalizeProviderId(profile.provider));
    }
  }
  if (envBackedProviders.size === 0) {
    return store;
  }

  const profiles = Object.fromEntries(
    Object.entries(store.profiles).filter(([, profile]) => {
      return !envBackedProviders.has(normalizeProviderId(profile.provider));
    }),
  );
  const keepProfileIds = new Set(Object.keys(profiles));

  const order = store.order
    ? Object.fromEntries(
        Object.entries(store.order)
          .filter(([provider]) => !envBackedProviders.has(normalizeProviderId(provider)))
          .map(([provider, ids]) => [provider, ids.filter((id) => keepProfileIds.has(id))])
          .filter(([, ids]) => ids.length > 0),
      )
    : undefined;

  const lastGood = store.lastGood
    ? Object.fromEntries(
        Object.entries(store.lastGood).filter(([provider, id]) => {
          return !envBackedProviders.has(normalizeProviderId(provider)) && keepProfileIds.has(id);
        }),
      )
    : undefined;

  const usageStats = store.usageStats
    ? Object.fromEntries(Object.entries(store.usageStats).filter(([id]) => keepProfileIds.has(id)))
    : undefined;

  return {
    ...store,
    profiles,
    order: order && Object.keys(order).length > 0 ? order : undefined,
    lastGood: lastGood && Object.keys(lastGood).length > 0 ? lastGood : undefined,
    usageStats: usageStats && Object.keys(usageStats).length > 0 ? usageStats : undefined,
  };
}

async function connectClient(params: { url: string; token: string; timeoutMs?: number }) {
  const timeoutMs = params.timeoutMs ?? GATEWAY_LIVE_PROBE_TIMEOUT_MS;
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    try {
      return await connectClientOnce({
        ...params,
        timeoutMs: Math.min(remainingMs, 35_000),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableGatewayConnectError(lastError) || remainingMs <= 5_000) {
        throw lastError;
      }
      logProgress(`gateway connect warmup retry ${attempt}: ${lastError.message}`);
      await sleep(Math.min(1_000 * attempt, 5_000));
    }
  }

  throw lastError ?? new Error("gateway connect timeout");
}

async function connectClientOnce(params: { url: string; token: string; timeoutMs?: number }) {
  const timeoutMs = params.timeoutMs ?? 10_000;
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    let client: GatewayClient | undefined;
    const stop = (err?: Error, nextClient?: GatewayClient) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        if (client) {
          void client.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        }
        reject(err);
      } else {
        resolve(nextClient as GatewayClient);
      }
    };
    client = new GatewayClient({
      url: params.url,
      token: params.token,
      requestTimeoutMs: Math.max(timeoutMs, GATEWAY_LIVE_MODEL_TIMEOUT_MS),
      connectChallengeTimeoutMs: timeoutMs,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "vitest-live",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(() => stop(new Error("gateway connect timeout")), timeoutMs);
    timer.unref();
    client.start();
  });
}

function isRetryableGatewayConnectError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("gateway closed during connect (1000)") ||
    message.includes("gateway connect timeout") ||
    message.includes("gateway connect challenge timeout") ||
    message.includes("gateway request timeout for connect")
  );
}

describe("sanitizeAuthProfileStoreForLiveGateway", () => {
  it("drops env-backed provider profiles when live auth should prefer env", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        openaiProfile: {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-test",
        },
        codexProfile: {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: 1,
        },
      },
      order: {
        openai: ["openaiProfile"],
        "openai-codex": ["codexProfile"],
      },
      lastGood: {
        openai: "openaiProfile",
        "openai-codex": "codexProfile",
      },
      usageStats: {
        openaiProfile: { lastUsed: 1 },
        codexProfile: { lastUsed: 2 },
      },
    };

    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-live-openai";
    try {
      const sanitized = sanitizeAuthProfileStoreForLiveGateway(store);
      expect(sanitized.profiles.openaiProfile).toBeUndefined();
      expect(sanitized.profiles.codexProfile).toBeDefined();
      expect(sanitized.order).toEqual({ "openai-codex": ["codexProfile"] });
      expect(sanitized.lastGood).toEqual({ "openai-codex": "codexProfile" });
      expect(sanitized.usageStats).toEqual({ codexProfile: { lastUsed: 2 } });
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });
});
function extractTranscriptMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as {
    text?: unknown;
    content?: unknown;
  };
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }
  if (typeof record.content === "string" && record.content.trim()) {
    return record.content.trim();
  }
  if (!Array.isArray(record.content)) {
    return "";
  }
  return record.content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" && text.trim() ? text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readSessionAssistantTexts(sessionKey: string, modelKey?: string): string[] {
  const { storePath, entry } = loadSessionEntry(sessionKey);
  if (!entry?.sessionId) {
    return [];
  }
  const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
  const assistantTexts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }
    assistantTexts.push(
      maybeStripAssistantScaffoldingForLiveModel(extractTranscriptMessageText(message), modelKey),
    );
  }
  return assistantTexts;
}

async function waitForSessionAssistantText(params: {
  sessionKey: string;
  baselineAssistantCount: number;
  context: string;
  modelKey?: string;
}) {
  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let delayMs = 50;
  while (Date.now() - startedAt < GATEWAY_LIVE_PROBE_TIMEOUT_MS) {
    const assistantTexts = readSessionAssistantTexts(params.sessionKey, params.modelKey);
    if (assistantTexts.length > params.baselineAssistantCount) {
      const freshText = assistantTexts
        .slice(params.baselineAssistantCount)
        .map((text) => text.trim())
        .findLast((text) => text.length > 0);
      if (freshText) {
        return freshText;
      }
    }
    if (Date.now() - lastHeartbeatAt >= GATEWAY_LIVE_HEARTBEAT_MS) {
      lastHeartbeatAt = Date.now();
      logProgress(
        `${params.context}: waiting for transcript (${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))}s)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 250);
  }
  throw new Error(`probe timeout after ${GATEWAY_LIVE_PROBE_TIMEOUT_MS}ms (${params.context})`);
}

async function requestGatewayAgentText(params: {
  client: GatewayClient;
  sessionKey: string;
  message: string;
  thinkingLevel: string;
  context: string;
  idempotencyKey: string;
  modelKey?: string;
  attachments?: Array<{
    mimeType: string;
    fileName: string;
    content: string;
  }>;
}) {
  const baselineAssistantCount = readSessionAssistantTexts(
    params.sessionKey,
    params.modelKey,
  ).length;
  const accepted = await withGatewayLiveProbeTimeout(
    params.client.request("agent", {
      sessionKey: params.sessionKey,
      idempotencyKey: params.idempotencyKey,
      message: params.message,
      thinking: params.thinkingLevel,
      deliver: false,
      attachments: params.attachments,
    }),
    `${params.context}: agent-accept`,
  );
  if (accepted?.status !== "accepted") {
    throw new Error(`agent status=${String(accepted?.status)}`);
  }
  return await waitForSessionAssistantText({
    sessionKey: params.sessionKey,
    baselineAssistantCount,
    context: `${params.context}: transcript-final`,
    modelKey: params.modelKey,
  });
}

type GatewayModelSuiteParams = {
  label: string;
  cfg: OpenClawConfig;
  candidates: Array<Model<Api>>;
  allowNotFoundSkip: boolean;
  extraToolProbes: boolean;
  extraImageProbes: boolean;
  thinkingLevel: string;
  providerOverrides?: Record<string, ModelProviderConfig>;
};

function buildLiveGatewayConfig(params: {
  cfg: OpenClawConfig;
  candidates: Array<Model<Api>>;
  providerOverrides?: Record<string, ModelProviderConfig>;
}): OpenClawConfig {
  const providerOverrides = params.providerOverrides ?? {};
  const lmstudioProvider = params.cfg.models?.providers?.lmstudio;
  const baseProviders = params.cfg.models?.providers ?? {};
  const nextProviders = {
    ...baseProviders,
    ...(lmstudioProvider
      ? {
          lmstudio: {
            ...lmstudioProvider,
            api: "openai-completions",
          },
        }
      : {}),
    ...providerOverrides,
  };
  const providers = Object.keys(nextProviders).length > 0 ? nextProviders : baseProviders;
  const baseModels = params.cfg.models;
  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      list: (params.cfg.agents?.list ?? []).map((entry) =>
        Object.assign({}, entry, { sandbox: { mode: `off` } }),
      ),
      defaults: {
        ...params.cfg.agents?.defaults,
        // Live tests should avoid Docker sandboxing so tool probes can
        // operate on the temporary probe files we create in the host workspace.
        sandbox: { mode: "off" },
        models: Object.fromEntries(params.candidates.map((m) => [`${m.provider}/${m.id}`, {}])),
      },
    },
    models:
      Object.keys(providers).length > 0
        ? ({ ...baseModels, providers } as ModelsConfig)
        : baseModels,
  };
}

async function sanitizeAuthConfig(params: {
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<OpenClawConfig["auth"] | undefined> {
  const auth = params.cfg.auth;
  if (!auth) {
    return auth;
  }
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });

  let profiles: NonNullable<OpenClawConfig["auth"]>["profiles"] | undefined;
  if (auth.profiles) {
    profiles = {};
    for (const [profileId, profile] of Object.entries(auth.profiles)) {
      if (!store.profiles[profileId]) {
        continue;
      }
      profiles[profileId] = profile;
    }
    if (Object.keys(profiles).length === 0) {
      profiles = undefined;
    }
  }

  let order: Record<string, string[]> | undefined;
  if (auth.order) {
    order = {};
    for (const [provider, ids] of Object.entries(auth.order)) {
      const filtered = ids.filter((id) => Boolean(store.profiles[id]));
      if (filtered.length === 0) {
        continue;
      }
      order[provider] = filtered;
    }
    if (Object.keys(order).length === 0) {
      order = undefined;
    }
  }

  if (!profiles && !order && !auth.cooldowns) {
    return undefined;
  }
  return {
    ...auth,
    profiles,
    order,
  };
}

function buildMinimaxProviderOverride(params: {
  cfg: OpenClawConfig;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
}): ModelProviderConfig | null {
  const existing = params.cfg.models?.providers?.minimax;
  if (!existing || !Array.isArray(existing.models) || existing.models.length === 0) {
    return null;
  }
  return {
    ...existing,
    api: params.api,
    baseUrl: params.baseUrl,
  };
}

async function runGatewayModelSuite(params: GatewayModelSuiteParams) {
  clearRuntimeConfigSnapshot();
  const runtimeEnv = enterProductionEnvForLiveRun();
  const previous = {
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    disableBonjour: process.env.OPENCLAW_DISABLE_BONJOUR,
    logLevel: process.env.OPENCLAW_LOG_LEVEL,
    agentDir: process.env.OPENCLAW_AGENT_DIR,
    piAgentDir: process.env.PI_CODING_AGENT_DIR,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };
  let tempAgentDir: string | undefined;
  let tempStateDir: string | undefined;

  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  if (QUIET_LIVE_LOGS) {
    process.env.OPENCLAW_DISABLE_BONJOUR = "1";
    process.env.OPENCLAW_LOG_LEVEL = "silent";
  }

  const token = `test-${randomUUID()}`;
  process.env.OPENCLAW_GATEWAY_TOKEN = token;
  const agentId = "dev";

  const hostAgentDir = resolveOpenClawAgentDir();
  const hostStore = ensureAuthProfileStore(hostAgentDir, {
    allowKeychainPrompt: false,
  });
  const sanitizedStore = sanitizeAuthProfileStoreForLiveGateway({
    version: hostStore.version,
    profiles: { ...hostStore.profiles },
    // Keep selection state so the gateway picks the same known-good profiles
    // as the host (important when some profiles are rate-limited/disabled).
    order: hostStore.order ? { ...hostStore.order } : undefined,
    lastGood: hostStore.lastGood ? { ...hostStore.lastGood } : undefined,
    usageStats: hostStore.usageStats ? { ...hostStore.usageStats } : undefined,
  });
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-state-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  tempAgentDir = path.join(tempStateDir, "agents", DEFAULT_AGENT_ID, "agent");
  saveAuthProfileStore(sanitizedStore, tempAgentDir);
  const tempSessionAgentDir = path.join(tempStateDir, "agents", agentId, "agent");
  if (tempSessionAgentDir !== tempAgentDir) {
    saveAuthProfileStore(sanitizedStore, tempSessionAgentDir);
  }
  process.env.OPENCLAW_AGENT_DIR = tempAgentDir;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, ".openclaw", "workspace-state.json"),
    `${JSON.stringify(
      {
        version: 1,
        setupCompletedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await fs.rm(path.join(workspaceDir, "BOOTSTRAP.md"), { force: true });
  const nonceA = randomUUID();
  const nonceB = randomUUID();
  const toolProbePath = path.join(workspaceDir, `.openclaw-live-tool-probe.${nonceA}.txt`);
  await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

  const agentDir = resolveOpenClawAgentDir();
  const sanitizedCfg: OpenClawConfig = {
    ...params.cfg,
    auth: await sanitizeAuthConfig({ cfg: params.cfg, agentDir }),
  };
  const nextCfg = buildLiveGatewayConfig({
    cfg: sanitizedCfg,
    candidates: params.candidates,
    providerOverrides: params.providerOverrides,
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-"));
  const tempConfigPath = path.join(tempDir, "openclaw.json");
  await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
  process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

  const liveProviders = nextCfg.models?.providers;
  if (liveProviders && Object.keys(liveProviders).length > 0) {
    const modelsPath = path.join(tempAgentDir, "models.json");
    await fs.mkdir(tempAgentDir, { recursive: true });
    await fs.writeFile(modelsPath, `${JSON.stringify({ providers: liveProviders }, null, 2)}\n`);
  }

  // Keep the broad live Docker suite on the impl entrypoint. The lazy public
  // boundary (`./server.js`) is covered elsewhere, but under Vitest's live Docker
  // worker this path can trip a Node module-status loader bug during startup.
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: GatewayClient | undefined;
  try {
    const port = await withGatewayLiveProbeTimeout(
      getFreeGatewayPort(),
      `${params.label}: gateway-port`,
    );
    server = await withGatewayLiveProbeTimeout(
      startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      }),
      `${params.label}: gateway-start`,
    );

    client = await withGatewayLiveProbeTimeout(
      connectClient({
        url: `ws://127.0.0.1:${port}`,
        token,
      }),
      `${params.label}: gateway-connect`,
    );
  } catch (error) {
    const message = String(error);
    if (isGatewayLiveProbeTimeout(message)) {
      logProgress(`[${params.label}] skip (gateway startup timeout)`);
      return;
    }
    throw error;
  }

  if (!server || !client) {
    logProgress(`[${params.label}] skip (gateway startup incomplete)`);
    return;
  }

  try {
    logProgress(
      `[${params.label}] running ${params.candidates.length} models (thinking=${params.thinkingLevel})`,
    );
    logProgress(
      `[${params.label}] heartbeat=${Math.max(1, Math.round(GATEWAY_LIVE_HEARTBEAT_MS / 1_000))}s probe-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_PROBE_TIMEOUT_MS / 1_000))}s model-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_MODEL_TIMEOUT_MS / 1_000))}s`,
    );
    const anthropicKeys = collectAnthropicApiKeys();
    if (anthropicKeys.length > 0) {
      process.env.ANTHROPIC_API_KEY = anthropicKeys[0];
      logProgress(`[${params.label}] anthropic keys loaded: ${anthropicKeys.length}`);
    }
    const sessionKey = `agent:${agentId}:${params.label}`;
    const failures: Array<{ model: string; error: string }> = [];
    let skippedCount = 0;
    const total = params.candidates.length;

    for (const [index, model] of params.candidates.entries()) {
      const modelKey = `${model.provider}/${model.id}`;
      const progressLabel = `[${params.label}] ${index + 1}/${total} ${modelKey}`;

      const attemptMax =
        model.provider === "anthropic" && anthropicKeys.length > 0 ? anthropicKeys.length : 1;

      for (let attempt = 0; attempt < attemptMax; attempt += 1) {
        if (model.provider === "anthropic" && anthropicKeys.length > 0) {
          process.env.ANTHROPIC_API_KEY = anthropicKeys[attempt];
        }
        try {
          const modelResult = await withGatewayLiveModelTimeout<"done" | "skip">(
            (async () => {
              // Ensure session exists + override model for this run.
              // Reset between models: avoids cross-provider transcript incompatibilities
              // (notably OpenAI Responses requiring reasoning replay for function_call items).
              await withGatewayLiveProbeTimeout(
                client.request("sessions.reset", {
                  key: sessionKey,
                }),
                `${progressLabel}: sessions-reset`,
              );
              await withGatewayLiveProbeTimeout(
                client.request("sessions.patch", {
                  key: sessionKey,
                  model: modelKey,
                }),
                `${progressLabel}: sessions-patch`,
              );

              logProgress(`${progressLabel}: prompt`);
              let text = await requestGatewayAgentText({
                client,
                sessionKey,
                idempotencyKey: `idem-${randomUUID()}`,
                modelKey,
                message:
                  "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
                thinkingLevel: params.thinkingLevel,
                context: `${progressLabel}: prompt`,
              });
              if (!text) {
                logProgress(`${progressLabel}: empty response, retrying`);
                text = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${randomUUID()}-retry`,
                  modelKey,
                  message:
                    "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
                  thinkingLevel: params.thinkingLevel,
                  context: `${progressLabel}: prompt-retry`,
                });
              }
              if (
                !text &&
                shouldSkipEmptyResponseForLiveModel({
                  provider: model.provider,
                  allowNotFoundSkip: params.allowNotFoundSkip,
                })
              ) {
                logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                return "skip";
              }
              if (
                isEmptyStreamText(text) &&
                shouldSkipEmptyResponseForLiveModel({
                  provider: model.provider,
                  allowNotFoundSkip: params.allowNotFoundSkip,
                })
              ) {
                logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                return "skip";
              }
              if (isGoogleishProvider(model.provider) && isGoogleModelNotFoundText(text)) {
                // Catalog drift: model IDs can disappear or become unavailable on the API.
                // Treat as skip when scanning "all models" for Google.
                logProgress(`${progressLabel}: skip (google model not found)`);
                return "skip";
              }
              if (params.allowNotFoundSkip && isModelNotFoundErrorMessage(text)) {
                logProgress(`${progressLabel}: skip (model not found)`);
                return "skip";
              }
              assertNoReasoningTags({
                text,
                model: modelKey,
                phase: "prompt",
                label: params.label,
              });
              if (!isMeaningful(text) || !hasEventLoopPromptKeywords(text)) {
                logProgress(`${progressLabel}: prompt retry (weak answer)`);
                const retryText = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${randomUUID()}-keyword-retry`,
                  modelKey,
                  message:
                    "Answer in exactly two short sentences. Include the exact lowercase words microtask and macrotask. No bullets.",
                  thinkingLevel: params.thinkingLevel,
                  context: `${progressLabel}: prompt-keyword-retry`,
                });
                if (retryText) {
                  text = retryText;
                  assertNoReasoningTags({
                    text,
                    model: modelKey,
                    phase: "prompt-retry",
                    label: params.label,
                  });
                }
              }
              if (!isMeaningful(text)) {
                if (isGoogleishProvider(model.provider) && /gemini/i.test(model.id)) {
                  logProgress(`${progressLabel}: skip (google not meaningful)`);
                  return "skip";
                }
                throw new Error(`not meaningful: ${text}`);
              }
              if (!hasEventLoopPromptKeywords(text)) {
                throw new Error(`missing required keywords: ${text}`);
              }

              // Real tool invocation: force the agent to Read a local file and echo a nonce.
              logProgress(`${progressLabel}: tool-read`);
              const runIdTool = randomUUID();
              const maxToolReadAttempts = 3;
              let toolText = "";
              for (
                let toolReadAttempt = 0;
                toolReadAttempt < maxToolReadAttempts;
                toolReadAttempt += 1
              ) {
                const strictReply = toolReadAttempt > 0;
                toolText = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${runIdTool}-tool-${toolReadAttempt + 1}`,
                  modelKey,
                  message: strictReply
                    ? "OpenClaw live tool probe (local, safe): " +
                      `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                      `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`
                    : "OpenClaw live tool probe (local, safe): " +
                      `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                      "Then reply with the two nonce values you read (include both).",
                  thinkingLevel: params.thinkingLevel,
                  context: `${progressLabel}: tool-read`,
                });
                if (
                  isEmptyStreamText(toolText) &&
                  shouldSkipEmptyResponseForLiveModel({
                    provider: model.provider,
                    allowNotFoundSkip: params.allowNotFoundSkip,
                  })
                ) {
                  logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                  return "skip";
                }
                assertNoReasoningTags({
                  text: toolText,
                  model: modelKey,
                  phase: "tool-read",
                  label: params.label,
                });
                if (hasExpectedToolNonce(toolText, nonceA, nonceB)) {
                  break;
                }
                if (
                  shouldRetryToolReadProbe({
                    text: toolText,
                    nonceA,
                    nonceB,
                    provider: model.provider,
                    attempt: toolReadAttempt,
                    maxAttempts: maxToolReadAttempts,
                  })
                ) {
                  logProgress(
                    `${progressLabel}: tool-read retry (${toolReadAttempt + 2}/${maxToolReadAttempts}) malformed tool output`,
                  );
                  continue;
                }
                throw new Error(`tool probe missing nonce: ${toolText}`);
              }
              if (!hasExpectedToolNonce(toolText, nonceA, nonceB)) {
                throw new Error(`tool probe missing nonce: ${toolText}`);
              }

              if (params.extraToolProbes) {
                logProgress(`${progressLabel}: tool-exec`);
                const nonceC = randomUUID();
                const toolWritePath = path.join(tempDir, `write-${runIdTool}.txt`);
                const maxExecReadAttempts = 3;
                let execReadText = "";
                for (
                  let execReadAttempt = 0;
                  execReadAttempt < maxExecReadAttempts;
                  execReadAttempt += 1
                ) {
                  const strictReply = execReadAttempt > 0;
                  execReadText = await requestGatewayAgentText({
                    client,
                    sessionKey,
                    idempotencyKey: `idem-${runIdTool}-exec-read-${execReadAttempt + 1}`,
                    modelKey,
                    message: strictReply
                      ? "OpenClaw live tool probe (local, safe): " +
                        "use the tool named `exec` (or `Exec`) to run this command: " +
                        `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}". ` +
                        `Then use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolWritePath}"}. ` +
                        `Then reply with exactly: ${nonceC}. No extra text.`
                      : "OpenClaw live tool probe (local, safe): " +
                        "use the tool named `exec` (or `Exec`) to run this command: " +
                        `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}". ` +
                        `Then use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolWritePath}"}. ` +
                        "Finally reply including the nonce text you read back.",
                    thinkingLevel: params.thinkingLevel,
                    context: `${progressLabel}: tool-exec`,
                  });
                  if (
                    isEmptyStreamText(execReadText) &&
                    shouldSkipEmptyResponseForLiveModel({
                      provider: model.provider,
                      allowNotFoundSkip: params.allowNotFoundSkip,
                    })
                  ) {
                    logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                    return "skip";
                  }
                  assertNoReasoningTags({
                    text: execReadText,
                    model: modelKey,
                    phase: "tool-exec",
                    label: params.label,
                  });
                  if (hasExpectedSingleNonce(execReadText, nonceC)) {
                    break;
                  }
                  if (
                    shouldRetryExecReadProbe({
                      text: execReadText,
                      nonce: nonceC,
                      provider: model.provider,
                      attempt: execReadAttempt,
                      maxAttempts: maxExecReadAttempts,
                    })
                  ) {
                    logProgress(
                      `${progressLabel}: tool-exec retry (${execReadAttempt + 2}/${maxExecReadAttempts}) malformed tool output`,
                    );
                    continue;
                  }
                  throw new Error(`exec+read probe missing nonce: ${execReadText}`);
                }
                if (!hasExpectedSingleNonce(execReadText, nonceC)) {
                  throw new Error(`exec+read probe missing nonce: ${execReadText}`);
                }

                await fs.rm(toolWritePath, { force: true });
              }

              if (params.extraImageProbes && model.input?.includes("image")) {
                logProgress(`${progressLabel}: image`);
                // Shorter code => less OCR flake across providers, still tests image attachments end-to-end.
                const imageCode = randomImageProbeCode();
                const imageBase64 = renderCatNoncePngBase64(imageCode);
                const runIdImage = randomUUID();

                const imageText = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${runIdImage}-image`,
                  modelKey,
                  message:
                    "Look at the attached image. Reply with exactly two tokens separated by a single space: " +
                    "(1) the animal shown or written in the image, lowercase; " +
                    "(2) the code printed in the image, uppercase. No extra text.",
                  attachments: [
                    {
                      mimeType: "image/png",
                      fileName: `probe-${runIdImage}.png`,
                      content: imageBase64,
                    },
                  ],
                  thinkingLevel: params.thinkingLevel,
                  context: `${progressLabel}: image`,
                });
                if (
                  isEmptyStreamText(imageText) &&
                  shouldSkipEmptyResponseForLiveModel({
                    provider: model.provider,
                    allowNotFoundSkip: params.allowNotFoundSkip,
                  })
                ) {
                  logProgress(`${progressLabel}: image skip (${model.provider} empty response)`);
                } else {
                  assertNoReasoningTags({
                    text: imageText,
                    model: modelKey,
                    phase: "image",
                    label: params.label,
                  });
                  if (!/\bcat\b/i.test(imageText)) {
                    logProgress(`${progressLabel}: image skip (missing 'cat')`);
                  } else {
                    const candidates = imageText.toUpperCase().match(/[A-Z0-9]{6,20}/g) ?? [];
                    const bestDistance = candidates.reduce((best, cand) => {
                      if (Math.abs(cand.length - imageCode.length) > 2) {
                        return best;
                      }
                      return Math.min(best, editDistance(cand, imageCode));
                    }, Number.POSITIVE_INFINITY);
                    if (!(bestDistance <= 3)) {
                      logProgress(`${progressLabel}: image skip (code mismatch)`);
                    }
                  }
                }
              }

              if (
                (model.provider === "openai" && model.api === "openai-responses") ||
                (model.provider === "openai-codex" && model.api === "openai-codex-responses")
              ) {
                logProgress(`${progressLabel}: tool-only regression`);
                const runId2 = randomUUID();
                const firstText = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-1`,
                  modelKey,
                  message: `Call the tool named \`read\` (or \`Read\`) on "${toolProbePath}". Do not write any other text.`,
                  thinkingLevel: params.thinkingLevel,
                  context: `${progressLabel}: tool-only-regression-first`,
                });
                assertNoReasoningTags({
                  text: firstText,
                  model: modelKey,
                  phase: "tool-only",
                  label: params.label,
                });

                const reply = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-2`,
                  modelKey,
                  message: `Now answer: what are the values of nonceA and nonceB in "${toolProbePath}"? Reply with exactly: ${nonceA} ${nonceB}.`,
                  thinkingLevel: params.thinkingLevel,
                  context: `${progressLabel}: tool-only-regression-second`,
                });
                assertNoReasoningTags({
                  text: reply,
                  model: modelKey,
                  phase: "tool-only-followup",
                  label: params.label,
                });
                if (!reply.includes(nonceA) || !reply.includes(nonceB)) {
                  throw new Error(`unexpected reply: ${reply}`);
                }
              }

              if (model.provider === "anthropic") {
                await runAnthropicRefusalProbe({
                  client,
                  sessionKey,
                  modelKey,
                  label: progressLabel,
                  thinkingLevel: params.thinkingLevel,
                });
              }
              return "done";
            })(),
            `${progressLabel}: model`,
          );
          if (modelResult === "skip") {
            skippedCount += 1;
            break;
          }
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
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic rate limit)`);
            break;
          }
          if (model.provider === "anthropic" && isAnthropicBillingError(message)) {
            if (attempt + 1 < attemptMax) {
              logProgress(`${progressLabel}: billing issue, retrying with next key`);
              continue;
            }
            logProgress(`${progressLabel}: skip (anthropic billing)`);
            break;
          }
          if (
            model.provider === "anthropic" &&
            isEmptyStreamText(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: empty response, retrying with next key`);
            continue;
          }
          if (model.provider === "anthropic" && isEmptyStreamText(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic empty response)`);
            break;
          }
          if (
            isEmptyStreamText(message) &&
            shouldSkipEmptyResponseForLiveModel({
              provider: model.provider,
              allowNotFoundSkip: params.allowNotFoundSkip,
            })
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
            break;
          }
          if (isGoogleishProvider(model.provider) && isRateLimitErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (google rate limit)`);
            break;
          }
          if (
            (model.provider === "minimax" ||
              model.provider === "opencode" ||
              model.provider === "opencode-go" ||
              model.provider === "zai") &&
            isRateLimitErrorMessage(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (rate limit)`);
            break;
          }
          if (isProviderUnavailableErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (provider unavailable)`);
            break;
          }
          if (isAudioOnlyModelErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (audio-only model)`);
            break;
          }
          if (isUnsupportedReasoningEffortErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (reasoning unsupported)`);
            break;
          }
          if (isUnsupportedThinkingToggleErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (thinking toggle unsupported)`);
            break;
          }
          if (model.provider === "openrouter" && isPromptProbeMiss(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (openrouter prompt probe miss)`);
            break;
          }
          if (params.allowNotFoundSkip && isModelNotFoundErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (model not found)`);
            break;
          }
          if (
            model.provider === "anthropic" &&
            isGatewayLiveProbeTimeout(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: probe timeout, retrying with next key`);
            continue;
          }
          if (isGatewayLiveProbeTimeout(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (probe timeout)`);
            break;
          }
          if (isGatewayLiveModelTimeout(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (model timeout)`);
            break;
          }
          // OpenAI Codex refresh tokens can become single-use; skip instead of failing all live tests.
          if (model.provider === "openai-codex" && isRefreshTokenReused(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (codex refresh token reused)`);
            break;
          }
          if (model.provider === "openai-codex" && isAccountIdExtractionError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (codex account id extraction)`);
            break;
          }
          if (model.provider === "openai-codex" && isChatGPTUsageLimitErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (chatgpt usage limit)`);
            break;
          }
          if (model.provider === "openai-codex" && isInstructionsRequiredError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (instructions required)`);
            break;
          }
          if (
            (model.provider === "openai" || model.provider === "openai-codex") &&
            isOpenAIReasoningSequenceError(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (openai reasoning sequence error)`);
            break;
          }
          if (
            (model.provider === "openai" || model.provider === "openai-codex") &&
            isToolNonceRefusal(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (tool probe refusal)`);
            break;
          }
          if (
            isExecReadNonceProbeMiss(message) &&
            shouldSkipExecReadNonceMissForLiveModel(modelKey)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (exec/read workspace isolation)`);
            break;
          }
          if (shouldSkipToolNonceProbeMissForLiveModel(modelKey) && isToolNonceProbeMiss(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (${modelKey} tool probe nonce miss)`);
            break;
          }
          if (isMissingProfileError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (missing auth profile)`);
            break;
          }
          if (model.provider === "ollama" && isOllamaUnavailableErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (ollama unavailable)`);
            break;
          }
          if (params.label.startsWith("minimax-")) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (minimax endpoint error)`);
            break;
          }
          logProgress(`${progressLabel}: failed`);
          failures.push({ model: modelKey, error: message });
          break;
        }
      }
    }

    if (failures.length > 0) {
      const preview = formatFailurePreview(failures, 20);
      throw new Error(
        `gateway live model failures (${failures.length}, showing ${Math.min(failures.length, 20)}):\n${preview}`,
      );
    }
    if (skippedCount === total) {
      logProgress(`[${params.label}] skipped all models (missing profiles)`);
    }
  } finally {
    clearRuntimeConfigSnapshot();
    restoreProductionEnvForLiveRun(runtimeEnv);
    client.stop();
    await server.close({ reason: "live test complete" });
    await fs.rm(toolProbePath, { force: true });
    // Give the filesystem a short retry window while agent/runtime teardown
    // releases handles inside these temporary live-test directories.
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (tempAgentDir) {
      await fs.rm(tempAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
    process.env.OPENCLAW_GATEWAY_TOKEN = previous.token;
    process.env.OPENCLAW_SKIP_CHANNELS = previous.skipChannels;
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previous.skipGmail;
    process.env.OPENCLAW_SKIP_CRON = previous.skipCron;
    process.env.OPENCLAW_SKIP_CANVAS_HOST = previous.skipCanvas;
    process.env.OPENCLAW_DISABLE_BONJOUR = previous.disableBonjour;
    process.env.OPENCLAW_LOG_LEVEL = previous.logLevel;
    process.env.OPENCLAW_AGENT_DIR = previous.agentDir;
    process.env.PI_CODING_AGENT_DIR = previous.piAgentDir;
    process.env.OPENCLAW_STATE_DIR = previous.stateDir;
  }
}

describeLive("gateway live (dev agent, profile keys)", () => {
  it(
    "runs meaningful prompts across models with available keys",
    async () =>
      await withSuppressedGatewayLiveWarnings(async () => {
        clearRuntimeConfigSnapshot();
        const cfg = loadConfig();
        await ensureOpenClawModelsJson(cfg);

        const agentDir = resolveOpenClawAgentDir();
        const authStorage = discoverAuthStorage(agentDir);
        const modelRegistry = discoverModels(authStorage, agentDir);
        const all = modelRegistry.getAll();

        const rawModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS?.trim();
        const useModern = !rawModels || rawModels === "modern" || rawModels === "all";
        const useExplicit = Boolean(rawModels) && !useModern;
        const filter = useExplicit ? parseFilter(rawModels) : null;
        const maxModels = GATEWAY_LIVE_MAX_MODELS;
        const targetMatcher = createLiveTargetMatcher({
          providerFilter: PROVIDERS,
          modelFilter: filter,
          config: cfg,
          env: process.env,
        });
        const wanted = filter
          ? all.filter((m) => targetMatcher.matchesModel(m.provider, m.id))
          : all.filter(
              (m) =>
                !shouldExcludeProviderFromDefaultHighSignalLiveSweep({
                  provider: m.provider,
                  useExplicitModels: useExplicit,
                  providerFilter: PROVIDERS,
                  config: cfg,
                  env: process.env,
                }) && isHighSignalLiveModelRef({ provider: m.provider, id: m.id }),
            );

        const candidates: Array<Model<Api>> = [];
        const skipped: Array<{ model: string; error: string }> = [];
        for (const model of wanted) {
          if (shouldSuppressBuiltInModel({ provider: model.provider, id: model.id })) {
            continue;
          }
          if (!targetMatcher.matchesProvider(model.provider)) {
            continue;
          }
          const modelRef = `${model.provider}/${model.id}`;
          try {
            const apiKeyInfo = await getApiKeyForModel({
              model,
              cfg,
              credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
            });
            if (REQUIRE_PROFILE_KEYS && !apiKeyInfo.source.startsWith("profile:")) {
              skipped.push({
                model: modelRef,
                error: `non-profile credential source: ${apiKeyInfo.source}`,
              });
              continue;
            }
            candidates.push(model);
          } catch (error) {
            skipped.push({ model: modelRef, error: String(error) });
          }
        }

        if (candidates.length === 0) {
          if (skipped.length > 0) {
            logProgress(
              `[all-models] auth lookup skipped candidates:\n${formatFailurePreview(skipped, 8)}`,
            );
          }
          logProgress("[all-models] no API keys found; skipping");
          return;
        }
        const selectedCandidates = selectHighSignalLiveItems(
          candidates,
          maxModels > 0 ? maxModels : candidates.length,
          (model) => ({ provider: model.provider, id: model.id }),
          (model) => model.provider,
        );
        logProgress(`[all-models] selection=${useExplicit ? "explicit" : "high-signal"}`);
        if (selectedCandidates.length < candidates.length) {
          logProgress(
            `[all-models] capped to ${selectedCandidates.length}/${candidates.length} via OPENCLAW_LIVE_GATEWAY_MAX_MODELS=${maxModels}`,
          );
        }
        const imageCandidates = selectedCandidates.filter((m) => m.input?.includes("image"));
        if (imageCandidates.length === 0) {
          logProgress("[all-models] no image-capable models selected; image probe will be skipped");
        }
        await runGatewayModelSuite({
          label: "all-models",
          cfg,
          candidates: selectedCandidates,
          allowNotFoundSkip: useModern,
          extraToolProbes: ENABLE_EXTRA_TOOL_PROBES,
          extraImageProbes: ENABLE_EXTRA_IMAGE_PROBES,
          thinkingLevel: THINKING_LEVEL,
        });

        const minimaxCandidates = selectedCandidates.filter(
          (model) => model.provider === "minimax",
        );
        if (minimaxCandidates.length === 0) {
          logProgress("[minimax] no candidates with keys; skipping dual endpoint probes");
          return;
        }

        const minimaxAnthropic = buildMinimaxProviderOverride({
          cfg,
          api: "anthropic-messages",
          baseUrl: "https://api.minimax.io/anthropic",
        });
        if (minimaxAnthropic) {
          await runGatewayModelSuite({
            label: "minimax-anthropic",
            cfg,
            candidates: minimaxCandidates,
            allowNotFoundSkip: useModern,
            extraToolProbes: ENABLE_EXTRA_TOOL_PROBES,
            extraImageProbes: ENABLE_EXTRA_IMAGE_PROBES,
            thinkingLevel: THINKING_LEVEL,
            providerOverrides: { minimax: minimaxAnthropic },
          });
        } else {
          logProgress("[minimax-anthropic] missing minimax provider config; skipping");
        }
      }),
    GATEWAY_LIVE_SUITE_TIMEOUT_MS,
  );

  it("z.ai fallback handles anthropic tool history", async () => {
    if (!ZAI_FALLBACK) {
      return;
    }
    clearRuntimeConfigSnapshot();
    const runtimeEnv = enterProductionEnvForLiveRun();
    const previous = {
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
      skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
      skipCron: process.env.OPENCLAW_SKIP_CRON,
      skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    };

    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";

    const token = `test-${randomUUID()}`;
    process.env.OPENCLAW_GATEWAY_TOKEN = token;

    const cfg = loadConfig();
    await ensureOpenClawModelsJson(cfg);

    const agentDir = resolveOpenClawAgentDir();
    const authStorage = discoverAuthStorage(agentDir);
    const modelRegistry = discoverModels(authStorage, agentDir);
    const anthropic = modelRegistry.find("anthropic", "claude-opus-4-6") as Model<Api> | null;
    const zai = modelRegistry.find("zai", "glm-4.7") as Model<Api> | null;

    if (!anthropic || !zai) {
      return;
    }
    try {
      await getApiKeyForModel({
        model: anthropic,
        cfg,
        credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
      });
      await getApiKeyForModel({
        model: zai,
        cfg,
        credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
      });
    } catch {
      return;
    }

    const agentId = "dev";
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    await fs.mkdir(workspaceDir, { recursive: true });
    const nonceA = randomUUID();
    const nonceB = randomUUID();
    const toolProbePath = path.join(workspaceDir, `.openclaw-live-zai-fallback.${nonceA}.txt`);
    await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let client: GatewayClient | undefined;
    try {
      const port = await withGatewayLiveProbeTimeout(
        getFreeGatewayPort(),
        "zai-fallback: gateway-port",
      );
      server = await withGatewayLiveProbeTimeout(
        startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        }),
        "zai-fallback: gateway-start",
      );

      client = await withGatewayLiveProbeTimeout(
        connectClient({
          url: `ws://127.0.0.1:${port}`,
          token,
        }),
        "zai-fallback: gateway-connect",
      );
    } catch (error) {
      const message = String(error);
      if (isGatewayLiveProbeTimeout(message)) {
        logProgress("[zai-fallback] skip (gateway startup timeout)");
        return;
      }
      throw error;
    }

    if (!server || !client) {
      logProgress("[zai-fallback] skip (gateway startup incomplete)");
      return;
    }

    try {
      const sessionKey = `agent:${agentId}:live-zai-fallback`;

      await withGatewayLiveProbeTimeout(
        client.request("sessions.patch", {
          key: sessionKey,
          model: "anthropic/claude-opus-4-6",
        }),
        "zai-fallback: sessions-patch-anthropic",
      );
      await withGatewayLiveProbeTimeout(
        client.request("sessions.reset", {
          key: sessionKey,
        }),
        "zai-fallback: sessions-reset",
      );

      const toolText = await requestGatewayAgentText({
        client,
        sessionKey,
        idempotencyKey: `idem-${randomUUID()}-tool`,
        modelKey: "anthropic/claude-opus-4-6",
        message:
          `Call the tool named \`read\` (or \`Read\` if \`read\` is unavailable) with JSON arguments {"path":"${toolProbePath}"}. ` +
          `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
        thinkingLevel: THINKING_LEVEL,
        context: "zai-fallback: tool-probe",
      });
      assertNoReasoningTags({
        text: toolText,
        model: "anthropic/claude-opus-4-6",
        phase: "zai-fallback-tool",
        label: "zai-fallback",
      });
      if (!toolText.includes(nonceA) || !toolText.includes(nonceB)) {
        throw new Error(`anthropic tool probe missing nonce: ${toolText}`);
      }

      await withGatewayLiveProbeTimeout(
        client.request("sessions.patch", {
          key: sessionKey,
          model: "zai/glm-4.7",
        }),
        "zai-fallback: sessions-patch-zai",
      );

      const followupText = await requestGatewayAgentText({
        client,
        sessionKey,
        idempotencyKey: `idem-${randomUUID()}-followup`,
        modelKey: "zai/glm-4.7",
        message:
          `What are the values of nonceA and nonceB in "${toolProbePath}"? ` +
          `Reply with exactly: ${nonceA} ${nonceB}.`,
        thinkingLevel: THINKING_LEVEL,
        context: "zai-fallback: followup",
      });
      assertNoReasoningTags({
        text: followupText,
        model: "zai/glm-4.7",
        phase: "zai-fallback-followup",
        label: "zai-fallback",
      });
      if (!followupText.includes(nonceA) || !followupText.includes(nonceB)) {
        throw new Error(`zai followup missing nonce: ${followupText}`);
      }
    } finally {
      clearRuntimeConfigSnapshot();
      restoreProductionEnvForLiveRun(runtimeEnv);
      client.stop();
      await server.close({ reason: "live test complete" });
      await fs.rm(toolProbePath, { force: true });

      process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = previous.token;
      process.env.OPENCLAW_SKIP_CHANNELS = previous.skipChannels;
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previous.skipGmail;
      process.env.OPENCLAW_SKIP_CRON = previous.skipCron;
      process.env.OPENCLAW_SKIP_CANVAS_HOST = previous.skipCanvas;
    }
  }, 180_000);
});
