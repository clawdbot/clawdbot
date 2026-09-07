// Public SDK data contracts for Gateway transport, runs, sessions, tools,
// artifacts, tasks, environments, and normalized event streams.
import type { GatewayClientRequestOptions } from "@openclaw/gateway-client";
import type {
  ArtifactSummary as GatewayArtifactSummaryType,
  ArtifactsDownloadResult as GatewayArtifactsDownloadResultType,
  ArtifactsGetResult as GatewayArtifactsGetResultType,
  ArtifactsListParams as GatewayArtifactsListParamsType,
  ArtifactsListResult as GatewayArtifactsListResultType,
  EnvironmentSummary as GatewayEnvironmentSummaryType,
  EnvironmentsCreateParams as GatewayEnvironmentsCreateParamsType,
  EnvironmentsListResult as GatewayEnvironmentsListResultType,
  SessionsCreateParams as GatewaySessionsCreateParamsType,
  SessionsSendParams as GatewaySessionsSendParamsType,
  TaskSummary as GatewayTaskSummaryType,
  ToolsInvokeParams as GatewayToolsInvokeParamsType,
  ToolsInvokeResult as GatewayToolsInvokeResultType,
} from "@openclaw/gateway-protocol";

export type {
  AgentsCreateParams,
  AgentsDeleteParams,
  AgentsUpdateParams,
  ArtifactsDownloadResult as GatewayArtifactsDownloadResult,
  ArtifactsGetResult as GatewayArtifactsGetResult,
  ArtifactsListResult as GatewayArtifactsListResult,
  ArtifactSummary as GatewayArtifactSummary,
  EnvironmentsListResult as GatewayEnvironmentsListResult,
  EnvironmentSummary as GatewayEnvironmentSummary,
  TaskSummary,
  TasksCancelResult,
  TasksGetResult,
  TasksListParams,
  TasksListResult,
  ToolsEffectiveParams,
  WorkerEnvironmentMetadata,
  WorkerEnvironmentState,
  WorkerTunnelStatus,
} from "@openclaw/gateway-protocol";

export type JsonObject = Record<string, unknown>;

/** SDK request projection; additional GatewayClient lifecycle hooks stay client-owned. */
export type GatewayRequestOptions = Pick<GatewayClientRequestOptions, "expectFinal" | "timeoutMs">;

/** Raw event payload emitted by the Gateway transport. */
export type GatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: unknown;
};

