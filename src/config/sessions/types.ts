// Session store types define durable per-session metadata and merge/usage helpers.
import crypto from "node:crypto";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpIdentity,
  SessionAcpMeta,
} from "@openclaw/acp-core/types";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString, type FastMode } from "@openclaw/normalization-core/string-coerce";
import type { SessionRow, SessionRunStatus } from "../../../packages/gateway-protocol/src/index.js";
import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SessionGoal } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionAgentStatus } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { ChatType } from "../../channels/chat-type.js";
import type {
  CronScheduledToolCallerOrigin,
  CronScheduledToolPolicy,
} from "../../cron/scheduled-tool-policy.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import type { SessionBoardFace } from "../../shared/session-types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { TtsAutoMode } from "../types.tts.js";
import type { MainRestartRecoveryState } from "./main-session-recovery.types.js";
import type {
  PendingDeliveryNoticeState,
  PendingFinalDeliveryState,
} from "./pending-final-delivery-types.js";
import type { SessionRestartRecoveryState } from "./restart-recovery-types.js";
import type {
  SessionCreatedActor,
  SessionCreatedVia,
  SessionEntryProvenance,
  SessionOwnerAssignment,
  SessionParticipant,
} from "./session-entry-provenance.js";
import type { AgentPatchedSessionModelFallback } from "./session-model-fallback.js";
import type { SessionSkillSnapshot } from "./session-prompt-types.js";
import type { SessionSystemPromptReport } from "./session-system-prompt-report.js";
import type { SessionToolOverrides } from "./session-tool-overrides.js";

export type { SessionToolOverrides } from "./session-tool-overrides.js";
export type { SessionSystemPromptReport } from "./session-system-prompt-report.js";

export type SessionScope = "per-sender" | "global";
export type SessionChatType = ChatType;
export const SESSION_TOTAL_TOKENS_VERSION = 1 as const;
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
  avatar?: string;
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

/**
 * Durable transcript-repair record: an assistant final that was delivered to
 * the user but could not be appended to the canonical transcript. Kept
 * separate from `pendingFinalDelivery` so transport-replay cleanup never drops
 * the only copy of the missing assistant turn.
 */
export type PendingTranscriptRepairState = {
  /** Stable identity for retry-safe transcript insertion. */
  id: string;
  text: string;
  provider?: string;
  model?: string;
  createdAt: number;
};

type FallbackNoticeState = {
  kind: "active";
  selectedModel: string;
  activeModel: string;
  reason?: string;
};

type MemoryFlushState =
  | { kind: "succeeded"; compactionCount: number }
  | {
      kind: "failed";
      compactionCount?: number;
      failureCount: number;
    };

export type { AcpSessionRuntimeOptions, SessionAcpIdentity, SessionAcpMeta };

export type CliSessionReseedReceipt = {
  version: 1;
  promptHash: string;
  localSessionId: string;
  userTurnDisposition: "persisted" | "omitted";
};

export type SessionDiffBaseline = {
  version: 1;
  sessionId: string;
  root: string;
  files: Array<{ path: string; fingerprint: string }>;
  /** Some checkout entries could not be fingerprinted without exceeding diff safety caps. */
  truncated?: true;
};

