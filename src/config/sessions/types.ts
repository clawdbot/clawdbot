// Session store types define durable per-session metadata and merge/usage helpers.
import crypto from "node:crypto";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpIdentity,
  SessionAcpMeta,
} from "@openclaw/acp-core/types";
import { normalizeOptionalString, type FastMode } from "@openclaw/normalization-core/string-coerce";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionAgentStatus } from "../../../packages/gateway-protocol/src/session-icon.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { CronScheduledToolPolicy } from "../../cron/scheduled-tool-policy.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import type { Skill } from "../../skills/loading/skill-contract.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { TtsAutoMode } from "../types.tts.js";
import type { MainRestartRecoveryState } from "./main-session-recovery.types.js";
import type { SessionRestartRecoveryState } from "./restart-recovery-types.js";
import type {
  SessionCreatedActor,
  SessionCreatedVia,
  SessionEntryProvenance,
} from "./session-entry-provenance.js";
import { rewriteSessionFileForNewSessionId } from "./session-file-rotation.js";
import type { AgentPatchedSessionModelFallback } from "./session-model-fallback.js";

export type SessionScope = "per-sender" | "global";
export type SessionChatType = ChatType;
type SessionVisibility = "shared" | "read-only" | "suggest" | "draft";

export type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  accountId?: string;
  threadId?: string | number;
};

/** Canonical persisted delivery ownership for one session. */
export type SessionDeliveryState =
  | { kind: "none" }
  | { kind: "internal" }
  | {
      kind: "external";
      route: ChannelRouteRef;
      context: DeliveryContext;
      origin: SessionOrigin;
    };

export type { AcpSessionRuntimeOptions, SessionAcpIdentity, SessionAcpMeta };

export type CliSessionReseedReceipt = {
  version: 1;
  promptHash: string;
  localSessionId: string;
  userTurnDisposition: "persisted" | "omitted";
};

export type CliSessionBinding = {
  sessionId: string;
  /** Resume with the backend's fork argument once, then clear before process start. */
  forkNextResume?: true;
  /** Trust an explicitly attached CLI session even when auth, prompt, or MCP fingerprints drift. */
  forceReuse?: boolean;
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion?: number;
  extraSystemPromptHash?: string;
  messageToolPolicyHash?: string;
  promptToolNamesHash?: string;
  cwdHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  /** Identifies one synthetic history prompt and the trusted local handling of its user turn. */
  reseedReceipt?: CliSessionReseedReceipt;
};

export type SessionCompactionCheckpointReason =
  | "manual"
  | "auto-threshold"
  | "overflow-retry"
  | "timeout-retry";

type SessionCompactionTranscriptReference = {
  sessionId: string;
  sessionFile?: string;
  leafId?: string;
  entryId?: string;
};

export type SessionCompactionCheckpoint = {
  checkpointId: string;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  reason: SessionCompactionCheckpointReason;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
  preCompaction: SessionCompactionTranscriptReference;
  postCompaction: SessionCompactionTranscriptReference;
};

type SessionContextBudgetStatusRoute =
  | "fits"
  | "compact_only"
  | "truncate_tool_results_only"
  | "compact_then_truncate";

export type SessionContextBudgetStatus = {
  schemaVersion: 1;
  source: "pre-prompt-estimate";
  updatedAt: number;
  provider: string;
  model: string;
  route: SessionContextBudgetStatusRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  contextTokenBudget: number;
  promptBudgetBeforeReserve: number;
  reserveTokens: number;
  effectiveReserveTokens: number;
  remainingPromptBudgetTokens: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  messageCount: number;
  unwindowedMessageCount: number;
  sessionId?: string;
};

export type AmbientTranscriptWatermark = {
  sessionId: string;
  messageId: string;
  timestampMs?: number;
  updatedAt: number;
};

type SessionPluginDebugEntry = {
  pluginId: string;
  lines: string[];
};

export type SessionPluginJsonValue =
  | string
  | number
  | boolean
  | null
  | SessionPluginJsonValue[]
  | { [key: string]: SessionPluginJsonValue };

