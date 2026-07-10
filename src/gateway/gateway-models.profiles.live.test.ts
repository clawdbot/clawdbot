// Live model profile gateway tests sweep configured providers, auth profiles, model listing, and smoke prompts.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { renderCatNoncePngBase64 } from "../../test/helpers/live-image-probe.js";
import { discoverAuthStorage, discoverModels } from "../agents/agent-model-discovery.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { collectAnthropicApiKeys } from "../agents/live-auth-keys.js";
import { appendPrioritizedDynamicLiveModels } from "../agents/live-model-dynamic-candidates.js";
import { isModelNotFoundErrorMessage } from "../agents/live-model-errors.js";
import {
  DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  DEFAULT_SMALL_LIVE_MODEL_LIMIT,
  getHighSignalLiveModelPriorityIndex,
  getHighSignalLiveModelProviders,
  isHighSignalLiveModelRef,
  isSmallLiveModelRef,
  listPrioritizedHighSignalLiveModelRefs,
  listPrioritizedSmallLiveModelRefs,
  resolveHighSignalLiveModelLimit,
  selectHighSignalLiveItems,
  selectSmallLiveItems,
  shouldExcludeProviderFromDefaultHighSignalLiveSweep,
} from "../agents/live-model-filter.js";
import { createLiveTargetMatcher } from "../agents/live-target-matcher.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "../agents/live-test-helpers.js";
import {
  isLiveBillingDrift,
  isLiveRateLimitDrift,
  shouldSkipLiveProviderDrift,
} from "../agents/live-test-provider-drift.js";
import { getApiKeyForModel, resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { shouldSuppressBuiltInModel } from "../agents/model-suppression.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { clearRuntimeConfigSnapshot, getRuntimeConfig } from "../config/io.js";
import type { ModelsConfig, ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { ModelRegistry } from "../llm/model-registry.js";
import { normalizeGoogleModelId } from "../plugin-sdk/google-model-id.js";
import { resolveProviderThinkingProfile } from "../plugins/provider-runtime.js";
import type { ProviderThinkingModelCompat } from "../plugins/provider-thinking.types.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { stripAssistantInternalScaffolding } from "../shared/text/assistant-visible-text.js";
import { findFinalTagMatches, stripFinalTags } from "../shared/text/final-tags.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { getFreePort, isPortFree } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import {
  hasExpectedSingleNonce,
  hasExpectedToolNonce,
  isLikelyToolNonceRefusal,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe.test-helpers.js";
import { startGatewayServer } from "./server.impl.js";
import { readSessionMessagesAsync } from "./session-transcript-readers.js";
import { loadSessionEntry } from "./session-utils.js";

const ZAI_FALLBACK = isTruthyEnvValue(process.env.OPENCLAW_LIVE_GATEWAY_ZAI_FALLBACK);
const REQUIRE_PROFILE_KEYS = isLiveProfileKeyModeEnabled();
const LIVE_CREDENTIAL_PRECEDENCE = REQUIRE_PROFILE_KEYS ? "profile-first" : "env-first";
const PROVIDERS = parseFilter(process.env.OPENCLAW_LIVE_GATEWAY_PROVIDERS);
const GATEWAY_LIVE_SMOKE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_GATEWAY_SMOKE);
const THINKING_LEVEL = resolveGatewayLiveThinkingLevel({
  raw: process.env.OPENCLAW_LIVE_GATEWAY_THINKING,
  smoke: GATEWAY_LIVE_SMOKE,
});
const ENABLE_EXTRA_TOOL_PROBES = !GATEWAY_LIVE_SMOKE;
const ENABLE_EXTRA_IMAGE_PROBES = !GATEWAY_LIVE_SMOKE;
const THINKING_TAG_RE = /<\s*\/?\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\s*>/i;
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const GATEWAY_LIVE_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS = 60 * 60 * 1000;
const EXPLICIT_LIVE_FALLBACK_CONTEXT_WINDOW = 128_000;
const GATEWAY_LIVE_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const GATEWAY_LIVE_PROBE_TIMEOUT_MS = Math.max(
  30_000,
  toInt(process.env.OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS, 90_000),
);
const GATEWAY_LIVE_SETUP_TIMEOUT_MS = resolveGatewayLiveSetupTimeoutMs();
const GATEWAY_LIVE_MODEL_TIMEOUT_MS = resolveGatewayLiveModelTimeoutMs();
const GATEWAY_LIVE_SESSION_CONTROL_TIMEOUT_MS = resolveGatewayLiveSessionControlTimeoutMs();
const GATEWAY_LIVE_TRANSCRIPT_TIMEOUT_MS = resolveGatewayLiveTranscriptTimeoutMs();
const GATEWAY_LIVE_AGENT_RUN_TIMEOUT_MS = resolveGatewayLiveAgentRunTimeoutMs();
const GATEWAY_LIVE_AGENT_WAIT_TIMEOUT_MS = resolveGatewayLiveAgentWaitTimeoutMs();
const GATEWAY_LIVE_HEARTBEAT_MS = Math.max(
  1_000,
  toInt(process.env.OPENCLAW_LIVE_GATEWAY_HEARTBEAT_MS, 30_000),
);
const GATEWAY_LIVE_STRIP_SCAFFOLDING_MODEL_KEYS = new Set([
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview-customtools",
  "openai/gpt-5.4-pro",
]);
const GATEWAY_LIVE_AGENT_ID = "dev";
const GATEWAY_LIVE_CONFIG_TEST_WORKSPACE = path.join(os.tmpdir(), "openclaw-live-config-test");
const GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR = path.join(
  os.tmpdir(),
  "openclaw-live-config-test-agent",
);
const GATEWAY_LIVE_EXEC_READ_NONCE_MISS_SKIP_MODEL_KEYS = new Set([
  "fireworks/accounts/fireworks/models/glm-5",
  "fireworks/accounts/fireworks/models/kimi-k2p5",
  "fireworks/accounts/fireworks/models/kimi-k2p6",
  "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
  "google/gemini-3.1-flash-lite",
]);
const GATEWAY_LIVE_TOOL_NONCE_MISS_SKIP_MODEL_KEYS = new Set([
  // Hosted DeepSeek V4 Flash can surface its internal tool-call sentinel
  // instead of the readback nonce after the tool-read probe succeeds.
  "deepinfra/deepseek-ai/DeepSeek-V4-Flash",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-pro-preview",
]);
const GATEWAY_LIVE_MAX_MODELS = resolveGatewayLiveMaxModels();
const GATEWAY_LIVE_SUITE_TIMEOUT_MS = resolveGatewayLiveSuiteTimeoutMs(GATEWAY_LIVE_MAX_MODELS);
const QUIET_LIVE_LOGS = process.env.OPENCLAW_LIVE_TEST_QUIET !== "0";

const describeLive = isLiveTestEnabled(["OPENCLAW_LIVE_GATEWAY"]) ? describe : describe.skip;

function parseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") {
    return null;
  }
  const ids: string[] = [];
  for (const rawId of trimmed.split(",")) {
    const id = rawId.trim();
    if (id.length > 0) {
      ids.push(id);
    }
  }
  return ids.length ? new Set(ids) : null;
}

function providerFilterList(): string[] | undefined {
  return PROVIDERS
    ? [...PROVIDERS].toSorted((left, right) => left.localeCompare(right))
    : undefined;
}

function providerListFromExplicitModelFilter(params: {
  modelFilter: Set<string> | null;
  providerFilter: Set<string> | null;
}): string[] | undefined {
  if (!params.modelFilter || params.modelFilter.size === 0) {
    return undefined;
  }
  const providers = new Set<string>();
  for (const raw of params.modelFilter) {
    const ref = parseExplicitLiveModelRef(raw, params.providerFilter);
    if (!ref) {
      return undefined;
    }
    providers.add(ref.provider);
  }
  return providers.size > 0
    ? [...providers].toSorted((left, right) => left.localeCompare(right))
    : undefined;
}

function providerScopedModelRegistryProviders(params: {
  providerList: string[] | undefined;
  useSmall: boolean;
  useExplicit: boolean;
  modelFilter: Set<string> | null;
  providerFilter: Set<string> | null;
}): string[] | undefined {
  if (params.providerList) {
    return params.providerList;
  }
  if (!params.useExplicit) {
    const providers = params.useSmall
      ? [
          ...new Set(
            listPrioritizedSmallLiveModelRefs().map((ref) => normalizeProviderId(ref.provider)),
          ),
        ].toSorted((left, right) => left.localeCompare(right))
      : getHighSignalLiveModelProviders();
    return providers.filter((provider) =>
      params.providerFilter ? params.providerFilter.has(provider) : true,
    );
  }
  return providerListFromExplicitModelFilter({
    modelFilter: params.modelFilter,
    providerFilter: params.providerFilter,
  });
}

function filterGatewayLiveModelRefsByProvider(
  refs: readonly { provider: string; id: string }[],
  providerFilter: ReadonlySet<string> | null,
): Array<{ provider: string; id: string }> {
  if (!providerFilter) {
    return [...refs];
  }
  const providers = new Set(
    [...providerFilter].map((provider) => normalizeProviderId(provider)).filter(Boolean),
  );
  return refs.filter((ref) => providers.has(normalizeProviderId(ref.provider)));
}

function resolvePrioritizedGatewayLiveModelRefs(params: {
  providerFilter: ReadonlySet<string> | null;
  useExplicit: boolean;
  useSmall: boolean;
}): Array<{ provider: string; id: string }> {
  if (params.useExplicit) {
    return [];
  }
  // High-signal refs can be plugin-resolved models absent from the static
  // catalog; omitting them leaves provider-scoped live lanes with zero coverage.
  return filterGatewayLiveModelRefsByProvider(
    params.useSmall
      ? listPrioritizedSmallLiveModelRefs()
      : listPrioritizedHighSignalLiveModelRefs(),
    params.providerFilter,
  );
}

function isWantedSmallGatewayLiveModel(params: {
  model: Pick<Model, "provider" | "id">;
  targetMatcher: ReturnType<typeof createLiveTargetMatcher>;
}): boolean {
  return (
    params.targetMatcher.matchesProvider(params.model.provider) &&
    isSmallLiveModelRef({ provider: params.model.provider, id: params.model.id })
  );
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

function resolveGatewayLiveSetupTimeoutMs(
  raw = process.env.OPENCLAW_LIVE_GATEWAY_SETUP_TIMEOUT_MS,
): number {
  return Math.max(1_000, toInt(raw, 180_000));
}

function resolveGatewayLiveMaxModels(): number {
  const gatewayRaw = process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS?.trim();
  if (gatewayRaw) {
    return Math.max(0, toInt(gatewayRaw, 0));
  }
  const rawModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS?.trim();
  const useSmallModels = rawModels === "small";
  const useExplicitModels =
    Boolean(rawModels) && rawModels !== "modern" && rawModels !== "all" && !useSmallModels;
  return resolveHighSignalLiveModelLimit({
    rawMaxModels: process.env.OPENCLAW_LIVE_MAX_MODELS,
    useExplicitModels,
    defaultLimit: useSmallModels
      ? DEFAULT_SMALL_LIVE_MODEL_LIMIT
      : DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  });
}

function resolveGatewayLiveSuiteTimeoutMs(maxModels: number): number {
  if (maxModels <= 0) {
    return GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS;
  }
  // Gateway live runs multiple probes per model and may retry with another
  // profile key before moving on, so the suite budget has to scale with the
  // model timeout rather than only the first prompt.
  const perModelBudgetMs = Math.max(3 * 60 * 1000, GATEWAY_LIVE_MODEL_TIMEOUT_MS * 3);
  const estimated = 10 * 60 * 1000 + maxModels * perModelBudgetMs;
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
  const requested = toInt(gatewayModelTimeoutRaw, toInt(liveModelTimeoutRaw, 300_000));
  return Math.max(stepTimeoutMs, requested);
}

function resolveGatewayLiveSessionControlTimeoutMs(
  stepTimeoutMs = GATEWAY_LIVE_PROBE_TIMEOUT_MS,
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  return Math.max(stepTimeoutMs, Math.min(modelTimeoutMs, 180_000));
}

function resolveGatewayLiveTranscriptTimeoutMs(
  stepTimeoutMs = GATEWAY_LIVE_PROBE_TIMEOUT_MS,
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  return Math.max(stepTimeoutMs, modelTimeoutMs);
}

function resolveGatewayLiveAgentRunTimeoutMs(
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  if (!Number.isFinite(modelTimeoutMs) || modelTimeoutMs <= 1_000) {
    return Math.max(1_000, Math.floor(modelTimeoutMs));
  }
  const terminalGraceMs = Math.min(30_000, Math.max(5_000, Math.floor(modelTimeoutMs / 6)));
  return Math.max(1_000, Math.floor(modelTimeoutMs - terminalGraceMs));
}

function resolveGatewayLiveAgentWaitTimeoutMs(
  agentRunTimeoutMs = GATEWAY_LIVE_AGENT_RUN_TIMEOUT_MS,
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  const waitGraceMs = Math.min(10_000, Math.max(1_000, Math.floor(modelTimeoutMs / 12)));
  return Math.max(1_000, Math.min(modelTimeoutMs, Math.floor(agentRunTimeoutMs + waitGraceMs)));
}

function resolveGatewayLiveProviderTimeoutSeconds(
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  return Math.max(1, Math.ceil(modelTimeoutMs / 1_000));
}

function isGatewayLiveProbeTimeout(error: string): boolean {
  return /probe timeout after \d+ms/i.test(error);
}

function isGatewayLiveModelTimeout(error: string): boolean {
  return (
    /model timeout after \d+ms/i.test(error) ||
    (/\bagent\.wait timeout for runId=/i.test(error) &&
      /\btimeoutPhase=(?:preflight|provider|post_turn)\b/i.test(error))
  );
}

function assertGatewayLiveDidNotSkipAllDueToTimeout(params: {
  label: string;
  skippedCount: number;
  timeoutSkippedCount: number;
  total: number;
}): void {
  if (
    params.total === 0 ||
    params.skippedCount !== params.total ||
    params.timeoutSkippedCount === 0
  ) {
    return;
  }
  throw new Error(
    `[${params.label}] skipped all ${params.total} live model(s) after ${params.timeoutSkippedCount} timeout skip(s); increase the live gateway timeout or fix the timeout source instead of treating this as missing profile coverage.`,
  );
}

function assertGatewayLiveCompletedSomeModels(params: {
  label: string;
  passedCount: number;
  skippedCount: number;
  timeoutSkippedCount: number;
  total: number;
}): void {
  if (params.total === 0 || params.passedCount > 0) {
    return;
  }
  assertGatewayLiveDidNotSkipAllDueToTimeout({
    label: params.label,
    skippedCount: params.skippedCount,
    timeoutSkippedCount: params.timeoutSkippedCount,
    total: params.total,
  });
  throw new Error(
    `[${params.label}] completed zero successful live model run(s) across ${params.total} selected model(s); skipped=${params.skippedCount}. Live proof must exercise at least one model.`,
  );
}

function formatGatewayLiveFilterSet(filter: ReadonlySet<string> | null): string {
  if (!filter || filter.size === 0) {
    return "all";
  }
  return [...filter].toSorted((left, right) => left.localeCompare(right)).join(",");
}

function assertGatewayLiveSelectedSomeModels(params: {
  allowProviderDriftSkip: boolean;
  label: string;
  modelFilter: ReadonlySet<string> | null;
  providerFilter: ReadonlySet<string> | null;
  total: number;
  useSmall: boolean;
  useExplicit: boolean;
  wantedCount: number;
}): void {
  if (params.wantedCount > 0 || (!params.modelFilter && !params.providerFilter)) {
    return;
  }
  if (
    params.allowProviderDriftSkip &&
    params.providerFilter &&
    [...params.providerFilter].every((provider) =>
      shouldSkipEmptyResponseForLiveModel({ provider, allowNotFoundSkip: true }),
    )
  ) {
    return;
  }
  const mode = params.useExplicit ? "explicit" : params.useSmall ? "small" : "high-signal";
  throw new Error(
    `[${params.label}] selected no ${mode} live models for providers=${formatGatewayLiveFilterSet(params.providerFilter)} models=${formatGatewayLiveFilterSet(params.modelFilter)} from ${params.total} registry model(s); update the live model selection or pass explicit live model refs.`,
  );
}

function assertGatewayLiveHasRunnableCandidates(params: {
  candidatesCount: number;
  label: string;
  skipped: Array<{ model: string; error: string }>;
}): void {
  if (params.candidatesCount > 0) {
    return;
  }
  const preview = params.skipped.length > 0 ? `:\n${formatFailurePreview(params.skipped, 8)}` : ".";
  throw new Error(
    `[${params.label}] selected no runnable live model candidates with usable credentials; skipped ${params.skipped.length} candidate(s)${preview}`,
  );
}

function failGatewayLiveStartupCoverage(params: { label: string; reason: string }): never {
  throw new Error(
    `[${params.label}] gateway startup failed before live model coverage: ${params.reason}`,
  );
}

async function withGatewayLiveTimeout<T>(params: {
  operation: Promise<T>;
  timeoutMs: number;
  timeoutLabel: "setup" | "probe" | "model";
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

async function withGatewayLiveSetupTimeout<T>(
  operation: Promise<T>,
  context: string,
  timeoutMs = GATEWAY_LIVE_SETUP_TIMEOUT_MS,
): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs,
    timeoutLabel: "setup",
    context,
  });
}

