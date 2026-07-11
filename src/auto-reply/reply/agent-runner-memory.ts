/** Preflight compaction and memory flush helpers for agent runner sessions. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { classifyCompactionReason } from "../../agents/embedded-agent-runner/compact-reasons.js";
import { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliRuntimeAliasForProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveContextConfigProviderForRuntime } from "../../agents/openai-routing.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import {
  resolvePersistedSessionRuntimeId,
  resolveSessionRuntimeOverrideForProvider,
} from "../../agents/session-runtime-compat.js";
import {
  resolveCandidateThinkingLevel,
  resolveEffectiveAgentRuntime,
} from "../../agents/thinking-runtime.js";
import {
  deriveContextPromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type UsageLike,
} from "../../agents/usage.js";
import {
  resolveAgentIdFromSessionKey,
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
} from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/sqlite-marker.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionMessagesAsync } from "../../gateway/session-utils.fs.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveMemoryFlushPlan } from "../../plugins/memory-state.js";
import { CommandLane } from "../../process/lanes.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  buildEmbeddedRunExecutionParams,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveMaxActiveTranscriptBytes,
  resolveMemoryFlushContextWindowTokens,
  resolveResponsesServerCompactionThreshold,
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import { isRenderablePayload } from "./reply-payloads-base.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { incrementCompactionCount } from "./session-updates.js";

type EmbeddedAgentRuntime = typeof import("../../agents/embedded-agent.js");
type UpdateSessionEntryParams = {
  storePath: string;
  sessionKey: string;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
};

const MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS = 600;
const MAX_FLUSH_FAILURES = 3;
const MAX_FLUSH_ERROR_LENGTH = 200;

const embeddedAgentRuntimeLoader = createLazyImportLoader<EmbeddedAgentRuntime>(
  () => import("../../agents/embedded-agent.js"),
);

function loadEmbeddedAgentRuntime(): Promise<EmbeddedAgentRuntime> {
  return embeddedAgentRuntimeLoader.load();
}

async function compactEmbeddedAgentSessionDefault(
  ...args: Parameters<typeof import("../../agents/embedded-agent.js").compactEmbeddedAgentSession>
): Promise<
  Awaited<ReturnType<typeof import("../../agents/embedded-agent.js").compactEmbeddedAgentSession>>
> {
  const { compactEmbeddedAgentSession } = await loadEmbeddedAgentRuntime();
  return await compactEmbeddedAgentSession(...args);
}

async function runEmbeddedAgentDefault(
  ...args: Parameters<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>
): Promise<Awaited<ReturnType<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>>> {
  const { runEmbeddedAgent } = await loadEmbeddedAgentRuntime();
  return await runEmbeddedAgent(...args);
}

async function updateSessionEntryDefault(
  params: UpdateSessionEntryParams,
): Promise<SessionEntry | null> {
  return await updateSessionEntry(
    {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    params.update,
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
    },
  );
}

async function ensureMemoryFlushTargetFile(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<void> {
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const relativePath = normalizeOptionalString(params.relativePath);
  if (!workspaceDir || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Invalid memory flush target path");
  }
  const workspaceRoot = path.resolve(workspaceDir);
  const targetPath = path.resolve(workspaceRoot, relativePath);
  const targetRelativePath = path.relative(workspaceRoot, targetPath);
  if (
    !targetRelativePath ||
    targetRelativePath.startsWith("..") ||
    path.isAbsolute(targetRelativePath)
  ) {
    throw new Error("Memory flush target path must stay inside the workspace");
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await fs.promises.open(targetPath, "a");
  await handle.close();
}

const memoryDeps = {
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionDefault,
  runWithModelFallback,
  ensureSelectedAgentHarnessPlugin,
  runEmbeddedAgent: runEmbeddedAgentDefault,
  ensureMemoryFlushTargetFile,
  registerAgentRunContext,
  refreshQueuedFollowupSession,
  incrementCompactionCount,
  updateSessionEntry: updateSessionEntryDefault,
  emitAgentEvent,
  randomUUID: () => crypto.randomUUID(),
  now: () => Date.now(),
};

/** Overrides memory helper dependencies for tests. */
export function setAgentRunnerMemoryTestDeps(overrides?: Partial<typeof memoryDeps>): void {
  Object.assign(memoryDeps, {
    runWithModelFallback,
    ensureSelectedAgentHarnessPlugin,
    compactEmbeddedAgentSession: compactEmbeddedAgentSessionDefault,
    runEmbeddedAgent: runEmbeddedAgentDefault,
    ensureMemoryFlushTargetFile,
    registerAgentRunContext,
    refreshQueuedFollowupSession,
    incrementCompactionCount,
    updateSessionEntry: updateSessionEntryDefault,
    emitAgentEvent,
    randomUUID: () => crypto.randomUUID(),
    now: () => Date.now(),
    ...overrides,
  });
}

function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
  const trimmed = normalizeOptionalString(prompt);
  if (!trimmed) {
    return undefined;
  }
  const message: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
  const tokens = estimateMessagesTokens([message]);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  return Math.ceil(tokens);
}

function resolveEffectivePromptTokens(
  basePromptTokens?: number,
  lastOutputTokens?: number,
  promptTokenEstimate?: number,
): number {
  const base = Math.max(0, basePromptTokens ?? 0);
  const output = Math.max(0, lastOutputTokens ?? 0);
  const estimate = Math.max(0, promptTokenEstimate ?? 0);
  // Flush gating projects the next input context by adding the previous
  // completion and the current user prompt estimate.
  return base + output + estimate;
}

function isPreflightCompactionSkipReason(reason?: string): boolean {
  const classification = classifyCompactionReason(reason);
  // Preflight compaction is a guardrail, not a hard dependency. These classes
  // mean the context engine found nothing useful to compact, so the reply should
  // continue instead of surfacing a generic user-facing failure.
  return (
    classification === "below_threshold" ||
    classification === "no_compactable_entries" ||
    classification === "already_compacted_recently"
  );
}