type SessionPluginNextTurnInjection = {
  id: string;
  pluginId: string;
  pluginName?: string;
  text: string;
  idempotencyKey?: string;
  placement: "prepend_context" | "append_context";
  ttlMs?: number;
  createdAt: number;
  metadata?: SessionPluginJsonValue;
};

type SubagentRecoveryState = {
  /** Consecutive accepted automatic orphan-recovery resumes in the rapid re-wedge window. */
  automaticAttempts?: number;
  /** Timestamp (ms) of the latest accepted automatic orphan-recovery resume. */
  lastAttemptAt?: number;
  /** Registry run id that triggered the latest automatic orphan-recovery resume. */
  lastRunId?: string;
  /** Timestamp (ms) when automatic recovery was tombstoned for this session. */
  wedgedAt?: number;
  /** Human-readable reason automatic recovery was tombstoned. */
  wedgedReason?: string;
};

type LaneExecutionState =
  | "active"
  | "draining"
  | "suspended"
  | "resuming"
  | "circuit_open"
  | "failed_handoff";

export interface QuotaSuspension {
  schemaVersion: 1;
  suspendedAt: number; // epoch ms
  reason: "quota_exhausted" | "manual" | "circuit_open";
  failedProvider: string;
  failedModel: string;
  /** Recovery briefing text injected into the next attempt when state === "resuming". */
  summary?: string;
  /** Opaque pointer to an external snapshot blob (path/key); not the briefing text itself. */
  snapshotRef?: string;
  /** Lane that was set to concurrency=0 when this suspension was issued. */
  laneId?: string;
  expectedResumeBy?: number; // Reaper TTL (e.g. 30min)
  state: LaneExecutionState; // State machine check for hot-path
}

export type SessionGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export type SessionGoal = {
  schemaVersion: 1;
  id: string;
  objective: string;
  status: SessionGoalStatus;
  createdAt: number;
  updatedAt: number;
  tokenStart: number;
  tokenStartFresh?: boolean;
  tokensUsed: number;
  tokenBudget?: number;
  continuationTurns: number;
  lastStatusNote?: string;
  pausedAt?: number;
  blockedAt?: number;
  completedAt?: number;
  usageLimitedAt?: number;
  budgetLimitedAt?: number;
};

export type PendingSkillSuggestion = {
  skillName: string;
  detectedAt: number;
};

export type RestartRecoveryRun = {
  runId: string;
  lifecycleGeneration: string;
};

