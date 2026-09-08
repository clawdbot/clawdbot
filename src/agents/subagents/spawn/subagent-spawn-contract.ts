import type { FastMode } from "../../../shared/fast-mode.js";
import type { SpawnedToolContext } from "../../spawned-context.js";
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

export type SpawnSubagentContext = SpawnedToolContext & {
  onSpawnEffectsStart?: () => void;
  agentSessionKey?: string;
  requesterTurnRunId?: string;
  /** Separate key used only for completion routing, not sandbox policy. */
  completionOwnerKey?: string;
  /** Active requester sandbox classification, preserved separately from the durable lineage key.
   * Hidden native spawn derives sandbox admission from this when set, mirroring visible/ACP paths. */
  sandboxed?: boolean;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  requesterAgentIdOverride?: string;
  requesterRunId?: string;
  /** Private invocation fence, consumed only before registration transfers ownership. */
  assertActive?: () => void;
};

export type SpawnSubagentResult = {
  childSessionKey?: string;
  sessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  taskName?: string;
  expectsCompletionMessage?: boolean;
  note?: string;
  /** Fully resolved model ref applied to the spawned child session. */
  resolvedModel?: string;
  /** Provider prefix parsed from resolvedModel when the ref includes one. */
  resolvedProvider?: string;
  modelApplied?: boolean;
  error?: string;
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
} & (
  | { status: "accepted"; context: SpawnSubagentContextMode }
  | { status: "forbidden" | "error"; context?: never }
);