/** Minimal transport interface consumed by the OpenClaw SDK client. */
export type OpenClawTransport = {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T>;
  events(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent>;
  close?(): Promise<void> | void;
};

/** Transport variant that requires an explicit connection step. */
export type ConnectableOpenClawTransport = OpenClawTransport & {
  connect(): Promise<void>;
};

/** Desired runtime/harness selection for future per-run execution routing. */
export type RuntimeSelection =
  | "auto"
  | { type: "embedded"; id: "openclaw" | "codex" | (string & {}) }
  | { type: "cli"; id: "claude-cli" | (string & {}) }
  | { type: "acp"; harness: "claude" | "cursor" | "gemini" | "opencode" | (string & {}) }
  | { type: "managed"; provider: "local" | "node" | "testbox" | "cloud" | (string & {}) };

/** Desired execution environment selection for future per-run routing. */
export type EnvironmentSelection =
  | { type: "local"; cwd?: string }
  | { type: "gateway"; url?: string; cwd?: string }
  | { type: "node"; nodeId: string; cwd?: string }
  | { type: "managed"; provider: string; repo?: string; ref?: string }
  | { type: "ephemeral"; provider: string; repo?: string; ref?: string };

/** SDK-friendly environment type suggestions over the protocol's open string. */
export type SDKEnvironmentType =
  | "local"
  | "gateway"
  | "node"
  | "managed"
  | "ephemeral"
  | (string & {});

/** Closed SDK projection of the protocol's runtime-validated status string. */
export type SDKEnvironmentStatus = "available" | "unavailable" | "starting" | "stopping" | "error";

/** Closed SDK projection of the protocol's runtime-validated trust string. */
export type SDKEnvironmentTrust = "persistent" | "disposable";

export type NodeWorkerBundleStatus = NonNullable<GatewayEnvironmentSummaryType["workerBundle"]>;

export type SDKEnvironmentSummary = Omit<
  GatewayEnvironmentSummaryType,
  "type" | "status" | "trust"
> & {
  type: SDKEnvironmentType;
  status: SDKEnvironmentStatus;
  trust?: SDKEnvironmentTrust;
};

/** Compatibility name retained for the SDK environment projection. */
export type EnvironmentSummary = SDKEnvironmentSummary;

export type EnvironmentCreateParams = GatewayEnvironmentsCreateParamsType;

type GatewayWorkerEnvironmentProfileSummary = NonNullable<
  GatewayEnvironmentsListResultType["profiles"]
>[number];

export type SDKWorkerEnvironmentProfileSummary = Omit<
  GatewayWorkerEnvironmentProfileSummary,
  "trust"
> & {
  trust?: SDKEnvironmentTrust;
};

/** Compatibility name retained for the SDK worker profile projection. */
export type WorkerEnvironmentProfileSummary = SDKWorkerEnvironmentProfileSummary;

export type SDKEnvironmentsListResult = Omit<
  GatewayEnvironmentsListResultType,
  "environments" | "profiles"
> & {
  environments: SDKEnvironmentSummary[];
  profiles?: SDKWorkerEnvironmentProfileSummary[];
};

/** Compatibility name retained for the SDK environment list projection. */
export type EnvironmentsListResult = SDKEnvironmentsListResult;

export type WorkspaceSelection = {
  cwd?: string;
  repo?: string;
  ref?: string;
};

export type ApprovalMode = "ask" | "never" | "auto" | "trusted";

export type ApprovalDecisionParams = {
  decision: "allow-once" | "allow-always" | "deny";
};

/** Terminal and non-terminal status values returned by Run.wait. */
export type RunStatus = "accepted" | "completed" | "failed" | "cancelled" | "timed_out";

export type RunTimestamp = NonNullable<GatewayTaskSummaryType["createdAt"]>;

export type SDKMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
};

/** SDK-friendly artifact type suggestions over the protocol's open string. */
type SDKArtifactType =
  | "file"
  | "patch"
  | "diff"
  | "log"
  | "media"
  | "screenshot"
  | "trajectory"
  | "pull_request"
  | "workspace"
  | (string & {});

/** The SDK remains forward-compatible with future artifact delivery modes. */
type SDKArtifactDownloadMode = GatewayArtifactSummaryType["download"]["mode"] | (string & {});

/**
 * SDK artifact projection retained for pre-protocol consumers.
 * Wire responses satisfy this shape, while legacy sparse summaries remain assignable.
 */
export type SDKArtifactSummary = Omit<GatewayArtifactSummaryType, "type" | "title" | "download"> & {
  type: SDKArtifactType;
  title?: GatewayArtifactSummaryType["title"];
  download?: { mode: SDKArtifactDownloadMode };
  sessionId?: string;
  createdAt?: string;
  expiresAt?: string;
};

/** Compatibility name retained for the SDK artifact projection. */
export type ArtifactSummary = SDKArtifactSummary;

type ArtifactScopeKey = "sessionKey" | "runId" | "taskId";
type ScopedArtifactQuery<Key extends ArtifactScopeKey> = Omit<GatewayArtifactsListParamsType, Key> &
  Required<Pick<GatewayArtifactsListParamsType, Key>>;

/** SDK query projection requiring at least one artifact ownership scope. */
export type ArtifactQuery =
  | ScopedArtifactQuery<"sessionKey">
  | ScopedArtifactQuery<"runId">
  | ScopedArtifactQuery<"taskId">;

export type SDKArtifactsListResult = Omit<GatewayArtifactsListResultType, "artifacts"> & {
  artifacts: SDKArtifactSummary[];
};

/** Compatibility name retained for the SDK artifact list projection. */
export type ArtifactsListResult = SDKArtifactsListResult;

export type SDKArtifactsGetResult = Omit<GatewayArtifactsGetResultType, "artifact"> & {
  artifact: SDKArtifactSummary;
};

/** Compatibility name retained for the SDK artifact get projection. */
export type ArtifactsGetResult = SDKArtifactsGetResult;

