import crypto from "node:crypto";
import fs from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import {
  derivePromptTokens,
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
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { resolveMemoryFlushPlan } from "../../plugins/memory-state.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import {
  buildEmbeddedRunExecutionParams,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveMaxActiveTranscriptBytes,
  resolveMemoryFlushContextWindowTokens,
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { incrementCompactionCount } from "./session-updates.js";

type PiEmbeddedRuntime = typeof import("../../agents/pi-embedded.js");

let piEmbeddedRuntimePromise: Promise<PiEmbeddedRuntime> | undefined;

function loadPiEmbeddedRuntime(): Promise<PiEmbeddedRuntime> {
  piEmbeddedRuntimePromise ??= import("../../agents/pi-embedded.js");
  return piEmbeddedRuntimePromise;
}

async function compactEmbeddedPiSessionDefault(
  ...args: Parameters<typeof import("../../agents/pi-embedded.js").compactEmbeddedPiSession>
): Promise<
  Awaited<ReturnType<typeof import("../../agents/pi-embedded.js").compactEmbeddedPiSession>>
> {
  const { compactEmbeddedPiSession } = await loadPiEmbeddedRuntime();
  return await compactEmbeddedPiSession(...args);
}

async function runEmbeddedPiAgentDefault(
  ...args: Parameters<typeof import("../../agents/pi-embedded.js").runEmbeddedPiAgent>
): Promise<Awaited<ReturnType<typeof import("../../agents/pi-embedded.js").runEmbeddedPiAgent>>> {
  const { runEmbeddedPiAgent } = await loadPiEmbeddedRuntime();
  return await runEmbeddedPiAgent(...args);
}

const memoryDeps = {
  compactEmbeddedPiSession: compactEmbeddedPiSessionDefault,
  runWithModelFallback,
  runEmbeddedPiAgent: runEmbeddedPiAgentDefault,
  registerAgentRunContext,
  refreshQueuedFollowupSession,
  incrementCompactionCount,
  updateSessionStoreEntry,
  randomUUID: () => crypto.randomUUID(),
  now: () => Date.now(),
};

export function setAgentRunnerMemoryTestDeps(overrides?: Partial<typeof memoryDeps>): void {
  Object.assign(memoryDeps, {
    runWithModelFallback,
    compactEmbeddedPiSession: compactEmbeddedPiSessionDefault,
    runEmbeddedPiAgent: runEmbeddedPiAgentDefault,
    registerAgentRunContext,
    refreshQueuedFollowupSession,
    incrementCompactionCount,
    updateSessionStoreEntry,
    randomUUID: () => crypto.randomUUID(),
    now: () => Date.now(),
    ...overrides,
  });
}

export function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
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

export function resolveEffectivePromptTokens(
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

export function resolveMemoryFlushModelFallbackOptions(
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

export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number;
  outputTokens?: number;
};

// Keep a generous near-threshold window so large assistant outputs still trigger
// transcript reads in time to flip memory-flush gating when needed.
const TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS = 8192;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;

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
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: opts?.storePath,
    });
    // Normalize sessionFile through resolveSessionFilePath so relative entries
    // are resolved against the sessions dir/store layout, not process.cwd().
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : sessionEntry,
      pathOpts,
    );
  } catch {
    return undefined;
  }
}

function deriveTranscriptUsageSnapshot(
  usage: ReturnType<typeof normalizeUsage> | undefined,
): SessionTranscriptUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = derivePromptTokens(usage);
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

  const snapshot: SessionLogSnapshot = {};

  if (params.includeByteSize) {
    try {
      const stat = await fs.promises.stat(logPath);
      const size = Math.floor(stat.size);
      snapshot.byteSize = Number.isFinite(size) && size >= 0 ? size : undefined;
    } catch {
      snapshot.byteSize = undefined;
    }
  }

  if (params.includeUsage) {
    try {
      const lastUsage = await readLastNonzeroUsageFromSessionLog(logPath);
      snapshot.usage = deriveTranscriptUsageSnapshot(lastUsage);
    } catch {
      snapshot.usage = undefined;
    }
  }

  return snapshot;
}