function resolveMemoryFlushModelFallbackOptions(
  run: FollowupRun["run"],
  model?: string,
  configOverride: FollowupRun["run"]["config"] = run.config,
) {
  const options = resolveModelFallbackOptions(run, configOverride);
  const override = normalizeOptionalString(model);
  if (!override) {
    return options;
  }
  // A memory-flush maintenance model is an exact override: do not let a failed
  // local flush silently fall through to the paid active conversation fallback.
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim();
    if (overrideProvider && overrideModel) {
      return {
        ...options,
        provider: overrideProvider,
        model: overrideModel,
        fallbacksOverride: [],
      };
    }
  }
  return {
    ...options,
    model: override,
    fallbacksOverride: [],
  };
}

function followupUsesCliRuntime(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionEntry?: Pick<
    SessionEntry,
    "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
  >;
}): boolean {
  const provider = params.followupRun.run.provider;
  if (isCliProvider(provider, params.cfg)) {
    return true;
  }
  return isCliRuntimeAliasForProvider({
    provider,
    runtime: resolvePersistedSessionRuntimeId(params.sessionEntry),
    cfg: params.cfg,
  });
}

function resolveFollowupContextConfigProvider(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
}): string {
  const provider = params.followupRun.run.provider;
  return resolveContextConfigProviderForRuntime({
    provider,
    runtimeId: resolveFollowupAgentRuntimeId(params),
    config: params.cfg,
  });
}

function resolveFollowupAgentRuntimeId(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
}): string {
  const matchingSessionEntry =
    params.sessionEntry?.sessionId === params.followupRun.run.sessionId
      ? params.sessionEntry
      : undefined;
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
    modelId: params.followupRun.run.model,
    agentId: params.followupRun.run.agentId,
    sessionKey:
      params.runtimePolicySessionKey ??
      params.sessionKey ??
      params.followupRun.run.runtimePolicySessionKey ??
      params.followupRun.run.sessionKey,
    sessionEntry: matchingSessionEntry,
  });
}

function followupUsesCodexRuntime(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
}): boolean {
  return normalizeLowercaseStringOrEmpty(resolveFollowupAgentRuntimeId(params)) === "codex";
}

function resolveVisibleMemoryFlushErrorPayloads(payloads?: ReplyPayload[]): ReplyPayload[] {
  return (payloads ?? []).filter(
    (payload) => payload.isError === true && isRenderablePayload(payload),
  );
}

function buildVisibleMemoryFlushFailure(payloads: ReplyPayload[]): Error {
  const message = payloads
    .map((payload) => normalizeOptionalString(payload.text))
    .filter((text): text is string => Boolean(text))
    .join("\n");
  return new Error(message || "Memory flush returned an error response");
}

function buildMemoryFlushErrorPayload(err: unknown): ReplyPayload | undefined {
  if (isAbortError(err)) {
    return undefined;
  }
  const message = normalizeOptionalString(formatErrorMessage(err));
  if (!message) {
    return undefined;
  }
  const visibleText = message.startsWith("⚠️") ? message : `⚠️ ${message}`;
  return {
    text:
      visibleText.length > MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS
        ? `${truncateUtf16Safe(visibleText, MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS - 1)}…`
        : visibleText,
    isError: true,
  };
}

function truncateMemoryFlushErrorMessage(err: unknown): string {
  const message = normalizeOptionalString(formatErrorMessage(err)) || String(err);
  return message.length > MAX_FLUSH_ERROR_LENGTH
    ? `${truncateUtf16Safe(message, MAX_FLUSH_ERROR_LENGTH - 1)}…`
    : message;
}

/** Usage snapshot read from a session transcript before compaction. */
export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number;
  outputTokens?: number;
  trailingBytesTokens?: number;
};

// Keep a generous near-threshold window so large assistant outputs still trigger
// transcript reads in time to flip memory-flush gating when needed.
const TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS = 8192;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;
const FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN = 4;

function parseUsageFromTranscriptLine(line: string): ReturnType<typeof normalizeUsage> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: { usage?: UsageLike };
      usage?: UsageLike;
    };
    const usageRaw = parsed.message?.usage ?? parsed.usage;
    const usage = normalizeUsage(usageRaw);
    if (usage && hasNonzeroUsage(usage)) {
      return usage;
    }
  } catch {
    // ignore bad lines
  }
  return undefined;
}

function resolveSessionLogPath(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  try {
    const transcriptPath = normalizeOptionalString(
      (sessionEntry as (SessionEntry & { transcriptPath?: string }) | undefined)?.transcriptPath,
    );
    const sessionFile = normalizeOptionalString(sessionEntry?.sessionFile) || transcriptPath;
    if (parseSqliteSessionFileMarker(sessionFile)) {
      return sessionFile;
    }
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    if (!sessionFile && agentId && opts?.storePath) {
      return formatSqliteSessionFileMarker({
        agentId,
        sessionId,
        storePath: opts.storePath,
      });
    }
    if (!sessionFile) {
      return undefined;
    }
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: opts?.storePath,
    });
    // Normalize sessionFile through resolveSessionFilePath so relative entries
    // are resolved against the sessions dir/store layout, not process.cwd().
    return resolveSessionFilePath(sessionId, { sessionFile }, pathOpts);
  } catch {
    return undefined;
  }
}

function deriveTranscriptUsageSnapshot(
  snapshot:
    | {
        usage?: ReturnType<typeof normalizeUsage>;
        trailingBytes?: number;
      }
    | undefined,
): SessionTranscriptUsageSnapshot | undefined {
  const usage = snapshot?.usage;
  if (!usage) {
    return undefined;
  }
  const promptTokens = deriveContextPromptTokens({ lastCallUsage: usage });
  const outputRaw = usage.output;
  const outputTokens =
    typeof outputRaw === "number" && Number.isFinite(outputRaw) && outputRaw > 0
      ? outputRaw
      : undefined;
  if (!(typeof promptTokens === "number") && !(typeof outputTokens === "number")) {
    return undefined;
  }
  return {
    promptTokens,
    outputTokens,
    trailingBytesTokens:
      typeof snapshot.trailingBytes === "number" &&
      Number.isFinite(snapshot.trailingBytes) &&
      snapshot.trailingBytes >= 0
        ? Math.ceil(snapshot.trailingBytes / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN)
        : undefined,
  };
}

type SessionLogSnapshot = {
  byteSize?: number;
  usage?: SessionTranscriptUsageSnapshot;
};

