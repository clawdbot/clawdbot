import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
} from "@mariozechner/pi-ai";
import {
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import type {
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../auto-reply/thinking.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { isCacheEnabled, resolveCacheTtlMs } from "../config/cache-utils.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveProviderCapabilities } from "../config/provider-capabilities.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { createSubsystemLogger } from "../logging.js";
import {
  type enqueueCommand,
  enqueueCommandInLane,
} from "../process/command-queue.js";
import { normalizeMessageProvider } from "../utils/message-provider.js";
import { resolveUserPath } from "../utils.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import {
  markAuthProfileFailure,
  markAuthProfileGood,
  markAuthProfileUsed,
} from "./auth-profiles.js";
import type { BashElevatedDefaults } from "./bash-tools.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "./context-window-guard.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "./defaults.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import {
  ensureAuthProfileStore,
  getApiKeyForModel,
  resolveAuthProfileOrder,
  resolveModelAuthMode,
} from "./model-auth.js";
import { normalizeModelCompat } from "./model-compat.js";
import { ensureClawdbotModelsJson } from "./models-config.js";
import type { MessagingToolSend } from "./pi-embedded-messaging.js";
import { ensurePiCompactionReserveTokens } from "./pi-settings.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

export type { MessagingToolSend } from "./pi-embedded-messaging.js";

import {
  buildBootstrapContextFiles,
  classifyFailoverReason,
  type EmbeddedContextFile,
  ensureSessionHeader,
  formatAssistantErrorText,
  isAuthAssistantError,
  isCloudCodeAssistFormatError,
  isContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isGoogleModelApi,
  isRateLimitAssistantError,
  isTimeoutErrorMessage,
  pickFallbackThinkingLevel,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
  validateGeminiTurns,
} from "./pi-embedded-helpers.js";
import {
  type BlockReplyChunking,
  subscribeEmbeddedPiSession,
} from "./pi-embedded-subscribe.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  formatReasoningMessage,
} from "./pi-embedded-utils.js";
import { setContextPruningRuntime } from "./pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "./pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "./pi-extensions/context-pruning/tools.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { createClawdbotCodingTools } from "./pi-tools.js";
import { resolveSandboxContext } from "./sandbox.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
  type SkillSnapshot,
} from "./skills.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { buildToolSummaryMap } from "./tool-summaries.js";
import { normalizeUsage, type UsageLike } from "./usage.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

// Optional features can be implemented as Pi extensions that run in the same Node process.

