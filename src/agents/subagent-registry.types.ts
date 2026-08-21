import type { SubagentEndReason } from "../context-engine/types.js";
/** Persisted execution, completion, delivery, and attachment state for child runs. */
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { AgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type SubagentCompletionRequest = {
  runId: string;
  /** Exact in-process owner required after acquiring the terminal completion lock. */
  expectedEntry?: SubagentRunRecord;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
  startedAt?: number;
  suppressSessionEffects?: boolean;
  recoverInterrupted?: true;
  completionSnapshot?: { resultText: string | null; capturedAt: number };
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export type ContextEngineSubagentEndedParams = {
  childSessionKey: string;
  reason: SubagentEndReason;
  agentDir?: string;
  workspaceDir?: string;
};

export type SubagentProgressOrigin = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  channelId?: string | number;
  messageId?: string | number;
};

export type PendingFinalDeliveryPayload = {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  childSessionKey: string;
  childRunId: string;
  task: string;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export type SubagentRestartRecoveryReceipt = {
  sessionId: string;
  sessionMarker: string;
  sessionLifecycleRevision?: string;
  idempotencyKey: string;
  phase: "reserved" | "attempted" | "consumed" | "accepted" | "abandoned";
  lifecycleGeneration?: string;
};

type SubagentDeliveryDisposition =
  | "delivered"
  | "session_queued"
  | "intentional_non_delivery"
  | "retryable"
  | "ambiguous"
  | "permanent_failure";

type SubagentExecutionState = {
  status: "queued" | "running" | "interrupted" | "terminal";
  /** Gateway lifecycle that owns child-session effects for this run. */
  lifecycleGeneration?: string;
  /** Durable dispatch receipt for one interrupted-session snapshot. */
  restartRecovery?: SubagentRestartRecoveryReceipt;
  /** Sticky terminal policy: this run must never mutate its child session again. */
  suppressSessionEffects?: true;
  acceptedAt?: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  interruptedAt?: number;
  interruptionReason?: "gateway-restart" | "lost-execution-context";
  transcriptTarget?: AgentRunSessionTarget;
};

export type SubagentCompletionState = {
  required: boolean;
  resultText?: string | null;
  capturedAt?: number;
  fallbackResultText?: string | null;
  fallbackCapturedAt?: number;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export type SwarmCollectorStatus = "done" | "failed" | "killed" | "timeout";

export type SwarmCollectorCompletion = {
  status: SwarmCollectorStatus;
  structured?: unknown;
  schemaError?: string;
  failure?: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export type FactoryNativePermissionProfileDefinition = {
  workspace_roots: Record<string, true>;
  filesystem: Record<string, "read" | "write" | "deny" | Record<string, "read" | "write" | "deny">>;
  network: { enabled: false };
};

export type FactoryNativeShellEnvironmentPolicy = {
  inherit: "none";
  ignore_default_excludes: false;
  set: Record<string, string>;
  include_only: string[];
};

export type SwarmLaunchAuthority = {
  contractVersion: 1;
  authorityProfileId: "factory_native_build_v1";
  platform: "darwin";
  executor: "codex-app-server";
  backend: "macos-seatbelt";
  approvalPolicy: "never";
  approvalsReviewer: "auto_review";
  permissionProfile: {
    id: "factory_native_build_v1";
    definition: FactoryNativePermissionProfileDefinition;
    definitionHash: `sha256:${string}`;
    platformDefaultTempAccess: "read_write";
  };
  filesystem: {
    platformDefaults: ":minimal";
    readableRoots: string[];
    writableRoots: string[];
    gitMetadataRoot: string;
    readOnlyWorktreeSubpaths: [".git", ".codex", ".agents"];
    deniedSecretGlobs: [
      ".env",
      "**/.env",
      ".env.*",
      "**/.env.*",
      "*.env",
      "**/*.env",
      ".secrets/**",
      "**/.secrets/**",
    ];
    factoryStateRoot: string;
    scratchRoot: string;
    sanitizedHome: string;
    tempDir: string;
    inheritedTmpdir: false;
    controlPlaneStateInSharedTemp: false;
  };
  network: "none";
  shellEnvironmentPolicy: {
    definition: FactoryNativeShellEnvironmentPolicy;
    definitionHash: `sha256:${string}`;
    /** Caller-selected, canonical toolchain bins in exact precedence order. */
    orderedNativePathEntries: string[];
    /** Exact PATH installed after appending the fixed macOS system fallback. */
    effectivePath: string;
    runtimeAddedNames: ["CODEX_THREAD_ID"];
    containsSecretValues: false;
  };
  toolSurface: {
    codexNativeCodeMode: true;
    openClawDynamicTools: [];
    disabledCapabilities: [
      "openclaw-exec",
      "openclaw-process",
      "mcp",
      "apps",
      "plugins",
      "browser",
      "web-search",
      "image-generation",
      "multi-agent",
      "hooks",
    ];
  };
  worktreeFenceToken: string;
  worktreeOwnershipGeneration: number;
  cwd: string;
  workspaceRoot: string;
};

export type SwarmEffectiveAuthorityProof = {
  proofContractVersion: 1;
  contractHash: `sha256:${string}`;
  launchIdentityDigest: `sha256:${string}`;
  runtime: {
    codexVersion: string;
    appServerVersion: string;
    appServerInstanceId: string;
    appServerPid?: number;
    appServerBuildIdentity: string;
    runtimeArtifactId: string;
    runtimeArtifactFingerprint: string;
    activePermissionProfile: {
      id: string;
      extends?: string | null;
    };
    sandbox: {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: false;
      excludeTmpdirEnvVar: true;
      excludeSlashTmp: true;
    };
    profileDefinitionHash: `sha256:${string}`;
    threadConfigHash: `sha256:${string}`;
    shellEnvironmentPolicyHash: `sha256:${string}`;
    policyHash: `sha256:${string}`;
    dynamicTools: string[];
    cwd: string;
    runtimeWorkspaceRoots: string[];
    approvalPolicy: "never";
    approvalsReviewer: "auto_review";
    permissionSelection: "factory_native_build_v1";
    threadStartRequestHash: `sha256:${string}`;
    turnStartRequestHash: `sha256:${string}`;
  };
  proofHash: `sha256:${string}`;
  observedAt: number;
};

export type SwarmTerminalEvidence = {
  evidenceContractVersion: 1;
  launchIdentityDigest: `sha256:${string}`;
  runId: string;
  sessionKey: string;
  agentId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  taskId?: string;
  replayKey: string;
  requestFingerprint: `sha256:${string}`;
  authority: SwarmLaunchAuthority;
  schemaContractVersion: "openclaw/agent-structured-result/v1";
  schemaCanonicalJson: string;
  schemaHash: `sha256:${string}`;
  result?: {
    canonicalJson: string;
    contentHash: `sha256:${string}`;
  };
  outcome: {
    status: SwarmCollectorStatus;
    schemaError?: string;
    failure?: string;
  };
  endedAt: number;
  frozenAt: number;
  runtime: {
    openClawVersion: string;
    openClawBuildIdentity: string;
    harness?: string;
    model?: string;
    reasoning?: string;
    thinking?: string;
    authorityProof?: SwarmEffectiveAuthorityProof;
  };
  usage?: { inputTokens: number; outputTokens: number };
};

export type SwarmStructuredOutputState = {
  structured?: unknown;
  schemaError?: string;
  invalidAttempts: number;
};

export type SwarmQueuedLaunch = {
  request: Record<string, unknown>;
  /** Exact trusted launch capability, persisted so restart replay cannot lose it. */
  authorization?: SubagentLaunchAuthorization;
  timeoutMs: number;
  schedulerGroupKey: string;
  maxConcurrent: number;
};

export type SubagentCompletionDeliveryState = {
  status:
    | "not_required"
    | "pending"
    | "in_progress"
    | "delivered"
    | "failed"
    | "suspended"
    | "discarded";
  payload?: PendingFinalDeliveryPayload;
  createdAt?: number;
  enqueuedAt?: number;
  deliveredAt?: number;
  announcedAt?: number;
  lastAttemptAt?: number;
  attemptCount?: number;
  lastError?: string | null;
  /** Closed result of the latest transport attempt; never doubles as delivery success. */
  disposition?: SubagentDeliveryDisposition;
  /** Logical obligation generation. Redrive increments it and never revives an old row. */
  generation?: number;
  queueId?: string;
  windowStartedAt?: number;
  deadlineAt?: number;
  nextAttemptAt?: number;
  steeringLeaseId?: string;
  steeringLeasedAt?: number;
  steeringInjectedAt?: number;
  suspendedAt?: number;
  suspendedReason?: "retry-limit" | "expiry" | "permanent_failure";
  dismissedAt?: number;
  discardedAt?: number;
  discardReason?: "expired";
  discardedPayloadSummary?: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    childRunId?: string;
    endedAt?: number;
    status?: string;
    lastError?: string | null;
  };
  lastDropReason?:
    | "queue_cap"
    | "parent_run_ended"
    | "sink_unavailable"
    | "dedupe"
    | "waiting_for_requester_turn";
};

/** Durable outbox state for the top-level requester settle wake. */
export type RequesterSettleWakeState = {
  status: "pending" | "dispatching";
  /** Number of delivery attempts already admitted. */
  attemptCount: number;
  /** Ambiguous transport replays made with the current idempotency key. */
  replayCount?: number;
  /** Persisted retry deadline; restore waits until this instant. */
  nextAttemptAt?: number;
  /** Frozen wave membership after delivery admission or requester-yield re-admission. */
  batchRunIds?: string[];
  /** Batch frozen while its spawning requester turn was yielding. */
  requesterYieldBatch?: true;
  /** Present only when an idle requester needs a new turn after yielding. */
  afterRequesterYield?: true;
  /** Monotonic process generation protecting a newer yield from stale completion. */
  rearmGeneration?: number;
  lastError?: string | null;
  /** Cleanup wanted to retire this row; defer deletion until the outbox resolves. */
  retireAfterSettle?: boolean;
};

type SubagentKillReconciliationState = {
  /** Actual cancellation time; a yielded run may have an older execution end. */
  killedAt: number;
  /** Requester aborts must not re-inject a delayed completion after queues are cleared. */
  suppressTaskDelivery?: boolean;
  /** Durable ownership boundary even after the newer registry row is released. */
  supersededAt?: number;
};

type SubagentKillIntent = {
  requestedAt: number;
  reason: string;
  lifecycleGeneration?: string;
  sessionId?: string;
  sessionLifecycleRevision?: string;
  suppressTaskDelivery?: boolean;
};

export type SubagentRunRecord = {
  runId: string;
  /** Detached task owner; steer/restart changes runId but continues the same task. */
  taskRunId?: string;
  /** Requester attempt that must settle before this completion row can retire. */
  requesterTurnRunId?: string;
  /** Durable proof that this requester attempt invoked sessions_yield. */
  requesterTurnYielded?: true;
  /** Cleanup retirement deferred until requesterTurnRunId settles. */
  retireAfterRequesterTurn?: boolean;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  /** Durable source locator for transport-neutral progress presentation. */
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  /** Effective requester agent, including cron/hook overrides not encoded in the session key. */
  requesterAgentId?: string;
  task: string;
  taskName?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  /** Monotonic ownership generation within one child session. */
  generation?: number;
  createdAt: number;
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  /** Sticky owner while restart recovery replays this exact terminal run. */
  terminalOwner?: "interrupted-recovery";
  /** Present only while a current-version killed run awaits bounded reconciliation. */
  killReconciliation?: SubagentKillReconciliationState;
  /** Durable operator cancellation ownership before runtime side effects complete. */
  killIntent?: SubagentKillIntent;
  /** Durable requester-stop policy until silent completion cleanup finishes. */
  suppressCompletionDelivery?: boolean;
  expectsCompletionMessage?: boolean;
  endedReason?: SubagentLifecycleEndedReason;
  pauseReason?: "sessions_yield";
  wakeOnDescendantSettle?: boolean;
  execution: SubagentExecutionState;
  completion?: SubagentCompletionState;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  /** Set after cleanupBrowserSessionsForLifecycleEnd has been dispatched once. */
  browserCleanupDispatchedAt?: number;
  /** Set immediately before irreversible sessions.delete cleanup is dispatched. */
  deleteCleanupDispatchedAt?: number;
  /** Durable outbox marker for parent/external completion delivery. */
  delivery?: SubagentCompletionDeliveryState;
  /** Durable top-level requester wake obligation, replayed after restart. */
  requesterSettleWake?: RequesterSettleWakeState;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  /** Collector-mode runs remain waitable and never announce to the requester. */
  collect?: boolean;
  /** Stable spawning-session owner for caps, scheduling, and wait authorization. */
  swarmRequesterSessionKey?: string;
  /** Spawner plus ancestor sessions authorized to wait, frozen when the collector is registered. */
  swarmWaitOwnerSessionKeys?: string[];
  /** Stable public collector id; gateway execution ids can change across dispatch/recovery. */
  swarmRunId?: string;
  /** Stable scheduler slot identity across gateway-assigned run id replacements. */
  schedulerSlotId?: string;
  /** Exact host-reserved Gateway request identity for the current collector turn. */
  swarmLaunchIdempotencyKey?: string;
  /** Replay-safe host bridge identity used to recover a collector after restart. */
  swarmLaunchReplayKey?: string;
  /** Canonical collector request hash paired with a host-reserved launch identity. */
  swarmLaunchRequestFingerprint?: string;
  /** Immutable digest covering the accepted host launch identity. */
  swarmLaunchIdentityDigest?: `sha256:${string}`;
  /** Requester generation frozen into the persisted collector result receipt. */
  swarmRequesterSessionId?: string;
  swarmRequesterLifecycleRevision?: string;
  /** Host-owned authority and worktree fencing facts for this launch. */
  swarmLaunchAuthority?: SwarmLaunchAuthority;
  /** App-server-produced effective authority proof, frozen before the first native turn. */
  swarmEffectiveAuthorityProof?: SwarmEffectiveAuthorityProof;
  /** True only between host reservation and accepted Gateway dispatch. */
  swarmLaunchPending?: boolean;
  groupId?: string;
  outputSchema?: Record<string, unknown>;
  structuredOutput?: SwarmStructuredOutputState;
  queuedLaunch?: SwarmQueuedLaunch;
  /** Durable retry obligation for a prepared collector session whose launch failed. */
  collectorLaunchCleanupPending?: boolean;
  /** Set after failed-launch context-engine cleanup succeeds, preventing duplicate end hooks. */
  contextEngineCleanupCompletedAt?: number;
  collectorCompletion?: SwarmCollectorCompletion;
  /** Producer-frozen terminal evidence; once persisted it is immutable. */
  swarmTerminalEvidence?: SwarmTerminalEvidence;
};

/** Minimal registry shape needed by session-list topology and display reads. */
export type SubagentRunReadRecord = Pick<
  SubagentRunRecord,
  | "runId"
  | "childSessionKey"
  | "controllerSessionKey"
  | "requesterSessionKey"
  | "model"
  | "generation"
  | "createdAt"
  | "sessionStartedAt"
  | "accumulatedRuntimeMs"
  | "runTimeoutSeconds"
  | "endedReason"
  | "cleanupCompletedAt"
  | "delivery"
> & {
  execution: Pick<SubagentExecutionState, "startedAt" | "endedAt" | "outcome">;
};
