import type { FastMode } from "../shared/fast-mode.js";
import type { ProvisionalSessionCleanupIdentity } from "./subagent-spawn-cleanup-types.js";
import type {
  SpawnSubagentContextMode,
  SpawnSubagentMode,
  SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  taskName?: string;
  thinking?: string;
  fastMode?: FastMode;
  collect?: boolean;
  outputSchema?: Record<string, unknown>;
  groupId?: string;
  /** Host bridge identity used to recover a replay-safe collector launch. */
  swarmLaunchReplayKey?: string;
  /** Canonical request hash checked before reusing a host-reserved collector. */
  swarmLaunchRequestFingerprint?: string;
  cwd?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sandbox?: SpawnSubagentSandboxMode;
  context?: SpawnSubagentContextMode;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;
};

export type SpawnSubagentContext = {
  agentSessionKey?: string;
  requesterTurnRunId?: string;
  /** Separate key used only for completion routing, not sandbox policy. */
  completionOwnerKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
  requesterAgentIdOverride?: string;
  /** Exact target authorized by a plugin-owned, active spawn lease. */
  authorizedTargetAgentId?: string;
  /** Plugin-preallocated child identity for crash-safe launch coordination. */
  preallocatedChildSessionKey?: string;
  /** Plugin-preallocated run identity for crash-safe launch coordination. */
  preallocatedRunId?: string;
  /** Plugin that owns the reserved child session. */
  pluginOwnerId?: string;
  /** Immutable requester session identity bound to the reserved replay token. */
  requesterSessionId?: string;
  /** Whether the requester lifecycle revision key existed when the reservation was admitted. */
  requesterLifecycleRevisionPresent?: boolean;
  /** Requester lifecycle revision value bound to the reserved replay token when present. */
  requesterLifecycleRevision?: string;
  /** Process-local token binding a reserved run to its Gateway dedupe reservation. */
  reservedSubagentClaimToken?: string;
  /** Explicit workspace directory for subagent to inherit (optional). */
  workspaceDir?: string;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  requesterRunId?: string;
  signal?: AbortSignal;
};

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  sessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  taskName?: string;
  note?: string;
  /** Fully resolved model ref applied to the spawned child session. */
  resolvedModel?: string;
  /** Provider prefix parsed from resolvedModel when the ref includes one. */
  resolvedProvider?: string;
  modelApplied?: boolean;
  error?: string;
  reservedCleanup?: {
    sessionDeletion: "deleted" | "not_deleted" | "indeterminate";
    sessionIdentity?: ProvisionalSessionCleanupIdentity;
  };
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
};