async function appendPostCompactionRefreshPrompt(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
}): Promise<void> {
  const refreshPrompt = await readPostCompactionContext(params.followupRun.run.workspaceDir, {
    cfg: params.cfg,
    agentId: params.followupRun.run.agentId,
  });
  if (!refreshPrompt) {
    return;
  }

  const existingPrompt = normalizeOptionalString(params.followupRun.run.extraSystemPrompt);
  if (existingPrompt?.includes(refreshPrompt)) {
    return;
  }

  params.followupRun.run.extraSystemPrompt = [existingPrompt, refreshPrompt]
    .filter(Boolean)
    .join("\n\n");
}

async function readSessionLogSnapshot(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  opts?: { storePath?: string };
  includeByteSize: boolean;
  includeUsage: boolean;
}): Promise<SessionLogSnapshot> {
  const logPath = resolveSessionLogPath(
    params.sessionId,
    params.sessionEntry,
    params.sessionKey,
    params.opts,
  );
  if (!logPath) {
    return {};
  }
  if (parseSqliteSessionFileMarker(logPath)) {
    return {};
  }

  const snapshot: SessionLogSnapshot = {};
  let usageScan: SessionLogUsageScan | undefined;

  if (params.includeUsage) {
    try {
      usageScan = await readLastNonzeroUsageFromSessionLog(logPath);
      snapshot.usage = deriveTranscriptUsageSnapshot(usageScan);
    } catch {
      snapshot.usage = undefined;
    }
  }

  if (params.includeByteSize) {
    const scannedSize = usageScan?.byteSize;
    if (typeof scannedSize === "number" && Number.isFinite(scannedSize) && scannedSize >= 0) {
      snapshot.byteSize = Math.floor(scannedSize);
      return snapshot;
    }
    snapshot.byteSize = await readSessionLogByteSize(logPath);
  }

  return snapshot;
}

type SessionLogUsageScan = {
  usage?: ReturnType<typeof normalizeUsage>;
  trailingBytes?: number;
  byteSize: number;
};

async function readSessionLogByteSize(logPath: string): Promise<number | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(logPath, "r");
    const stat = await handle.stat();
    const size = Math.floor(stat.size);
    return Number.isFinite(size) && size >= 0 ? size : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function readLastNonzeroUsageFromSessionLog(logPath: string): Promise<SessionLogUsageScan> {
  const handle = await fs.promises.open(logPath, "r");
  try {
    const stat = await handle.stat();
    let position = stat.size;
    let leadingPartial = "";
    while (position > 0) {
      const chunkSize = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position);
      const start = position - chunkSize;
      const buffer = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, start);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.toString("utf-8", 0, bytesRead);
      const appendedPartialBytes = Buffer.byteLength(leadingPartial, "utf8");
      const combined = `${chunk}${leadingPartial}`;
      const lines = combined.split(/\n+/);
      const firstLine = lines.shift() ?? "";
      if (start > 0) {
        leadingPartial = firstLine;
      } else {
        leadingPartial = "";
        lines.unshift(firstLine);
      }
      const suffixBytesBeforeChunk = stat.size - position;
      const suffixBytesOutsideCombined = Math.max(0, suffixBytesBeforeChunk - appendedPartialBytes);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const usage = parseUsageFromTranscriptLine(lines[i] ?? "");
        if (usage) {
          const trailingLines = lines.slice(i + 1);
          const trailingBytesInChunk = estimatePostUsageTrailingBytes(trailingLines);
          return {
            usage,
            trailingBytes: suffixBytesOutsideCombined + trailingBytesInChunk,
            byteSize: stat.size,
          };
        }
      }
      position = start;
    }
    const usage = parseUsageFromTranscriptLine(leadingPartial);
    return usage
      ? {
          usage,
          trailingBytes: Math.max(0, stat.size - Buffer.byteLength(leadingPartial, "utf8")),
          byteSize: stat.size,
        }
      : { byteSize: stat.size };
  } finally {
    await handle.close();
  }
}

function estimatePostUsageTrailingBytes(lines: string[]): number {
  if (!lines.some((line) => line.trim())) {
    return 0;
  }
  return Buffer.byteLength(lines.join("\n"), "utf8") + lines.length;
}

type TranscriptTokenEstimate = {
  promptTokens: number;
  outputTokens?: number;
  transcriptByteSize?: number;
  transcriptBytesTokens?: number;
};

async function estimatePromptTokensFromSessionTranscript(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): Promise<TranscriptTokenEstimate | undefined> {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  try {
    const snapshot = await readSessionLogSnapshot({
      sessionId,
      sessionEntry: params.sessionEntry,
      sessionKey: params.sessionKey,
      opts: { storePath: params.storePath },
      includeByteSize: true,
      includeUsage: true,
    });
    const transcriptBytesTokens =
      typeof snapshot.byteSize === "number" &&
      Number.isFinite(snapshot.byteSize) &&
      snapshot.byteSize > 0
        ? Math.ceil(snapshot.byteSize / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN)
        : undefined;
    const promptTokens = snapshot.usage?.promptTokens;
    const trailingBytesTokens = snapshot.usage?.trailingBytesTokens;
    const outputTokens = snapshot.usage?.outputTokens;
    if (
      typeof promptTokens === "number" &&
      Number.isFinite(promptTokens) &&
      promptTokens > 0 &&
      trailingBytesTokens === 0 &&
      typeof outputTokens === "number" &&
      Number.isFinite(outputTokens) &&
      outputTokens > 0
    ) {
      return {
        promptTokens: Math.ceil(promptTokens),
        outputTokens: Math.ceil(outputTokens),
        transcriptByteSize: snapshot.byteSize,
        transcriptBytesTokens,
      };
    }
    const messages = (await readSessionMessagesAsync(
      sessionId,
      params.storePath,
      params.sessionEntry?.sessionFile,
      {
        mode: "recent",
        maxMessages: 200,
        maxBytes: 1024 * 1024,
      },
    )) as AgentMessage[];
    const estimatedMessageTokens = (() => {
      if (messages.length === 0) {
        return undefined;
      }
      const tokens = estimateMessagesTokens(messages);
      return Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : undefined;
    })();
    if (typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens > 0) {
      const usagePromptTokens = Math.ceil(promptTokens) + (trailingBytesTokens ?? 0);
      return {
        promptTokens: Math.max(usagePromptTokens, estimatedMessageTokens ?? 0),
        outputTokens:
          typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0
            ? Math.ceil(outputTokens)
            : undefined,
        transcriptByteSize: snapshot.byteSize,
        transcriptBytesTokens,
      };
    }
    const estimatedTokens = estimatedMessageTokens ?? transcriptBytesTokens;
    if (estimatedTokens === undefined) {
      return undefined;
    }
    return {
      promptTokens: Math.ceil(estimatedTokens),
      transcriptByteSize: snapshot.byteSize,
      transcriptBytesTokens,
    };
  } catch {
    return undefined;
  }
}