export type SDKArtifactsDownloadResult = Omit<GatewayArtifactsDownloadResultType, "artifact"> & {
  artifact: SDKArtifactSummary;
};

/** Compatibility name retained for the SDK artifact download projection. */
export type ArtifactsDownloadResult = SDKArtifactsDownloadResult;

export type TaskStatus = GatewayTaskSummaryType["status"];

export type SDKError = {
  code?: string;
  message: string;
  details?: unknown;
};

/** Parameters for direct tool invocation through the SDK. */
type SDKToolInvokeParams = Omit<GatewayToolsInvokeParamsType, "name" | "conversationReadOrigin">;

/** Compatibility name retained for the SDK tool invocation projection. */
export type ToolInvokeParams = SDKToolInvokeParams;

type SDKToolInvokeResult = Omit<GatewayToolsInvokeResultType, "error"> & {
  error?: SDKError;
};

/** Compatibility name retained for the SDK tool result projection. */
export type ToolInvokeResult = SDKToolInvokeResult;

/** Normalized result returned by Run.wait. */
export type RunResult = {
  runId: string;
  status: RunStatus;
  sessionId?: string;
  sessionKey?: string;
  taskId?: string;
  startedAt?: RunTimestamp;
  endedAt?: RunTimestamp;
  output?: {
    text?: string;
    messages?: SDKMessage[];
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  artifacts?: ArtifactSummary[];
  error?: SDKError;
  raw?: unknown;
};

/** Stable SDK event type taxonomy derived from raw Gateway events. */
export type OpenClawEventType =
  | "run.created"
  | "run.queued"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.timed_out"
  | "assistant.delta"
  | "assistant.message"
  | "thinking.delta"
  | "tool.call.started"
  | "tool.call.delta"
  | "tool.call.completed"
  | "tool.call.failed"
  | "approval.requested"
  | "approval.resolved"
  | "question.requested"
  | "question.answered"
  | "artifact.created"
  | "artifact.updated"
  | "session.created"
  | "session.updated"
  | "session.compacted"
  | "task.updated"
  | "git.branch"
  | "git.diff"
  | "git.pr"
  | "raw";

/** Normalized SDK event with common run/session/task metadata. */
export type OpenClawEvent<TData = unknown> = {
  version: 1;
  id: string;
  ts: number;
  type: OpenClawEventType;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  taskId?: string;
  agentId?: string;
  data: TData;
  raw?: GatewayEvent;
};

/** Parameters for creating an agent run. */
export type AgentRunParams = {
  input: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  sessionId?: string;
  sessionKey?: string;
  deliver?: boolean;
  attachments?: unknown[];
  timeoutMs?: number;
  label?: string;
  runtime?: RuntimeSelection;
  environment?: EnvironmentSelection;
  workspace?: WorkspaceSelection;
  approvals?: ApprovalMode;
  idempotencyKey?: string;
};

type SDKSessionCreateKeys =
  | "key"
  | "agentId"
  | "label"
  | "model"
  | "thinkingLevel"
  | "parentSessionKey"
  | "emitCommandHooks"
  | "succeedsParent"
  | "task"
  | "message"
  | "attachments";

/** SDK session-create projection with transport-neutral attachment inputs. */
type SDKSessionCreateParams = Omit<
  Pick<GatewaySessionsCreateParamsType, SDKSessionCreateKeys>,
  "attachments"
> & {
  attachments?: unknown[];
};

/** Compatibility name retained for the SDK session-create projection. */
export type SessionCreateParams = SDKSessionCreateParams;

type SDKSessionSendKeys =
  | "key"
  | "message"
  | "thinking"
  | "attachments"
  | "timeoutMs"
  | "idempotencyKey";

/** SDK session-send projection with transport-neutral attachment inputs. */
type SDKSessionSendParams = Omit<
  Pick<GatewaySessionsSendParamsType, SDKSessionSendKeys>,
  "attachments"
> & {
  attachments?: unknown[];
};

/** Compatibility name retained for the SDK session-send projection. */
export type SessionSendParams = SDKSessionSendParams;

export type SessionTarget = {
  key: string;
  sessionId?: string;
  agentId?: string;
  label?: string;
};

export type RunCreateParams = AgentRunParams;