/**
 * Resolve provider-specific extraParams from model config.
 * Auto-enables thinking mode for GLM-4.x models unless explicitly disabled.
 *
 * For ZAI GLM-4.x models, we auto-enable thinking via the Z.AI Cloud API format:
 *   thinking: { type: "enabled", clear_thinking: boolean }
 *
 * - GLM-4.7: Preserved thinking (clear_thinking: false) - reasoning kept across turns
 * - GLM-4.5/4.6: Interleaved thinking (clear_thinking: true) - reasoning cleared each turn
 *
 * Users can override via config:
 *   agents.defaults.models["zai/glm-4.7"].params.thinking = { type: "disabled" }
 *
 * Or disable via runtime flag: --thinking off
 *
 * @see https://docs.z.ai/guides/capabilities/thinking-mode
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: ClawdbotConfig | undefined;
  provider: string;
  modelId: string;
  thinkLevel?: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  let extraParams = modelConfig?.params ? { ...modelConfig.params } : undefined;

  // Auto-enable thinking for ZAI GLM-4.x models when not explicitly configured
  // Skip if user explicitly disabled thinking via --thinking off
  if (params.provider === "zai" && params.thinkLevel !== "off") {
    const modelIdLower = params.modelId.toLowerCase();
    const isGlm4 = modelIdLower.includes("glm-4");

    if (isGlm4) {
      // Check if user has explicitly configured thinking params
      const hasThinkingConfig = extraParams?.thinking !== undefined;

      if (!hasThinkingConfig) {
        // GLM-4.7 supports preserved thinking (reasoning kept across turns)
        // GLM-4.5/4.6 use interleaved thinking (reasoning cleared each turn)
        // Z.AI Cloud API format: thinking: { type: "enabled", clear_thinking: boolean }
        const isGlm47 = modelIdLower.includes("glm-4.7");
        const clearThinking = !isGlm47;

        extraParams = {
          ...extraParams,
          thinking: {
            type: "enabled",
            clear_thinking: clearThinking,
          },
        };

        log.debug(
          `auto-enabled thinking for ${modelKey}: type=enabled, clear_thinking=${clearThinking}`,
        );
      }
    }
  }

  return extraParams;
}

// We configure context pruning per-session via a WeakMap registry keyed by the SessionManager instance.

function resolvePiExtensionPath(id: string): string {
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  // In dev this file is `.ts` (tsx), in production it's `.js`.
  const ext = path.extname(self) === ".ts" ? "ts" : "js";
  return path.join(dir, "pi-extensions", `${id}.${ext}`);
}

function resolveContextWindowTokens(params: {
  cfg: ClawdbotConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningExtension(params: {
  cfg: ClawdbotConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): { additionalExtensionPaths?: string[] } {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "adaptive" && raw?.mode !== "aggressive") return {};

  const settings = computeEffectiveSettings(raw);
  if (!settings) return {};

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
  });

  return {
    additionalExtensionPaths: [resolvePiExtensionPath("context-pruning")],
  };
}

function buildEmbeddedExtensionPaths(params: {
  cfg: ClawdbotConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): string[] {
  const paths = [resolvePiExtensionPath("transcript-sanitize")];
  const pruning = buildContextPruningExtension(params);
  if (pruning.additionalExtensionPaths) {
    paths.push(...pruning.additionalExtensionPaths);
  }
  return paths;
}

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
};

function buildModelAliasLines(cfg?: ClawdbotConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) continue;
    const alias = String(
      (entryRaw as { alias?: string } | undefined)?.alias ?? "",
    ).trim();
    if (!alias) continue;
    entries.push({ alias, model });
  }
  return entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

type ApiKeyInfo = {
  apiKey: string;
  profileId?: string;
  source: string;
};

export type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
  }>;
  meta: EmbeddedPiRunMeta;
  // True if a messaging tool (telegram, whatsapp, discord, slack, sessions_send)
  // successfully sent a message. Used to suppress agent's confirmation text.
  didSendViaMessagingTool?: boolean;
  // Texts successfully sent via messaging tools during the run.
  messagingToolSentTexts?: string[];
  // Messaging tool targets that successfully sent a message during the run.
  messagingToolSentTargets?: MessagingToolSend[];
};

export type EmbeddedPiCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  };
};

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

const log = createSubsystemLogger("agent/embedded");
const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";

type CustomEntryLike = { type?: unknown; customType?: unknown };

function hasGoogleTurnOrderingMarker(sessionManager: SessionManager): boolean {
  try {
    return sessionManager
      .getEntries()
      .some(
        (entry) =>
          (entry as CustomEntryLike)?.type === "custom" &&
          (entry as CustomEntryLike)?.customType ===
            GOOGLE_TURN_ORDERING_CUSTOM_TYPE,
      );
  } catch {
    return false;
  }
}

function markGoogleTurnOrderingMarker(sessionManager: SessionManager): void {
  try {
    sessionManager.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
      timestamp: Date.now(),
    });
  } catch {
    // ignore marker persistence failures
  }
}

export function applyGoogleTurnOrderingFix(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  sessionManager: SessionManager;
  sessionId: string;
  warn?: (message: string) => void;
}): { messages: AgentMessage[]; didPrepend: boolean } {
  if (!isGoogleModelApi(params.modelApi)) {
    return { messages: params.messages, didPrepend: false };
  }
  const first = params.messages[0] as
    | { role?: unknown; content?: unknown }
    | undefined;
  if (first?.role !== "assistant") {
    return { messages: params.messages, didPrepend: false };
  }
  const sanitized = sanitizeGoogleTurnOrdering(params.messages);
  const didPrepend = sanitized !== params.messages;
  if (didPrepend && !hasGoogleTurnOrderingMarker(params.sessionManager)) {
    const warn = params.warn ?? ((message: string) => log.warn(message));
    warn(
      `google turn ordering fixup: prepended user bootstrap (sessionId=${params.sessionId})`,
    );
    markGoogleTurnOrderingMarker(params.sessionManager);
  }
  return { messages: sanitized, didPrepend };
}

async function sanitizeSessionHistory(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  sessionManager: SessionManager;
  sessionId: string;
}): Promise<AgentMessage[]> {
  const sanitizedImages = await sanitizeSessionMessagesImages(
    params.messages,
    "session:history",
    {
      sanitizeToolCallIds: isGoogleModelApi(params.modelApi),
      enforceToolCallLast: params.modelApi === "anthropic-messages",
    },
  );
  const repairedTools = sanitizeToolUseResultPairing(sanitizedImages);
  return applyGoogleTurnOrderingFix({
    messages: repairedTools,
    modelApi: params.modelApi,
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
  }).messages;
}

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();
type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();

// ============================================================================
// SessionManager Pre-warming Cache
// ============================================================================

type SessionManagerCacheEntry = {
  sessionFile: string;
  loadedAt: number;
};

const SESSION_MANAGER_CACHE = new Map<string, SessionManagerCacheEntry>();
const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000; // 45 seconds

function getSessionManagerTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.CLAWDBOT_SESSION_MANAGER_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS,
  });
}

function isSessionManagerCacheEnabled(): boolean {
  return isCacheEnabled(getSessionManagerTtl());
}

function trackSessionManagerAccess(sessionFile: string): void {
  if (!isSessionManagerCacheEnabled()) return;
  const now = Date.now();
  SESSION_MANAGER_CACHE.set(sessionFile, {
    sessionFile,
    loadedAt: now,
  });
}

function isSessionManagerCached(sessionFile: string): boolean {
  if (!isSessionManagerCacheEnabled()) return false;
  const entry = SESSION_MANAGER_CACHE.get(sessionFile);
  if (!entry) return false;
  const now = Date.now();
  const ttl = getSessionManagerTtl();
  return now - entry.loadedAt <= ttl;
}

async function prewarmSessionFile(sessionFile: string): Promise<void> {
  if (!isSessionManagerCacheEnabled()) return;
  if (isSessionManagerCached(sessionFile)) return;

  try {
    // Read a small chunk to encourage OS page cache warmup.
    const handle = await fs.open(sessionFile, "r");
    try {
      const buffer = Buffer.alloc(4096);
      await handle.read(buffer, 0, buffer.length, 0);
    } finally {
      await handle.close();
    }
    trackSessionManagerAccess(sessionFile);
  } catch {
    // File doesn't exist yet, SessionManager will create it
  }
}

const isAbortError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  if (name === "AbortError") return true;
  const message =
    "message" in err && typeof err.message === "string"
      ? err.message.toLowerCase()
      : "";
  return message.includes("aborted");
};

type EmbeddedSandboxInfo = {
  enabled: boolean;
  workspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  agentWorkspaceMount?: string;
  browserControlUrl?: string;
  browserNoVncUrl?: string;
  hostBrowserAllowed?: boolean;
  allowedControlUrls?: string[];
  allowedControlHosts?: string[];
  allowedControlPorts?: number[];
  elevated?: {
    allowed: boolean;
    defaultLevel: "on" | "off";
  };
};

function resolveSessionLane(key: string) {
  const cleaned = key.trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : "main";
}

function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(
        new Date(),
      );
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
}

function formatUserTime(date: Date, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (
      !map.weekday ||
      !map.year ||
      !map.month ||
      !map.day ||
      !map.hour ||
      !map.minute
    ) {
      return undefined;
    }
    return `${map.weekday} ${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
  } catch {
    return undefined;
  }
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
  bashElevated?: BashElevatedDefaults,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) return undefined;
  const elevatedAllowed = Boolean(
    bashElevated?.enabled && bashElevated.allowed,
  );
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    workspaceAccess: sandbox.workspaceAccess,
    agentWorkspaceMount:
      sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
    browserControlUrl: sandbox.browser?.controlUrl,
    browserNoVncUrl: sandbox.browser?.noVncUrl,
    hostBrowserAllowed: sandbox.browserAllowHostControl,
    allowedControlUrls: sandbox.browserAllowedControlUrls,
    allowedControlHosts: sandbox.browserAllowedControlHosts,
    allowedControlPorts: sandbox.browserAllowedControlPorts,
    ...(elevatedAllowed
      ? {
          elevated: {
            allowed: true,
            defaultLevel: bashElevated?.defaultLevel ?? "off",
          },
        }
      : {}),
  };
}

function buildEmbeddedSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint: boolean;
  heartbeatPrompt?: string;
  skillsPrompt?: string;
  runtimeInfo: {
    host: string;
    os: string;
    arch: string;
    node: string;
    model: string;
    provider?: string;
    capabilities?: string[];
  };
  sandboxInfo?: EmbeddedSandboxInfo;
  tools: AgentTool[];
  modelAliasLines: string[];
  userTimezone: string;
  userTime?: string;
  contextFiles?: EmbeddedContextFile[];
}): string {
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    reasoningLevel: params.reasoningLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: params.reasoningTagHint,
    heartbeatPrompt: params.heartbeatPrompt,
    skillsPrompt: params.skillsPrompt,
    runtimeInfo: params.runtimeInfo,
    sandboxInfo: params.sandboxInfo,
    toolNames: params.tools.map((tool) => tool.name),
    toolSummaries: buildToolSummaryMap(params.tools),
    modelAliasLines: params.modelAliasLines,
    userTimezone: params.userTimezone,
    userTime: params.userTime,
    contextFiles: params.contextFiles,
  });
}

export function createSystemPromptOverride(
  systemPrompt: string,
): (defaultPrompt: string) => string {
  const trimmed = systemPrompt.trim();
  return () => trimmed;
}

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.

type AnyAgentTool = AgentTool;

export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
}): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  // Always pass all tools as customTools so the SDK doesn't "helpfully" swap in
  // its own built-in implementations (we need our tool wrappers + policy).
  const { tools } = options;
  return {
    builtInTools: [],
    customTools: toToolDefinitions(tools),
  };
}

export function queueEmbeddedPiMessage(
  sessionId: string,
  text: string,
): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  if (!handle.isStreaming()) return false;
  if (handle.isCompacting()) return false;
  void handle.queueMessage(text);
  return true;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  handle.abort();
  return true;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  return ACTIVE_EMBEDDED_RUNS.has(sessionId);
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  return handle.isStreaming();
}

export function waitForEmbeddedPiRunEnd(
  sessionId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId))
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) EMBEDDED_RUN_WAITERS.delete(sessionId);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) EMBEDDED_RUN_WAITERS.delete(sessionId);
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) return;
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}

function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh" too; Clawdbot doesn't surface it for now.
  if (!level) return "off";
  return level;
}

function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: ReturnType<typeof discoverAuthStorage>;
  modelRegistry: ReturnType<typeof discoverModels>;
} {
  const resolvedAgentDir = agentDir ?? resolveClawdbotAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
  if (!model) {
    return {
      error: `Unknown model: ${provider}/${modelId}`,
      authStorage,
      modelRegistry,
    };
  }
  return { model: normalizeModelCompat(model), authStorage, modelRegistry };
}

export async function compactEmbeddedPiSession(params: {
  sessionId: string;
  sessionKey?: string;
  messageProvider?: string;
  agentAccountId?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: ClawdbotConfig;
  skillsSnapshot?: SkillSnapshot;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: BashElevatedDefaults;
  customInstructions?: string;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
}): Promise<EmbeddedPiCompactResult> {
  const sessionLane = resolveSessionLane(
    params.sessionKey?.trim() || params.sessionId,
  );
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ??
    ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider =
        (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveClawdbotAgentDir();
      await ensureClawdbotModelsJson(params.config, agentDir);
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
      );
      if (!model) {
        return {
          ok: false,
          compacted: false,
          reason: error ?? `Unknown model: ${provider}/${modelId}`,
        };
      }
      try {
        const apiKeyInfo = await getApiKeyForModel({
          model,
          cfg: params.config,
        });
        authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
      } catch (err) {
        return {
          ok: false,
          compacted: false,
          reason: describeUnknownError(err),
        };
      }

      await fs.mkdir(resolvedWorkspace, { recursive: true });
      const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
      const sandbox = await resolveSandboxContext({
        config: params.config,
        sessionKey: sandboxSessionKey,
        workspaceDir: resolvedWorkspace,
      });
      const effectiveWorkspace = sandbox?.enabled
        ? sandbox.workspaceAccess === "rw"
          ? resolvedWorkspace
          : sandbox.workspaceDir
        : resolvedWorkspace;
      await fs.mkdir(effectiveWorkspace, { recursive: true });
      await ensureSessionHeader({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      let restoreSkillEnv: (() => void) | undefined;
      process.chdir(effectiveWorkspace);
      try {
        const shouldLoadSkillEntries =
          !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
        const skillEntries = shouldLoadSkillEntries
          ? loadWorkspaceSkillEntries(effectiveWorkspace)
          : [];
        restoreSkillEnv = params.skillsSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: params.skillsSnapshot,
              config: params.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries ?? [],
              config: params.config,
            });
        const skillsPrompt = resolveSkillsPromptForRun({
          skillsSnapshot: params.skillsSnapshot,
          entries: shouldLoadSkillEntries ? skillEntries : undefined,
          config: params.config,
          workspaceDir: effectiveWorkspace,
        });

        const bootstrapFiles = filterBootstrapFilesForSession(
          await loadWorkspaceBootstrapFiles(effectiveWorkspace),
          params.sessionKey ?? params.sessionId,
        );
        const contextFiles = buildBootstrapContextFiles(bootstrapFiles);
        const runAbortController = new AbortController();
        const tools = createClawdbotCodingTools({
          bash: {
            ...params.config?.tools?.bash,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageProvider,
          agentAccountId: params.agentAccountId,
          sessionKey: params.sessionKey ?? params.sessionId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          config: params.config,
          abortSignal: runAbortController.signal,
          modelProvider: model.provider,
          modelAuthMode: resolveModelAuthMode(model.provider, params.config),
          // No currentChannelId/currentThreadTs for compaction - not in message context
        });
        const machineName = await getMachineDisplayName();
        const runtimeProvider = normalizeMessageProvider(
          params.messageProvider,
        );
        const runtimeCapabilities = runtimeProvider
          ? (resolveProviderCapabilities({
              cfg: params.config,
              provider: runtimeProvider,
              accountId: params.agentAccountId,
            }) ?? [])
          : undefined;
        const runtimeInfo = {
          host: machineName,
          os: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          node: process.version,
          model: `${provider}/${modelId}`,
          provider: runtimeProvider,
          capabilities: runtimeCapabilities,
        };
        const sandboxInfo = buildEmbeddedSandboxInfo(
          sandbox,
          params.bashElevated,
        );
        const reasoningTagHint = provider === "ollama";
        const userTimezone = resolveUserTimezone(
          params.config?.agents?.defaults?.userTimezone,
        );
        const userTime = formatUserTime(new Date(), userTimezone);
        // Only include heartbeat prompt for the default agent
        const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
          sessionKey: params.sessionKey,
          config: params.config,
        });
        const isDefaultAgent = sessionAgentId === defaultAgentId;
        const appendPrompt = buildEmbeddedSystemPrompt({
          workspaceDir: effectiveWorkspace,
          defaultThinkLevel: params.thinkLevel,
          reasoningLevel: params.reasoningLevel ?? "off",
          extraSystemPrompt: params.extraSystemPrompt,
          ownerNumbers: params.ownerNumbers,
          reasoningTagHint,
          heartbeatPrompt: isDefaultAgent
            ? resolveHeartbeatPrompt(
                params.config?.agents?.defaults?.heartbeat?.prompt,
              )
            : undefined,
          skillsPrompt,
          runtimeInfo,
          sandboxInfo,
          tools,
          modelAliasLines: buildModelAliasLines(params.config),
          userTimezone,
          userTime,
          contextFiles,
        });
        const systemPrompt = createSystemPromptOverride(appendPrompt);

        const sessionLock = await acquireSessionWriteLock({
          sessionFile: params.sessionFile,
        });
        try {
          // Pre-warm session file to bring it into OS page cache
          await prewarmSessionFile(params.sessionFile);
          const sessionManager = SessionManager.open(params.sessionFile);
          trackSessionManagerAccess(params.sessionFile);
          const settingsManager = SettingsManager.create(
            effectiveWorkspace,
            agentDir,
          );
          ensurePiCompactionReserveTokens({ settingsManager });
          const additionalExtensionPaths = buildEmbeddedExtensionPaths({
            cfg: params.config,
            sessionManager,
            provider,
            modelId,
            model,
          });

          const { builtInTools, customTools } = splitSdkTools({
            tools,
            sandboxEnabled: !!sandbox?.enabled,
          });

          let session: Awaited<
            ReturnType<typeof createAgentSession>
          >["session"];
          ({ session } = await createAgentSession({
            cwd: resolvedWorkspace,
            agentDir,
            authStorage,
            modelRegistry,
            model,
            thinkingLevel: mapThinkingLevel(params.thinkLevel),
            systemPrompt,
            tools: builtInTools,
            customTools,
            sessionManager,
            settingsManager,
            skills: [],
            contextFiles: [],
            additionalExtensionPaths,
          }));

          try {
            const prior = await sanitizeSessionHistory({
              messages: session.messages,
              modelApi: model.api,
              sessionManager,
              sessionId: params.sessionId,
            });
            const validated = validateGeminiTurns(prior);
            if (validated.length > 0) {
              session.agent.replaceMessages(validated);
            }
            const result = await session.compact(params.customInstructions);
            return {
              ok: true,
              compacted: true,
              result: {
                summary: result.summary,
                firstKeptEntryId: result.firstKeptEntryId,
                tokensBefore: result.tokensBefore,
                details: result.details,
              },
            };
          } finally {
            session.dispose();
          }
        } finally {
          await sessionLock.release();
        }
      } catch (err) {
        return {
          ok: false,
          compacted: false,
          reason: describeUnknownError(err),
        };
      } finally {
        restoreSkillEnv?.();
        process.chdir(prevCwd);
      }
    }),
  );
}

export async function runEmbeddedPiAgent(params: {
  sessionId: string;
  sessionKey?: string;
  messageProvider?: string;
  agentAccountId?: string;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: ClawdbotConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  /** Optional image attachments for multimodal messages. */
  images?: ImageContent[];
  provider?: string;
  model?: string;
  authProfileId?: string;
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: BashElevatedDefaults;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  shouldEmitToolResult?: () => boolean;
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
  }) => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onReasoningStream?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
}): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(
    params.sessionKey?.trim() || params.sessionId,
  );
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ??
    ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const runAbortController = new AbortController();
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      const started = Date.now();
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider =
        (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveClawdbotAgentDir();
      await ensureClawdbotModelsJson(params.config, agentDir);
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
      );
      if (!model) {
        throw new Error(error ?? `Unknown model: ${provider}/${modelId}`);
      }

      const ctxInfo = resolveContextWindowInfo({
        cfg: params.config,
        provider,
        modelId,
        modelContextWindow: model.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      });
      const ctxGuard = evaluateContextWindowGuard({
        info: ctxInfo,
        warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
        hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      });
      if (ctxGuard.shouldWarn) {
        log.warn(
          `low context window: ${provider}/${modelId} ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
        );
      }
      if (ctxGuard.shouldBlock) {
        log.error(
          `blocked model (context window too small): ${provider}/${modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}`,
        );
        throw new FailoverError(
          `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
          { reason: "unknown", provider, model: modelId },
        );
      }
      const authStore = ensureAuthProfileStore(agentDir);
      const explicitProfileId = params.authProfileId?.trim();
      const profileOrder = resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider,
        preferredProfile: explicitProfileId,
      });
      if (explicitProfileId && !profileOrder.includes(explicitProfileId)) {
        throw new Error(
          `Auth profile "${explicitProfileId}" is not configured for ${provider}.`,
        );
      }
      const profileCandidates =
        profileOrder.length > 0 ? profileOrder : [undefined];
      let profileIndex = 0;
      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;

      const resolveApiKeyForCandidate = async (candidate?: string) => {
        return getApiKeyForModel({
          model,
          cfg: params.config,
          profileId: candidate,
          store: authStore,
        });
      };

      const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
        apiKeyInfo = await resolveApiKeyForCandidate(candidate);
        authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        lastProfileId = apiKeyInfo.profileId;
      };

      const advanceAuthProfile = async (): Promise<boolean> => {
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          try {
            await applyApiKeyInfo(candidate);
            profileIndex = nextIndex;
            thinkLevel = initialThinkLevel;
            attemptedThinking.clear();
            return true;
          } catch (err) {
            if (candidate && candidate === explicitProfileId) throw err;
            nextIndex += 1;
          }
        }
        return false;
      };

      try {
        await applyApiKeyInfo(profileCandidates[profileIndex]);
      } catch (err) {
        if (profileCandidates[profileIndex] === explicitProfileId) throw err;
        const advanced = await advanceAuthProfile();
        if (!advanced) throw err;
      }

      while (true) {
        const thinkingLevel = mapThinkingLevel(thinkLevel);
        attemptedThinking.add(thinkLevel);

        log.debug(
          `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${provider} model=${modelId} thinking=${thinkLevel} messageProvider=${params.messageProvider ?? "unknown"}`,
        );

        await fs.mkdir(resolvedWorkspace, { recursive: true });
        const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
        const sandbox = await resolveSandboxContext({
          config: params.config,
          sessionKey: sandboxSessionKey,
          workspaceDir: resolvedWorkspace,
        });
        const effectiveWorkspace = sandbox?.enabled
          ? sandbox.workspaceAccess === "rw"
            ? resolvedWorkspace
            : sandbox.workspaceDir
          : resolvedWorkspace;
        await fs.mkdir(effectiveWorkspace, { recursive: true });
        await ensureSessionHeader({
          sessionFile: params.sessionFile,
          sessionId: params.sessionId,
          cwd: effectiveWorkspace,
        });

        let restoreSkillEnv: (() => void) | undefined;
        process.chdir(effectiveWorkspace);
        try {
          const shouldLoadSkillEntries =
            !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
          const skillEntries = shouldLoadSkillEntries
            ? loadWorkspaceSkillEntries(effectiveWorkspace)
            : [];
          restoreSkillEnv = params.skillsSnapshot
            ? applySkillEnvOverridesFromSnapshot({
                snapshot: params.skillsSnapshot,
                config: params.config,
              })
            : applySkillEnvOverrides({
                skills: skillEntries ?? [],
                config: params.config,
              });
          const skillsPrompt = resolveSkillsPromptForRun({
            skillsSnapshot: params.skillsSnapshot,
            entries: shouldLoadSkillEntries ? skillEntries : undefined,
            config: params.config,
            workspaceDir: effectiveWorkspace,
          });

          const bootstrapFiles = filterBootstrapFilesForSession(
            await loadWorkspaceBootstrapFiles(effectiveWorkspace),
            params.sessionKey ?? params.sessionId,
          );
          const contextFiles = buildBootstrapContextFiles(bootstrapFiles);
          // Tool schemas must be provider-compatible (OpenAI requires top-level `type: "object"`).
          // `createClawdbotCodingTools()` normalizes schemas so the session can pass them through unchanged.
          const tools = createClawdbotCodingTools({
            bash: {
              ...params.config?.tools?.bash,
              elevated: params.bashElevated,
            },
            sandbox,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            sessionKey: params.sessionKey ?? params.sessionId,
            agentDir,
            workspaceDir: effectiveWorkspace,
            config: params.config,
            abortSignal: runAbortController.signal,
            modelProvider: model.provider,
            modelAuthMode: resolveModelAuthMode(model.provider, params.config),
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
          });
          const machineName = await getMachineDisplayName();
          const runtimeInfo = {
            host: machineName,
            os: `${os.type()} ${os.release()}`,
            arch: os.arch(),
            node: process.version,
            model: `${provider}/${modelId}`,
          };
          const sandboxInfo = buildEmbeddedSandboxInfo(
            sandbox,
            params.bashElevated,
          );
          const reasoningTagHint = provider === "ollama";
          const userTimezone = resolveUserTimezone(
            params.config?.agents?.defaults?.userTimezone,
          );
          const userTime = formatUserTime(new Date(), userTimezone);
          // Only include heartbeat prompt for the default agent
          const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
            sessionKey: params.sessionKey,
            config: params.config,
          });
          const isDefaultAgent = sessionAgentId === defaultAgentId;
          const appendPrompt = buildEmbeddedSystemPrompt({
            workspaceDir: effectiveWorkspace,
            defaultThinkLevel: thinkLevel,
            reasoningLevel: params.reasoningLevel ?? "off",
            extraSystemPrompt: params.extraSystemPrompt,
            ownerNumbers: params.ownerNumbers,
            reasoningTagHint,
            heartbeatPrompt: isDefaultAgent
              ? resolveHeartbeatPrompt(
                  params.config?.agents?.defaults?.heartbeat?.prompt,
                )
              : undefined,
            skillsPrompt,
            runtimeInfo,
            sandboxInfo,
            tools,
            modelAliasLines: buildModelAliasLines(params.config),
            userTimezone,
            userTime,
            contextFiles,
          });
          const systemPrompt = createSystemPromptOverride(appendPrompt);

          const sessionLock = await acquireSessionWriteLock({
            sessionFile: params.sessionFile,
          });
          // Pre-warm session file to bring it into OS page cache
          await prewarmSessionFile(params.sessionFile);
          const sessionManager = SessionManager.open(params.sessionFile);
          trackSessionManagerAccess(params.sessionFile);
          const settingsManager = SettingsManager.create(
            effectiveWorkspace,
            agentDir,
          );
          ensurePiCompactionReserveTokens({ settingsManager });
          const additionalExtensionPaths = buildEmbeddedExtensionPaths({
            cfg: params.config,
            sessionManager,
            provider,
            modelId,
            model,
          });

          const { builtInTools, customTools } = splitSdkTools({
            tools,
            sandboxEnabled: !!sandbox?.enabled,
          });

          let session: Awaited<
            ReturnType<typeof createAgentSession>
          >["session"];
          ({ session } = await createAgentSession({
            cwd: resolvedWorkspace,
            agentDir,
            authStorage,
            modelRegistry,
            model,
            thinkingLevel,
            systemPrompt,
            // Built-in tools recognized by pi-coding-agent SDK
            tools: builtInTools,
            // Custom clawdbot tools (browser, canvas, nodes, cron, etc.)
            customTools,
            sessionManager,
            settingsManager,
            skills: [],
            contextFiles: [],
            additionalExtensionPaths,
          }));

          try {
            const prior = await sanitizeSessionHistory({
              messages: session.messages,
              modelApi: model.api,
              sessionManager,
              sessionId: params.sessionId,
            });
            const validated = validateGeminiTurns(prior);
            if (validated.length > 0) {
              session.agent.replaceMessages(validated);
            }
          } catch (err) {
            session.dispose();
            await sessionLock.release();
            throw err;
          }
          let aborted = Boolean(params.abortSignal?.aborted);
          let timedOut = false;
          const abortRun = (isTimeout = false) => {
            aborted = true;
            if (isTimeout) timedOut = true;
            runAbortController.abort();
            void session.abort();
          };
          let subscription: ReturnType<typeof subscribeEmbeddedPiSession>;
          try {
            subscription = subscribeEmbeddedPiSession({
              session,
              runId: params.runId,
              verboseLevel: params.verboseLevel,
              reasoningMode: params.reasoningLevel ?? "off",
              shouldEmitToolResult: params.shouldEmitToolResult,
              onToolResult: params.onToolResult,
              onReasoningStream: params.onReasoningStream,
              onBlockReply: params.onBlockReply,
              blockReplyBreak: params.blockReplyBreak,
              blockReplyChunking: params.blockReplyChunking,
              onPartialReply: params.onPartialReply,
              onAgentEvent: params.onAgentEvent,
              enforceFinalTag: params.enforceFinalTag,
            });
          } catch (err) {
            session.dispose();
            await sessionLock.release();
            throw err;
          }
          const {
            assistantTexts,
            toolMetas,
            unsubscribe,
            waitForCompactionRetry,
            getMessagingToolSentTexts,
            getMessagingToolSentTargets,
            didSendViaMessagingTool,
          } = subscription;

          const queueHandle: EmbeddedPiQueueHandle = {
            queueMessage: async (text: string) => {
              await session.steer(text);
            },
            isStreaming: () => session.isStreaming,
            isCompacting: () => subscription.isCompacting(),
            abort: abortRun,
          };
          ACTIVE_EMBEDDED_RUNS.set(params.sessionId, queueHandle);

          let abortWarnTimer: NodeJS.Timeout | undefined;
          const abortTimer = setTimeout(
            () => {
              log.warn(
                `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
              );
              abortRun(true);
              if (!abortWarnTimer) {
                abortWarnTimer = setTimeout(() => {
                  if (!session.isStreaming) return;
                  log.warn(
                    `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                  );
                }, 10_000);
              }
            },
            Math.max(1, params.timeoutMs),
          );

          let messagesSnapshot: AgentMessage[] = [];
          let sessionIdUsed = session.sessionId;
          const onAbort = () => {
            abortRun();
          };
          if (params.abortSignal) {
            if (params.abortSignal.aborted) {
              onAbort();
            } else {
              params.abortSignal.addEventListener("abort", onAbort, {
                once: true,
              });
            }
          }
          let promptError: unknown = null;
          try {
            const promptStartedAt = Date.now();
            log.debug(
              `embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`,
            );
            try {
              await session.prompt(params.prompt, {
                images: params.images,
              });
            } catch (err) {
              promptError = err;
            } finally {
              log.debug(
                `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
              );
            }
            try {
              await waitForCompactionRetry();
            } catch (err) {
              // Capture AbortError from waitForCompactionRetry to enable fallback/rotation.
              if (isAbortError(err)) {
                if (!promptError) promptError = err;
              } else {
                throw err;
              }
            }
            messagesSnapshot = session.messages.slice();
            sessionIdUsed = session.sessionId;
          } finally {
            clearTimeout(abortTimer);
            if (abortWarnTimer) {
              clearTimeout(abortWarnTimer);
              abortWarnTimer = undefined;
            }
            unsubscribe();
            if (ACTIVE_EMBEDDED_RUNS.get(params.sessionId) === queueHandle) {
              ACTIVE_EMBEDDED_RUNS.delete(params.sessionId);
              notifyEmbeddedRunEnded(params.sessionId);
            }
            session.dispose();
            await sessionLock.release();
            params.abortSignal?.removeEventListener?.("abort", onAbort);
          }
          if (promptError && !aborted) {
            const errorText = describeUnknownError(promptError);
            if (isContextOverflowError(errorText)) {
              return {
                payloads: [
                  {
                    text:
                      "Context overflow: the conversation history is too large for the model. " +
                      "Use /new or /reset to start a fresh session, or try a model with a larger context window.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: {
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                  },
                },
              };
            }
            const promptFailoverReason = classifyFailoverReason(errorText);
            if (
              promptFailoverReason &&
              promptFailoverReason !== "timeout" &&
              lastProfileId
            ) {
              await markAuthProfileFailure({
                store: authStore,
                profileId: lastProfileId,
                reason: promptFailoverReason,
                cfg: params.config,
                agentDir: params.agentDir,
              });
            }
            if (
              isFailoverErrorMessage(errorText) &&
              promptFailoverReason !== "timeout" &&
              (await advanceAuthProfile())
            ) {
              continue;
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            throw promptError;
          }

          const lastAssistant = messagesSnapshot
            .slice()
            .reverse()
            .find((m) => (m as AgentMessage)?.role === "assistant") as
            | AssistantMessage
            | undefined;

          const fallbackThinking = pickFallbackThinkingLevel({
            message: lastAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const fallbackConfigured =
            (params.config?.agents?.defaults?.model?.fallbacks?.length ?? 0) >
            0;
          const authFailure = isAuthAssistantError(lastAssistant);
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant);
          const failoverFailure = isFailoverAssistantError(lastAssistant);
          const assistantFailoverReason = classifyFailoverReason(
            lastAssistant?.errorMessage ?? "",
          );
          const cloudCodeAssistFormatError = lastAssistant?.errorMessage
            ? isCloudCodeAssistFormatError(lastAssistant.errorMessage)
            : false;

          // Treat timeout as potential rate limit (Antigravity hangs on rate limit)
          const shouldRotate = (!aborted && failoverFailure) || timedOut;

          if (shouldRotate) {
            // Mark current profile for cooldown before rotating
            if (lastProfileId) {
              const reason =
                timedOut || assistantFailoverReason === "timeout"
                  ? "timeout"
                  : (assistantFailoverReason ?? "unknown");
              await markAuthProfileFailure({
                store: authStore,
                profileId: lastProfileId,
                reason,
                cfg: params.config,
                agentDir: params.agentDir,
              });
              if (timedOut) {
                log.warn(
                  `Profile ${lastProfileId} timed out (possible rate limit). Trying next account...`,
                );
              }
              if (cloudCodeAssistFormatError) {
                log.warn(
                  `Profile ${lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
                );
              }
            }
            const rotated = await advanceAuthProfile();
            if (rotated) {
              continue;
            }
            if (fallbackConfigured) {
              const message =
                lastAssistant?.errorMessage?.trim() ||
                (lastAssistant
                  ? formatAssistantErrorText(lastAssistant, {
                      cfg: params.config,
                      sessionKey: params.sessionKey ?? params.sessionId,
                    })
                  : "") ||
                (timedOut
                  ? "LLM request timed out."
                  : rateLimitFailure
                    ? "LLM request rate limited."
                    : authFailure
                      ? "LLM request unauthorized."
                      : "LLM request failed.");
              const status =
                resolveFailoverStatus(assistantFailoverReason ?? "unknown") ??
                (isTimeoutErrorMessage(message) ? 408 : undefined);
              throw new FailoverError(message, {
                reason: assistantFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status,
              });
            }
          }

          const usage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: lastAssistant?.provider ?? provider,
            model: lastAssistant?.model ?? model.id,
            usage,
          };

          const replyItems: Array<{
            text: string;
            media?: string[];
            isError?: boolean;
            audioAsVoice?: boolean;
            replyToId?: string;
            replyToTag?: boolean;
            replyToCurrent?: boolean;
          }> = [];

          const errorText = lastAssistant
            ? formatAssistantErrorText(lastAssistant, {
                cfg: params.config,
                sessionKey: params.sessionKey ?? params.sessionId,
              })
            : undefined;

          if (errorText) replyItems.push({ text: errorText, isError: true });

          const inlineToolResults =
            params.verboseLevel === "on" &&
            !params.onPartialReply &&
            !params.onToolResult &&
            toolMetas.length > 0;
          if (inlineToolResults) {
            for (const { toolName, meta } of toolMetas) {
              const agg = formatToolAggregate(toolName, meta ? [meta] : []);
              const {
                text: cleanedText,
                mediaUrls,
                audioAsVoice,
                replyToId,
                replyToTag,
                replyToCurrent,
              } = parseReplyDirectives(agg);
              if (cleanedText)
                replyItems.push({
                  text: cleanedText,
                  media: mediaUrls,
                  audioAsVoice,
                  replyToId,
                  replyToTag,
                  replyToCurrent,
                });
            }
          }

          const reasoningText =
            lastAssistant && params.reasoningLevel === "on"
              ? formatReasoningMessage(extractAssistantThinking(lastAssistant))
              : "";
          if (reasoningText) replyItems.push({ text: reasoningText });

          const fallbackAnswerText = lastAssistant
            ? extractAssistantText(lastAssistant)
            : "";
          const answerTexts = assistantTexts.length
            ? assistantTexts
            : fallbackAnswerText
              ? [fallbackAnswerText]
              : [];
          for (const text of answerTexts) {
            const {
              text: cleanedText,
              mediaUrls,
              audioAsVoice,
              replyToId,
              replyToTag,
              replyToCurrent,
            } = parseReplyDirectives(text);
            if (
              !cleanedText &&
              (!mediaUrls || mediaUrls.length === 0) &&
              !audioAsVoice
            )
              continue;
            replyItems.push({
              text: cleanedText,
              media: mediaUrls,
              audioAsVoice,
              replyToId,
              replyToTag,
              replyToCurrent,
            });
          }

          // Check if any replyItem has audioAsVoice tag - if so, apply to all media payloads
          const hasAudioAsVoiceTag = replyItems.some(
            (item) => item.audioAsVoice,
          );
          const payloads = replyItems
            .map((item) => ({
              text: item.text?.trim() ? item.text.trim() : undefined,
              mediaUrls: item.media?.length ? item.media : undefined,
              mediaUrl: item.media?.[0],
              isError: item.isError,
              replyToId: item.replyToId,
              replyToTag: item.replyToTag,
              replyToCurrent: item.replyToCurrent,
              // Apply audioAsVoice to media payloads if tag was found anywhere in response
              audioAsVoice:
                item.audioAsVoice || (hasAudioAsVoiceTag && item.media?.length),
            }))
            .filter(
              (p) =>
                p.text || p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0),
            );

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
            });
            // Track usage for round-robin rotation
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
            });
          }
          return {
            payloads: payloads.length ? payloads : undefined,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
            },
            didSendViaMessagingTool: didSendViaMessagingTool(),
            messagingToolSentTexts: getMessagingToolSentTexts(),
            messagingToolSentTargets: getMessagingToolSentTargets(),
          };
        } finally {
          restoreSkillEnv?.();
          process.chdir(prevCwd);
        }
      }
    }),
  );
}