export type SessionEntry = SessionRestartRecoveryState &
  SessionEntryProvenance & {
    /** Collaboration mode. Missing legacy values are equivalent to "shared". */
    visibility?: SessionVisibility;
    /**
     * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
     * Stored on the main session entry.
     */
    lastHeartbeatText?: string;
    /** Timestamp (ms) when lastHeartbeatText was delivered. */
    lastHeartbeatSentAt?: number;
    /**
     * Base session key for heartbeat-created isolated sessions.
     * When present, `<base>:heartbeat` is a synthetic isolated session rather than
     * a real user/session-scoped key that merely happens to end with `:heartbeat`.
     */
    heartbeatIsolatedBaseSessionKey?: string;
    /** Legacy heartbeat task timestamps consumed and cleared only by doctor migration. */
    heartbeatTaskState?: Record<string, number>;
    /** Plugin-owned session state, grouped by plugin id then extension namespace. */
    pluginExtensions?: Record<string, Record<string, SessionPluginJsonValue>>;
    /** Trusted session initialization is incomplete; all work admission stays blocked. */
    initializationPending?: true;
    /** Top-level SessionEntry mirror slots owned by plugin session extensions. */
    pluginExtensionSlotKeys?: Record<string, Record<string, string>>;
    /** Durable one-shot prompt additions drained before the next agent turn. */
    pluginNextTurnInjections?: Record<string, SessionPluginNextTurnInjection[]>;
    sessionId: string;
    updatedAt: number;
    /** Process-lifetime session whose entry and transcript stay in the in-memory agent database. */
    incognito?: true;
    /** Opaque owner revision used to reject stale lifecycle mutations. */
    lifecycleRevision?: string;
    // archivedAt/pinnedAt mirror the Codex thread-management shape (state DB
    // threads.archived_at: the boolean is always derived from the timestamp and
    // stamped server-side). Codex serializes camelCase but in epoch SECONDS;
    // these are epoch MS like every other session timestamp — convert at the
    // codex plugin seam when exchanging thread metadata.
    /** Timestamp (ms) when the session was archived from active session lists. */
    archivedAt?: number;
    /** Actor that archived the session; cleared when the session is restored. */
    archivedBy?: SessionCreatedActor;
    /** Timestamp (ms) when the session was pinned for quick access. */
    pinnedAt?: number;
    /** Custom sidebar icon in the format accepted by the gateway protocol session-icon helper. */
    icon?: string;
    /** Timestamp (ms) when an operator client last marked the session read. */
    lastReadAt?: number;
    /** Agent-declared sidebar presence; projection drops it after expiresAt. */
    agentStatus?: SessionAgentStatus;
    /** Latest utility-model status judgment for idle session status surfaces. */
    observerDigest?: SessionObserverDigest;
    /** Timestamp (ms) when an operator explicitly marked the session unread; cleared on read. */
    markedUnreadAt?: number;
    /** Timestamp (ms) of the latest completed agent run; metadata patches do not update it. */
    lastActivityAt?: number;
    sessionFile?: string;
    /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
    spawnedBy?: string;
    /** Immutable session key authorized to receive this child's completion handoff. */
    completionOwnerSessionKey?: string;
    /** Workspace inherited by spawned sessions and reused on later turns for the same child session. */
    spawnedWorkspaceDir?: string;
    /** Task working directory inherited by spawned sessions and reused on later turns. */
    spawnedCwd?: string;
    /**
     * Managed worktree bound to this session; set with spawnedCwd at worktree
     * creation and cleared together when a plain New Chat detaches the checkout.
     */
    worktree?: { id: string; branch: string; repoRoot: string };
    /** Explicit parent session linkage for dashboard-created child sessions. */
    parentSessionKey?: string;
    /** How this session node came to exist; written once and retained across sessionId rotations. */
    createdVia?: SessionCreatedVia;
    /** Actor that caused node creation, with an optional profile, session, or sender id; written once. */
    createdActor?: SessionCreatedActor;
    /** Node creation time (ms); unlike sessionStartedAt, survives sessionId rotations. */
    createdAt?: number;
    /** Exact source generation and optional cut entry for an actual transcript-copy fork. */
    forkSource?: { sessionKey: string; sessionId: string; entryId?: string };
    /** Session id of the prior transcript generation under this same session key. */
    previousSessionId?: string;
    /** Thread parent-seeding settled marker; also set when seeding is deliberately skipped. */
    forkedFromParent?: boolean;
    /** Subagent spawn depth (0 = main, 1 = sub-agent, 2 = sub-sub-agent). */
    spawnDepth?: number;
    /** Explicit role assigned at spawn time for subagent tool policy/control decisions. */
    subagentRole?: "orchestrator" | "leaf";
    /** Explicit control scope assigned at spawn time for subagent control decisions. */
    subagentControlScope?: "children" | "none";
    /** Version of the requester tool-policy snapshot captured when this child was spawned. */
    inheritedToolPolicyVersion?: 1;
    /** Session-scoped tool deny entries inherited from the caller that created this session. */
    inheritedToolDeny?: string[];
    /** Session-scoped tool allow entries inherited from the caller that created this session. */
    inheritedToolAllow?: string[];
    systemSent?: boolean;
    abortedLastRun?: boolean;
    /** Interrupted run generations whose late lifecycle events must be ignored. */
    restartRecoveryRuns?: RestartRecoveryRun[];
    /** Keeps automatic restart recovery limited to replay-safe tools until the run terminates. */
    restartRecoveryForceSafeTools?: true;
    /** Durable guard state for automatic subagent orphan recovery. */
    subagentRecovery?: SubagentRecoveryState;
    /** Quota cascade protection and state-aware failover status. */
    quotaSuspension?: QuotaSuspension;
    /** Core-owned durable goal state for this thread/session. */
    goal?: SessionGoal;
    /** Durable one-shot Skill Workshop suggestion for the next interactive turn. */
    pendingSkillSuggestion?: PendingSkillSuggestion;
    /** Recent durable-instruction fingerprints already processed by Skill Workshop capture. */
    skillCaptureSignalHashes?: string[];
    /** Timestamp (ms) when the current sessionId first became active. */
    sessionStartedAt?: number;
    /** Stable usage lineage key for transcript-backed rollups across sessionId rotations. */
    usageFamilyKey?: string;
    /** Session ids known to belong to this usage lineage, including archived predecessors. */
    usageFamilySessionIds?: string[];
    /** Timestamp (ms) of the last user/channel interaction that should extend idle lifetime. */
    lastInteractionAt?: number;
    /** Stable first-run start time for subagent sessions, persisted after completion. */
    startedAt?: number;
    /** Latest completed run end time for subagent sessions, persisted after completion. */
    endedAt?: number;
    /** Accumulated runtime across subagent follow-up runs, persisted after completion. */
    runtimeMs?: number;
    /** Final persisted subagent run status, used after in-memory run archival. */
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    /** Compact user-facing reason for the latest failed or timed-out run. */
    lastRunError?: string;
    /**
     * Session-level stop cutoff captured when /stop is received.
     * Messages at/before this boundary are skipped to avoid replaying
     * queued pre-stop backlog.
     */
    abortCutoffMessageSid?: string;
    /** Epoch ms cutoff paired with abortCutoffMessageSid when available. */
    abortCutoffTimestamp?: number;
    chatType?: SessionChatType;
    thinkingLevel?: string;
    /**
     * Exact isolated-cron continuation policy. Only hidden `:run:` session rows
     * carry this while detached generated-media work may still wake the run.
     */
    cronRunContinuation?: {
      lifecycleRevision: string;
      phase: "running" | "ready" | "continuing";
      /** True only after this row's session changes were projected to the stable cron row. */
      basePersisted?: boolean;
      ownerRunId?: string;
      /** Gateway lifecycle generation that owns a continuing claim. */
      ownerLifecycleGeneration?: string;
      /** CLI backend whose native session must exist before media work detaches. */
      cliExecutionProvider?: string;
      toolsAllow?: string[];
      toolsAllowIsDefault?: boolean;
      /** Exact server-stamped authority provenance copied from the owning cron job. */
      scheduledToolPolicy?: CronScheduledToolPolicy;
      cliSessionBindingFacts?: {
        extraSystemPromptStatic?: string;
        sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
        requireExplicitMessageTarget?: boolean;
      };
    };
    fastMode?: FastMode;
    /** Swarm group for collector-mode child sessions. */
    swarmGroupId?: string;
    /** Marks non-interactive collector-mode child sessions. */
    swarmCollector?: boolean;
    /** JSON Schema exposed through the synthetic structured_output tool. */
    swarmOutputSchema?: Record<string, unknown>;
    verboseLevel?: string;
    traceLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
    ttsAuto?: TtsAutoMode;
    /** Hash of the latest assistant reply that was sent through `/tts latest`. */
    lastTtsReadLatestHash?: string;
    /** Timestamp (ms) when `/tts latest` last sent audio for this session. */
    lastTtsReadLatestAt?: number;
    execHost?: string;
    execSecurity?: string;
    execAsk?: string;
    execNode?: string;
    /** Working directory interpreted only by the bound exec node. */
    execCwd?: string;
    responseUsage?: "on" | "off" | "tokens" | "full";
    providerOverride?: string;
    modelOverride?: string;
    /** Session-scoped agent runtime/harness override selected with the model picker. */
    agentRuntimeOverride?: string;
    /**
     * Tracks whether the persisted model override came from an explicit user
     * action (`/model`, `sessions.patch`) or from a temporary runtime fallback.
     * Resets only preserve user-driven overrides.
     */
    modelOverrideSource?: "auto" | "user";
    /** Selected model that produced the current auto fallback override. */
    modelOverrideFallbackOriginProvider?: string;
    modelOverrideFallbackOriginModel?: string;
    /** One-run rollback guard for a model selected by the agent sessions tool. */
    modelFallback?: AgentPatchedSessionModelFallback;
    authProfileOverride?: string;
    authProfileOverrideSource?: "auto" | "user";
    authProfileOverrideCompactionCount?: number;
    /**
     * Set on explicit user-driven session model changes (for example `/model`
     * and `sessions.patch`) during an active run. The embedded runner checks
     * this flag to decide whether to throw `LiveSessionModelSwitchError`.
     * System-initiated fallbacks (rate-limit retry rotation) never set this
     * flag, so they are never mistaken for user-initiated switches.
     */
    liveModelSwitchPending?: boolean;
    groupActivation?: "mention" | "always";
    groupActivationNeedsSystemIntro?: boolean;
    sendPolicy?: "allow" | "deny";
    queueMode?: "steer" | "followup" | "collect" | "interrupt";
    queueDebounceMs?: number;
    queueCap?: number;
    queueDrop?: "old" | "new" | "summarize";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /** Durable marker that final user reply delivery still needs a retry/resume pass. */
    pendingFinalDelivery?: boolean;
    pendingFinalDeliveryCreatedAt?: number;
    pendingFinalDeliveryLastAttemptAt?: number;
    pendingFinalDeliveryAttemptCount?: number;
    pendingFinalDeliveryLastError?: string | null;
    /** Frozen reply text that needs delivery. */
    pendingFinalDeliveryText?: string | null;
    /** Original delivery context (channel, recipient, etc). */
    pendingFinalDeliveryContext?: DeliveryContext;
    /** Durable send intent backing pending final delivery, when already created. */
    pendingFinalDeliveryIntentId?: string | null;
    /**
     * Whether totalTokens reflects a fresh context snapshot for the latest run.
     * Undefined means legacy/unknown freshness; false forces consumers to treat
     * totalTokens as stale/unknown for context-utilization displays.
     */
    totalTokensFresh?: boolean;
    estimatedCostUsd?: number;
    cacheRead?: number;
    cacheWrite?: number;
    modelProvider?: string;
    model?: string;
    /**
     * Prevents OpenClaw model changes and automatic maintenance eviction until
     * the owning harness explicitly retires the session.
     */
    modelSelectionLocked?: boolean;
    /**
     * Embedded agent harness selected for this session id.
     * Prevents config/env changes from moving an existing transcript between
     * incompatible runtime harnesses.
     */
    agentHarnessId?: string;
    /**
     * Last selected/runtime model pair for which a fallback notice was emitted.
     * Used to avoid repeating the same fallback notice every turn.
     */
    fallbackNoticeSelectedModel?: string;
    fallbackNoticeActiveModel?: string;
    fallbackNoticeReason?: string;
    contextTokens?: number;
    contextBudgetStatus?: SessionContextBudgetStatus;
    compactionCount?: number;
    compactionCheckpoints?: SessionCompactionCheckpoint[];
    memoryFlushAt?: number;
    memoryFlushCompactionCount?: number;
    memoryFlushContextHash?: string;
    /** Consecutive memory flush failures since the last successful flush. */
    memoryFlushFailureCount?: number;
    /** Timestamp (ms) of the last failed memory flush attempt. */
    memoryFlushLastFailedAt?: number;
    /** Last memory flush failure error message, truncated for durable metadata. */
    memoryFlushLastFailureError?: string;
    cliSessionIds?: Record<string, string>;
    cliSessionBindings?: Record<string, CliSessionBinding>;
    claudeCliSessionId?: string;
    label?: string;
    /** User-defined organization bucket for session lists; unrelated to chat groupId/groupChannel. */
    category?: string;
    displayName?: string;
    /** Canonical delivery state. Legacy delivery fields are migrated by `openclaw doctor --fix`. */
    delivery?: SessionDeliveryState;
    groupId?: string;
    subject?: string;
    groupChannel?: string;
    space?: string;
    /** Last ambient room message durably appended to this transcript, keyed by channel scope. */
    ambientTranscriptWatermarks?: Record<string, AmbientTranscriptWatermark>;
    skillsSnapshot?: SessionSkillSnapshot;
    systemPromptReport?: SessionSystemPromptReport;
    /**
     * Generic plugin-owned runtime debug entries shown in verbose status surfaces.
     * Each plugin owns and may overwrite only its own entry between turns.
     */
    pluginDebugEntries?: SessionPluginDebugEntry[];
    acp?: SessionAcpMeta;
  };

