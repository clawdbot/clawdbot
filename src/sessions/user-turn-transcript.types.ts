// User-turn transcript type contracts shared by runtime and queue option types.
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { InputProvenance } from "./input-provenance.js";

export type UserTurnSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  threadId?: string | number;
} & Record<string, unknown>;

export type PersistedUserTurnMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  kind?: string | null;
};

export type PersistedUserTurnMessage = Extract<AgentMessage, { role: "user" }>;

export type UserTurnInput = {
  text?: string | null;
  media?: readonly PersistedUserTurnMediaInput[] | null;
  timestamp?: number;
  idempotencyKey?: string;
  senderIsOwner?: boolean;
  provenance?: InputProvenance;
  mediaOnlyText?: string;
  /** Durable participant attribution. Callers must opt in at the product boundary. */
  sender?: { id?: string | null; name?: string | null; username?: string | null } | null;
};

export type UserTurnTranscriptUpdateMode = "inline" | "none";

export type UserTurnBeforeMessageWrite = (params: {
  message: PersistedUserTurnMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

type UserTurnTranscriptPersistenceTarget = {
  sessionId: string;
  sessionKey: string;
  sessionEntry: UserTurnSessionEntry | undefined;
  sessionStore?: Record<string, UserTurnSessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
  cwd?: string;
  config?: unknown;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
};

export type UserTurnTranscriptFileTarget = {
  transcriptPath: string;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  cwd?: string;
  config?: unknown;
};

export type UserTurnTranscriptTarget =
  | UserTurnTranscriptPersistenceTarget
  | UserTurnTranscriptFileTarget;

export type UserTurnTranscriptPersistResult = {
  sessionFile: string;
  sessionEntry: UserTurnSessionEntry | undefined;
  messageId: string;
  message: PersistedUserTurnMessage;
};

export type UserTurnTranscriptTargetResolver =
  | UserTurnTranscriptTarget
  | (() => UserTurnTranscriptTarget | undefined | Promise<UserTurnTranscriptTarget | undefined>);

export type UserTurnTranscriptRecorder = {
  readonly message: PersistedUserTurnMessage | undefined;
  resolveMessage: () => Promise<PersistedUserTurnMessage | undefined>;
  markSentToProvider?: () => void;
  markRuntimePersistencePending: (pending: Promise<void>) => void;
  markRuntimePersisted: (message?: PersistedUserTurnMessage) => void;
  markBlocked: () => void;
  hasPersisted: () => boolean;
  isBlocked: () => boolean;
  hasRuntimePersistencePending: () => boolean;
  waitForRuntimePersistence: () => Promise<void>;
  persistApproved: (params?: {
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
  }) => Promise<UserTurnTranscriptPersistResult | undefined>;
  persistFallback: (params?: {
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
  }) => Promise<UserTurnTranscriptPersistResult | undefined>;
};