async function readLastNonzeroUsageFromSessionLog(logPath: string) {
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
      const combined = `${chunk}${leadingPartial}`;
      const lines = combined.split(/\n+/);
      leadingPartial = lines.shift() ?? "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const usage = parseUsageFromTranscriptLine(lines[i] ?? "");
        if (usage) {
          return usage;
        }
      }
      position = start;
    }
    return parseUsageFromTranscriptLine(leadingPartial);
  } finally {
    await handle.close();
  }
}

function estimatePromptTokensFromSessionTranscript(params: {
  sessionId?: string;
  storePath?: string;
  sessionFile?: string;
}): number | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  try {
    const messages = readSessionMessages(
      sessionId,
      params.storePath,
      params.sessionFile,
    ) as AgentMessage[];
    if (messages.length === 0) {
      return undefined;
    }
    const estimatedTokens = estimateMessagesTokens(messages);
    if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
      return undefined;
    }
    return Math.ceil(estimatedTokens);
  } catch {
    return undefined;
  }
}

export async function readPromptTokensFromSessionLog(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): Promise<SessionTranscriptUsageSnapshot | undefined> {
  const snapshot = await readSessionLogSnapshot({
    sessionId,
    sessionEntry,
    sessionKey,
    opts,
    includeByteSize: false,
    includeUsage: true,
  });
  return snapshot.usage;
}

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
}): Promise<SessionEntry | undefined> {
  if (!params.sessionKey) {
    return params.sessionEntry;
  }

  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!entry?.sessionId) {
    return entry ?? params.sessionEntry;
  }

  const isCli = isCliProvider(params.followupRun.run.provider, params.cfg);
  if (params.isHeartbeat || isCli) {
    return entry ?? params.sessionEntry;
  }

  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
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
  const maxActiveTranscriptBytes = resolveMaxActiveTranscriptBytes(params.cfg);
  const shouldCheckActiveTranscriptBytes = typeof maxActiveTranscriptBytes === "number";
  const transcriptSizeSnapshot = shouldCheckActiveTranscriptBytes
    ? await readSessionLogSnapshot({
        sessionId: entry.sessionId,
        sessionEntry: entry,
        sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
        opts: { storePath: params.storePath },
        includeByteSize: true,
        includeUsage: false,
      })
    : undefined;
  const activeTranscriptBytes = transcriptSizeSnapshot?.byteSize;
  const shouldCompactByTranscriptBytes =
    typeof activeTranscriptBytes === "number" &&
    typeof maxActiveTranscriptBytes === "number" &&
    activeTranscriptBytes >= maxActiveTranscriptBytes;
  const shouldUseTranscriptFallback = entry.totalTokensFresh === false || !hasPersistedTotalTokens;
  if (!shouldUseTranscriptFallback && !shouldCompactByTranscriptBytes) {
    return entry ?? params.sessionEntry;
  }
  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const transcriptPromptTokens =
    typeof freshPersistedTokens === "number"
      ? undefined
      : estimatePromptTokensFromSessionTranscript({
          sessionId: entry.sessionId,
          storePath: params.storePath,
          sessionFile: entry.sessionFile ?? params.followupRun.run.sessionFile,
        });
  const projectedTokenCount =
    typeof transcriptPromptTokens === "number"
      ? resolveEffectivePromptTokens(transcriptPromptTokens, undefined, promptTokenEstimate)
      : undefined;
  const tokenCountForCompaction =
    typeof projectedTokenCount === "number" &&
    Number.isFinite(projectedTokenCount) &&
    projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;

  const threshold = contextWindowTokens - reserveTokensFloor - softThresholdTokens;
  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${threshold} ` +
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
  const sessionFile = resolveSessionLogPath(
    entry.sessionId,
    entry.sessionFile ? entry : { ...entry, sessionFile: params.followupRun.run.sessionFile },
    params.sessionKey ?? params.followupRun.run.sessionKey,
    { storePath: params.storePath },
  );
  const result = await memoryDeps.compactEmbeddedPiSession({
    sessionId: entry.sessionId,
    sessionKey: params.sessionKey,
    sandboxSessionKey: params.runtimePolicySessionKey,
    allowGatewaySubagentBinding: true,
    messageChannel: params.followupRun.run.messageProvider,
    groupId: entry.groupId ?? params.followupRun.run.groupId,
    groupChannel: entry.groupChannel ?? params.followupRun.run.groupChannel,
    groupSpace: entry.space ?? params.followupRun.run.groupSpace,
    senderId: params.followupRun.run.senderId,
    senderName: params.followupRun.run.senderName,
    senderUsername: params.followupRun.run.senderUsername,
    senderE164: params.followupRun.run.senderE164,
    sessionFile: sessionFile ?? params.followupRun.run.sessionFile,
    workspaceDir: params.followupRun.run.workspaceDir,
    agentDir: params.followupRun.run.agentDir,
    config: params.cfg,
    skillsSnapshot: entry.skillsSnapshot ?? params.followupRun.run.skillsSnapshot,
    provider: params.followupRun.run.provider,
    model: params.followupRun.run.model,
    agentHarnessId:
      entry.sessionId === params.followupRun.run.sessionId ? entry.agentHarnessId : undefined,
    thinkLevel: params.followupRun.run.thinkLevel,
    bashElevated: params.followupRun.run.bashElevated,
    trigger: "budget",
    currentTokenCount: tokenCountForCompaction ?? freshPersistedTokens,
    senderIsOwner: params.followupRun.run.senderIsOwner,
    ownerNumbers: params.followupRun.run.ownerNumbers,
    abortSignal: params.replyOperation.abortSignal,
  });

  if (!result?.ok || !result.compacted) {
    logVerbose(
      `preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${result?.reason ?? "not_compacted"}`,
    );
    return entry ?? params.sessionEntry;
  }

  await incrementCompactionCount({
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
      memoryDeps.refreshQueuedFollowupSession({
        key: queueKey,
        previousSessionId,
        nextSessionId: entry.sessionId,
        nextSessionFile: entry.sessionFile,
      });
    }
  }
  return entry ?? params.sessionEntry;
}

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
}): Promise<SessionEntry | undefined> {
  const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
  if (!memoryFlushPlan) {
    return params.sessionEntry;
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

  const isCli = isCliProvider(params.followupRun.run.provider, params.cfg);
  const canAttemptFlush = memoryFlushWritable && !params.isHeartbeat && !isCli;
  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
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
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({ totalTokens: transcriptPromptTokens, totalTokensFresh: true }),
        });
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
    return entry ?? params.sessionEntry;
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
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let memoryCompactionCompleted = false;
  const memoryFlushNowMs = memoryDeps.now();
  const activeMemoryFlushPlan =
    resolveMemoryFlushPlan({
      cfg: params.cfg,
      nowMs: memoryFlushNowMs,
    }) ?? memoryFlushPlan;
  const memoryFlushWritePath = activeMemoryFlushPlan.relativePath;
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
      run: async (provider, model, runOptions) => {
        const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
          run: params.followupRun.run,
          sessionCtx: params.sessionCtx,
          hasRepliedRef: params.opts?.hasRepliedRef,
          provider,
          model,
          runId: flushRunId,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
        });
        const result = await memoryDeps.runEmbeddedPiAgent({
          ...embeddedContext,
          ...senderContext,
          ...runBaseParams,
          sandboxSessionKey: params.runtimePolicySessionKey,
          allowGatewaySubagentBinding: true,
          silentExpected: true,
          trigger: "memory",
          memoryFlushWritePath,
          prompt: activeMemoryFlushPlan.prompt,
          transcriptPrompt: "",
          extraSystemPrompt: flushSystemPrompt,
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
    let memoryFlushCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    if (memoryCompactionCompleted) {
      const previousSessionId = activeSessionEntry?.sessionId ?? params.followupRun.run.sessionId;
      const nextCount = await memoryDeps.incrementCompactionCount({
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
      if (typeof nextCount === "number") {
        memoryFlushCompactionCount = nextCount;
      }
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await memoryDeps.updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({
            memoryFlushAt: memoryDeps.now(),
            memoryFlushCompactionCount,
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
    logVerbose(`memory flush run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}