/** Internal durable fields excluded from public/plugin session projections. */
export type InternalSessionEntry = SessionEntry & {
  mainRestartRecovery?: MainRestartRecoveryState;
};

export function isTerminalSessionStatus(
  status: unknown,
): status is Exclude<NonNullable<SessionEntry["status"]>, "running"> {
  return status === "done" || status === "failed" || status === "killed" || status === "timeout";
}

function isSessionPluginTraceLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("🔎 ") || /(?:^|\s)(?:Debug|Trace):/.test(trimmed);
}

function resolveSessionPluginLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
  includeLine: (line: string) => boolean,
): string[] {
  // Status and trace surfaces share the same plugin-owned lines but apply different filters.
  return Array.isArray(entry?.pluginDebugEntries)
    ? entry.pluginDebugEntries.flatMap((pluginEntry) =>
        Array.isArray(pluginEntry?.lines)
          ? pluginEntry.lines.filter(
              (line): line is string =>
                typeof line === "string" && line.trim().length > 0 && includeLine(line),
            )
          : [],
      )
    : [];
}

export function resolveSessionPluginStatusLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
): string[] {
  return resolveSessionPluginLines(entry, (line) => !isSessionPluginTraceLine(line));
}

export function resolveSessionPluginTraceLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
): string[] {
  return resolveSessionPluginLines(entry, isSessionPluginTraceLine);
}