async function withGatewayLiveProbeTimeout<T>(operation: Promise<T>, context: string): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs: GATEWAY_LIVE_PROBE_TIMEOUT_MS,
    timeoutLabel: "probe",
    context,
  });
}

async function withGatewayLiveSessionControlTimeout<T>(
  operation: Promise<T>,
  context: string,
): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs: GATEWAY_LIVE_SESSION_CONTROL_TIMEOUT_MS,
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
  writeSync(2, `[live] ${message}\n`);
}

function enterProductionEnvForLiveRun() {
  const previous = {
    vitest: process.env.VITEST,
    nodeEnv: process.env.NODE_ENV,
    testFast: process.env.OPENCLAW_TEST_FAST,
  };
  delete process.env.VITEST;
  delete process.env.OPENCLAW_TEST_FAST;
  process.env.NODE_ENV = "production";
  return previous;
}

function restoreProductionEnvForLiveRun(previous: {
  vitest: string | undefined;
  nodeEnv: string | undefined;
  testFast: string | undefined;
}) {
  if (previous.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = previous.vitest;
  }
  if (previous.testFast === undefined) {
    delete process.env.OPENCLAW_TEST_FAST;
  } else {
    process.env.OPENCLAW_TEST_FAST = previous.testFast;
  }
  if (previous.nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previous.nodeEnv;
  }
}

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    deleteTestEnvValue(key);
  } else {
    setTestEnvValue(key, value);
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
  if (THINKING_TAG_RE.test(params.text) || findFinalTagMatches(params.text).length > 0) {
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
  const words = trimmed.split(/\s+/g);
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
  const withoutThinking = text
    .replace(/<\s*think\b[^<>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
    .replace(/^[\s\S]*?<\s*\/\s*think\s*>\s*/i, "");
  return stripFinalTags(withoutThinking);
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
    params.provider === "minimax-portal" ||
    params.provider === "openai" ||
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
        "<final data-model=openrouter/google/gemini/>Visible",
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
        "google/gemini-3.1-flash-lite",
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

  it("matches hosted Fireworks models that execute but miss readback nonces", () => {
    expect(
      shouldSkipExecReadNonceMissForLiveModel("fireworks/accounts/fireworks/models/glm-5"),
    ).toBe(true);
    expect(
      shouldSkipExecReadNonceMissForLiveModel("fireworks/accounts/fireworks/models/kimi-k2p5"),
    ).toBe(true);
    expect(
      shouldSkipExecReadNonceMissForLiveModel("fireworks/accounts/fireworks/models/kimi-k2p6"),
    ).toBe(true);
    expect(
      shouldSkipExecReadNonceMissForLiveModel(
        "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      ),
    ).toBe(true);
  });
});

describe("resolveGatewayLiveModelTimeoutMs", () => {
  it("prefers gateway-specific timeout when provided", () => {
    expect(resolveGatewayLiveModelTimeoutMs("180000", "45000", 90_000)).toBe(180_000);
  });

  it("falls back to the shared live timeout", () => {
    expect(resolveGatewayLiveModelTimeoutMs("", "45000", 30_000)).toBe(45_000);
  });

  it("defaults to the release live model budget", () => {
    expect(resolveGatewayLiveModelTimeoutMs("", undefined, 90_000)).toBe(300_000);
  });
});

describe("resolveGatewayLiveTranscriptTimeoutMs", () => {
  it("uses the model budget for transcript waits", () => {
    expect(resolveGatewayLiveTranscriptTimeoutMs(90_000, 180_000)).toBe(180_000);
  });
});

describe("gateway live timeout floors", () => {
  it("defaults setup budget above slow ARM model discovery", () => {
    expect(resolveGatewayLiveSetupTimeoutMs("")).toBe(180_000);
  });

  it("keeps explicit shorter setup budgets available for targeted probes", () => {
    expect(resolveGatewayLiveSetupTimeoutMs("60000")).toBe(60_000);
  });

  it("never goes below the probe timeout", () => {
    expect(resolveGatewayLiveModelTimeoutMs("45000", undefined, 90_000)).toBe(90_000);
    expect(resolveGatewayLiveTranscriptTimeoutMs(240_000, 180_000)).toBe(240_000);
  });
});

describe("resolveGatewayLiveSessionControlTimeoutMs", () => {
  it("allows slow gateway session-control calls without using the full model budget", () => {
    expect(resolveGatewayLiveSessionControlTimeoutMs(90_000, 300_000)).toBe(180_000);
  });

  it("keeps explicit longer probe budgets intact", () => {
    expect(resolveGatewayLiveSessionControlTimeoutMs(240_000, 300_000)).toBe(240_000);
  });
});

describe("resolveGatewayLiveAgentRunTimeoutMs", () => {
  it("leaves terminal-observation grace inside the model timeout", () => {
    expect(resolveGatewayLiveAgentRunTimeoutMs(180_000)).toBe(150_000);
  });

  it("keeps short live probes bounded but positive", () => {
    expect(resolveGatewayLiveAgentRunTimeoutMs(6_000)).toBe(1_000);
  });
});

describe("resolveGatewayLiveAgentWaitTimeoutMs", () => {
  it("waits past the run timeout but before the model timeout", () => {
    expect(resolveGatewayLiveAgentWaitTimeoutMs(150_000, 180_000)).toBe(160_000);
  });
});

describe("resolveGatewayLiveProviderTimeoutSeconds", () => {
  it("matches provider timeout config to the harness model budget", () => {
    expect(resolveGatewayLiveProviderTimeoutSeconds(180_001)).toBe(181);
  });
});

describe("isGatewayLiveProbeTimeout", () => {
  it("keeps missing terminal replies out of provider timeout skips", () => {
    expect(isGatewayLiveProbeTimeout("probe timeout after 90000ms (prompt)")).toBe(true);
    expect(isGatewayLiveProbeTimeout("terminal timeout after 90000ms (tool-read)")).toBe(false);
  });
});

describe("isGatewayLiveModelTimeout", () => {
  it("matches provider-attributed agent wait timeouts", () => {
    expect(
      isGatewayLiveModelTimeout(
        "minimax/MiniMax-M3: prompt: agent.wait timeout for runId=idem-1 (timeoutPhase=provider, providerStarted=true, stopReason=rpc, error=aborted)",
      ),
    ).toBe(true);
  });

  it("does not match wait-layer agent wait timeouts", () => {
    expect(
      isGatewayLiveModelTimeout(
        "minimax/MiniMax-M3: prompt: agent.wait timeout for runId=idem-1 (timeoutPhase=queue, providerStarted=false, stopReason=rpc, error=aborted)",
      ),
    ).toBe(false);
  });
});

describe("formatGatewayLiveAgentWaitFailure", () => {
  it("includes terminal attribution fields without requiring transcript text", () => {
    expect(
      formatGatewayLiveAgentWaitFailure({
        context: "anthropic prompt",
        runId: "run-1",
        result: {
          status: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
          stopReason: "rpc",
        },
      }).message,
    ).toContain(
      "anthropic prompt: agent.wait timeout for runId=run-1 (timeoutPhase=provider, providerStarted=true, stopReason=rpc)",
    );
  });
});

describe("isGatewayAgentWaitCompletedWithoutReply", () => {
  it("accepts the malformed completion envelope used by tool-only turns", () => {
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "error", error: " completed " })).toBe(
      true,
    );
  });

  it("rejects genuine agent errors and non-error completion envelopes", () => {
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "error", error: "aborted" })).toBe(
      false,
    );
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "ok", error: "completed" })).toBe(
      false,
    );
  });
});

describe("assertGatewayLiveDidNotSkipAllDueToTimeout", () => {
  it("allows all-skip runs when no timeout skip was involved", () => {
    expect(() =>
      assertGatewayLiveDidNotSkipAllDueToTimeout({
        label: "all-models",
        skippedCount: 2,
        timeoutSkippedCount: 0,
        total: 2,
      }),
    ).not.toThrow();
  });

  it("fails all-skip runs when timeout skips consumed the selected coverage", () => {
    expect(() =>
      assertGatewayLiveDidNotSkipAllDueToTimeout({
        label: "all-models",
        skippedCount: 1,
        timeoutSkippedCount: 1,
        total: 1,
      }),
    ).toThrow(/skipped all 1 live model/);
  });
});

describe("assertGatewayLiveCompletedSomeModels", () => {
  it("allows live sweeps with at least one successful model run", () => {
    expect(() =>
      assertGatewayLiveCompletedSomeModels({
        label: "all-models",
        passedCount: 1,
        skippedCount: 4,
        timeoutSkippedCount: 0,
        total: 5,
      }),
    ).not.toThrow();
  });

  it("fails live sweeps with no successful model runs", () => {
    expect(() =>
      assertGatewayLiveCompletedSomeModels({
        label: "all-models",
        passedCount: 0,
        skippedCount: 2,
        timeoutSkippedCount: 0,
        total: 2,
      }),
    ).toThrow(/completed zero successful live model run/);
  });
});

describe("assertGatewayLiveSelectedSomeModels", () => {
  it("allows unfiltered sweeps with no high-signal models", () => {
    expect(() =>
      assertGatewayLiveSelectedSomeModels({
        allowProviderDriftSkip: false,
        label: "all-models",
        modelFilter: null,
        providerFilter: null,
        total: 0,
        useSmall: false,
        useExplicit: false,
        wantedCount: 0,
      }),
    ).not.toThrow();
  });

  it("fails filtered sweeps that select no models", () => {
    expect(() =>
      assertGatewayLiveSelectedSomeModels({
        allowProviderDriftSkip: false,
        label: "all-models",
        modelFilter: null,
        providerFilter: new Set(["openai"]),
        total: 42,
        useSmall: false,
        useExplicit: false,
        wantedCount: 0,
      }),
    ).toThrow(/selected no high-signal live models/);
  });

  it("allows modern provider-drift skips for empty MiniMax provider sweeps", () => {
    expect(() =>
      assertGatewayLiveSelectedSomeModels({
        allowProviderDriftSkip: true,
        label: "all-models",
        modelFilter: null,
        providerFilter: new Set(["minimax", "minimax-portal"]),
        total: 0,
        useSmall: false,
        useExplicit: false,
        wantedCount: 0,
      }),
    ).not.toThrow();
  });
});

describe("assertGatewayLiveHasRunnableCandidates", () => {
  it("fails selected sweeps when auth lookup leaves no runnable candidates", () => {
    expect(() =>
      assertGatewayLiveHasRunnableCandidates({
        candidatesCount: 0,
        label: "all-models",
        skipped: [{ model: "openai/gpt-5.5", error: "missing auth profile" }],
      }),
    ).toThrow(/selected no runnable live model candidates/);
  });

  it("allows selected sweeps with runnable candidates", () => {
    expect(() =>
      assertGatewayLiveHasRunnableCandidates({
        candidatesCount: 1,
        label: "all-models",
        skipped: [],
      }),
    ).not.toThrow();
  });
});

describe("failGatewayLiveStartupCoverage", () => {
  it("fails startup timeouts instead of treating them as skipped live coverage", () => {
    expect(() =>
      failGatewayLiveStartupCoverage({
        label: "all-models",
        reason: "probe timeout after 90000ms (all-models: gateway-start)",
      }),
    ).toThrow(/gateway startup failed before live model coverage/);
  });
});

describe("resolveGatewayLiveSuiteTimeoutMs", () => {
  it("leaves uncapped explicit sweeps bounded by the unbounded live timeout", () => {
    expect(resolveGatewayLiveSuiteTimeoutMs(0)).toBe(GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS);
  });

  it("scales model-capped sweeps for multi-probe retries", () => {
    expect(resolveGatewayLiveSuiteTimeoutMs(4)).toBeGreaterThan(GATEWAY_LIVE_DEFAULT_TIMEOUT_MS);
  });

  it("caps very large model sweeps", () => {
    expect(resolveGatewayLiveSuiteTimeoutMs(999)).toBe(GATEWAY_LIVE_MAX_TIMEOUT_MS);
  });
});

