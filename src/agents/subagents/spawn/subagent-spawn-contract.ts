import type { FastMode } from "../../../shared/fast-mode.js";
import type { SpawnedToolContext } from "../../spawned-context.js";
import type {
  SpawnSubagentContextMode,
  SpawnSubagentMode,
  SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";

type SpawnSubagentAdmissionBoundary =
  | "child-session"
  | "gateway-dispatch"
  | "registry-acceptance"
  | "lifecycle-publication"
  | "final-acceptance";

export type SpawnSubagentAdmissionAuthority = {
  signal: AbortSignal;
  source: {
    ownerSessionKey: string;
    flowId?: string;
    expectedRevision?: number;
  };
  assertCurrent(
    boundary: SpawnSubagentAdmissionBoundary,
    source?: { flowId?: string; expectedRevision?: number; task: string } | null,
  ): void;
};

export class SpawnSubagentAdmissionCancelledError extends Error {
  readonly code = "CONTINUATION_DELEGATE_ADMISSION_CANCELLED";

  constructor(message: string) {
    super(message);
    this.name = "SpawnSubagentAdmissionCancelledError";
  }
}

export function isSpawnSubagentAdmissionCancelledError(
  error: unknown,
): error is SpawnSubagentAdmissionCancelledError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CONTINUATION_DELEGATE_ADMISSION_CANCELLED"
  );
}

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
  requesterAgentIdOverride?: string;
  requesterRunId?: string;
  continuationDelegateAdmission?: SpawnSubagentAdmissionAuthority;
};

export type SpawnSubagentResult = {
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
  /** Removes and terminates this exact accepted run if its source handoff loses authority. */
  rollbackAccepted?: () => Promise<void>;
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
} & (
  | { status: "accepted"; context: SpawnSubagentContextMode }
  | { status: "cancelled" | "forbidden" | "error"; context?: never }
);