export function normalizeSessionRuntimeModelFields(entry: SessionEntry): SessionEntry {
  const normalizedModel = normalizeOptionalString(entry.model);
  const normalizedProvider = normalizeOptionalString(entry.modelProvider);
  let next = entry;

  if (!normalizedModel) {
    // A model without a valid provider/model pair is not durable runtime metadata.
    if (entry.model !== undefined || entry.modelProvider !== undefined) {
      next = { ...next };
      delete next.model;
      delete next.modelProvider;
    }
    return next;
  }

  if (entry.model !== normalizedModel) {
    if (next === entry) {
      next = { ...next };
    }
    next.model = normalizedModel;
  }

  if (!normalizedProvider) {
    if (entry.modelProvider !== undefined) {
      if (next === entry) {
        next = { ...next };
      }
      delete next.modelProvider;
    }
    return next;
  }

  if (entry.modelProvider !== normalizedProvider) {
    if (next === entry) {
      next = { ...next };
    }
    next.modelProvider = normalizedProvider;
  }
  return next;
}

export function setSessionRuntimeModel(
  entry: SessionEntry,
  runtime: { provider: string; model: string },
): boolean {
  const provider = runtime.provider.trim();
  const model = runtime.model.trim();
  if (!provider || !model) {
    return false;
  }
  entry.modelProvider = provider;
  entry.model = model;
  return true;
}