export type CliSessionBinding = {
  sessionId: string;
  /** Last successful assistant boundary accepted by the backend's resume contract. */
  resumeCheckpointId?: string;
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

type AcpSessionBinding = {
  acpBackendId: string;
  acpAgentId: string;
  agentSessionId: string;
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
  tokensVersion?: typeof SESSION_TOTAL_TOKENS_VERSION;
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
  /**
   * @deprecated Lane suspension was removed; nothing writes this anymore. Kept only to
   * hold the shipped SDK surface stable; drop at the next surface window.
   */
  laneId?: string;
  expectedResumeBy?: number; // Reaper TTL (e.g. 30min)
  state: LaneExecutionState; // State machine check for hot-path
}

export type {
  SessionGoal,
  SessionGoalStatus,
} from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";

export type RestartRecoveryRun = {
  runId: string;
  lifecycleGeneration: string;
};

type SessionEntryCore = SessionRestartRecoveryState &
  SessionEntryProvenance &
  Pick<SessionRow, "permissionMode" | "sessionRoot"> & {
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
    /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
    spawnedBy?: string;
    /** Immutable session key authorized to receive this child's completion handoff. */
    completionOwnerSessionKey?: string;
    /** Workspace inherited by spawned sessions and reused on later turns for the same child session. */
    spawnedWorkspaceDir?: string;
    /** Task working directory inherited by spawned sessions and reused on later turns. */
    spawnedCwd?: string;
    /** Content-free fingerprints for checkout changes that predate this session generation. */
    sessionDiffBaseline?: SessionDiffBaseline;
    /**
     * Managed worktree bound to this session; set with spawnedCwd at worktree
     * creation and cleared together when a plain New Chat detaches the checkout.
     */
    worktree?: {
      id: string;
      branch: string;
      repoRoot: string;
      /** Durable skill workspace prepared when this session runs from a managed worktree. */
      canonicalWorkspaceDir?: string;
    };
    /** Project registry id selected when this logical session node was created. */
    projectId?: string;
    /** Explicit parent session linkage for dashboard-created child sessions. */
    parentSessionKey?: string;
    /** Exact parent incarnation captured when this child was created. */
    parentSessionId?: string;
    /** How this session node came to exist; written once and retained across sessionId rotations. */
    createdVia?: SessionCreatedVia;
    /** Actor that caused node creation, with an optional profile, session, or sender id; written once. */
    createdActor?: SessionCreatedActor;
    /** Creation-only sandbox requirement; existing unstamped sessions always remain unstamped. */
    sandbox?: "required";
    /** Mutable responsibility, projected from SQLite; absent means createdActor owns the session. */
    owner?: SessionOwnerAssignment;
    /** Retained identities, projected from the participant table before display truncation. */
    participants?: SessionParticipant[];
    /** Raw retained identity count, including the owner, for admission-bound coverage. */
    participantCount?: number;
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
    status?: SessionRunStatus;
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
    contextWindow?: string;
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
      /** Store-private origin paired with an account scheduled-tool policy. */
      scheduledToolCallerOrigin?: CronScheduledToolCallerOrigin;
      cliSessionBindingFacts?: {
        extraSystemPromptStatic?: string;
        sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
        requireExplicitMessageTarget?: boolean;
      };
    };
    fastMode?: FastMode;
    toolOverrides?: SessionToolOverrides;
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
    /** Present only when providerOverride/modelOverride are a canonical route pair. */
    modelOverrideRouteResolution?: "resolved";
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
    queueMode?: QueueMode;
    queueDebounceMs?: number;
    queueCap?: number;
    queueDrop?: "old" | "new" | "summarize";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    pendingFinalDelivery?: PendingFinalDeliveryState;
    pendingDeliveryNotice?: PendingDeliveryNoticeState;
    /**
     * Ordered durable backlog of delivered assistant finals that failed to
     * reach the canonical transcript. Session admission restores each item
     * before another turn can extend that transcript. Kept as a list so
     * independently admitted writers never overwrite an earlier reply.
     */
    pendingTranscriptRepair?: PendingTranscriptRepairState[];
    /**
     * Whether totalTokens reflects a fresh context snapshot for the latest run.
     * Undefined means legacy/unknown freshness; false forces consumers to treat
     * totalTokens as stale/unknown for context-utilization displays.
     */
    totalTokensFresh?: boolean;
    /** Version 1 records totalTokens as the current prompt/context snapshot only. */
    totalTokensVersion?: typeof SESSION_TOTAL_TOKENS_VERSION;
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
    fallbackNotice?: FallbackNoticeState;
    contextTokens?: number;
    /** Origin of the persisted context window; `resolved` is legacy/unverified. */
    contextTokensSource?: "runtime" | "runtime-configured" | "resolved" | "resolved-v1";
    contextBudgetStatus?: SessionContextBudgetStatus;
    compactionCount?: number;
    compactionCheckpoints?: SessionCompactionCheckpoint[];
    memoryFlush?: MemoryFlushState;
    cliSessionIds?: Record<string, string>;
    cliSessionBindings?: Record<string, CliSessionBinding>;
    /** Initialization fence for seeding canonical ACP metadata; cleared after creation. */
    acpSessionBinding?: AcpSessionBinding;
    claudeCliSessionId?: string;
    label?: string;
    /** Persistent operator/agent-set sidebar emoji icon (single grapheme). */
    icon?: string;
    /** User-defined organization bucket for session lists; unrelated to chat groupId/groupChannel. */
    category?: string;
    /** Preferred Control UI face when a caller opens this session without explicit face intent. */
    boardFace?: SessionBoardFace;
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

export interface SessionEntry extends SessionEntryCore {}

/** Internal durable fields excluded from public/plugin session projections. */
export type InternalSessionEntryCore = SessionEntryCore & {
  /** Run that owns the current non-terminal Gateway lifecycle projection. */
  lifecycleRunId?: string;
  /** Exact run that produced the latest terminal Gateway lifecycle projection. */
  lastRunId?: string;
  /** Run admitted by the session lane; overwritten at admission and checked by transcript writes. */
  activeWriterRunId?: string;
  /** Canonical remote repository awaiting preparation by this exact session generation. */
  pendingProjectGitUrl?: string;
  /** Authorized worktree intent awaiting preparation by an admitted turn. */
  pendingWorktree?: {
    workspace?: string;
    name?: string;
    baseRef?: string;
    titleSource: string;
  };
  /** Private per-generation ownership for the pre-runtime checkout baseline capture. */
  sessionDiffBaselineCapture?: import("./session-diff-baseline-capture.js").SessionDiffBaselineCapture;
  mainRestartRecovery?: MainRestartRecoveryState;
};

export interface InternalSessionEntry extends InternalSessionEntryCore {}

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
    return stripRetiredSessionEntryLocators(
      normalizeSessionRuntimeModelFields({
        ...patch,
        sessionId,
        updatedAt,
        sessionStartedAt: patch.sessionStartedAt ?? updatedAt,
      }),
    );
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

  // Node creation and exact fork ancestry are write-once; sandbox policy cannot be added later.
  if (existing.createdVia !== undefined) {
    next.createdVia = existing.createdVia;
  }
  if (existing.createdActor !== undefined) {
    next.createdActor = existing.createdActor;
  }
  if (existing.sandbox === "required") {
    next.sandbox = existing.sandbox;
  } else {
    delete next.sandbox;
  }
  if (existing.createdAt !== undefined) {
    next.createdAt = existing.createdAt;
  }
  if (existing.projectId !== undefined) {
    next.projectId = existing.projectId;
  }
  if (existing.forkSource !== undefined) {
    next.forkSource = existing.forkSource;
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
  return stripRetiredSessionEntryLocators(normalizeSessionRuntimeModelFields(next));
}

function stripRetiredSessionEntryLocators(entry: SessionEntry): SessionEntry {
  const mutable = entry as SessionEntry & { sessionFile?: unknown; transcriptPath?: unknown };
  delete mutable.sessionFile;
  delete mutable.transcriptPath;
  return entry;
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

export function resolveSessionTotalTokens(entry?: Pick<SessionEntry, "totalTokens"> | null) {
  return asNonNegativeFiniteNumber(entry?.totalTokens);
}

export function resolveFreshSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion"> | null,
): number | undefined {
  const total = resolveSessionTotalTokens(entry);
  if (total === undefined) {
    return undefined;
  }
  if (
    entry?.totalTokensFresh !== true ||
    entry.totalTokensVersion !== SESSION_TOTAL_TOKENS_VERSION
  ) {
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

export type { SessionSkillPromptRef, SessionSkillSnapshot } from "./session-prompt-types.js";

export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
