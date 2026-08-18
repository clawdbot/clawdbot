// User-turn transcript type contracts shared by runtime and queue option types.
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "../config/sessions/session-transcript-turn-lifecycle.types.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { TranscriptTurnAdmission } from "../config/sessions/transcript-turn-admission.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { MediaFactInput } from "../media/media-facts.js";
import type { InputProvenance } from "./input-provenance.js";

type UserTurnSessionEntry = SessionEntry;

export type PersistedUserTurnMediaInput = Pick<
  MediaFactInput,
  | "contentType"
  | "durationMs"
  | "fileName"
  | "height"
  | "hydrationSuppressed"
  | "messageId"
  | "path"
  | "sizeBytes"
  | "transcribed"
  | "url"
  | "width"
> & {
  kind?: string | null;
  workspaceDir?: string | null;
};

export type PersistedUserTurnMessage = Extract<AgentMessage, { role: "user" }> & {
  __openclaw?: Record<string, unknown>;
};

export type UserTurnInput = {
  text?: string | null;
  media?: readonly PersistedUserTurnMediaInput[] | null;
  /** Restart-safe native image placement; model-visible prompt bytes remain separate. */
  mediaImageLayout?: {
    slots: readonly {
      kind: "inline" | "offloaded";
      factIndex?: number;
    }[];
    suppressedFactIndexes?: readonly number[];
  } | null;
  timestamp?: number;
  idempotencyKey?: string;
  /** Private durable receipts for managed system events adopted by this turn. */
  sessionDeliveryAckIds?: readonly string[];
  /** Durable transcript message reference used to render and hydrate replies. */
  replyToId?: string;
  /** Bounded display fallback for replies whose target is outside loaded history. */
  replyToPreview?: { text: string; senderLabel?: string | null } | null;
  senderIsOwner?: boolean;
  provenance?: InputProvenance;
  /** Durable participant attribution. Callers must opt in at the product boundary. */
  sender?: { id?: string | null; name?: string | null; username?: string | null } | null;
  /** Durable transport correlation; stored privately and never rendered into model input. */
  transport?: {
    channel?: string;
    conversationRef?: string;
    messageId?: string;
    replyToId?: string;
    threadId?: string;
  };
};

export type UserTurnTranscriptUpdateMode = "inline" | "none";

export type UserTurnMessagePersistenceParams = {
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  cwd?: string;
  config?: unknown;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
};

type UserTurnBeforeMessageWrite = (params: {
  message: PersistedUserTurnMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

type UserTurnTranscriptPersistenceTarget = {
  sessionId: string;
  expectedSessionId?: string;
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

export type UserTurnTranscriptTarget = UserTurnTranscriptPersistenceTarget;

export type UserTurnTranscriptAdmissionReceipt = TranscriptTurnAdmission;

export type UserTurnTranscriptPersistResult = {
  /** True only when this call inserted the transcript message. */
  appended?: boolean;
  sessionFile: string;
  sessionEntry: UserTurnSessionEntry | undefined;
  messageId: string;
  message: PersistedUserTurnMessage;
  admission: UserTurnTranscriptAdmissionReceipt;
};

export type UserTurnTranscriptTargetResolver =
  | UserTurnTranscriptTarget
  | (() => UserTurnTranscriptTarget | undefined | Promise<UserTurnTranscriptTarget | undefined>);

export type PersistUserTurnTranscriptParams = {
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  sessionId: string;
  expectedSessionId?: string;
  sessionKey: string;
  sessionEntry: UserTurnSessionEntry | undefined;
  sessionStore?: Record<string, UserTurnSessionEntry>;
  storePath?: string;
  agentId: string;
  logicalTurnId?: string;
  threadId?: string | number;
  cwd?: string;
  config?: unknown;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
};

type UserTurnInputResolver = () => UserTurnInput | undefined | Promise<UserTurnInput | undefined>;

export type CreateUserTurnTranscriptRecorderParams = {
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  resolveInput?: UserTurnInputResolver;
  target: UserTurnTranscriptTargetResolver;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
  errorContext?: string;
  onPersistenceError?: (error: unknown) => void;
  onMessagePersisted?: (message: PersistedUserTurnMessage) => void | Promise<void>;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
};

export type UserTurnTranscriptRecorder = {
  readonly message: PersistedUserTurnMessage | undefined;
  resolveMessage: () => Promise<PersistedUserTurnMessage | undefined>;
  /** Replaces generated current-turn text before runtime persistence/provider submission. */
  replaceTextBeforePersistence?: (text: string) => void;
  /** Confirms exact-run steering provenance after transcript commitment is proven. */
  confirmSteerTargetRunIdForPersistence?: (targetRunId: string) => Promise<void>;
  getPersistedMessage?: () => PersistedUserTurnMessage | undefined;
  getAdmissionReceipt: () => UserTurnTranscriptAdmissionReceipt | undefined;
  replaceSessionDeliveryAckIds?: (deliveryIds: readonly string[]) => boolean;
  setAdmissionHandler?: (handler: (admission: UserTurnTranscriptAdmissionReceipt) => void) => void;
  markSentToProvider?: () => void;
  markRuntimePersistencePending: (pending: Promise<void>) => void;
  markRuntimePersisted: (
    message?: PersistedUserTurnMessage,
    anchor?: TranscriptEntryAnchor | UserTurnTranscriptAdmissionReceipt,
  ) => void;
  markBlocked: () => void;
  hasPersisted: () => boolean;
  isBlocked: () => boolean;
  hasRuntimePersistencePending: () => boolean;
  waitForRuntimePersistence: () => Promise<void>;
  persistApproved: (params?: {
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
    cwd?: string;
    expectedSessionId?: string;
    expectedSessionState?: SessionTranscriptTurnExpectedState;
    sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
    /** Allow a later explicit persistence attempt when this attempt appends nothing. */
    retryIfUnpersisted?: boolean;
  }) => Promise<UserTurnTranscriptPersistResult | undefined>;
  persistBlocked: (
    message: PersistedUserTurnMessage,
    params?: {
      target?: UserTurnTranscriptTargetResolver;
      updateMode?: UserTurnTranscriptUpdateMode;
      cwd?: string;
    },
  ) => Promise<UserTurnTranscriptPersistResult | undefined>;
  persistFallback: (params?: {
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
    cwd?: string;
  }) => Promise<UserTurnTranscriptPersistResult | undefined>;
};