type SessionEntryMergePolicy = "touch-activity" | "preserve-activity";

type MergeSessionEntryOptions = {
  policy?: SessionEntryMergePolicy;
  now?: number;
};

function resolveMergedUpdatedAt(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): number {
  const now = options?.now ?? Date.now();
  const existingUpdatedAt = normalizeMergedUpdatedAt(existing?.updatedAt, now);
  const patchUpdatedAt = normalizeMergedUpdatedAt(patch.updatedAt, now);
  if (options?.policy === "preserve-activity" && existing) {
    return existingUpdatedAt ?? patchUpdatedAt ?? now;
  }
  return Math.max(existingUpdatedAt ?? 0, patchUpdatedAt ?? 0, now);
}

function normalizeMergedUpdatedAt(value: number | undefined, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(value, now);
}

function mergeSessionEntryWithPolicy(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = resolveMergedUpdatedAt(existing, patch, options);
  if (!existing) {
    return normalizeSessionRuntimeModelFields({
      ...patch,
      sessionId,
      updatedAt,
      sessionStartedAt: patch.sessionStartedAt ?? updatedAt,
    });
  }
  const next = {
    ...existing,
    ...patch,
    sessionId,
    updatedAt,
    sessionStartedAt:
      patch.sessionStartedAt ??
      (existing.sessionId === sessionId ? existing.sessionStartedAt : updatedAt),
  };

  // Node creation and exact fork ancestry are write-once; patches may only fill absent values.
  if (existing.createdVia !== undefined) {
    next.createdVia = existing.createdVia;
  }
  if (existing.createdActor !== undefined) {
    next.createdActor = existing.createdActor;
  }
  if (existing.createdAt !== undefined) {
    next.createdAt = existing.createdAt;
  }
  if (existing.forkSource !== undefined) {
    next.forkSource = existing.forkSource;
  }

  if (existing.sessionId !== sessionId) {
    // Session id rotations should move transcript paths when they match known reset/fork shapes.
    const patchHasSessionFile = Object.hasOwn(patch, "sessionFile");
    const candidateSessionFile = patchHasSessionFile ? patch.sessionFile : existing.sessionFile;
    const rewrittenSessionFile = rewriteSessionFileForNewSessionId({
      sessionFile: candidateSessionFile,
      previousSessionId: existing.sessionId,
      nextSessionId: sessionId,
    });
    if (rewrittenSessionFile) {
      next.sessionFile = rewrittenSessionFile;
    }
  }

  // Guard against stale provider carry-over when callers patch runtime model
  // without also patching runtime provider.
  if (Object.hasOwn(patch, "model") && !Object.hasOwn(patch, "modelProvider")) {
    const patchedModel = normalizeOptionalString(patch.model);
    const existingModel = normalizeOptionalString(existing.model);
    if (patchedModel && patchedModel !== existingModel) {
      delete next.modelProvider;
    }
  }
  return normalizeSessionRuntimeModelFields(next);
}

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch);
}

