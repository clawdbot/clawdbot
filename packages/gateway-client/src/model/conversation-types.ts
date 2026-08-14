import type { EventFrame, UiArtifact, UiArtifactViewOffer } from "@openclaw/gateway-protocol";
import type { GatewaySessionMessageSubscriptionCoordinator } from "../browser.js";
import type { ControlModelConversation } from "./conversation.js";
import type {
  ControlModelConnectionSnapshot,
  ControlModelError,
  ControlModelGatewayBinding,
  DeepReadonly,
} from "./model.js";

export type ControlModelConversationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "partial"
  | "stale"
  | "error"
  | "disposed";
export type ControlModelCommandCategory =
  | "disconnected"
  | "disposed"
  | "unsupported"
  | "invalid-input"
  | "stale"
  | "forbidden"
  | "conflict"
  | "not-found"
  | "timeout"
  | "aborted"
  | "retryable"
  | "malformed";

export class ControlModelCommandError extends Error {
  readonly category: ControlModelCommandCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly command: string;

  constructor(options: {
    category: ControlModelCommandCategory;
    code: string;
    message: string;
    command: string;
    retryable?: boolean;
    retryAfterMs?: number;
  }) {
    super(options.message);
    this.name = "ControlModelCommandError";
    this.category = options.category;
    this.code = options.code;
    this.retryable = options.retryable === true;
    this.retryAfterMs = options.retryAfterMs;
    this.command = options.command;
  }
}

export type ControlModelConversationMessage = Readonly<{
  key: string;
  role: string;
  sequence: number | null;
  runId: string | null;
  pending: boolean;
  live: boolean;
  provisional: boolean;
  artifactIds: readonly string[];
  raw: DeepReadonly<unknown>;
}>;
export type ControlModelConversationRun = Readonly<{
  runId: string;
  status: string;
  message?: DeepReadonly<unknown>;
  stopReason?: string;
  errorKind?: string;
  errorMessage?: string;
}>;
export type ControlModelToolStatus = "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type ControlModelConversationTool = Readonly<{
  key: string;
  runId: string;
  toolCallId: string;
  name: string | null;
  status: ControlModelToolStatus;
  phase: string;
  input: unknown;
  output: unknown;
  truncated: boolean;
  artifactIds: readonly string[];
  progress: Readonly<{ updates: number; bytes: number; truncated: boolean }>;
}>;
export type ControlModelConversationApproval = DeepReadonly<Record<string, unknown>> &
  Readonly<{
    id: string;
    status: string;
    presentation?: DeepReadonly<Record<string, unknown>>;
  }>;
export type ControlModelConversationQuestion = DeepReadonly<Record<string, unknown>> &
  Readonly<{ id: string; status: string }>;
export type ControlModelConversationBounds = Readonly<{
  maxSubscribers: number;
  maxMessages: number;
  maxRuns: number;
  maxTools: number;
  maxApprovals: number;
  maxQuestions: number;
  maxProgressUpdates: number;
  maxProgressBytes: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
  maxArtifactDepth: number;
  maxArtifactCollectionItems: number;
  maxArtifactStringBytes: number;
  maxArtifactViews: number;
}>;
export type ControlModelConversationHistory = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  hasMore: boolean;
  nextOffset: number | null;
  totalMessages: number | null;
  completeSnapshot: boolean;
  window: "newest" | "older";
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  revision: number;
  error: ControlModelError | null;
}>;
export type ControlModelConversationSnapshot = Readonly<{
  sessionKey: string;
  status: ControlModelConversationStatus;
  revision: number;
  historyRevision: number;
  connection: ControlModelConnectionSnapshot;
  history: ControlModelConversationHistory;
  messages: readonly ControlModelConversationMessage[];
  runs: readonly ControlModelConversationRun[];
  activeRun: ControlModelConversationRun | null;
  tools: readonly ControlModelConversationTool[];
  artifacts: readonly DeepReadonly<UiArtifact>[];
  approvals: readonly ControlModelConversationApproval[];
  questions: readonly ControlModelConversationQuestion[];
  partialReasons: readonly string[];
  stale: boolean;
  hasTransportGap: boolean;
  commandAvailability: Readonly<{
    send: boolean;
    abort: boolean;
    resolveApproval: boolean;
    answerQuestion: boolean;
    cancelQuestion: boolean;
    materializeView: boolean;
  }>;
  bounds: Readonly<{
    messagesTruncated: boolean;
    runsTruncated: boolean;
    toolsTruncated: boolean;
    approvalsTruncated: boolean;
    questionsTruncated: boolean;
    artifactsTruncated: boolean;
  }>;
}>;

export type ControlModelSendInput =
  | string
  | Readonly<{
      message?: string;
      content?: string;
      attachments?: readonly unknown[];
      idempotencyKey?: string;
      thinking?: string;
      fastMode?: boolean | "auto";
      fastAutoOnSeconds?: number;
      queueMode?: string;
      replyToId?: string;
      toolBindings?: Readonly<Record<string, unknown>>;
      timeoutMs?: number;
      expectedLeafEntryId?: string | null;
      expectedRunId?: string;
      suppressCommandInterpretation?: boolean;
    }>;
export type ControlModelSendResult = Readonly<{
  runId: string | null;
  status: string;
  idempotencyKey: string;
}>;
export type ControlModelMaterializeViewInput = Readonly<{
  artifactId: string;
  artifactRevision: number;
  viewId: string;
}>;
export type ControlModelMaterializedView = DeepReadonly<UiArtifactViewOffer>;
export type ControlModelConversationSubscriber = () => void | Promise<void>;
export type ControlModelGatewayEventFrame = Readonly<
  EventFrame & {
    connectionEpoch: number;
    gap?: boolean | Readonly<Record<string, unknown>>;
  }
>;
export type ControlModelConversationHost = Readonly<{
  gateway: ControlModelGatewayBinding;
  agentId?: string;
  getConnectionSnapshot(): ControlModelConnectionSnapshot;
  isRunning(): boolean;
  getMessageSubscriptionCoordinator(): GatewaySessionMessageSubscriptionCoordinator;
  onConversationReleased(conversation: ControlModelConversation): Promise<void>;
  now(): number;
  generateId(prefix: string): string;
  reportSubscriberError(error: unknown): void;
  reportBackgroundError(error: unknown): void;
  bounds: ControlModelConversationBounds;
}>;