describe("resolveGatewayLiveMaxModels", () => {
  const originalGatewayModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS;
  const originalGatewayMax = process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
  const originalSharedMax = process.env.OPENCLAW_LIVE_MAX_MODELS;
  function restoreEnvValue(name: string, value: string | undefined): void {
    if (value === undefined) {
      deleteTestEnvValue(name);
    } else {
      setTestEnvValue(name, value);
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

  it("defaults small gateway sweeps to the curated small-model cap", () => {
    process.env.OPENCLAW_LIVE_GATEWAY_MODELS = "small";
    delete process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
    delete process.env.OPENCLAW_LIVE_MAX_MODELS;

    expect(resolveGatewayLiveMaxModels()).toBe(DEFAULT_SMALL_LIVE_MODEL_LIMIT);
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

function createGatewayLiveTestModel(provider: string, id: string): Model {
  return {
    provider,
    id,
    name: id,
    api: resolveExplicitLiveFallbackApi(provider),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
    reasoning: false,
  } as Model;
}

const EXPLICIT_LIVE_FALLBACK_API_BY_PROVIDER: Partial<Record<string, Api>> = {
  "amazon-bedrock": "bedrock-converse-stream",
};

const DEFAULT_BEDROCK_LIVE_REGION = "us-east-1";

function resolveExplicitLiveFallbackApi(provider: string): Api {
  return (
    EXPLICIT_LIVE_FALLBACK_API_BY_PROVIDER[normalizeProviderId(provider)] ?? "openai-responses"
  );
}

function resolveDefaultBedrockLiveBaseUrl(
  params: {
    cfg?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const env = params.env ?? process.env;
  const region =
    resolveBedrockDiscoveryRegion(params.cfg) ??
    normalizeOptionalEnvValue(env.AWS_REGION) ??
    normalizeOptionalEnvValue(env.AWS_DEFAULT_REGION) ??
    resolveAwsProfileRegion(env) ??
    DEFAULT_BEDROCK_LIVE_REGION;
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

function resolveBedrockDiscoveryRegion(cfg: OpenClawConfig | undefined): string | undefined {
  const pluginConfig = cfg?.plugins?.entries?.["amazon-bedrock"]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  const discoveryConfig = pluginConfig.discovery;
  if (!isRecord(discoveryConfig)) {
    return undefined;
  }
  const region = discoveryConfig.region;
  return typeof region === "string" ? normalizeOptionalEnvValue(region) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAwsProfileRegion(env: NodeJS.ProcessEnv): string | undefined {
  const profile = normalizeOptionalEnvValue(env.AWS_PROFILE) ?? "default";
  const homeDir = normalizeOptionalEnvValue(env.HOME) ?? os.homedir();
  const credentialsRegion = readAwsProfileRegionFromFile(
    resolveAwsSharedFilePath(
      env.AWS_SHARED_CREDENTIALS_FILE,
      homeDir,
      path.join(".aws", "credentials"),
    ),
    profile,
    "credentials",
  );
  if (credentialsRegion) {
    return credentialsRegion;
  }
  return readAwsProfileRegionFromFile(
    resolveAwsSharedFilePath(env.AWS_CONFIG_FILE, homeDir, path.join(".aws", "config")),
    profile,
    "config",
  );
}

function resolveAwsSharedFilePath(
  configuredPath: string | undefined,
  homeDir: string,
  defaultRelativePath: string,
): string {
  const normalized = normalizeOptionalEnvValue(configuredPath);
  if (!normalized) {
    return path.join(homeDir, defaultRelativePath);
  }
  if (normalized === "~") {
    return homeDir;
  }
  if (normalized.startsWith("~/")) {
    return path.join(homeDir, normalized.slice(2));
  }
  return path.resolve(normalized);
}

function readAwsProfileRegionFromFile(
  filePath: string,
  profile: string,
  fileKind: "config" | "credentials",
): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    return parseAwsProfileRegion(readFileSync(filePath, "utf8"), profile, fileKind);
  } catch {
    return undefined;
  }
}

function parseAwsProfileRegion(
  contents: string,
  profile: string,
  fileKind: "config" | "credentials",
): string | undefined {
  let currentSection: string | undefined;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = stripAwsSharedIniComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const section = /^\[([^\]]+)\]$/u.exec(line);
    if (section) {
      currentSection = normalizeAwsProfileSection(section[1] ?? "", fileKind);
      continue;
    }
    if (currentSection !== profile) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    if (key !== "region") {
      continue;
    }
    return normalizeOptionalEnvValue(value);
  }
  return undefined;
}

function stripAwsSharedIniComment(value: string): string {
  return value.split(/(^|\s)[;#]/u)[0] ?? "";
}

function normalizeAwsProfileSection(section: string, fileKind: "config" | "credentials"): string {
  const trimmed = section.trim();
  if (trimmed === "default" || fileKind === "credentials") {
    return trimmed;
  }
  const profileSection = /^profile\s+(?:"([^"]+)"|'([^']+)'|([\w@+.%:/-]+))$/u.exec(trimmed);
  return profileSection
    ? (profileSection[1] ?? profileSection[2] ?? profileSection[3] ?? "")
    : trimmed;
}

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  return trimmed;
}

function createExplicitLiveFallbackModel(provider: string, id: string): Model {
  return {
    ...createGatewayLiveTestModel(provider, id),
    contextWindow: EXPLICIT_LIVE_FALLBACK_CONTEXT_WINDOW,
    maxTokens: 4_096,
  };
}

function createGatewayLiveTestRegistry(overrides: Partial<ModelRegistry>): ModelRegistry {
  return {
    find() {
      return undefined;
    },
    getAll() {
      return [];
    },
    getAvailable() {
      return [];
    },
    hasConfiguredAuth() {
      return true;
    },
    ...overrides,
  };
}

describe("resolveExplicitLiveModelCandidates", () => {
  it("uses targeted registry lookup for explicit provider/model filters", () => {
    const model = createGatewayLiveTestModel("xai", "grok-4.3");
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["xai"]),
      modelFilter: new Set(["xai/grok-4.3"]),
      env: {},
    });
    const candidates = resolveExplicitLiveModelCandidates({
      modelRegistry: createGatewayLiveTestRegistry({
        find(provider, modelId) {
          expect(provider).toBe("xai");
          expect(modelId).toBe("grok-4.3");
          return model;
        },
        getAll() {
          throw new Error("explicit model lookup should not enumerate registry");
        },
      }),
      modelFilter: new Set(["xai/grok-4.3"]),
      providerFilter: new Set(["xai"]),
      targetMatcher: matcher,
    });

    expect(candidates).toEqual([model]);
  });

  it("normalizes retired Google Gemini refs before targeted lookup", () => {
    const model = createGatewayLiveTestModel("google", "gemini-3.1-pro-preview");
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["google"]),
      modelFilter: new Set(["google/gemini-3-pro-preview"]),
      env: {},
    });
    const candidates = resolveExplicitLiveModelCandidates({
      modelRegistry: createGatewayLiveTestRegistry({
        find(provider, modelId) {
          expect(provider).toBe("google");
          expect(modelId).toBe("gemini-3.1-pro-preview");
          return model;
        },
        getAll() {
          throw new Error("explicit model lookup should not enumerate registry");
        },
      }),
      modelFilter: new Set(["google/gemini-3-pro-preview"]),
      providerFilter: new Set(["google"]),
      targetMatcher: matcher,
    });

    expect(candidates).toEqual([model]);
  });

  it("keeps provider-qualified explicit refs usable when the registry is empty", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["openai"]),
      modelFilter: new Set(["openai/gpt-5.5"]),
      env: {},
    });
    const candidates = resolveExplicitLiveModelCandidates({
      modelRegistry: createGatewayLiveTestRegistry({
        find(provider, modelId) {
          expect(provider).toBe("openai");
          expect(modelId).toBe("gpt-5.5");
          return undefined;
        },
        getAll() {
          throw new Error("explicit model lookup should not enumerate registry");
        },
      }),
      modelFilter: new Set(["openai/gpt-5.5"]),
      providerFilter: new Set(["openai"]),
      targetMatcher: matcher,
    });

    if (!candidates) {
      throw new Error("expected explicit fallback candidates");
    }
    expect(candidates).toEqual([createExplicitLiveFallbackModel("openai", "gpt-5.5")]);
    expect(candidates[0]?.contextWindow).toBeGreaterThanOrEqual(4_000);
  });

  it("uses the Bedrock Converse API for explicit Bedrock fallback candidates", () => {
    const modelRef = "amazon-bedrock/global.anthropic.claude-sonnet-4-6";
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["amazon-bedrock"]),
      modelFilter: new Set([modelRef]),
      env: {},
    });
    const candidates = resolveExplicitLiveModelCandidates({
      modelRegistry: createGatewayLiveTestRegistry({
        find(provider, modelId) {
          expect(provider).toBe("amazon-bedrock");
          expect(modelId).toBe("global.anthropic.claude-sonnet-4-6");
          return undefined;
        },
      }),
      modelFilter: new Set([modelRef]),
      providerFilter: new Set(["amazon-bedrock"]),
      targetMatcher: matcher,
    });

    expect(candidates?.[0]).toMatchObject({
      provider: "amazon-bedrock",
      id: "global.anthropic.claude-sonnet-4-6",
      api: "bedrock-converse-stream",
    });
  });

  it("falls back to enumeration for ambiguous model-only filters", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: null,
      modelFilter: new Set(["grok-4.3"]),
      env: {},
    });

    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: createGatewayLiveTestRegistry({
          find() {
            throw new Error("ambiguous model-only lookup should not use direct find");
          },
          getAll() {
            return [];
          },
        }),
        modelFilter: new Set(["grok-4.3"]),
        providerFilter: null,
        targetMatcher: matcher,
      }),
    ).toBeNull();
  });
});

describe("providerScopedModelRegistryProviders", () => {
  it("uses curated high-signal providers for default modern sweeps", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: false,
        modelFilter: null,
        providerFilter: null,
      }),
    ).toEqual(getHighSignalLiveModelProviders());
  });

  it("intersects default modern sweeps with provider filters", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: false,
        modelFilter: null,
        providerFilter: new Set(["openai", "not-high-signal"]),
      }),
    ).toEqual(["openai"]);
  });

  it("uses curated small-model providers for small sweeps", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: true,
        useExplicit: false,
        modelFilter: null,
        providerFilter: null,
      }),
    ).toEqual(["lmstudio", "ollama", "openrouter", "sglang", "vllm", "zai"]);
  });

  it("intersects small gateway sweeps with provider filters", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: true,
        useExplicit: false,
        modelFilter: null,
        providerFilter: new Set(["ollama", "openai"]),
      }),
    ).toEqual(["ollama"]);
  });

  it("filters prioritized small refs before dynamic lookup", () => {
    expect(
      filterGatewayLiveModelRefsByProvider(
        listPrioritizedSmallLiveModelRefs(),
        new Set(["ollama"]),
      ),
    ).toEqual([{ provider: "ollama", id: "gemma3:4b" }]);
  });

  it("loads provider-scoped dynamic refs for default high-signal sweeps", () => {
    expect(
      resolvePrioritizedGatewayLiveModelRefs({
        providerFilter: new Set(["openrouter"]),
        useExplicit: false,
        useSmall: false,
      }),
    ).toEqual([
      { provider: "openrouter", id: "openai/gpt-5.2-chat" },
      { provider: "openrouter", id: "minimax/minimax-m2.7" },
      { provider: "openrouter", id: "ai21/jamba-large-1.7" },
    ]);
    expect(
      resolvePrioritizedGatewayLiveModelRefs({
        providerFilter: new Set(["fireworks"]),
        useExplicit: false,
        useSmall: false,
      }),
    ).toEqual([{ provider: "fireworks", id: "accounts/fireworks/models/glm-5p1" }]);
  });

  it("leaves explicit gateway model refs to targeted registry lookup", () => {
    expect(
      resolvePrioritizedGatewayLiveModelRefs({
        providerFilter: new Set(["openrouter"]),
        useExplicit: true,
        useSmall: false,
      }),
    ).toEqual([]);
  });

  it("does not count small models outside a provider-scoped gateway sweep", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["ollama"]),
      modelFilter: null,
      env: {},
    });

    expect(
      isWantedSmallGatewayLiveModel({
        model: createGatewayLiveTestModel("openrouter", "qwen/qwen3.5-9b"),
        targetMatcher: matcher,
      }),
    ).toBe(false);
    expect(
      isWantedSmallGatewayLiveModel({
        model: createGatewayLiveTestModel("ollama", "gemma3:4b"),
        targetMatcher: matcher,
      }),
    ).toBe(true);
  });

  it("uses explicit provider-qualified model refs without enumerating the full registry", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: true,
        modelFilter: new Set(["openai/gpt-5.2", "anthropic/claude-sonnet-4-6"]),
        providerFilter: null,
      }),
    ).toEqual(["anthropic", "openai"]);
  });

  it("uses a single provider filter for explicit model-only refs", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: true,
        modelFilter: new Set(["gpt-5.2"]),
        providerFilter: new Set(["openai"]),
      }),
    ).toEqual(["openai"]);
  });

  it("falls back to the full registry for ambiguous explicit model-only refs", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: true,
        modelFilter: new Set(["gpt-5.2"]),
        providerFilter: null,
      }),
    ).toBeUndefined();
  });
});

describe("resolveGatewayLiveModelThinkingLevel", () => {
  it("allows release lanes to lower gateway live thinking without smoke mode", () => {
    expect(resolveGatewayLiveThinkingLevel({ raw: "low", smoke: false })).toBe("low");
    expect(resolveGatewayLiveThinkingLevel({ raw: undefined, smoke: false })).toBe("high");
    expect(resolveGatewayLiveThinkingLevel({ raw: undefined, smoke: true })).toBe("low");
    expect(resolveGatewayLiveThinkingLevel({ raw: "wat", smoke: false })).toBe("high");
  });

  it("clamps requested thinking to levels supported by model metadata", () => {
    expect(
      resolveGatewayLiveModelThinkingLevel({
        cfg: {},
        model: {
          ...createGatewayLiveTestModel("example", "reasoning-model"),
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
          },
        },
        requestedLevel: "low",
      }),
    ).toBe("off");
  });

  it("does not let provider profiles override model-level thinking support", () => {
    expect(
      resolveGatewayLiveModelThinkingLevel({
        cfg: {},
        model: createGatewayLiveTestModel("openai", "gpt-5.5"),
        requestedLevel: "high",
      }),
    ).toBe("off");
  });

  it.each(["xai", "x-ai"])(
    "preserves Grok 4.5 thinking support for the %s provider id",
    (provider) => {
      expect(
        resolveGatewayLiveModelThinkingLevel({
          cfg: {},
          model: {
            ...createGatewayLiveTestModel(provider, "grok-4.5"),
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: "low",
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "high",
            },
          },
          requestedLevel: "high",
        }),
      ).toBe("high");
    },
  );

  it.each(["xai", "x-ai"])(
    "keeps off-only xAI models disabled for the %s provider id",
    (provider) => {
      expect(
        resolveGatewayLiveModelThinkingLevel({
          cfg: {},
          model: {
            ...createGatewayLiveTestModel(provider, "grok-build-0.1"),
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: null,
              medium: null,
              high: null,
              xhigh: null,
            },
          },
          requestedLevel: "high",
        }),
      ).toBe("off");
    },
  );
});