/** Runs preflight compaction when session state exceeds configured thresholds. */
export async function runPreflightCompactionIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
  replyOperation: ReplyOperation;
  onCompactionNotice?: (phase: CompactionNoticePhase) => Promise<void> | void;
}): Promise<SessionEntry | undefined> {
  const deps = {
    compactEmbeddedAgentSession: memoryDeps.compactEmbeddedAgentSession,
    incrementCompactionCount: memoryDeps.incrementCompactionCount,
    refreshQueuedFollowupSession: memoryDeps.refreshQueuedFollowupSession,
  };
  if (!params.sessionKey) {
    return params.sessionEntry;
  }

  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!entry?.sessionId) {
    return entry ?? params.sessionEntry;
  }

  const isCli = followupUsesCliRuntime({
    cfg: params.cfg,
    followupRun: params.followupRun,
    sessionEntry: entry,
  });
  if (params.isHeartbeat || isCli) {
    return entry ?? params.sessionEntry;
  }
  if (
    followupUsesCodexRuntime({
      cfg: params.cfg,
      followupRun: params.followupRun,
      sessionEntry: entry,
      sessionKey: params.sessionKey,
      runtimePolicySessionKey: params.runtimePolicySessionKey,
    })
  ) {
    // Codex runtime sessions should reach Codex with their real thread state.
    // Its harness owns automatic compaction; OpenClaw preflight compaction is
    // only for non-Codex embedded runtimes.
    logVerbose(
      `preflightCompaction skipped: sessionKey=${params.sessionKey} runtime=codex reason=codex_native_auto_compaction`,
    );
    return entry ?? params.sessionEntry;
  }

  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    cfg: params.cfg,
    provider: resolveFollowupContextConfigProvider({
      cfg: params.cfg,
      followupRun: params.followupRun,
      sessionEntry: entry,
      sessionKey: params.sessionKey,
      runtimePolicySessionKey: params.runtimePolicySessionKey,
    }),
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });
  const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
  const reserveTokensFloor =
    memoryFlushPlan?.reserveTokensFloor ??
    params.cfg.agents?.defaults?.compaction?.reserveTokensFloor ??
    20_000;
  const softThresholdTokens = memoryFlushPlan?.softThresholdTokens ?? 4_000;
  const freshPersistedTokens = resolveFreshSessionTotalTokens(entry);
  const persistedTotalTokens = entry.totalTokens;
  const hasPersistedTotalTokens =
    typeof persistedTotalTokens === "number" &&
    Number.isFinite(persistedTotalTokens) &&
    persistedTotalTokens > 0;
  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const serverCompactionThreshold = resolveResponsesServerCompactionThreshold({
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
    modelId: params.followupRun.run.model ?? params.defaultModel,
  });
  const threshold = Math.max(
    contextWindowTokens - reserveTokensFloor - softThresholdTokens,
    serverCompactionThreshold ?? 0,
  );
  const freshNeedsOutputRead =
    typeof freshPersistedTokens === "number" &&
    typeof promptTokenEstimate === "number" &&
    threshold > 0 &&
    freshPersistedTokens + promptTokenEstimate >= threshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;
  const maxActiveTranscriptBytes = resolveMaxActiveTranscriptBytes(params.cfg);
  const shouldCheckActiveTranscriptBytes = typeof maxActiveTranscriptBytes === "number";
  const transcriptUsageTokens =
    typeof freshPersistedTokens === "number" && !freshNeedsOutputRead
      ? undefined
      : await estimatePromptTokensFromSessionTranscript({
          sessionId: entry.sessionId,
          sessionEntry: entry,
          sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
          storePath: params.storePath,
        });
  const transcriptSizeSnapshot =
    shouldCheckActiveTranscriptBytes && transcriptUsageTokens?.transcriptByteSize === undefined
      ? await readSessionLogSnapshot({
          sessionId: entry.sessionId,
          sessionEntry: entry,
          sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
          opts: { storePath: params.storePath },
          includeByteSize: true,
          includeUsage: false,
        })
      : undefined;
  const activeTranscriptBytes =
    transcriptUsageTokens?.transcriptByteSize ?? transcriptSizeSnapshot?.byteSize;
  const shouldCompactByTranscriptBytes =
    typeof activeTranscriptBytes === "number" &&
    typeof maxActiveTranscriptBytes === "number" &&
    activeTranscriptBytes >= maxActiveTranscriptBytes;
  const stalePersistedPromptTokens =
    hasPersistedTotalTokens && entry.totalTokensFresh !== false
      ? Math.floor(persistedTotalTokens)
      : undefined;
  const transcriptPromptTokens = transcriptUsageTokens?.promptTokens;
  const transcriptOutputTokens = transcriptUsageTokens?.outputTokens;
  const usageProjectedTokenCount =
    typeof transcriptPromptTokens === "number"
      ? resolveEffectivePromptTokens(
          transcriptPromptTokens,
          transcriptOutputTokens,
          promptTokenEstimate,
        )
      : undefined;
  const freshProjectedTokenCount =
    typeof freshPersistedTokens === "number"
      ? resolveEffectivePromptTokens(
          freshPersistedTokens,
          transcriptOutputTokens,
          promptTokenEstimate,
        )
      : undefined;
  const projectedTokenCount = Math.max(
    usageProjectedTokenCount ?? 0,
    freshProjectedTokenCount ?? 0,
    stalePersistedPromptTokens ?? 0,
  );
  const tokenCountForCompaction =
    Number.isFinite(projectedTokenCount) && projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;

  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${threshold} ` +
      `serverCompactionThreshold=${serverCompactionThreshold ?? "undefined"} ` +
      `isHeartbeat=${params.isHeartbeat} isCli=${isCli} ` +
      `persistedFresh=${entry?.totalTokensFresh === true} ` +
      `transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} ` +
      `activeTranscriptBytes=${activeTranscriptBytes ?? "undefined"} ` +
      `maxActiveTranscriptBytes=${maxActiveTranscriptBytes ?? "undefined"} ` +
      `sizeTrigger=${shouldCompactByTranscriptBytes}`,
  );

  const shouldCompactByTokens = shouldRunPreflightCompaction({
    entry,
    tokenCount: tokenCountForCompaction,
    contextWindowTokens,
    reserveTokensFloor,
    softThresholdTokens,
    minimumThresholdTokens: serverCompactionThreshold,
  });
  const shouldCompact = shouldCompactByTokens || shouldCompactByTranscriptBytes;
  if (!shouldCompact) {
    return entry ?? params.sessionEntry;
  }

  const compactionTrigger = shouldCompactByTranscriptBytes ? "transcript_bytes" : "tokens";
  logVerbose(
    `preflightCompaction triggered: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `threshold=${threshold} trigger=${compactionTrigger} ` +
      `activeTranscriptBytes=${activeTranscriptBytes ?? "undefined"} ` +
      `maxActiveTranscriptBytes=${maxActiveTranscriptBytes ?? "undefined"}`,
  );

  params.replyOperation.setPhase("preflight_compacting");
  const notifyCompaction = async (phase: CompactionNoticePhase) => {
    try {
      await params.onCompactionNotice?.(phase);
    } catch (err) {
      logVerbose(`preflightCompaction notice delivery failed: ${String(err)}`);
    }
  };
  let startedCompactionNotice = false;
  let terminalCompactionNoticeSent = false;
  const notifyStartCompaction = async () => {
    startedCompactionNotice = true;
    await notifyCompaction("start");
  };
  const notifyTerminalCompaction = async (phase: "end" | "incomplete" | "skipped") => {
    terminalCompactionNoticeSent = true;
    await notifyCompaction(phase);
  };
  try {
    await notifyStartCompaction();
    const sessionFile = resolveSessionLogPath(
      entry.sessionId,
      entry,
      params.sessionKey ?? params.followupRun.run.sessionKey,
      { storePath: params.storePath },
    );
    if (!sessionFile) {
      await notifyTerminalCompaction("skipped");
      return entry ?? params.sessionEntry;
    }
    const result = await deps.compactEmbeddedAgentSession({
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      sandboxSessionKey: params.runtimePolicySessionKey,
      allowGatewaySubagentBinding: true,
      messageChannel: params.followupRun.run.messageProvider,
      clientCaps: params.followupRun.run.clientCaps,
      groupId: entry.groupId ?? params.followupRun.run.groupId,
      groupChannel: entry.groupChannel ?? params.followupRun.run.groupChannel,
      groupSpace: entry.space ?? params.followupRun.run.groupSpace,
      senderId: params.followupRun.run.senderId,
      senderName: params.followupRun.run.senderName,
      senderUsername: params.followupRun.run.senderUsername,
      senderE164: params.followupRun.run.senderE164,
      sessionFile,
      workspaceDir: params.followupRun.run.workspaceDir,
      cwd: params.followupRun.run.cwd,
      agentDir: params.followupRun.run.agentDir,
      config: params.cfg,
      skillsSnapshot: entry.skillsSnapshot ?? params.followupRun.run.skillsSnapshot,
      provider: params.followupRun.run.provider,
      model: params.followupRun.run.model,
      authProfileId: params.followupRun.run.authProfileId,
      authProfileIdSource: params.followupRun.run.authProfileIdSource,
      agentHarnessId:
        entry.sessionId === params.followupRun.run.sessionId
          ? entry.modelSelectionLocked === true
            ? resolvePersistedSessionRuntimeId(entry)
            : entry.agentHarnessId
          : undefined,
      modelSelectionLocked: entry.modelSelectionLocked === true,
      thinkLevel: params.followupRun.run.thinkLevel,
      bashElevated: params.followupRun.run.bashElevated,
      trigger: "budget",
      force: true,
      forcePreflight: true,
      preflightRequired: true,
      preflightCompactionTrigger: compactionTrigger,
      deferOwningContextEngineCompaction: false,
      contextTokenBudget: contextWindowTokens,
      currentTokenCount: tokenCountForCompaction ?? freshPersistedTokens,
      ownerNumbers: params.followupRun.run.ownerNumbers,
      abortSignal: params.replyOperation.abortSignal,
    });

    if (!result?.ok) {
      const reason = result?.reason ?? "not_compacted";
      if (isPreflightCompactionSkipReason(reason)) {
        await notifyTerminalCompaction("skipped");
        logVerbose(`preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${reason}`);
        return entry ?? params.sessionEntry;
      }
      await notifyTerminalCompaction("incomplete");
      logVerbose(`preflightCompaction failed: sessionKey=${params.sessionKey} reason=${reason}`);
      throw new Error(`Preflight compaction required but failed: ${reason}`);
    }

    if (!result.compacted) {
      const reason = normalizeOptionalString(result.reason) ?? "not_compacted";
      if (isPreflightCompactionSkipReason(reason)) {
        await notifyTerminalCompaction("skipped");
        logVerbose(`preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${reason}`);
        return entry ?? params.sessionEntry;
      }
      await notifyTerminalCompaction("incomplete");
      logVerbose(`preflightCompaction failed: sessionKey=${params.sessionKey} reason=${reason}`);
      throw new Error(`Preflight compaction required but failed: ${reason}`);
    }

    await deps.incrementCompactionCount({
      cfg: params.cfg,
      sessionEntry: entry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      tokensAfter: result.result?.tokensAfter,
      newSessionId: result.result?.sessionId,
      newSessionFile: result.result?.sessionFile,
    });
    await appendPostCompactionRefreshPrompt({
      cfg: params.cfg,
      followupRun: params.followupRun,
    });
    await notifyTerminalCompaction("end");
    entry = params.sessionStore?.[params.sessionKey] ?? entry;
    if (entry) {
      const previousSessionId = params.followupRun.run.sessionId;
      params.followupRun.run.sessionId = entry.sessionId;
      params.replyOperation.updateSessionId(entry.sessionId);
      if (entry.sessionFile) {
        params.followupRun.run.sessionFile = entry.sessionFile;
      }
      const queueKey = params.followupRun.run.sessionKey ?? params.sessionKey;
      if (queueKey) {
        deps.refreshQueuedFollowupSession({
          key: queueKey,
          previousSessionId,
          nextSessionId: entry.sessionId,
          nextSessionFile: entry.sessionFile,
        });
      }
    }
    return entry ?? params.sessionEntry;
  } catch (err) {
    if (startedCompactionNotice && !terminalCompactionNoticeSent) {
      await notifyCompaction("incomplete");
    }
    throw err;
  }
}

