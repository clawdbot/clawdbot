import crypto from "node:crypto";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { TtsAutoMode } from "../types.tts.js";

export type SessionScope = "per-sender" | "global";

export type SessionChannelId = ChannelId;

export type SessionChatType = ChatType;

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

export type SessionAcpIdentitySource = "ensure" | "status" | "event";

export type SessionAcpIdentityState = "pending" | "resolved";

export type SessionAcpIdentity = {
  state: SessionAcpIdentityState;
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  source: SessionAcpIdentitySource;
  lastUpdatedAt: number;
};

export type SessionAcpMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  identity?: SessionAcpIdentity;
  mode: "persistent" | "oneshot";
  runtimeOptions?: AcpSessionRuntimeOptions;
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
};

export type AcpSessionRuntimeOptions = {
  /**
   * ACP runtime mode set via session/set_mode (for example: "plan", "normal", "auto").
   */
  runtimeMode?: string;
  /** ACP runtime config option: model id. */
  model?: string;
  /** Working directory override for ACP session turns. */
  cwd?: string;
  /** ACP runtime config option: permission profile id. */
  permissionProfile?: string;
  /** ACP runtime config option: per-turn timeout in seconds. */
  timeoutSeconds?: number;
  /** Backend-specific option bag mapped through session/set_config_option. */
  backendExtras?: Record<string, string>;
};

export type CliSessionBinding = {
  sessionId: string;
  authProfileId?: string;
  authEpoch?: string;
  extraSystemPromptHash?: string;
  mcpConfigHash?: string;
};

export type SessionCompactionCheckpointReason =
  | "manual"
  | "auto-threshold"
  | "overflow-retry"
  | "timeout-retry";

export type SessionCompactionTranscriptReference = {
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

export type SessionPluginDebugEntry = {
  pluginId: string;
  lines: string[];
};

export type SessionEntry = {
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
  /** Heartbeat task state (task name -> last run timestamp ms). */
  heartbeatTaskState?: Record<string, number>;
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  /** Workspace inherited by spawned sessions and reused on later turns for the same child session. */
  spawnedWorkspaceDir?: string;
  /** Explicit parent session linkage for dashboard-created child sessions. */
  parentSessionKey?: string;
  /** True after a thread/topic session has been forked from its parent transcript once. */
  forkedFromParent?: boolean;
  /** Subagent spawn depth (0 = main, 1 = sub-agent, 2 = sub-sub-agent). */
  spawnDepth?: number;
  /** Explicit role assigned at spawn time for subagent tool policy/control decisions. */
  subagentRole?: "orchestrator" | "leaf";
  /** Explicit control scope assigned at spawn time for subagent control decisions. */
  subagentControlScope?: "children" | "none";
  systemSent?: boolean;
  abortedLastRun?: boolean;
  /** Stable first-run start time for subagent sessions, persisted after completion. */
  startedAt?: number;
  /** Latest completed run end time for subagent sessions, persisted after completion. */
  endedAt?: number;
  /** Accumulated runtime across subagent follow-up runs, persisted after completion. */
  runtimeMs?: number;
  /** Final persisted subagent run status, used after in-memory run archival. */
  status?: "running" | "done" | "failed" | "killed" | "timeout";
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
  fastMode?: boolean;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  ttsAuto?: TtsAutoMode;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  responseUsage?: "on" | "off" | "tokens" | "full";
  providerOverride?: string;
  modelOverride?: string;
  /**
   * Tracks whether the persisted model override came from an explicit user
   * action (`/model`, `sessions.patch`) or from a temporary runtime fallback.
   * Resets only preserve user-driven overrides.
   */
  modelOverrideSource?: "auto" | "user";
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
  queueMode?:
    | "steer"
    | "followup"
    | "collect"
    | "steer-backlog"
    | "steer+backlog"
    | "queue"
    | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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
   * Last selected/runtime model pair for which a fallback notice was emitted.
   * Used to avoid repeating the same fallback notice every turn.
   */
  fallbackNoticeSelectedModel?: string;
  fallbackNoticeActiveModel?: string;
  fallbackNoticeReason?: string;
  contextTokens?: number;
  compactionCount?: number;
  compactionCheckpoints?: SessionCompactionCheckpoint[];
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  memoryFlushContextHash?: string;
  cliSessionIds?: Record<string, string>;
  cliSessionBindings?: Record<string, CliSessionBinding>;
  claudeCliSessionId?: string;
  label?: string;
  displayName?: string;
  channel?: string;
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  origin?: SessionOrigin;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  skillsSnapshot?: SessionSkillSnapshot;
  systemPromptReport?: SessionSystemPromptReport;
  /**
   * Generic plugin-owned runtime debug entries shown in verbose status surfaces.
   * Each plugin owns and may overwrite only its own entry between turns.
   */
  pluginDebugEntries?: SessionPluginDebugEntry[];
  acp?: SessionAcpMeta;
};

function isSessionPluginTraceLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("🔎 ") || /(?:^|\s)(?:Debug|Trace):/.test(trimmed);
}

export function resolveSessionPluginStatusLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
): string[] {
  return Array.isArray(entry?.pluginDebugEntries)
    ? entry.pluginDebugEntries.flatMap((pluginEntry) =>
        Array.isArray(pluginEntry?.lines)
          ? pluginEntry.lines.filter(
              (line): line is string =>
                typeof line === "string" &&
                line.trim().length > 0 &&
                !isSessionPluginTraceLine(line),
            )
          : [],
      )
    : [];
}

export function resolveSessionPluginTraceLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
): string[] {
  return Array.isArray(entry?.pluginDebugEntries)
    ? entry.pluginDebugEntries.flatMap((pluginEntry) =>
        Array.isArray(pluginEntry?.lines)
          ? pluginEntry.lines.filter(
              (line): line is string =>
                typeof line === "string" &&
                line.trim().length > 0 &&
                isSessionPluginTraceLine(line),
            )
          : [],
      )
    : [];
}

export function normalizeSessionRuntimeModelFields(entry: SessionEntry): SessionEntry {
  const normalizedModel = normalizeOptionalString(entry.model);
  const normalizedProvider = normalizeOptionalString(entry.modelProvider);
  let next = entry;

  if (!normalizedModel) {
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

export type SessionEntryMergePolicy = "touch-activity" | "preserve-activity";

type MergeSessionEntryOptions = {
  policy?: SessionEntryMergePolicy;
  now?: number;
};

function resolveMergedUpdatedAt(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): number {
  if (options?.policy === "preserve-activity" && existing) {
    return existing.updatedAt ?? patch.updatedAt ?? options.now ?? Date.now();
  }
  return Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, options?.now ?? Date.now());
}

export function mergeSessionEntryWithPolicy(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = resolveMergedUpdatedAt(existing, patch, options);
  if (!existing) {
    return normalizeSessionRuntimeModelFields({ ...patch, sessionId, updatedAt });
  }
  const next = { ...existing, ...patch, sessionId, updatedAt };

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

export function resolveFreshSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = entry?.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return undefined;
  }
  if (entry?.totalTokensFresh === false) {
    return undefined;
  }
  return total;
}

export function isSessionTotalTokensFresh(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): boolean {
  return resolveFreshSessionTotalTokens(entry) !== undefined;
}

export type GroupKeyResolution = {
  key: string;
  channel?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
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
    entries: Array<{ name: string; blockChars: number }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      schemaChars: number;
      propertiesCount?: number | null;
    }>;
  };
};

export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 0;
