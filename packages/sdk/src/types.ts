export type JsonObject = Record<string, unknown>;

export type GatewayRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number | null;
};

export type GatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: unknown;
};

export type OpenClawTransport = {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T>;
  events(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent>;
  close?(): Promise<void> | void;
};

export type ConnectableOpenClawTransport = OpenClawTransport & {
  connect(): Promise<void>;
};

export type RuntimeSelection =
  | "auto"
  | { type: "embedded"; id: "pi" | "codex" | (string & {}) }
  | { type: "cli"; id: "claude-cli" | (string & {}) }
  | { type: "acp"; harness: "claude" | "cursor" | "gemini" | "opencode" | (string & {}) }
  | { type: "managed"; provider: "local" | "node" | "testbox" | "cloud" | (string & {}) };

export type EnvironmentSelection =
  | { type: "local"; cwd?: string }
  | { type: "gateway"; url?: string; cwd?: string }
  | { type: "node"; nodeId: string; cwd?: string }
  | { type: "managed"; provider: string; repo?: string; ref?: string }
  | { type: "ephemeral"; provider: string; repo?: string; ref?: string };

export type EnvironmentSummary = {
  id: string;
  type: "local" | "gateway" | "node" | "managed" | "ephemeral" | (string & {});
  label?: string;
  status: "available" | "unavailable" | "starting" | "stopping" | "error";
  capabilities?: string[];
};

export type EnvironmentsListResult = {
  environments: EnvironmentSummary[];
};

export type WorkspaceSelection = {
  cwd?: string;
  repo?: string;
  ref?: string;
};

export type ApprovalMode = "ask" | "never" | "auto" | "trusted";

export type RunStatus = "accepted" | "completed" | "failed" | "cancelled" | "timed_out";

export type RunTimestamp = string | number;

export type SDKMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
};

export type ArtifactSummary = {
  id: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  sessionKey?: string;
  type:
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
  title?: string;
  mimeType?: string;
  sizeBytes?: number;
  messageSeq?: number;
  source?: string;
  download?: {
    mode: "bytes" | "url" | "unsupported" | (string & {});
  };
  createdAt?: string;
  expiresAt?: string;
};

export type ArtifactQuery =
  | { sessionKey: string; runId?: string; taskId?: string }
  | { runId: string; sessionKey?: string; taskId?: string }
  | { taskId: string; sessionKey?: string; runId?: string };

export type ArtifactsListResult = {
  artifacts: ArtifactSummary[];
};

export type ArtifactsGetResult = {
  artifact: ArtifactSummary;
};

export type ArtifactsDownloadResult = {
  artifact: ArtifactSummary;
  encoding?: "base64";
  data?: string;
  url?: string;
};

export type SDKError = {
  code?: string;
  message: string;
  details?: unknown;
};

export type ToolInvokeParams = {
  args?: JsonObject;
  sessionKey?: string;
  agentId?: string;
  confirm?: boolean;
  idempotencyKey?: string;
};

export type ToolInvokeResult = {
  ok: boolean;
  toolName: string;
  output?: unknown;
  requiresApproval?: boolean;
  approvalId?: string;
  source?: string;
  error?: SDKError;
};

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

export type SessionCreateParams = {
  key?: string;
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  task?: string;
  message?: string;
};

export type SessionSendParams = {
  key: string;
  message: string;
  thinking?: string;
  attachments?: unknown[];
  timeoutMs?: number;
  idempotencyKey?: string;
};

export type SessionTarget = {
  key: string;
  sessionId?: string;
  agentId?: string;
  label?: string;
};

export type RunCreateParams = AgentRunParams;