type MemoryFlushOutcome = "skipped" | "completed" | "failed" | "exhausted";

type MemoryFlushResult = {
  sessionEntry?: SessionEntry;
  outcome: MemoryFlushOutcome;
};

/** Runs pre-compaction memory flush when transcript state warrants it. */
export async function runMemoryFlushIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
  replyOperation: ReplyOperation;
  onVisibleErrorPayloads?: (payloads: ReplyPayload[]) => void;
}): Promise<MemoryFlushResult> {
  const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
  if (!memoryFlushPlan) {
    return { sessionEntry: params.sessionEntry, outcome: "skipped" };
  }

  const memoryFlushWritable = (() => {
    if (!params.sessionKey) {
      return true;
    }
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.runtimePolicySessionKey ?? params.sessionKey,
    });
    if (!runtime.sandboxed) {
      return true;
    }
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();

  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  const isCli = followupUsesCliRuntime({
    cfg: params.cfg,
    followupRun: params.followupRun,
    sessionEntry: entry,
  });
  const canAttemptFlush = memoryFlushWritable && !params.isHeartbeat && !isCli;
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    cfg: params.cfg,
    provider: resolveFollowupContextConfigProvider({
      cfg: params.cfg,
      followupRun: params.followupRun,
      sessionEntry: entry,
      sessionKey: params.sessionKey,
      runtimePolicySessionKey: params.runtimePolicySessionKey,
    }),
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });

  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const persistedPromptTokensRaw = entry?.totalTokens;
  const persistedPromptTokens =
    typeof persistedPromptTokensRaw === "number" &&
    Number.isFinite(persistedPromptTokensRaw) &&
    persistedPromptTokensRaw > 0
      ? persistedPromptTokensRaw
      : undefined;
  const hasFreshPersistedPromptTokens =
    typeof persistedPromptTokens === "number" && entry?.totalTokensFresh === true;

  const flushThreshold =
    contextWindowTokens - memoryFlushPlan.reserveTokensFloor - memoryFlushPlan.softThresholdTokens;

  // When totals are stale/unknown, derive prompt + last output from transcript so memory
  // flush can still be evaluated against projected next-input size.
  //
  // When totals are fresh, only read the transcript when we're close enough to the
  // threshold that missing the last output tokens could flip the decision.
  const shouldReadTranscriptForOutput =
    canAttemptFlush &&
    entry &&
    hasFreshPersistedPromptTokens &&
    typeof promptTokenEstimate === "number" &&
    Number.isFinite(promptTokenEstimate) &&
    flushThreshold > 0 &&
    (persistedPromptTokens ?? 0) + promptTokenEstimate >=
      flushThreshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;

  const shouldReadTranscript = Boolean(
    canAttemptFlush && entry && (!hasFreshPersistedPromptTokens || shouldReadTranscriptForOutput),
  );

  const forceFlushTranscriptBytes = memoryFlushPlan.forceFlushTranscriptBytes;
  const shouldCheckTranscriptSizeForForcedFlush = Boolean(
    canAttemptFlush &&
    entry &&
    Number.isFinite(forceFlushTranscriptBytes) &&
    forceFlushTranscriptBytes > 0,
  );
  const shouldReadSessionLog = shouldReadTranscript || shouldCheckTranscriptSizeForForcedFlush;
  const sessionLogSnapshot = shouldReadSessionLog
    ? await readSessionLogSnapshot({
        sessionId: params.followupRun.run.sessionId,
        sessionEntry: entry,
        sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
        opts: { storePath: params.storePath },
        includeByteSize: shouldCheckTranscriptSizeForForcedFlush,
        includeUsage: shouldReadTranscript,
      })
    : undefined;
  const transcriptByteSize = sessionLogSnapshot?.byteSize;
  const shouldForceFlushByTranscriptSize =
    typeof transcriptByteSize === "number" && transcriptByteSize >= forceFlushTranscriptBytes;

  const transcriptUsageSnapshot = sessionLogSnapshot?.usage;
  const transcriptPromptTokens = transcriptUsageSnapshot?.promptTokens;
  const transcriptOutputTokens = transcriptUsageSnapshot?.outputTokens;
  const hasReliableTranscriptPromptTokens =
    typeof transcriptPromptTokens === "number" &&
    Number.isFinite(transcriptPromptTokens) &&
    transcriptPromptTokens > 0;
  const shouldPersistTranscriptPromptTokens =
    hasReliableTranscriptPromptTokens &&
    (!hasFreshPersistedPromptTokens ||
      (transcriptPromptTokens ?? 0) > (persistedPromptTokens ?? 0));

  if (entry && shouldPersistTranscriptPromptTokens) {
    const nextEntry = {
      ...entry,
      totalTokens: transcriptPromptTokens,
      totalTokensFresh: true,
    };
    entry = nextEntry;
    if (params.sessionKey && params.sessionStore) {
      params.sessionStore[params.sessionKey] = nextEntry;
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionEntry(
          {
            storePath: params.storePath,
            sessionKey: params.sessionKey,
          },
          () => ({ totalTokens: transcriptPromptTokens, totalTokensFresh: true }),
          {
            skipMaintenance: true,
            takeCacheOwnership: true,
          },
        );
        if (updatedEntry) {
          entry = updatedEntry;
          if (params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist derived prompt totalTokens: ${String(err)}`);
      }
    }
  }

  const promptTokensSnapshot = Math.max(
    hasFreshPersistedPromptTokens ? (persistedPromptTokens ?? 0) : 0,
    hasReliableTranscriptPromptTokens ? (transcriptPromptTokens ?? 0) : 0,
  );
  const hasFreshPromptTokensSnapshot =
    promptTokensSnapshot > 0 &&
    (hasFreshPersistedPromptTokens || hasReliableTranscriptPromptTokens);

  const projectedTokenCount = hasFreshPromptTokensSnapshot
    ? resolveEffectivePromptTokens(
        promptTokensSnapshot,
        transcriptOutputTokens,
        promptTokenEstimate,
      )
    : undefined;
  const tokenCountForFlush =
    typeof projectedTokenCount === "number" &&
    Number.isFinite(projectedTokenCount) &&
    projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;

  // Diagnostic logging to understand why memory flush may not trigger.
  logVerbose(
    `memoryFlush check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForFlush ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${flushThreshold} ` +
      `isHeartbeat=${params.isHeartbeat} isCli=${isCli} memoryFlushWritable=${memoryFlushWritable} ` +
      `compactionCount=${entry?.compactionCount ?? 0} memoryFlushCompactionCount=${entry?.memoryFlushCompactionCount ?? "undefined"} ` +
      `persistedPromptTokens=${persistedPromptTokens ?? "undefined"} persistedFresh=${entry?.totalTokensFresh === true} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} transcriptOutputTokens=${transcriptOutputTokens ?? "undefined"} ` +
      `projectedTokenCount=${projectedTokenCount ?? "undefined"} transcriptBytes=${transcriptByteSize ?? "undefined"} ` +
      `forceFlushTranscriptBytes=${forceFlushTranscriptBytes} forceFlushByTranscriptSize=${shouldForceFlushByTranscriptSize}`,
  );

  const shouldFlushMemory =
    (memoryFlushWritable &&
      !params.isHeartbeat &&
      !isCli &&
      shouldRunMemoryFlush({
        entry,
        tokenCount: tokenCountForFlush,
        contextWindowTokens,
        reserveTokensFloor: memoryFlushPlan.reserveTokensFloor,
        softThresholdTokens: memoryFlushPlan.softThresholdTokens,
      })) ||
    (shouldForceFlushByTranscriptSize &&
      entry != null &&
      !hasAlreadyFlushedForCurrentCompaction(entry));

  if (!shouldFlushMemory) {
    return { sessionEntry: entry ?? params.sessionEntry, outcome: "skipped" };
  }

  logVerbose(
    `memoryFlush triggered: sessionKey=${params.sessionKey} tokenCount=${tokenCountForFlush ?? "undefined"} threshold=${flushThreshold}`,
  );

  params.replyOperation.setPhase("memory_flushing");
  let activeSessionEntry = entry ?? params.sessionEntry;
  const activeSessionStore = params.sessionStore;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    activeSessionEntry?.systemPromptReport ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.systemPromptReport : undefined),
  );
  const flushRunId = memoryDeps.randomUUID();
  if (params.sessionKey) {
    memoryDeps.registerAgentRunContext(flushRunId, {
      sessionKey: params.sessionKey,
      ...(activeSessionEntry?.sessionId ? { sessionId: activeSessionEntry.sessionId } : {}),
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let memoryCompactionCompleted = false;
  let outcome: MemoryFlushOutcome = "completed";
  let visibleErrorPayloads: ReplyPayload[] = [];
  const memoryFlushNowMs = memoryDeps.now();
  const activeMemoryFlushPlan =
    resolveMemoryFlushPlan({
      cfg: params.cfg,
      nowMs: memoryFlushNowMs,
    }) ?? memoryFlushPlan;
  const memoryFlushWritePath = activeMemoryFlushPlan.relativePath;
  await memoryDeps.ensureMemoryFlushTargetFile({
    workspaceDir: params.followupRun.run.workspaceDir,
    relativePath: memoryFlushWritePath,
  });
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    activeMemoryFlushPlan.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  let postCompactionSessionId: string | undefined;
  let postCompactionSessionFile: string | undefined;
  try {
    await memoryDeps.runWithModelFallback({
      ...resolveMemoryFlushModelFallbackOptions(
        params.followupRun.run,
        activeMemoryFlushPlan.model,
        params.cfg,
      ),
      runId: flushRunId,
      sessionId: activeSessionEntry?.sessionId ?? params.followupRun.run.sessionId,
      lane: CommandLane.Main,
      abortSignal: params.replyOperation.abortSignal,
      resolveAgentHarnessRuntimeOverride: (provider) =>
        resolveSessionRuntimeOverrideForProvider({
          provider,
          entry: activeSessionEntry,
          cfg: params.cfg,
        }),
      prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
        await memoryDeps.ensureSelectedAgentHarnessPlugin({
          config: params.cfg,
          provider,
          modelId: model,
          agentId: params.followupRun.run.agentId,
          sessionKey:
            params.runtimePolicySessionKey ??
            params.followupRun.run.runtimePolicySessionKey ??
            params.sessionKey,
          agentHarnessId: agentHarnessRuntimeOverride,
          agentHarnessRuntimeOverride,
          workspaceDir: params.followupRun.run.workspaceDir,
        });
      },
      run: async (provider, model, runOptions) => {
        const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
          provider,
          entry: activeSessionEntry,
          cfg: params.cfg,
        });
        const candidateThinkLevel = resolveCandidateThinkingLevel({
          cfg: params.cfg,
          provider,
          modelId: model,
          level: params.followupRun.run.thinkLevel,
          agentId: params.followupRun.run.agentId,
          sessionKey:
            params.runtimePolicySessionKey ??
            params.followupRun.run.runtimePolicySessionKey ??
            params.sessionKey,
          sessionEntry: activeSessionEntry,
          agentRuntime: sessionRuntimeOverride,
        });
        const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
          run: { ...params.followupRun.run, thinkLevel: candidateThinkLevel },
          replyRoute: params.followupRun,
          sessionCtx: params.sessionCtx,
          hasRepliedRef: params.opts?.hasRepliedRef,
          provider,
          model,
          runId: flushRunId,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
        });
        const result = await memoryDeps.runEmbeddedAgent({
          ...embeddedContext,
          ...senderContext,
          ...runBaseParams,
          agentHarnessId: sessionRuntimeOverride,
          agentHarnessRuntimeOverride: sessionRuntimeOverride,
          sandboxSessionKey: params.runtimePolicySessionKey,
          allowGatewaySubagentBinding: true,
          silentExpected: true,
          trigger: "memory",
          memoryFlushWritePath,
          prompt: activeMemoryFlushPlan.prompt,
          transcriptPrompt: "",
          extraSystemPrompt: flushSystemPrompt,
          isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature:
            bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
          abortSignal: params.replyOperation.abortSignal,
          replyOperation: params.replyOperation,
          onAgentEvent: (evt) => {
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              if (phase === "end") {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
        visibleErrorPayloads = resolveVisibleMemoryFlushErrorPayloads(result.payloads);
        if (result.meta?.agentMeta?.sessionId) {
          postCompactionSessionId = result.meta.agentMeta.sessionId;
        }
        if (result.meta?.agentMeta?.sessionFile) {
          postCompactionSessionFile = result.meta.agentMeta.sessionFile;
        }
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
    });
    const flushedCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    if (memoryCompactionCompleted) {
      const previousSessionId = activeSessionEntry?.sessionId ?? params.followupRun.run.sessionId;
      await memoryDeps.incrementCompactionCount({
        cfg: params.cfg,
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        newSessionId: postCompactionSessionId,
        newSessionFile: postCompactionSessionFile,
      });
      const updatedEntry = params.sessionKey ? activeSessionStore?.[params.sessionKey] : undefined;
      if (updatedEntry) {
        activeSessionEntry = updatedEntry;
        params.followupRun.run.sessionId = updatedEntry.sessionId;
        params.replyOperation.updateSessionId(updatedEntry.sessionId);
        if (updatedEntry.sessionFile) {
          params.followupRun.run.sessionFile = updatedEntry.sessionFile;
        }
        const queueKey = params.followupRun.run.sessionKey ?? params.sessionKey;
        if (queueKey) {
          memoryDeps.refreshQueuedFollowupSession({
            key: queueKey,
            previousSessionId,
            nextSessionId: updatedEntry.sessionId,
            nextSessionFile: updatedEntry.sessionFile,
          });
        }
      }
    }
    if (visibleErrorPayloads.length > 0) {
      // Preserve any completed transcript rotation, then count the maintenance error.
      // Do not stamp memory-flush success for a resolved run that returned an error.
      throw buildVisibleMemoryFlushFailure(visibleErrorPayloads);
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await memoryDeps.updateSessionEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          skipMaintenance: true,
          takeCacheOwnership: true,
          update: async () => ({
            memoryFlushAt: memoryDeps.now(),
            memoryFlushCompactionCount: flushedCompactionCount,
            memoryFlushFailureCount: 0,
            memoryFlushLastFailedAt: undefined,
            memoryFlushLastFailureError: undefined,
          }),
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
          params.followupRun.run.sessionId = updatedEntry.sessionId;
          params.replyOperation.updateSessionId(updatedEntry.sessionId);
          if (updatedEntry.sessionFile) {
            params.followupRun.run.sessionFile = updatedEntry.sessionFile;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
  } catch (err) {
    outcome = "failed";
    const truncatedError = truncateMemoryFlushErrorMessage(err);
    if (!isAbortError(err) && params.storePath && params.sessionKey) {
      try {
        const failedAt = memoryDeps.now();
        const failedEntry = await memoryDeps.updateSessionEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          skipMaintenance: true,
          takeCacheOwnership: true,
          update: async (sessionEntry) => ({
            memoryFlushFailureCount: Math.max(0, sessionEntry.memoryFlushFailureCount ?? 0) + 1,
            memoryFlushLastFailedAt: failedAt,
            memoryFlushLastFailureError: truncatedError,
          }),
        });
        if (failedEntry) {
          activeSessionEntry = failedEntry;
          if (activeSessionStore) {
            activeSessionStore[params.sessionKey] = failedEntry;
          }
        }
        const failureCount = Math.max(0, failedEntry?.memoryFlushFailureCount ?? 0);
        logVerbose(
          `memory flush failed (attempt ${failureCount}/${MAX_FLUSH_FAILURES}): ${truncatedError}`,
        );
        memoryDeps.emitAgentEvent({
          runId: flushRunId,
          stream: "lifecycle",
          sessionKey: params.sessionKey,
          sessionId: activeSessionEntry?.sessionId,
          data: {
            phase: "memory_flush_failed",
            attempt: failureCount,
            maxAttempts: MAX_FLUSH_FAILURES,
            error: truncatedError,
          },
        });
        if (failedEntry && failureCount >= MAX_FLUSH_FAILURES) {
          outcome = "exhausted";
          logVerbose(
            `memory flush exhausted: skipping flush for this compaction cycle after ${failureCount} consecutive failures`,
          );
          memoryDeps.emitAgentEvent({
            runId: flushRunId,
            stream: "lifecycle",
            sessionKey: params.sessionKey,
            sessionId: failedEntry.sessionId,
            data: {
              phase: "memory_flush_exhausted",
              attempt: failureCount,
              maxAttempts: MAX_FLUSH_FAILURES,
            },
          });
          const exhaustedEntry = await memoryDeps.updateSessionEntry({
            storePath: params.storePath,
            sessionKey: params.sessionKey,
            skipMaintenance: true,
            takeCacheOwnership: true,
            update: async (sessionEntry) => ({
              memoryFlushAt: memoryDeps.now(),
              memoryFlushCompactionCount: sessionEntry.compactionCount ?? 0,
            }),
          });
          if (exhaustedEntry) {
            activeSessionEntry = exhaustedEntry;
            if (activeSessionStore) {
              activeSessionStore[params.sessionKey] = exhaustedEntry;
            }
          }
          params.onVisibleErrorPayloads?.([
            {
              text: `⚠️ Memory flush failed after ${MAX_FLUSH_FAILURES} attempts; skipping for this cycle. It will retry after the next compaction.`,
              isError: true,
            },
          ]);
        }
      } catch (persistErr) {
        logVerbose(`failed to persist memory flush failure metadata: ${String(persistErr)}`);
      }
    } else {
      logVerbose(`memory flush run failed: ${String(err)}`);
    }
    const visibleErrorPayload = buildMemoryFlushErrorPayload(err);
    if (visibleErrorPayload) {
      params.onVisibleErrorPayloads?.([visibleErrorPayload]);
    }
  }

  return { sessionEntry: activeSessionEntry, outcome };
}