describe("buildLiveGatewayConfig", () => {
  it("pins selected live gateway models to the OpenClaw runtime", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {},
      candidates: [createGatewayLiveTestModel("openai", "gpt-5.5")],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({
      agentRuntime: { id: "openclaw" },
    });
  });

  it("configures only the isolated live agent", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {
        agents: {
          list: [{ id: "ops", default: true }],
        },
        bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
        broadcast: {
          strategy: "parallel",
          "release-test": ["ops"],
        },
      },
      candidates: [createGatewayLiveTestModel("openai", "gpt-5.5")],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.agents?.list).toEqual([
      {
        id: GATEWAY_LIVE_AGENT_ID,
        default: true,
        agentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        workspace: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
        sandbox: { mode: "off" },
      },
    ]);
    expect(cfg.bindings).toBeUndefined();
    expect(cfg.broadcast).toBeUndefined();
  });

  it("replaces a configured live agent workspace with the isolated workspace", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {
        agents: {
          list: [
            {
              id: "Dev",
              default: true,
              agentDir: "/operator/agent",
              workspace: "/operator/workspace",
            },
          ],
        },
      },
      candidates: [createGatewayLiveTestModel("openai", "gpt-5.5")],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.agents?.list).toEqual([
      {
        id: GATEWAY_LIVE_AGENT_ID,
        default: true,
        agentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        workspace: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
        sandbox: { mode: "off" },
      },
    ]);
  });

  it("keeps discovered live model metadata ahead of stale configured model rows", () => {
    const discovered = {
      ...createGatewayLiveTestModel("google", "gemini-3-flash-preview"),
      contextWindow: 128_000,
    };
    const cfg = buildLiveGatewayConfig({
      cfg: {
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: [
                {
                  id: "gemini-3-flash-preview",
                  name: "gemini-3-flash-preview",
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000,
                  maxTokens: 100,
                  reasoning: false,
                },
              ],
            },
          },
        },
      },
      candidates: [discovered],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.models?.providers?.google?.models?.[0]?.contextWindow).toBe(128_000);
  });

  it("keeps live provider request timeout aligned with the harness model budget", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: [],
              timeoutSeconds: 30,
            },
          },
        },
      },
      candidates: [createGatewayLiveTestModel("google", "gemini-3.1-pro-preview")],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.models?.providers?.google?.timeoutSeconds).toBeGreaterThanOrEqual(
      Math.ceil(GATEWAY_LIVE_MODEL_TIMEOUT_MS / 1_000),
    );
  });

  it("writes valid AWS SDK provider config for explicit Bedrock fallback models", () => {
    const previous = {
      awsRegion: process.env.AWS_REGION,
      awsDefaultRegion: process.env.AWS_DEFAULT_REGION,
      awsProfile: process.env.AWS_PROFILE,
      awsConfigFile: process.env.AWS_CONFIG_FILE,
      awsSharedCredentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
      home: process.env.HOME,
    };
    try {
      deleteTestEnvValue("AWS_REGION");
      deleteTestEnvValue("AWS_DEFAULT_REGION");
      deleteTestEnvValue("AWS_PROFILE");
      deleteTestEnvValue("AWS_CONFIG_FILE");
      deleteTestEnvValue("AWS_SHARED_CREDENTIALS_FILE");
      setTestEnvValue("HOME", path.join(os.tmpdir(), `openclaw-empty-aws-home-${randomUUID()}`));

      const cfg = buildLiveGatewayConfig({
        cfg: {},
        candidates: [
          createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
        ],
        liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
      });

      expect(cfg.models?.providers?.["amazon-bedrock"]).toMatchObject({
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        models: [
          {
            id: "global.anthropic.claude-sonnet-4-6",
            api: "bedrock-converse-stream",
          },
        ],
      });
    } finally {
      restoreOptionalEnv("AWS_REGION", previous.awsRegion);
      restoreOptionalEnv("AWS_DEFAULT_REGION", previous.awsDefaultRegion);
      restoreOptionalEnv("AWS_PROFILE", previous.awsProfile);
      restoreOptionalEnv("AWS_CONFIG_FILE", previous.awsConfigFile);
      restoreOptionalEnv("AWS_SHARED_CREDENTIALS_FILE", previous.awsSharedCredentialsFile);
      restoreOptionalEnv("HOME", previous.home);
    }
  });

  it("uses AWS_REGION for explicit Bedrock fallback provider config", () => {
    const previous = {
      awsRegion: process.env.AWS_REGION,
      awsDefaultRegion: process.env.AWS_DEFAULT_REGION,
      awsProfile: process.env.AWS_PROFILE,
      awsConfigFile: process.env.AWS_CONFIG_FILE,
      awsSharedCredentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
      home: process.env.HOME,
    };
    try {
      setTestEnvValue("AWS_REGION", "eu-west-1");
      deleteTestEnvValue("AWS_DEFAULT_REGION");
      deleteTestEnvValue("AWS_PROFILE");
      deleteTestEnvValue("AWS_CONFIG_FILE");
      deleteTestEnvValue("AWS_SHARED_CREDENTIALS_FILE");
      deleteTestEnvValue("HOME");

      const cfg = buildLiveGatewayConfig({
        cfg: {},
        candidates: [
          createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
        ],
        liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
      });

      expect(cfg.models?.providers?.["amazon-bedrock"]?.baseUrl).toBe(
        "https://bedrock-runtime.eu-west-1.amazonaws.com",
      );
    } finally {
      restoreOptionalEnv("AWS_REGION", previous.awsRegion);
      restoreOptionalEnv("AWS_DEFAULT_REGION", previous.awsDefaultRegion);
      restoreOptionalEnv("AWS_PROFILE", previous.awsProfile);
      restoreOptionalEnv("AWS_CONFIG_FILE", previous.awsConfigFile);
      restoreOptionalEnv("AWS_SHARED_CREDENTIALS_FILE", previous.awsSharedCredentialsFile);
      restoreOptionalEnv("HOME", previous.home);
    }
  });

  it("preserves configured Bedrock provider endpoints for explicit fallback models", () => {
    const previousAwsRegion = process.env.AWS_REGION;
    setTestEnvValue("AWS_REGION", "eu-west-1");
    try {
      const cfg = buildLiveGatewayConfig({
        cfg: {
          models: {
            providers: {
              "amazon-bedrock": {
                api: "bedrock-converse-stream",
                auth: "aws-sdk",
                baseUrl: "https://bedrock-runtime.ap-south-1.amazonaws.com",
                models: [],
              },
            },
          },
        },
        candidates: [
          createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
        ],
        liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
      });

      expect(cfg.models?.providers?.["amazon-bedrock"]?.baseUrl).toBe(
        "https://bedrock-runtime.ap-south-1.amazonaws.com",
      );
    } finally {
      restoreOptionalEnv("AWS_REGION", previousAwsRegion);
    }
  });

  it("keeps explicit Bedrock fallback models on the Bedrock runtime", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {
        models: {
          providers: {
            "amazon-bedrock": {
              api: "openai-responses",
              auth: "api-key",
              baseUrl: "https://bedrock-runtime.ap-south-1.amazonaws.com",
              models: [],
            },
          },
        },
      },
      candidates: [
        createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
      ],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.models?.providers?.["amazon-bedrock"]).toMatchObject({
      api: "bedrock-converse-stream",
      auth: "aws-sdk",
      baseUrl: "https://bedrock-runtime.ap-south-1.amazonaws.com",
    });
  });

  it("uses configured Bedrock discovery regions for explicit fallback models", () => {
    const previousAwsRegion = process.env.AWS_REGION;
    setTestEnvValue("AWS_REGION", "eu-west-1");
    try {
      const cfg = buildLiveGatewayConfig({
        cfg: {
          plugins: {
            entries: {
              "amazon-bedrock": {
                config: {
                  discovery: {
                    region: "ap-northeast-1",
                  },
                },
              },
            },
          },
        },
        candidates: [
          createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
        ],
        liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
      });

      expect(cfg.models?.providers?.["amazon-bedrock"]?.baseUrl).toBe(
        "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
      );
    } finally {
      restoreOptionalEnv("AWS_REGION", previousAwsRegion);
    }
  });

  it("uses selected AWS profile region for explicit Bedrock fallback provider config", async () => {
    const previous = {
      awsRegion: process.env.AWS_REGION,
      awsDefaultRegion: process.env.AWS_DEFAULT_REGION,
      awsProfile: process.env.AWS_PROFILE,
      awsConfigFile: process.env.AWS_CONFIG_FILE,
      awsSharedCredentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
      home: process.env.HOME,
    };
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bedrock-aws-home-"));
    try {
      const awsDir = path.join(tempHome, ".aws");
      await fs.mkdir(awsDir, { recursive: true });
      await fs.writeFile(
        path.join(awsDir, "config"),
        "[profile bedrock-live]\nregion = ap-southeast-2\n",
        "utf8",
      );
      deleteTestEnvValue("AWS_REGION");
      deleteTestEnvValue("AWS_DEFAULT_REGION");
      setTestEnvValue("AWS_PROFILE", "bedrock-live");
      deleteTestEnvValue("AWS_CONFIG_FILE");
      deleteTestEnvValue("AWS_SHARED_CREDENTIALS_FILE");
      setTestEnvValue("HOME", tempHome);

      const cfg = buildLiveGatewayConfig({
        cfg: {},
        candidates: [
          createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
        ],
        liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
      });

      expect(cfg.models?.providers?.["amazon-bedrock"]?.baseUrl).toBe(
        "https://bedrock-runtime.ap-southeast-2.amazonaws.com",
      );
    } finally {
      restoreOptionalEnv("AWS_REGION", previous.awsRegion);
      restoreOptionalEnv("AWS_DEFAULT_REGION", previous.awsDefaultRegion);
      restoreOptionalEnv("AWS_PROFILE", previous.awsProfile);
      restoreOptionalEnv("AWS_CONFIG_FILE", previous.awsConfigFile);
      restoreOptionalEnv("AWS_SHARED_CREDENTIALS_FILE", previous.awsSharedCredentialsFile);
      restoreOptionalEnv("HOME", previous.home);
      await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("strips AWS profile region inline comments for explicit Bedrock fallback config", async () => {
    const previous = {
      awsRegion: process.env.AWS_REGION,
      awsDefaultRegion: process.env.AWS_DEFAULT_REGION,
      awsProfile: process.env.AWS_PROFILE,
      awsConfigFile: process.env.AWS_CONFIG_FILE,
      awsSharedCredentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
      home: process.env.HOME,
    };
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bedrock-aws-home-"));
    try {
      const awsDir = path.join(tempHome, ".aws");
      await fs.mkdir(awsDir, { recursive: true });
      await fs.writeFile(
        path.join(awsDir, "config"),
        '[profile "bedrock-live"] # live smoke\nregion = eu-central-1 # live smoke\n',
        "utf8",
      );
      deleteTestEnvValue("AWS_REGION");
      deleteTestEnvValue("AWS_DEFAULT_REGION");
      setTestEnvValue("AWS_PROFILE", "bedrock-live");
      deleteTestEnvValue("AWS_CONFIG_FILE");
      deleteTestEnvValue("AWS_SHARED_CREDENTIALS_FILE");
      setTestEnvValue("HOME", tempHome);

      const cfg = buildLiveGatewayConfig({
        cfg: {},
        candidates: [
          createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
        ],
        liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
      });

      expect(cfg.models?.providers?.["amazon-bedrock"]?.baseUrl).toBe(
        "https://bedrock-runtime.eu-central-1.amazonaws.com",
      );
    } finally {
      restoreOptionalEnv("AWS_REGION", previous.awsRegion);
      restoreOptionalEnv("AWS_DEFAULT_REGION", previous.awsDefaultRegion);
      restoreOptionalEnv("AWS_PROFILE", previous.awsProfile);
      restoreOptionalEnv("AWS_CONFIG_FILE", previous.awsConfigFile);
      restoreOptionalEnv("AWS_SHARED_CREDENTIALS_FILE", previous.awsSharedCredentialsFile);
      restoreOptionalEnv("HOME", previous.home);
      await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("prefers AWS credentials profile regions over config profile regions", async () => {
    const previous = {
      awsRegion: process.env.AWS_REGION,
      awsDefaultRegion: process.env.AWS_DEFAULT_REGION,
      awsProfile: process.env.AWS_PROFILE,
      awsConfigFile: process.env.AWS_CONFIG_FILE,
      awsSharedCredentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
      home: process.env.HOME,
    };
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bedrock-aws-home-"));
    try {
      const awsDir = path.join(tempHome, ".aws");
      await fs.mkdir(awsDir, { recursive: true });
      await fs.writeFile(
        path.join(awsDir, "config"),
        "[profile bedrock-live]\nregion = us-west-2\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(awsDir, "credentials"),
        "[bedrock-live]\nregion = ca-central-1\n",
        "utf8",
      );
      deleteTestEnvValue("AWS_REGION");
      deleteTestEnvValue("AWS_DEFAULT_REGION");
      setTestEnvValue("AWS_PROFILE", "bedrock-live");
      deleteTestEnvValue("AWS_CONFIG_FILE");
      deleteTestEnvValue("AWS_SHARED_CREDENTIALS_FILE");
      setTestEnvValue("HOME", tempHome);

      const cfg = buildLiveGatewayConfig({
        cfg: {},
        candidates: [
          createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
        ],
        liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
      });

      expect(cfg.models?.providers?.["amazon-bedrock"]?.baseUrl).toBe(
        "https://bedrock-runtime.ca-central-1.amazonaws.com",
      );
    } finally {
      restoreOptionalEnv("AWS_REGION", previous.awsRegion);
      restoreOptionalEnv("AWS_DEFAULT_REGION", previous.awsDefaultRegion);
      restoreOptionalEnv("AWS_PROFILE", previous.awsProfile);
      restoreOptionalEnv("AWS_CONFIG_FILE", previous.awsConfigFile);
      restoreOptionalEnv("AWS_SHARED_CREDENTIALS_FILE", previous.awsSharedCredentialsFile);
      restoreOptionalEnv("HOME", previous.home);
      await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("enterProductionEnvForLiveRun", () => {
  it("clears Vitest fast-reply flags while preserving caller state", () => {
    const previous = {
      vitest: process.env.VITEST,
      nodeEnv: process.env.NODE_ENV,
      testFast: process.env.OPENCLAW_TEST_FAST,
    };
    process.env.VITEST = "1";
    process.env.NODE_ENV = "test";
    process.env.OPENCLAW_TEST_FAST = "1";

    const runtimeEnv = enterProductionEnvForLiveRun();
    try {
      expect(process.env.VITEST).toBeUndefined();
      expect(process.env.NODE_ENV).toBe("production");
      expect(process.env.OPENCLAW_TEST_FAST).toBeUndefined();
    } finally {
      restoreProductionEnvForLiveRun(runtimeEnv);
      restoreOptionalEnv("VITEST", previous.vitest);
      restoreOptionalEnv("NODE_ENV", previous.nodeEnv);
      restoreOptionalEnv("OPENCLAW_TEST_FAST", previous.testFast);
    }
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

function isAnthropicModelUnavailableDrift(raw: string): boolean {
  const msg = raw.trim();
  if (!msg) {
    return false;
  }
  if (isModelNotFoundErrorMessage(msg)) {
    return true;
  }
  return /\b404 status code\b/i.test(msg) && /\bno body\b/i.test(msg);
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
  return isLikelyToolNonceRefusal(error);
}

function isToolNonceProbeMiss(error: string): boolean {
  const msg = error.toLowerCase();
  return msg.includes("tool probe missing nonce") || msg.includes("exec+read probe missing nonce");
}

function isTransientToolReadProbeErrorForLiveModel(error: string): boolean {
  const msg = error.toLowerCase();
  // Some tool-capable providers complete a tool turn without appending reply text.
  // Retry here; the existing model policy decides whether exhausted misses may skip.
  const isCompletedWithoutReply =
    msg.includes("agent.wait error") && msg.includes("(error=completed)");
  const isTransientProviderFailure =
    msg.includes("unknown error occurred") ||
    (msg.includes("ai service returned an internal error") &&
      msg.includes("try again in a moment"));
  return (
    msg.includes("tool-read: agent-wait") &&
    (isCompletedWithoutReply || (msg.includes("failovererror") && isTransientProviderFailure))
  );
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
    provider === "minimax-portal" ||
    provider === "opencode" ||
    provider === "opencode-go" ||
    provider === "openrouter" ||
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
    { modelKey: "minimax-portal/MiniMax-M3", expected: true },
    { modelKey: "opencode/big-pickle", expected: true },
    { modelKey: "opencode-go/glm-5", expected: true },
    { modelKey: "openrouter/ai21/jamba-large-1.7", expected: true },
    { modelKey: "xai/grok-4.1-fast", expected: true },
    { modelKey: "zai/glm-5.1", expected: true },
    { modelKey: "deepinfra/deepseek-ai/DeepSeek-V4-Flash", expected: true },
    { modelKey: "google/gemini-3-flash-preview", expected: true },
    { modelKey: "google/gemini-3.1-pro-preview", expected: true },
    { modelKey: "openai/gpt-5.4", expected: false },
  ])("returns $expected for $modelKey", ({ modelKey, expected }) => {
    expect(shouldSkipToolNonceProbeMissForLiveModel(modelKey)).toBe(expected);
  });
});

describe("isTransientToolReadProbeErrorForLiveModel", () => {
  it("matches generic provider failover during the tool-read phase", () => {
    expect(
      isTransientToolReadProbeErrorForLiveModel(
        "[all-models] 1/1 google/gemini-3.1-pro-preview: tool-read: agent-wait: agent.wait error for runId=run-1 (error=FailoverError: An unknown error occurred)",
      ),
    ).toBe(true);
    expect(
      isTransientToolReadProbeErrorForLiveModel(
        "[all-models] 1/1 openai/gpt-5.5: tool-read: agent-wait: agent.wait error for runId=run-1 (error=FailoverError: The AI service returned an internal error. Please try again in a moment.)",
      ),
    ).toBe(true);
    expect(
      isTransientToolReadProbeErrorForLiveModel(
        "[all-models] 1/1 google/gemini-3.1-pro-preview: prompt: agent-wait: agent.wait error for runId=run-1 (error=FailoverError: An unknown error occurred)",
      ),
    ).toBe(false);
    expect(
      isTransientToolReadProbeErrorForLiveModel(
        "[all-models] 1/1 openai/gpt-5.5: prompt: agent-wait: agent.wait error for runId=run-1 (error=FailoverError: The AI service returned an internal error. Please try again in a moment.)",
      ),
    ).toBe(false);
  });

  it("matches terminal tool-read runs that completed without a reply", () => {
    expect(
      isTransientToolReadProbeErrorForLiveModel(
        "[all-models] 1/1 openrouter/ai21/jamba-large-1.7: tool-read: agent-wait: agent.wait error for runId=run-1 (error=completed)",
      ),
    ).toBe(true);
    expect(
      isTransientToolReadProbeErrorForLiveModel(
        "[all-models] 1/1 openrouter/ai21/jamba-large-1.7: prompt: agent-wait: agent.wait error for runId=run-1 (error=completed)",
      ),
    ).toBe(false);
  });
});

describe("getHighSignalLiveModelPriorityIndex", () => {
  it("prefers curated Google replacements over big-pickle", () => {
    expect(
      getHighSignalLiveModelPriorityIndex({ provider: "google", id: "gemini-3.1-pro-preview" }),
    ).toBe(4);
    expect(
      getHighSignalLiveModelPriorityIndex({ provider: "google", id: "gemini-3.5-flash" }),
    ).toBe(5);
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
    { provider: "minimax-portal", allowNotFoundSkip: true, expected: true },
    { provider: "zai", allowNotFoundSkip: true, expected: true },
    { provider: "openai", allowNotFoundSkip: true, expected: true },
    { provider: "xai", allowNotFoundSkip: true, expected: false },
  ])(
    "returns $expected for $provider (allowNotFoundSkip=$allowNotFoundSkip)",
    ({ provider, allowNotFoundSkip, expected }) => {
      expect(shouldSkipEmptyResponseForLiveModel({ provider, allowNotFoundSkip })).toBe(expected);
    },
  );
});

describe("isAnthropicModelUnavailableDrift", () => {
  it("treats Anthropic bare 404 live probe failures as model drift", () => {
    expect(
      isAnthropicModelUnavailableDrift(
        "agent.wait error for runId=run-1 (error=FailoverError: 404 status code (no body))",
      ),
    ).toBe(true);
    expect(isAnthropicModelUnavailableDrift("Error: 503 status code (no body)")).toBe(false);
  });
});

describe("isEmptyStreamText", () => {
  it.each([
    { text: "request ended without sending any chunks", expected: true },
    { text: `not meaningful: ${STREAM_ERROR_FALLBACK_TEXT}`, expected: true },
    { text: "not meaningful: let me think", expected: false },
  ])("returns $expected for $text", ({ text, expected }) => {
    expect(isEmptyStreamText(text)).toBe(expected);
  });
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
  return (
    text.includes("request ended without sending any chunks") ||
    text.includes(STREAM_ERROR_FALLBACK_TEXT)
  );
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
  // Must stay within the glyph set in `test/helpers/live-image-probe.ts`.
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
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    const client: GatewayClient | undefined = new GatewayClient({
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
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: 1,
        },
      },
      order: {
        openai: ["codexProfile", "openaiProfile"],
      },
      lastGood: {
        openai: "codexProfile",
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
      expect(sanitized.profiles.codexProfile).toBeUndefined();
      expect(sanitized.order).toBeUndefined();
      expect(sanitized.lastGood).toBeUndefined();
      expect(sanitized.usageStats).toBeUndefined();
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
  const textParts: string[] = [];
  for (const entry of record.content) {
    if (entry && typeof entry === "object") {
      const text = (entry as { text?: unknown }).text;
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (trimmed.length > 0) {
        textParts.push(trimmed);
      }
    }
  }
  return textParts.join("\n").trim();
}

type SessionAssistantEntry = {
  stopReason?: string;
  text: string;
};

async function readSessionMessagesForLiveProbe(sessionKey: string): Promise<unknown[]> {
  const { storePath, entry } = loadSessionEntry(sessionKey);
  if (!entry?.sessionId) {
    return [];
  }
  return await readSessionMessagesAsync(
    {
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey,
      storePath,
    },
    {
      mode: "full",
      reason: "live model assistant text verification",
    },
  );
}

function sessionMessagesAfterNextUserTurn(
  messages: readonly unknown[],
  baselineMessageCount: number,
  expectedUserText?: string,
): unknown[] {
  const nextUserOffset = messages.slice(baselineMessageCount).findIndex((message) => {
    return (
      (message as { role?: unknown } | null | undefined)?.role === "user" &&
      (expectedUserText === undefined || extractTranscriptMessageText(message) === expectedUserText)
    );
  });
  if (nextUserOffset < 0) {
    return [];
  }
  return messages.slice(baselineMessageCount + nextUserOffset + 1);
}

function sessionAssistantEntriesForLiveProbe(
  messages: readonly unknown[],
  modelKey?: string,
): SessionAssistantEntry[] {
  const assistantEntries: SessionAssistantEntry[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }
    const stopReason = (message as { stopReason?: unknown }).stopReason;
    assistantEntries.push({
      text: maybeStripAssistantScaffoldingForLiveModel(
        extractTranscriptMessageText(message),
        modelKey,
      ),
      ...(typeof stopReason === "string" ? { stopReason } : {}),
    });
  }
  return assistantEntries;
}

async function readSessionAssistantEntries(
  sessionKey: string,
  modelKey?: string,
  baselineMessageCount?: number,
  expectedUserText?: string,
): Promise<SessionAssistantEntry[]> {
  const messages = await readSessionMessagesForLiveProbe(sessionKey);
  // Assistant-count cursors can admit a late write from the previous run.
  // The next matching user entry is the durable boundary that owns this attempt's replies.
  const scopedMessages =
    baselineMessageCount === undefined
      ? messages
      : sessionMessagesAfterNextUserTurn(messages, baselineMessageCount, expectedUserText);
  return sessionAssistantEntriesForLiveProbe(scopedMessages, modelKey);
}

async function readSessionAssistantTexts(
  sessionKey: string,
  modelKey?: string,
  baselineMessageCount?: number,
  expectedUserText?: string,
): Promise<string[]> {
  return (
    await readSessionAssistantEntries(sessionKey, modelKey, baselineMessageCount, expectedUserText)
  ).map((entry) => entry.text);
}

function latestAssistantTextAfterBaseline(
  assistantTexts: string[],
  baselineAssistantCount: number,
): string | undefined {
  return assistantTexts
    .slice(baselineAssistantCount)
    .map((text) => text.trim())
    .findLast((text) => text.length > 0);
}

function latestTerminalAssistantTextAfterBaseline(
  assistantEntries: SessionAssistantEntry[],
  baselineAssistantCount: number,
): string | undefined {
  const latest = assistantEntries.slice(baselineAssistantCount).at(-1);
  if (!latest || latest.stopReason === "toolUse") {
    return undefined;
  }
  return latest.text.trim() || undefined;
}

describe("latestAssistantTextAfterBaseline", () => {
  it("returns the final reply after an intermediate tool preamble", () => {
    expect(
      latestAssistantTextAfterBaseline(
        ["previous reply", "I will read the file.", "nonce-a nonce-b"],
        1,
      ),
    ).toBe("nonce-a nonce-b");
  });

  it("waits for a terminal reply after a tool preamble", () => {
    expect(
      latestTerminalAssistantTextAfterBaseline(
        [
          { stopReason: "stop", text: "previous reply" },
          { stopReason: "toolUse", text: "I will read the file." },
          { stopReason: "stop", text: "nonce-a nonce-b" },
        ],
        1,
      ),
    ).toBe("nonce-a nonce-b");
    expect(
      latestTerminalAssistantTextAfterBaseline(
        [
          { stopReason: "stop", text: "previous reply" },
          { stopReason: "error", text: "partial reply" },
          { stopReason: "toolUse", text: "I will read the file." },
        ],
        1,
      ),
    ).toBeUndefined();
  });

  it("correlates retry replies after late prior transcript writes", () => {
    const firstBaselineMessageCount = 1;
    const firstAttemptMessages: unknown[] = [
      { role: "user", content: "prior attempt" },
      { role: "toolResult", content: "stale-a stale-b" },
      { role: "assistant", stopReason: "stop", content: "stale-a stale-b" },
      { role: "user", content: "stale retry" },
      { role: "assistant", stopReason: "stop", content: "stale-a stale-b" },
      { role: "user", content: "read first-a first-b" },
      { role: "assistant", stopReason: "toolUse", content: "reading first probe" },
      { role: "toolResult", content: "first-a first-b" },
      { role: "assistant", stopReason: "stop", content: "first-a first-b" },
    ];
    expect(
      sessionMessagesAfterNextUserTurn(
        firstAttemptMessages.slice(0, 5),
        firstBaselineMessageCount,
        "read first-a first-b",
      ),
    ).toEqual([]);
    const firstToolUseOnly = sessionAssistantEntriesForLiveProbe(
      sessionMessagesAfterNextUserTurn(
        firstAttemptMessages.slice(0, 8),
        firstBaselineMessageCount,
        "read first-a first-b",
      ),
    );
    expect(latestTerminalAssistantTextAfterBaseline(firstToolUseOnly, 0)).toBeUndefined();
    const firstEntries = sessionAssistantEntriesForLiveProbe(
      sessionMessagesAfterNextUserTurn(
        firstAttemptMessages,
        firstBaselineMessageCount,
        "read first-a first-b",
      ),
    );
    expect(latestTerminalAssistantTextAfterBaseline(firstEntries, 0)).toBe("first-a first-b");

    const secondBaselineMessageCount = firstAttemptMessages.length;
    const secondAttemptMessages = [
      ...firstAttemptMessages,
      { role: "toolResult", content: "first-a first-b" },
      { role: "assistant", stopReason: "stop", content: "first-a first-b" },
      { role: "user", content: "stale first retry" },
      { role: "assistant", stopReason: "stop", content: "first-a first-b" },
      { role: "user", content: "read second-a second-b" },
      { role: "assistant", stopReason: "toolUse", content: "reading second probe" },
      { role: "toolResult", content: "second-a second-b" },
      { role: "assistant", stopReason: "stop", content: "second-a second-b" },
    ];
    const secondEntries = sessionAssistantEntriesForLiveProbe(
      sessionMessagesAfterNextUserTurn(
        secondAttemptMessages,
        secondBaselineMessageCount,
        "read second-a second-b",
      ),
    );
    expect(latestTerminalAssistantTextAfterBaseline(secondEntries, 0)).toBe("second-a second-b");
  });
});

async function waitForSessionAssistantText(params: {
  sessionKey: string;
  baselineMessageCount: number;
  expectedUserText: string;
  context: string;
  modelKey?: string;
  terminalOnly?: boolean;
  timeoutLabel?: "model" | "probe" | "terminal";
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let delayMs = 50;
  const timeoutMs = params.timeoutMs ?? GATEWAY_LIVE_TRANSCRIPT_TIMEOUT_MS;
  const timeoutLabel = params.timeoutLabel ?? "model";
  while (Date.now() - startedAt < timeoutMs) {
    const assistantEntries = await readSessionAssistantEntries(
      params.sessionKey,
      params.modelKey,
      params.baselineMessageCount,
      params.expectedUserText,
    );
    const freshText = params.terminalOnly
      ? latestTerminalAssistantTextAfterBaseline(assistantEntries, 0)
      : latestAssistantTextAfterBaseline(
          assistantEntries.map((entry) => entry.text),
          0,
        );
    if (freshText) {
      return freshText;
    }
    if (Date.now() - lastHeartbeatAt >= GATEWAY_LIVE_HEARTBEAT_MS) {
      lastHeartbeatAt = Date.now();
      logProgress(
        `${params.context}: waiting for transcript (${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))}s)`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
    delayMs = Math.min(delayMs * 2, 250);
  }
  throw new Error(`${timeoutLabel} timeout after ${timeoutMs}ms (${params.context})`);
}

function formatGatewayLiveAgentWaitFailure(params: {
  context: string;
  runId: string;
  result: unknown;
}): Error {
  const result = params.result as
    | {
        status?: unknown;
        error?: unknown;
        stopReason?: unknown;
        timeoutPhase?: unknown;
        providerStarted?: unknown;
      }
    | null
    | undefined;
  const status = typeof result?.status === "string" ? result.status : "unknown";
  const details = [
    typeof result?.timeoutPhase === "string" ? `timeoutPhase=${result.timeoutPhase}` : undefined,
    typeof result?.providerStarted === "boolean"
      ? `providerStarted=${String(result.providerStarted)}`
      : undefined,
    typeof result?.stopReason === "string" ? `stopReason=${result.stopReason}` : undefined,
    typeof result?.error === "string" ? `error=${result.error}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return new Error(
    `${params.context}: agent.wait ${status} for runId=${params.runId}${
      details.length > 0 ? ` (${details.join(", ")})` : ""
    }`,
  );
}

function isGatewayAgentWaitCompletedWithoutReply(result: unknown): boolean {
  const value = result as { status?: unknown; error?: unknown } | null | undefined;
  return (
    value?.status === "error" &&
    typeof value.error === "string" &&
    value.error.trim().toLowerCase() === "completed"
  );
}

async function waitForGatewayAgentRun(params: {
  client: GatewayClient;
  runId: string;
  context: string;
  timeoutMs?: number;
  allowCompletedWithoutReply?: boolean;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? GATEWAY_LIVE_TRANSCRIPT_TIMEOUT_MS;
  const result = await params.client.request(
    "agent.wait",
    {
      runId: params.runId,
      timeoutMs,
    },
    {
      timeoutMs: timeoutMs + 5_000,
    },
  );
  if (
    (result as { status?: unknown } | undefined)?.status === "ok" ||
    (params.allowCompletedWithoutReply && isGatewayAgentWaitCompletedWithoutReply(result))
  ) {
    return;
  }
  throw formatGatewayLiveAgentWaitFailure({
    context: params.context,
    runId: params.runId,
    result,
  });
}

async function requestGatewayAgentText(params: {
  client: GatewayClient;
  sessionKey: string;
  message: string;
  thinkingLevel: string;
  context: string;
  idempotencyKey: string;
  modelKey?: string;
  assistantText?: "required" | "optional";
  attachments?: Array<{
    mimeType: string;
    fileName: string;
    content: string;
  }>;
}) {
  const baselineMessageCount = (await readSessionMessagesForLiveProbe(params.sessionKey)).length;
  const runId = params.idempotencyKey;
  const accepted = await withGatewayLiveProbeTimeout(
    params.client.request("agent", {
      sessionKey: params.sessionKey,
      idempotencyKey: runId,
      message: params.message,
      thinking: params.thinkingLevel,
      deliver: false,
      timeout: Math.ceil(GATEWAY_LIVE_AGENT_RUN_TIMEOUT_MS / 1_000),
      attachments: params.attachments,
    }),
    `${params.context}: agent-accept`,
  );
  if (accepted?.status !== "accepted") {
    throw new Error(`agent status=${String(accepted?.status)}`);
  }
  if (params.assistantText === "optional") {
    // Tool-only turns intentionally may not append assistant text. Their
    // contract is terminal completion; the following turn proves tool state.
    await waitForGatewayAgentRun({
      client: params.client,
      runId,
      context: `${params.context}: agent-wait`,
      timeoutMs: GATEWAY_LIVE_AGENT_WAIT_TIMEOUT_MS,
      allowCompletedWithoutReply: true,
    });
    const assistantTexts = await readSessionAssistantTexts(
      params.sessionKey,
      params.modelKey,
      baselineMessageCount,
      params.message,
    );
    return assistantTexts.at(-1) ?? "";
  }
  const transcriptPromise = waitForSessionAssistantText({
    sessionKey: params.sessionKey,
    baselineMessageCount,
    expectedUserText: params.message,
    context: `${params.context}: transcript-final`,
    modelKey: params.modelKey,
    timeoutLabel: "model",
    timeoutMs: GATEWAY_LIVE_TRANSCRIPT_TIMEOUT_MS,
  }).then((text) => ({ kind: "transcript" as const, text }));
  const agentWaitPromise = waitForGatewayAgentRun({
    client: params.client,
    runId,
    context: `${params.context}: agent-wait`,
    timeoutMs: GATEWAY_LIVE_AGENT_WAIT_TIMEOUT_MS,
  }).then(
    () => ({ kind: "agent-ok" as const }),
    (error: unknown) => ({ kind: "agent-error" as const, error }),
  );
  const first = await Promise.race([transcriptPromise, agentWaitPromise]);
  if (first.kind === "transcript") {
    // Do not start the next live probe while this run is still cleaning up.
    // The transcript can be visible before the embedded attempt reacquires and
    // releases its session lock, and back-to-back probes on the same session
    // can otherwise trip the takeover fence.
    const waitResult = await agentWaitPromise;
    if (waitResult.kind === "agent-error") {
      throw waitResult.error instanceof Error
        ? waitResult.error
        : new Error(String(waitResult.error));
    }
    return await waitForSessionAssistantText({
      sessionKey: params.sessionKey,
      baselineMessageCount,
      expectedUserText: params.message,
      context: `${params.context}: transcript-terminal`,
      modelKey: params.modelKey,
      terminalOnly: true,
      timeoutLabel: "terminal",
      timeoutMs: GATEWAY_LIVE_PROBE_TIMEOUT_MS,
    });
  }
  void transcriptPromise.catch(() => undefined);
  if (first.kind === "agent-error") {
    throw first.error instanceof Error ? first.error : new Error(String(first.error));
  }
  return await waitForSessionAssistantText({
    sessionKey: params.sessionKey,
    baselineMessageCount,
    expectedUserText: params.message,
    context: `${params.context}: transcript-after-agent-wait`,
    modelKey: params.modelKey,
    terminalOnly: true,
    timeoutLabel: "terminal",
    timeoutMs: GATEWAY_LIVE_PROBE_TIMEOUT_MS,
  });
}

type GatewayModelSuiteParams = {
  label: string;
  cfg: OpenClawConfig;
  candidates: Array<Model>;
  allowNotFoundSkip: boolean;
  extraToolProbes: boolean;
  extraImageProbes: boolean;
  thinkingLevel: string;
  providerOverrides?: Record<string, ModelProviderConfig>;
};

type LiveModelRegistry = ModelRegistry;

function toGatewayLiveModel(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  modelConfig: NonNullable<ModelProviderConfig["models"]>[number];
}): Model | null {
  const id = params.modelConfig.id?.trim();
  const api = params.modelConfig.api ?? params.providerConfig.api;
  const baseUrl = params.modelConfig.baseUrl ?? params.providerConfig.baseUrl;
  if (!id || !api || !baseUrl) {
    return null;
  }
  const input = params.modelConfig.input.filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  return {
    id,
    name: params.modelConfig.name ?? id,
    api: api as Api,
    provider: params.provider,
    baseUrl,
    reasoning: params.modelConfig.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    cost: params.modelConfig.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: params.modelConfig.contextWindow ?? 128_000,
    maxTokens: params.modelConfig.maxTokens ?? 16_384,
    compat: params.modelConfig.compat,
  };
}

async function loadProviderScopedConfiguredModels(params: {
  agentDir: string;
  providerList: readonly string[];
}): Promise<Array<Model>> {
  const modelsPath = path.join(params.agentDir, "models.json");
  let parsed: { providers?: Record<string, ModelProviderConfig> };
  try {
    parsed = JSON.parse(await fs.readFile(modelsPath, "utf8")) as {
      providers?: Record<string, ModelProviderConfig>;
    };
  } catch {
    return [];
  }

  const providers = parsed.providers ?? {};
  const models: Array<Model> = [];
  const seen = new Set<string>();
  for (const rawProvider of params.providerList) {
    const normalizedProvider = normalizeProviderId(rawProvider);
    const entry = Object.entries(providers).find(
      ([provider]) => normalizeProviderId(provider) === normalizedProvider,
    );
    if (!entry) {
      continue;
    }
    const [provider, providerConfig] = entry;
    for (const modelConfig of providerConfig.models ?? []) {
      const model = toGatewayLiveModel({ provider, providerConfig, modelConfig });
      if (!model) {
        continue;
      }
      const key = `${normalizeProviderId(model.provider)}/${model.id.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push(model);
    }
  }
  return models;
}

async function loadProviderScopedModels(params: {
  agentDir: string;
  providerList: readonly string[];
}): Promise<Array<Model>> {
  return await loadProviderScopedConfiguredModels(params);
}

function createStaticLiveModelRegistry(models: Array<Model>): LiveModelRegistry {
  return {
    find(provider, modelId) {
      const normalizedProvider = normalizeProviderId(provider);
      const normalizedModelId = modelId.toLowerCase();
      return models.find(
        (model) =>
          normalizeProviderId(model.provider) === normalizedProvider &&
          model.id.toLowerCase() === normalizedModelId,
      );
    },
    getAll() {
      return models;
    },
    getAvailable() {
      return models;
    },
    hasConfiguredAuth() {
      return true;
    },
  };
}

async function loadAuthBackedLiveModelRegistry(params: {
  agentDir: string;
  cfg: OpenClawConfig;
  providerList: string[] | undefined;
}): Promise<{
  authProfileStore: AuthProfileStore;
  modelRegistry: LiveModelRegistry;
  all: Array<Model>;
}> {
  const authProfileStore = await withGatewayLiveSetupTimeout(
    Promise.resolve().then(() =>
      params.providerList
        ? ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
            allowKeychainPrompt: false,
          })
        : ensureAuthProfileStore(params.agentDir, {
            allowKeychainPrompt: false,
          }),
    ),
    "[all-models] load auth profiles",
  );
  const authStorage = await withGatewayLiveSetupTimeout(
    Promise.resolve().then(() =>
      discoverAuthStorage(params.agentDir, {
        config: params.cfg,
        env: process.env,
        ...(params.providerList
          ? {
              skipExternalAuthProfiles: true,
              syntheticAuthProviderRefs: [],
            }
          : {}),
      }),
    ),
    "[all-models] load auth storage",
  );
  logProgress("[all-models] loading model registry");
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const all = await withGatewayLiveSetupTimeout(
    Promise.resolve().then(() => modelRegistry.getAll()),
    "[all-models] load model registry",
  );
  return { authProfileStore, modelRegistry, all };
}

function toLiveModelConfig(model: Model): NonNullable<ModelProviderConfig["models"]>[number] {
  return {
    id: model.id,
    name: model.name,
    api: model.api as ModelProviderConfig["api"],
    baseUrl: model.baseUrl,
    input: model.input ?? ["text"],
    reasoning: model.reasoning,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

function mergeLiveProviderConfig(params: {
  provider: string;
  base: ModelProviderConfig | undefined;
  discovered: ModelProviderConfig;
}): ModelProviderConfig {
  const baseModels = params.base?.models ?? [];
  const discoveredModels = params.discovered.models ?? [];
  const mergedModels = new Map<string, NonNullable<ModelProviderConfig["models"]>[number]>();
  for (const model of baseModels) {
    if (model.id) {
      mergedModels.set(model.id, model);
    }
  }
  for (const model of discoveredModels) {
    if (model.id) {
      mergedModels.set(model.id, model);
    }
  }
  const useDiscoveredRuntime = normalizeProviderId(params.provider) === "amazon-bedrock";
  return {
    ...params.discovered,
    ...params.base,
    api: useDiscoveredRuntime ? params.discovered.api : (params.base?.api ?? params.discovered.api),
    auth: useDiscoveredRuntime
      ? params.discovered.auth
      : (params.base?.auth ?? params.discovered.auth),
    baseUrl: params.base?.baseUrl ?? params.discovered.baseUrl,
    timeoutSeconds: Math.max(
      params.base?.timeoutSeconds ?? 0,
      params.discovered.timeoutSeconds ?? 0,
    ),
    models: [...mergedModels.values()],
  };
}

function buildLiveProviderConfigs(params: {
  candidates: Array<Model>;
  cfg: OpenClawConfig;
}): Record<string, ModelProviderConfig> {
  const providers: Record<string, ModelProviderConfig> = {};
  for (const model of params.candidates) {
    const existing = providers[model.provider];
    if (existing) {
      existing.models ??= [];
      existing.models.push(toLiveModelConfig(model));
      continue;
    }
    providers[model.provider] = buildLiveProviderConfig({ model, cfg: params.cfg });
  }
  return providers;
}

function buildLiveProviderConfig(params: {
  model: Model;
  cfg: OpenClawConfig;
}): ModelProviderConfig {
  const { model } = params;
  const provider = normalizeProviderId(model.provider);
  const config: ModelProviderConfig = {
    api: model.api as ModelProviderConfig["api"],
    baseUrl:
      provider === "amazon-bedrock"
        ? (model.baseUrl ?? resolveDefaultBedrockLiveBaseUrl({ cfg: params.cfg }))
        : model.baseUrl,
    timeoutSeconds: resolveGatewayLiveProviderTimeoutSeconds(),
    models: [toLiveModelConfig(model)],
  };
  if (provider === "amazon-bedrock") {
    return {
      ...config,
      api: model.api as ModelProviderConfig["api"],
      auth: "aws-sdk",
    };
  }
  return config;
}

function parseExplicitLiveModelRef(
  raw: string,
  providerFilter: Set<string> | null,
): { provider: string; modelId: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const provider = normalizeProviderId(trimmed.slice(0, slash));
    const rawModelId = trimmed.slice(slash + 1).trim();
    const modelId =
      provider === "google" || provider === "google-gemini-cli" || provider === "google-vertex"
        ? normalizeGoogleModelId(rawModelId)
        : rawModelId;
    return provider && modelId ? { provider, modelId } : null;
  }
  if (!providerFilter || providerFilter.size !== 1) {
    return null;
  }
  const [provider] = [...providerFilter];
  return provider ? { provider: normalizeProviderId(provider), modelId: trimmed } : null;
}

function resolveExplicitLiveModelCandidates(params: {
  modelRegistry: LiveModelRegistry;
  modelFilter: Set<string> | null;
  providerFilter: Set<string> | null;
  targetMatcher: ReturnType<typeof createLiveTargetMatcher>;
}): Array<Model> | null {
  if (!params.modelFilter || params.modelFilter.size === 0) {
    return null;
  }
  const candidates: Array<Model> = [];
  const seen = new Set<string>();
  for (const raw of params.modelFilter) {
    const ref = parseExplicitLiveModelRef(raw, params.providerFilter);
    if (!ref) {
      return null;
    }
    const model =
      params.modelRegistry.find(ref.provider, ref.modelId) ??
      createExplicitLiveFallbackModel(ref.provider, ref.modelId);
    if (
      !params.targetMatcher.matchesProvider(model.provider) ||
      !params.targetMatcher.matchesModel(model.provider, model.id)
    ) {
      return null;
    }
    const key = `${normalizeProviderId(model.provider)}/${model.id.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(model);
    }
  }
  return candidates;
}

function resolveGatewayLiveModelThinkingLevel(params: {
  cfg: OpenClawConfig;
  model: Model;
  requestedLevel: string;
}): string {
  const { model, requestedLevel } = params;
  const normalized = requestedLevel.trim() as ModelThinkingLevel;
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) {
    return requestedLevel;
  }
  const profile = resolveProviderThinkingProfile({
    provider: model.provider,
    config: params.cfg,
    context: {
      provider: model.provider,
      modelId: model.id,
      reasoning: model.reasoning,
      compat: getProviderThinkingModelCompat(model),
    },
  });
  if (profile) {
    const levelIds = profile.levels.map((level) => level.id);
    if (levelIds.includes(normalized)) {
      return clampThinkingLevel(model, normalized);
    }
    if (profile.defaultLevel) {
      return clampThinkingLevel(model, profile.defaultLevel as ModelThinkingLevel);
    }
    if (levelIds.length === 1) {
      const [onlyLevel] = levelIds;
      return onlyLevel
        ? clampThinkingLevel(model, onlyLevel as ModelThinkingLevel)
        : requestedLevel;
    }
  }
  return clampThinkingLevel(model, normalized);
}

function getProviderThinkingModelCompat(model: Model): ProviderThinkingModelCompat | undefined {
  const compat = model.compat;
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const record = compat as Record<string, unknown>;
  const thinkingFormat =
    typeof record.thinkingFormat === "string" ? record.thinkingFormat : undefined;
  const supportedReasoningEfforts =
    Array.isArray(record.supportedReasoningEfforts) &&
    record.supportedReasoningEfforts.every((value) => typeof value === "string")
      ? record.supportedReasoningEfforts
      : record.supportedReasoningEfforts === null
        ? null
        : undefined;
  return thinkingFormat || supportedReasoningEfforts !== undefined
    ? {
        ...(thinkingFormat ? { thinkingFormat } : {}),
        ...(supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts } : {}),
      }
    : undefined;
}

function resolveGatewayLiveThinkingLevel(params: { raw?: string; smoke: boolean }): string {
  const raw = params.raw?.trim().toLowerCase();
  if (!raw) {
    return params.smoke ? "low" : "high";
  }
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(raw)
    ? raw
    : params.smoke
      ? "low"
      : "high";
}

function buildLiveGatewayConfig(params: {
  cfg: OpenClawConfig;
  candidates: Array<Model>;
  liveAgentDir: string;
  liveAgentWorkspaceDir: string;
  providerOverrides?: Record<string, ModelProviderConfig>;
}): OpenClawConfig {
  const providerOverrides = params.providerOverrides ?? {};
  const lmstudioProvider = params.cfg.models?.providers?.lmstudio;
  const baseProviders = params.cfg.models?.providers ?? {};
  const candidateProviders = buildLiveProviderConfigs({
    candidates: params.candidates,
    cfg: params.cfg,
  });
  const discoveredProviders = Object.fromEntries(
    Object.entries(candidateProviders).map(([provider, discovered]) => [
      provider,
      mergeLiveProviderConfig({ provider, base: baseProviders[provider], discovered }),
    ]),
  );
  const nextProviders = {
    ...baseProviders,
    ...discoveredProviders,
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
  const configuredAgents = [
    {
      id: GATEWAY_LIVE_AGENT_ID,
      default: true,
      agentDir: params.liveAgentDir,
      workspace: params.liveAgentWorkspaceDir,
      sandbox: { mode: "off" },
    },
  ] satisfies NonNullable<OpenClawConfig["agents"]>["list"];
  const baseModels = params.cfg.models;
  return {
    ...params.cfg,
    bindings: undefined,
    broadcast: undefined,
    agents: {
      ...params.cfg.agents,
      list: configuredAgents,
      defaults: {
        ...params.cfg.agents?.defaults,
        // Live tests should avoid Docker sandboxing so tool probes can
        // operate on the temporary probe files we create in the host workspace.
        sandbox: { mode: "off" },
        // This suite validates direct provider/API-key gateway behavior. OpenAI
        // agent models otherwise use the implicit Codex runtime, which tests a
        // different auth/runtime path and can hang until the model timeout.
        models: Object.fromEntries(
          params.candidates.map((m) => [
            `${m.provider}/${m.id}`,
            { agentRuntime: { id: "openclaw" as const } },
          ]),
        ),
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
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };

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
  const agentId = GATEWAY_LIVE_AGENT_ID;

  const hostAgentDir = resolveDefaultAgentDir(getRuntimeConfig());
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
  const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-state-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
  const tempAgentDir: string | undefined = path.join(
    tempStateDir,
    "agents",
    DEFAULT_AGENT_ID,
    "agent",
  );
  saveAuthProfileStore(sanitizedStore, tempAgentDir);
  const tempSessionAgentDir = path.join(tempStateDir, "agents", agentId, "agent");
  if (tempSessionAgentDir !== tempAgentDir) {
    saveAuthProfileStore(sanitizedStore, tempSessionAgentDir);
  }
  setTestEnvValue("OPENCLAW_AGENT_DIR", tempAgentDir);

  const workspaceDir = path.join(tempStateDir, "workspace-dev");
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
  // Keep probe values out of the path: weak tool callers may echo the filename
  // instead of reading the file, turning nonceA into a false duplicate answer.
  const toolProbePath = path.join(workspaceDir, ".openclaw-live-tool-probe.txt");
  await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

  const agentDir = resolveDefaultAgentDir(params.cfg);
  const sanitizedCfg: OpenClawConfig = {
    ...params.cfg,
    auth: await sanitizeAuthConfig({ cfg: params.cfg, agentDir }),
  };
  const nextCfg = buildLiveGatewayConfig({
    cfg: sanitizedCfg,
    candidates: params.candidates,
    liveAgentDir: tempSessionAgentDir,
    liveAgentWorkspaceDir: workspaceDir,
    providerOverrides: params.providerOverrides,
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-"));
  const tempConfigPath = path.join(tempDir, "openclaw.json");
  await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", tempConfigPath);

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
        failGatewayLiveStartupCoverage({ label: params.label, reason: message });
      }
      throw error;
    }

    if (!server || !client) {
      failGatewayLiveStartupCoverage({
        label: params.label,
        reason: "gateway server/client did not initialize",
      });
    }
    logProgress(
      `[${params.label}] running ${params.candidates.length} models (thinking=${params.thinkingLevel})`,
    );
    logProgress(
      `[${params.label}] heartbeat=${Math.max(1, Math.round(GATEWAY_LIVE_HEARTBEAT_MS / 1_000))}s probe-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_PROBE_TIMEOUT_MS / 1_000))}s agent-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_AGENT_RUN_TIMEOUT_MS / 1_000))}s agent-wait=${Math.max(1, Math.round(GATEWAY_LIVE_AGENT_WAIT_TIMEOUT_MS / 1_000))}s model-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_MODEL_TIMEOUT_MS / 1_000))}s transcript-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_TRANSCRIPT_TIMEOUT_MS / 1_000))}s`,
    );
    const anthropicKeys = collectAnthropicApiKeys();
    if (anthropicKeys.length > 0) {
      process.env.ANTHROPIC_API_KEY = anthropicKeys[0];
      logProgress(`[${params.label}] anthropic keys loaded: ${anthropicKeys.length}`);
    }
    const failures: Array<{ model: string; error: string }> = [];
    let passedCount = 0;
    let skippedCount = 0;
    let timeoutSkippedCount = 0;
    const total = params.candidates.length;

    for (const [index, model] of params.candidates.entries()) {
      const modelKey = `${model.provider}/${model.id}`;
      const progressLabel = `[${params.label}] ${index + 1}/${total} ${modelKey}`;
      const thinkingLevel = resolveGatewayLiveModelThinkingLevel({
        cfg: params.cfg,
        model,
        requestedLevel: params.thinkingLevel,
      });
      if (thinkingLevel !== params.thinkingLevel) {
        logProgress(`${progressLabel}: thinking ${params.thinkingLevel} -> ${thinkingLevel}`);
      }
      // Use a separate session per model: live providers can finalize late after
      // skip/retry paths, and a reset on a reused key does not isolate those
      // delayed transcript writes from the next model probe.
      const sessionKey = `agent:${agentId}:${params.label}:model-${index + 1}`;

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
              await withGatewayLiveSessionControlTimeout(
                client.request("sessions.reset", {
                  key: sessionKey,
                }),
                `${progressLabel}: sessions-reset`,
              );
              await withGatewayLiveSessionControlTimeout(
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
                thinkingLevel,
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
                  thinkingLevel,
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
                  thinkingLevel,
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
              // Known-variable models already skip after exhausted nonce misses.
              // Use the stricter follow-up prompts before conceding that coverage.
              const retryKnownToolNonceMiss = shouldSkipToolNonceProbeMissForLiveModel(modelKey);
              let toolText = "";
              for (
                let toolReadAttempt = 0;
                toolReadAttempt < maxToolReadAttempts;
                toolReadAttempt += 1
              ) {
                const strictReply = toolReadAttempt > 0;
                try {
                  toolText = await requestGatewayAgentText({
                    client,
                    sessionKey,
                    idempotencyKey: `idem-${runIdTool}-tool-${toolReadAttempt + 1}`,
                    modelKey,
                    message: strictReply
                      ? "OpenClaw live tool probe (local, safe): " +
                        `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                        "Then reply with exactly the two nonce values from that file, separated by one space. No extra text."
                      : "OpenClaw live tool probe (local, safe): " +
                        `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                        "Then reply with the two nonce values you read (include both).",
                    thinkingLevel,
                    context: `${progressLabel}: tool-read`,
                  });
                } catch (error) {
                  const message = String(error instanceof Error ? error.message : error);
                  if (
                    isTransientToolReadProbeErrorForLiveModel(message) &&
                    toolReadAttempt + 1 < maxToolReadAttempts
                  ) {
                    logProgress(
                      `${progressLabel}: tool-read retry (${toolReadAttempt + 2}/${maxToolReadAttempts}) transient provider result`,
                    );
                    continue;
                  }
                  if (
                    isTransientToolReadProbeErrorForLiveModel(message) &&
                    shouldSkipToolNonceProbeMissForLiveModel(modelKey)
                  ) {
                    logProgress(`${progressLabel}: skip (${modelKey} transient tool-read result)`);
                    return "skip";
                  }
                  throw error;
                }
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
                    retryKnownNonceMismatch: retryKnownToolNonceMiss,
                  })
                ) {
                  logProgress(
                    `${progressLabel}: tool-read retry (${toolReadAttempt + 2}/${maxToolReadAttempts}) tool output mismatch`,
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
                // Timeout wrappers do not cancel late tool runs, so keep provider-key attempts
                // isolated without putting a nonce-shaped UUID in the model-visible path.
                const toolWritePath = path.join(
                  tempDir,
                  `write-model-${index + 1}-attempt-${attempt + 1}.txt`,
                );
                const maxExecReadAttempts = 3;
                const retryKnownExecReadNonceMiss =
                  shouldSkipExecReadNonceMissForLiveModel(modelKey) || retryKnownToolNonceMiss;
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
                        "Then reply with exactly the nonce text from that file. No extra text."
                      : "OpenClaw live tool probe (local, safe): " +
                        "use the tool named `exec` (or `Exec`) to run this command: " +
                        `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}". ` +
                        `Then use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolWritePath}"}. ` +
                        "Finally reply including the nonce text you read back.",
                    thinkingLevel,
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
                      retryKnownNonceMismatch: retryKnownExecReadNonceMiss,
                    })
                  ) {
                    logProgress(
                      `${progressLabel}: tool-exec retry (${execReadAttempt + 2}/${maxExecReadAttempts}) tool output mismatch`,
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
                  thinkingLevel,
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
                (model.provider === "openai" && model.api === "openai-chatgpt-responses")
              ) {
                logProgress(`${progressLabel}: tool-only regression`);
                const runId2 = randomUUID();
                const firstText = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-1`,
                  modelKey,
                  message: `Call the tool named \`read\` (or \`Read\`) on "${toolProbePath}". Do not write any other text.`,
                  thinkingLevel,
                  context: `${progressLabel}: tool-only-regression-first`,
                  assistantText: "optional",
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
                  thinkingLevel,
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
                  thinkingLevel,
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
          passedCount += 1;
          logProgress(`${progressLabel}: done`);
          break;
        } catch (err) {
          const message = String(err);
          if (
            model.provider === "anthropic" &&
            isLiveRateLimitDrift(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: rate limit, retrying with next key`);
            continue;
          }
          if (model.provider === "anthropic" && isLiveRateLimitDrift(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic rate limit)`);
            break;
          }
          if (model.provider === "anthropic" && isLiveBillingDrift(message)) {
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
          if (model.provider === "anthropic" && isAnthropicModelUnavailableDrift(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic model unavailable)`);
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
          if (isGoogleishProvider(model.provider) && isLiveRateLimitDrift(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (google rate limit)`);
            break;
          }
          const driftSkip = shouldSkipLiveProviderDrift({
            error: message,
            allowAuth: true,
            allowBilling: true,
            allowProviderUnavailable: true,
          });
          if (driftSkip) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (${driftSkip.label})`);
            break;
          }
          if (
            (model.provider === "minimax" ||
              model.provider === "opencode" ||
              model.provider === "opencode-go" ||
              model.provider === "zai") &&
            isLiveRateLimitDrift(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (rate limit)`);
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
            timeoutSkippedCount += 1;
            logProgress(`${progressLabel}: skip (probe timeout)`);
            break;
          }
          if (isGatewayLiveModelTimeout(message)) {
            skippedCount += 1;
            timeoutSkippedCount += 1;
            logProgress(`${progressLabel}: skip (model timeout)`);
            break;
          }
          // OpenAI Codex refresh tokens can become single-use; skip instead of failing all live tests.
          if (model.provider === "openai" && isRefreshTokenReused(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (codex refresh token reused)`);
            break;
          }
          if (model.provider === "openai" && isAccountIdExtractionError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (codex account id extraction)`);
            break;
          }
          if (model.provider === "openai" && isChatGPTUsageLimitErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (chatgpt usage limit)`);
            break;
          }
          if (model.provider === "openai" && isInstructionsRequiredError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (instructions required)`);
            break;
          }
          if (model.provider === "openai" && isOpenAIReasoningSequenceError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (openai reasoning sequence error)`);
            break;
          }
          if (model.provider === "openai" && isToolNonceRefusal(message)) {
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
            const probe = isExecReadNonceProbeMiss(message) ? "exec/read" : "tool-read";
            logProgress(`${progressLabel}: skip (${modelKey} ${probe} nonce miss)`);
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
    assertGatewayLiveCompletedSomeModels({
      label: params.label,
      passedCount,
      skippedCount,
      timeoutSkippedCount,
      total,
    });
  } finally {
    clearRuntimeConfigSnapshot();
    restoreProductionEnvForLiveRun(runtimeEnv);
    client?.stop();
    if (server) {
      await server.close({ reason: "live test complete" });
    }
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

    restoreOptionalEnv("OPENCLAW_CONFIG_PATH", previous.configPath);
    restoreOptionalEnv("OPENCLAW_GATEWAY_TOKEN", previous.token);
    restoreOptionalEnv("OPENCLAW_SKIP_CHANNELS", previous.skipChannels);
    restoreOptionalEnv("OPENCLAW_SKIP_GMAIL_WATCHER", previous.skipGmail);
    restoreOptionalEnv("OPENCLAW_SKIP_CRON", previous.skipCron);
    restoreOptionalEnv("OPENCLAW_SKIP_CANVAS_HOST", previous.skipCanvas);
    restoreOptionalEnv("OPENCLAW_DISABLE_BONJOUR", previous.disableBonjour);
    restoreOptionalEnv("OPENCLAW_LOG_LEVEL", previous.logLevel);
    restoreOptionalEnv("OPENCLAW_AGENT_DIR", previous.agentDir);
    restoreOptionalEnv("OPENCLAW_STATE_DIR", previous.stateDir);
  }
}

describeLive("gateway live (dev agent, profile keys)", () => {
  it(
    "runs meaningful prompts across models with available keys",
    async () =>
      await withSuppressedGatewayLiveWarnings(async () => {
        const providerList = providerFilterList();
        const providerLog = providerList?.join(",") ?? "all";
        logProgress(`[all-models] discover candidates providers=${providerLog}`);
        logProgress("[all-models] loading config");
        clearRuntimeConfigSnapshot();
        const cfg = await withGatewayLiveSetupTimeout(
          Promise.resolve().then(() => getRuntimeConfig()),
          "[all-models] load config",
        );
        const workspaceDir = resolveAgentWorkspaceDir(cfg, DEFAULT_AGENT_ID);
        logProgress("[all-models] preparing models.json");
        const modelsJsonResult = await withGatewayLiveSetupTimeout(
          ensureOpenClawModelsJson(cfg, undefined, {
            workspaceDir,
            ...(providerList ? { providerDiscoveryProviderIds: providerList } : {}),
          }),
          "[all-models] prepare models.json",
        );
        const agentDir = modelsJsonResult.agentDir;

        const rawModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS?.trim();
        const useModern = !rawModels || rawModels === "modern" || rawModels === "all";
        const useSmall = rawModels === "small";
        const useExplicit = Boolean(rawModels) && !useModern && !useSmall;
        const filter = useExplicit ? parseFilter(rawModels) : null;
        const providerScopedModelProviders = providerScopedModelRegistryProviders({
          providerList,
          useSmall,
          useExplicit,
          modelFilter: filter,
          providerFilter: PROVIDERS,
        });
        let authProfileStore: AuthProfileStore | undefined;
        let modelRegistry: LiveModelRegistry;
        let all: Array<Model>;
        if (providerScopedModelProviders) {
          logProgress("[all-models] loading provider-scoped model refs");
          all = await withGatewayLiveSetupTimeout(
            loadProviderScopedModels({ agentDir, providerList: providerScopedModelProviders }),
            "[all-models] load provider-scoped model refs",
          );
          if (all.length > 0) {
            modelRegistry = createStaticLiveModelRegistry(all);
          } else {
            logProgress("[all-models] provider-scoped model refs empty; loading auth profiles");
            const authBacked = await loadAuthBackedLiveModelRegistry({
              agentDir,
              cfg,
              providerList: providerScopedModelProviders,
            });
            authProfileStore = authBacked.authProfileStore;
            modelRegistry = authBacked.modelRegistry;
            all = authBacked.all;
          }
        } else {
          logProgress("[all-models] loading auth profiles");
          const authBacked = await loadAuthBackedLiveModelRegistry({ agentDir, cfg, providerList });
          authProfileStore = authBacked.authProfileStore;
          modelRegistry = authBacked.modelRegistry;
          all = authBacked.all;
        }
        const prioritizedRefs = resolvePrioritizedGatewayLiveModelRefs({
          providerFilter: PROVIDERS,
          useExplicit,
          useSmall,
        });
        if (prioritizedRefs.length > 0) {
          const augmented = await withGatewayLiveSetupTimeout(
            appendPrioritizedDynamicLiveModels({
              models: all,
              config: cfg,
              agentDir,
              workspaceDir,
              env: process.env,
              modelRegistry,
              refs: prioritizedRefs,
            }),
            `[all-models] load dynamic ${useSmall ? "small" : "high-signal"} model refs`,
          );
          if (augmented.added.length > 0) {
            logProgress(
              `[all-models] loaded ${augmented.added.length} prioritized dynamic ${useSmall ? "small" : "high-signal"} model refs`,
            );
            all = augmented.models;
            modelRegistry = createStaticLiveModelRegistry(all);
          }
        }
        const maxModels = GATEWAY_LIVE_MAX_MODELS;
        const targetMatcher = createLiveTargetMatcher({
          providerFilter: PROVIDERS,
          modelFilter: filter,
          config: cfg,
          env: process.env,
        });
        let wanted = useExplicit
          ? resolveExplicitLiveModelCandidates({
              modelRegistry,
              modelFilter: filter,
              providerFilter: PROVIDERS,
              targetMatcher,
            })
          : null;
        if (!wanted) {
          wanted = filter
            ? all.filter((m) => targetMatcher.matchesModel(m.provider, m.id))
            : useSmall
              ? all.filter((m) => isWantedSmallGatewayLiveModel({ model: m, targetMatcher }))
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
        }
        logProgress(`[all-models] wanted=${wanted.length} total=${all.length}`);
        assertGatewayLiveSelectedSomeModels({
          allowProviderDriftSkip: useModern || useSmall,
          label: "all-models",
          modelFilter: filter,
          providerFilter: PROVIDERS,
          total: all.length,
          useSmall,
          useExplicit,
          wantedCount: wanted.length,
        });

        const candidates: Array<Model> = [];
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
            const apiKeyInfo = await withGatewayLiveSetupTimeout(
              getApiKeyForModel({
                model,
                cfg,
                store: authProfileStore,
                agentDir,
                workspaceDir,
                credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
              }),
              `[all-models] auth ${modelRef}`,
              GATEWAY_LIVE_PROBE_TIMEOUT_MS,
            );
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
        logProgress(`[all-models] candidates=${candidates.length} skipped=${skipped.length}`);

        if (candidates.length === 0) {
          if (skipped.length > 0) {
            logProgress(
              `[all-models] auth lookup skipped candidates:\n${formatFailurePreview(skipped, 8)}`,
            );
          }
        }
        assertGatewayLiveHasRunnableCandidates({
          candidatesCount: candidates.length,
          label: "all-models",
          skipped,
        });
        const selectCandidates = useSmall ? selectSmallLiveItems : selectHighSignalLiveItems;
        const selectedCandidates = selectCandidates(
          candidates,
          maxModels > 0 ? maxModels : candidates.length,
          (model) => ({ provider: model.provider, id: model.id }),
          (model) => model.provider,
        );
        logProgress(
          `[all-models] selection=${useExplicit ? "explicit" : useSmall ? "small" : "high-signal"}`,
        );
        if (selectedCandidates.length < candidates.length) {
          logProgress(
            `[all-models] capped to ${selectedCandidates.length}/${candidates.length} via OPENCLAW_LIVE_GATEWAY_MAX_MODELS=${maxModels}`,
          );
        }
        expect(selectedCandidates.length).toBeGreaterThan(0);
        const imageCandidates = selectedCandidates.filter((m) => m.input?.includes("image"));
        if (imageCandidates.length === 0) {
          logProgress("[all-models] no image-capable models selected; image probe will be skipped");
        }
        await runGatewayModelSuite({
          label: "all-models",
          cfg,
          candidates: selectedCandidates,
          allowNotFoundSkip: useModern || useSmall,
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
      agentDir: process.env.OPENCLAW_AGENT_DIR,
      stateDir: process.env.OPENCLAW_STATE_DIR,
    };

    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";

    const token = `test-${randomUUID()}`;
    process.env.OPENCLAW_GATEWAY_TOKEN = token;

    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let client: GatewayClient | undefined;
    let toolProbePath: string | undefined;
    let tempDir: string | undefined;
    let tempStateDir: string | undefined;
    try {
      const cfg = getRuntimeConfig();
      await ensureOpenClawModelsJson(cfg);

      const agentDir = resolveDefaultAgentDir(cfg);
      const hostStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
      });
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const anthropic = modelRegistry.find("anthropic", "claude-opus-4-6") as Model | null;
      const zai = modelRegistry.find("zai", "glm-5.1") as Model | null;

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

      const agentId = GATEWAY_LIVE_AGENT_ID;
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-zai-state-"));
      setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
      const workspaceDir = path.join(tempStateDir, "workspace-dev");
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
      const nonceA = randomUUID();
      const nonceB = randomUUID();
      // Match the broad probe: the filename must not reveal either expected value.
      toolProbePath = path.join(workspaceDir, ".openclaw-live-zai-fallback.txt");
      await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

      const sanitizedStore = sanitizeAuthProfileStoreForLiveGateway({
        version: hostStore.version,
        profiles: { ...hostStore.profiles },
        order: hostStore.order ? { ...hostStore.order } : undefined,
        lastGood: hostStore.lastGood ? { ...hostStore.lastGood } : undefined,
        usageStats: hostStore.usageStats ? { ...hostStore.usageStats } : undefined,
      });
      const tempAgentDir = path.join(tempStateDir, "agents", agentId, "agent");
      saveAuthProfileStore(sanitizedStore, tempAgentDir);
      setTestEnvValue("OPENCLAW_AGENT_DIR", tempAgentDir);

      const sanitizedCfg: OpenClawConfig = {
        ...cfg,
        auth: await sanitizeAuthConfig({ cfg, agentDir }),
      };
      const nextCfg = buildLiveGatewayConfig({
        cfg: sanitizedCfg,
        candidates: [anthropic, zai],
        liveAgentDir: tempAgentDir,
        liveAgentWorkspaceDir: workspaceDir,
      });
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-zai-"));
      const tempConfigPath = path.join(tempDir, "openclaw.json");
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", tempConfigPath);
      clearRuntimeConfigSnapshot();

      const liveProviders = nextCfg.models?.providers;
      if (liveProviders && Object.keys(liveProviders).length > 0) {
        await fs.mkdir(tempAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(tempAgentDir, "models.json"),
          `${JSON.stringify({ providers: liveProviders }, null, 2)}\n`,
        );
      }

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
          failGatewayLiveStartupCoverage({ label: "zai-fallback", reason: message });
        }
        throw error;
      }

      if (!server || !client) {
        failGatewayLiveStartupCoverage({
          label: "zai-fallback",
          reason: "gateway server/client did not initialize",
        });
      }

      const sessionKey = `agent:${agentId}:live-zai-fallback`;

      await withGatewayLiveSessionControlTimeout(
        client.request("sessions.patch", {
          key: sessionKey,
          model: "anthropic/claude-opus-4-6",
        }),
        "zai-fallback: sessions-patch-anthropic",
      );
      await withGatewayLiveSessionControlTimeout(
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

      await withGatewayLiveSessionControlTimeout(
        client.request("sessions.patch", {
          key: sessionKey,
          model: "zai/glm-5.1",
        }),
        "zai-fallback: sessions-patch-zai",
      );

      const followupText = await requestGatewayAgentText({
        client,
        sessionKey,
        idempotencyKey: `idem-${randomUUID()}-followup`,
        modelKey: "zai/glm-5.1",
        message:
          `What are the values of nonceA and nonceB in "${toolProbePath}"? ` +
          `Reply with exactly: ${nonceA} ${nonceB}.`,
        thinkingLevel: THINKING_LEVEL,
        context: "zai-fallback: followup",
      });
      assertNoReasoningTags({
        text: followupText,
        model: "zai/glm-5.1",
        phase: "zai-fallback-followup",
        label: "zai-fallback",
      });
      if (!followupText.includes(nonceA) || !followupText.includes(nonceB)) {
        throw new Error(`zai followup missing nonce: ${followupText}`);
      }
    } finally {
      clearRuntimeConfigSnapshot();
      restoreProductionEnvForLiveRun(runtimeEnv);
      client?.stop();
      if (server) {
        await server.close({ reason: "live test complete" });
      }
      if (toolProbePath) {
        await fs.rm(toolProbePath, { force: true });
      }
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
      if (tempStateDir) {
        await fs.rm(tempStateDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      }

      restoreOptionalEnv("OPENCLAW_CONFIG_PATH", previous.configPath);
      restoreOptionalEnv("OPENCLAW_GATEWAY_TOKEN", previous.token);
      restoreOptionalEnv("OPENCLAW_SKIP_CHANNELS", previous.skipChannels);
      restoreOptionalEnv("OPENCLAW_SKIP_GMAIL_WATCHER", previous.skipGmail);
      restoreOptionalEnv("OPENCLAW_SKIP_CRON", previous.skipCron);
      restoreOptionalEnv("OPENCLAW_SKIP_CANVAS_HOST", previous.skipCanvas);
      restoreOptionalEnv("OPENCLAW_AGENT_DIR", previous.agentDir);
      restoreOptionalEnv("OPENCLAW_STATE_DIR", previous.stateDir);
    }
  }, 180_000);
});