export function mergeSessionEntryPreserveActivity(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch, {
    policy: "preserve-activity",
  });
}

export function resolveSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = entry?.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return undefined;
  }
  return total;
}

export function resolveFreshSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = resolveSessionTotalTokens(entry);
  if (total === undefined) {
    return undefined;
  }
  if (entry?.totalTokensFresh === false) {
    return undefined;
  }
  return total;
}

export type GroupKeyResolution = {
  key: string;
  channel?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillPromptRef = {
  version: 1;
  algorithm: "sha256";
  hash: string;
  bytes: number;
};

export type SessionSkillSnapshot = {
  prompt: string;
  /** Persisted stores may replace large duplicate prompts with a content-addressed blob ref. */
  promptRef?: SessionSkillPromptRef;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  /** Effective node-exec eligibility used to select connected node-hosted skills. */
  nodeSkillsEligibility?: { canExec: boolean; node?: string };
  /**
   * Runtime-only, never persisted. Carries the full parsed Skill[] (including
   * each SKILL.md body) so the embedded runner can skip a workspace skill
   * scan within a turn. Persistence projections strip it before committing
   * session state. On a cold session resume this is undefined and
   * src/skills/runtime/embedded-run-entries.ts rebuilds it from disk.
   */
  resolvedSkills?: Skill[];
  version?: number;
};

export type SessionSystemPromptReport = {
  source: "run" | "estimate";
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: {
    warningMode?: "off" | "once" | "always";
    warningShown?: boolean;
    promptWarningSignature?: string;
    warningSignaturesSeen?: string[];
    truncatedFiles?: number;
    nearLimitFiles?: number;
    totalNearLimit?: boolean;
  };
  sandbox?: {
    mode?: string;
    sandboxed?: boolean;
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
    hash?: string;
  };
  currentTurn?: {
    kind?: "user_request" | "room_event";
    promptChars: number;
    runtimeContextChars: number;
    // Hook prepend/append context sent to the model but absent from the
    // persisted transcript prompt; consumers add it on top of transcript sums.
    modelOnlyPromptChars?: number;
  };
  injectedWorkspaceFiles: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
  }>;
  skills: {
    promptChars: number;
    hash?: string;
    entries: Array<{ name: string; blockChars: number }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      summaryHash?: string;
      schemaChars: number;
      schemaHash?: string;
      propertiesCount?: number | null;
    }>;
  };
};

export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 0;
