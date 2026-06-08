// Agent Core type module defines shared TypeScript contracts.
import type {
  ImageContent,
  Model,
  SimpleStreamOptions,
  StreamFn,
  TextContent,
  Transport,
} from "../../../llm-core/src/index.js";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../index.js";
import type { AgentCoreCompletionRuntimeDeps, AgentCoreRuntimeDeps } from "../runtime-deps.js";
import type { Session } from "./session/session.js";

/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** Create a successful {@link Result}. */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
  return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
  return { ok: false, error };
}

/** Return the success value or throw the failure error. Intended for tests and explicit adapter boundaries. */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
  if (!result.ok) {
    throw toLintErrorObject(result.error, "Non-Error thrown");
  }
  return result.value;
}

/** Return the success value or `undefined`. Only object values are allowed to avoid truthiness bugs with primitives. */
export function getOrUndefined<TValue extends object, TError>(
  result: Result<TValue, TError>,
): TValue | undefined {
  return result.ok ? result.value : undefined;
}

/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

/**
 * Skill loaded from a `SKILL.md` file or provided by an application.
 *
 * `name`, `description`, `filePath`, and optional `promptVersion` are inserted into the system prompt in an XML-formatted block as suggested by agentskills.io.
 * Use {@link formatSkillsForSystemPrompt} to generate the spec-compatible system prompt block.
 */
export interface Skill {
  /** Stable skill name used for lookup and model-visible listings. */
  name: string;
  /** Short model-visible description of when to use the skill. */
  description: string;
  /** Full skill instructions. */
  content: string;
  /** Absolute path to the skill file. Used for model-visible location and resolving relative references. */
  filePath: string;
  /** Deterministic marker for the skill content, rendered as <version> when available. */
  promptVersion?: string;
  /** Exclude this skill from model-visible skill lists while still allowing explicit application invocation. */
  disableModelInvocation?: boolean;
}

/** Prompt template that can be formatted into a prompt for explicit invocation. */
export interface PromptTemplate {
  /** Stable template name used for lookup or application command routing. */
  name: string;
  /** Optional description for command lists or autocomplete. */
  description?: string;
  /** Template content. Argument placeholders are formatted by `formatPromptTemplateInvocation`. */
  content: string;
}

/** Resources made available to explicit invocation methods and system-prompt callbacks. */
export interface AgentHarnessResources<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
  /** Prompt templates available for explicit invocation. */
  promptTemplates?: TPromptTemplate[];
  /** Skills available to the model and explicit skill invocation. */
  skills?: TSkill[];
}

/** Curated provider request options owned by the harness and snapshotted per turn. */
export interface AgentHarnessStreamOptions {
  /** Preferred transport forwarded to the stream function. */
  transport?: Transport;
  /** Provider request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum provider retry attempts. */
  maxRetries?: number;
  /** Optional cap for provider-requested retry delays. */
  maxRetryDelayMs?: number;
  /** Additional request headers merged with auth and lifecycle headers. */
  headers?: Record<string, string>;
  /** Provider metadata forwarded with requests. */
  metadata?: SimpleStreamOptions["metadata"];
  /** Provider cache retention hint. */
  cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

/** Per-request stream option patch returned by provider hooks. */
export interface AgentHarnessStreamOptionsPatch extends Omit<
  Partial<AgentHarnessStreamOptions>,
  "headers" | "metadata"
> {
  /** Header patch. `undefined` values delete keys; explicit `headers: undefined` clears all headers. */
  headers?: Record<string, string | undefined>;
  /** Metadata patch. `undefined` values delete keys; explicit `metadata: undefined` clears all metadata. */
  metadata?: Record<string, unknown>;
}

/** Kind of filesystem object as addressed by a {@link FileSystem}. Symlinks are not followed automatically. */
export type FileKind = "file" | "directory" | "symlink";

/** Stable, backend-independent file error codes returned by {@link FileSystem} file operations. */
export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown";

/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
  /** Backend-independent error code. */
  public code: FileErrorCode;
  /** Absolute addressed path associated with the failure, when available. */
  public path?: string;

  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FileError";
    this.code = code;
    this.path = path;
  }
}

/** Stable, backend-independent execution error codes returned by {@link ExecutionEnv.exec}. */
export type ExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "shell_unavailable"
  | "spawn_error"
  | "callback_error"
  | "unknown";

/** Error returned by {@link ExecutionEnv.exec}. */
export class ExecutionError extends Error {
  /** Backend-independent error code. */
  public code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExecutionError";
    this.code = code;
  }
}

/** Stable compaction error codes returned by compaction helpers. */
export type CompactionErrorCode =
  | "aborted"
  | "summarization_failed"
  | "invalid_session"
  | "unknown";

/** Error returned by compaction helpers. */
export class CompactionError extends Error {
  /** Backend-independent error code. */
  public code: CompactionErrorCode;

  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactionError";
    this.code = code;
  }
}

/** Stable branch-summary error codes returned by branch summarization helpers. */
export type BranchSummaryErrorCode = "aborted" | "summarization_failed" | "invalid_session";

/** Error returned by branch summarization helpers. */
export class BranchSummaryError extends Error {
  /** Backend-independent error code. */
  public code: BranchSummaryErrorCode;

  constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BranchSummaryError";
    this.code = code;
  }
}

export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_entry"
  | "invalid_fork_target"
  | "storage"
  | "unknown";

/** Error thrown by session storage, repositories, and session tree operations. */
export class SessionError extends Error {
  /** Session subsystem error code. */
  public code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionError";
    this.code = code;
  }
}

export type AgentHarnessErrorCode =
  | "busy"
  | "invalid_state"
  | "invalid_argument"
  | "session"
  | "hook"
  | "auth"
  | "compaction"
  | "branch_summary"
  | "unknown";

/** Public AgentHarness failure with a stable top-level classification. */
export class AgentHarnessError extends Error {
  public code: AgentHarnessErrorCode;

  constructor(code: AgentHarnessErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentHarnessError";
    this.code = code;
  }
}

/** Metadata for one filesystem object in a {@link FileSystem}. */
export interface FileInfo {
  /** Basename of {@link path}. */
  name: string;
  /** Absolute, syntactically normalized addressed path in the execution environment. Symlinks are not followed. */
  path: string;
  /** Object kind. Symlink targets are not followed; use {@link FileSystem.canonicalPath} explicitly. */
  kind: FileKind;
  /** Size in bytes for the addressed filesystem object. */
  size: number;
  /** Modification time as milliseconds since Unix epoch. */
  mtimeMs: number;
}

/** Options for {@link Shell.exec}. */
export interface ExecutionEnvExecOptions {
  /** Working directory for the command. Relative paths are resolved against {@link ExecutionEnv.cwd}. Defaults to {@link ExecutionEnv.cwd}. */
  cwd?: string;
  /** Additional environment variables for the command. Values override the environment defaults. Defaults to no overrides. */
  env?: Record<string, string>;
  /** Timeout in seconds. Implementations should return a timeout error when the command exceeds this duration. Defaults to no timeout. */
  timeout?: number;
  /** Abort signal used to terminate the command. Defaults to no abort signal. */
  abortSignal?: AbortSignal;
  /** Called with stdout chunks as they are produced. */
  onStdout?: (chunk: string) => void;
  /** Called with stderr chunks as they are produced. */
  onStderr?: (chunk: string) => void;
}

/**
 * Filesystem capability used by the harness.
 *
 * Paths passed to methods may be absolute or relative to {@link cwd}. Paths returned by file operations are addressed paths
 * in the filesystem namespace, but are not canonicalized through symlinks unless returned by {@link canonicalPath}.
 *
 * Operation methods must never throw or reject. All filesystem failures, including unexpected backend failures, must be
 * encoded in the returned {@link Result}. Implementations must preserve this invariant.
 */
export interface FileSystem {
  /** Current working directory for relative paths. */
  cwd: string;

  /** Return an absolute addressed path without requiring it to exist and without resolving symlinks. */
  absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  /** Join path segments in the filesystem namespace without requiring the result to exist. */
  joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  /** Read a UTF-8 text file. */
  readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  /** Read UTF-8 text lines. Implementations should stop once `maxLines` lines have been read. */
  readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>>;
  /** Read a binary file. */
  readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>;
  /** Create or overwrite a file, creating parent directories when supported. */
  writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>;
  /** Create or append to a file, creating parent directories when supported. */
  appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>;
  /** Return metadata for the addressed path without following symlinks. */
  fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
  /** List direct children of a directory without following symlinks. */
  listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
  /** Return the canonical path for an existing path, resolving symlinks where supported. */
  canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  /** Return false for missing paths. Other errors, such as permission failures, return a {@link FileError}. */
  exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
  /** Create a directory. Defaults: `recursive: true`, no abort signal. */
  createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>>;
  /** Remove a file or directory. Defaults: `recursive: false`, `force: false`, no abort signal. */
  remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>>;
  /** Create a temporary directory and return its absolute path. Defaults: `prefix: "tmp-"`, no abort signal. */
  createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  /** Create a temporary file and return its absolute path. Defaults: `prefix: ""`, `suffix: ""`, no abort signal. */
  createTempFile(options?: {
    prefix?: string;
    suffix?: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<string, FileError>>;

  /** Release filesystem resources. Must be best-effort and must not throw or reject. */
  cleanup(): Promise<void>;
}

/** Shell execution capability used by the harness. */
export interface Shell {
  /** Execute a shell command in {@link FileSystem.cwd} unless `options.cwd` is provided. */
  exec(
    command: string,
    options?: ExecutionEnvExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
  /** Release shell resources. Must be best-effort and must not throw or reject. */
  cleanup(): Promise<void>;
}

/** Filesystem and process execution environment used by the harness. */
export interface ExecutionEnv extends FileSystem, Shell {}

/** Base fields shared by append-only session tree entries. */
export interface SessionTreeEntryBase {
  /** Entry discriminator used for JSONL persistence and typed narrowing. */
  type: string;
  /** Stable entry id unique within a session file. */
  id: string;
  /** Parent entry id, or null for a root entry. */
  parentId: string | null;
  /** ISO timestamp string used for persistence and sorting. */
  timestamp: string;
}

/** Persisted transcript message entry. */
export interface MessageEntry extends SessionTreeEntryBase {
  type: "message";
  message: AgentMessage;
}

/** Persisted thinking-level selection marker. */
export interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

/** Persisted model selection marker. */
export interface ModelChangeEntry extends SessionTreeEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

/** Persisted summary that replaces older transcript history in context. */
export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
}

/** Persisted summary of an abandoned branch when navigating the session tree. */
export interface BranchSummaryEntry<T = unknown> extends SessionTreeEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
}

/** Persisted harness/application marker that is not replayed into model context. */
export interface CustomEntry<T = unknown> extends SessionTreeEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}

/** Persisted harness/application message that can be replayed into model context. */
export interface CustomMessageEntry<T = unknown> extends SessionTreeEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: T;
  display: boolean;
}

/** Append-only label update for another session entry. */
export interface LabelEntry extends SessionTreeEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

/** Persisted session metadata marker. */
export interface SessionInfoEntry extends SessionTreeEntryBase {
  // The persisted discriminator predates the public "session name" wording.
  type: "session_info";
  name?: string;
}

/** Append-only marker that changes the active visible leaf. */
export interface LeafEntry extends SessionTreeEntryBase {
  type: "leaf";
  targetId: string | null;
}

/** All persisted session tree entry variants. */
export type SessionTreeEntry =
  | MessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry
  | LeafEntry;

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
}

export interface JsonlSessionMetadata extends SessionMetadata {
  cwd: string;
  path: string;
  parentSessionPath?: string;
}

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLeafId(): Promise<string | null>;
  /** Persist a leaf entry that records the active session-tree leaf. */
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
  getLabel(id: string): Promise<string | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
}

export type { Session } from "./session/session.js";

export interface SessionCreateOptions {
  id?: string;
}

export interface SessionForkOptions {
  entryId?: string;
  position?: "before" | "at";
  id?: string;
}

export interface SessionRepo<
  TMetadata extends SessionMetadata = SessionMetadata,
  TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
  TListOptions = void,
> {
  create(options: TCreateOptions): Promise<Session<TMetadata>>;
  open(metadata: TMetadata): Promise<Session<TMetadata>>;
  list(options?: TListOptions): Promise<TMetadata[]>;
  delete(metadata: TMetadata): Promise<void>;
  fork(
    source: TMetadata,
    options: SessionForkOptions & TCreateOptions,
  ): Promise<Session<TMetadata>>;
}

export interface JsonlSessionCreateOptions extends SessionCreateOptions {
  cwd: string;
  parentSessionPath?: string;
}

export interface JsonlSessionListOptions {
  cwd?: string;
}

export interface JsonlSessionRepoApi extends SessionRepo<
  JsonlSessionMetadata,
  JsonlSessionCreateOptions,
  JsonlSessionListOptions
> {}

export type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";

export type PendingSessionWrite = SessionTreeEntry extends infer TEntry
  ? TEntry extends SessionTreeEntry
    ? Omit<TEntry, "id" | "parentId" | "timestamp">
    : never
  : never;

export interface QueueUpdateEvent {
  type: "queue_update";
  steer: AgentMessage[];
  followUp: AgentMessage[];
  nextTurn: AgentMessage[];
}

export interface SavePointEvent {
  type: "save_point";
  hadPendingMutations: boolean;
}

export interface AbortEvent {
  type: "abort";
  clearedSteer: AgentMessage[];
  clearedFollowUp: AgentMessage[];
}

export interface SettledEvent {
  type: "settled";
  nextTurnCount: number;
}

export interface BeforeAgentStartEvent<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
  type: "before_agent_start";
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;
  resources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  model: Model;
  sessionId: string;
  streamOptions: AgentHarnessStreamOptions;
}

export interface BeforeProviderPayloadEvent {
  type: "before_provider_payload";
  model: Model;
  payload: unknown;
}

export interface AfterProviderResponseEvent {
  type: "after_provider_response";
  status: number;
  headers: Record<string, string>;
}

export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: Array<TextContent | ImageContent>;
  details: unknown;
  isError: boolean;
}

export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  branchEntries: SessionTreeEntry[];
  customInstructions?: string;
  signal: AbortSignal;
}

export interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry: CompactionEntry;
  fromHook: boolean;
}

export interface SessionBeforeTreeEvent {
  type: "session_before_tree";
  preparation: TreePreparation;
  signal: AbortSignal;
}

export interface SessionTreeEvent {
  type: "session_tree";
  newLeafId: string | null;
  oldLeafId: string | null;
  summaryEntry?: BranchSummaryEntry;
  fromHook?: boolean;
}

export interface ModelSelectEvent {
  type: "model_select";
  model: Model;
  previousModel: Model | undefined;
  source: "set" | "restore";
}

export interface ThinkingLevelSelectEvent {
  type: "thinking_level_select";
  level: ThinkingLevel;
  previousLevel: ThinkingLevel;
}

export interface ResourcesUpdateEvent<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
  type: "resources_update";
  resources: AgentHarnessResources<TSkill, TPromptTemplate>;
  previousResources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

export type AgentHarnessOwnEvent<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
> =
  | QueueUpdateEvent
  | SavePointEvent
  | AbortEvent
  | SettledEvent
  | BeforeAgentStartEvent<TSkill, TPromptTemplate>
  | ContextEvent
  | BeforeProviderRequestEvent
  | BeforeProviderPayloadEvent
  | AfterProviderResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent
  | SessionBeforeTreeEvent
  | SessionTreeEvent
  | ModelSelectEvent
  | ThinkingLevelSelectEvent
  | ResourcesUpdateEvent<TSkill, TPromptTemplate>;

export type AgentHarnessEvent<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
> = AgentEvent | AgentHarnessOwnEvent<TSkill, TPromptTemplate>;

/** Hook result for mutating the initial prompt run before the agent starts. */
export interface BeforeAgentStartResult {
  /** Replacement messages for the prompt run. */
  messages?: AgentMessage[];
  /** Replacement system prompt for the prompt run. */
  systemPrompt?: string;
}

/** Hook result for replacing the full context message list before provider conversion. */
export interface ContextResult {
  messages: AgentMessage[];
}

/** Hook result for patching provider request options before payload construction. */
export interface BeforeProviderRequestResult {
  streamOptions?: AgentHarnessStreamOptionsPatch;
}

/** Hook result for replacing the provider payload after construction. */
export interface BeforeProviderPayloadResult {
  payload: unknown;
}

/** Hook result for blocking a tool call before execution. */
export interface ToolCallResult {
  block?: boolean;
  reason?: string;
}

/** Hook patch for a completed tool result before it is persisted/emitted. */
export interface ToolResultPatch {
  content?: Array<TextContent | ImageContent>;
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

/** Hook result for cancelling or replacing a planned compaction. */
export interface SessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: CompactResult;
}

/** Hook result for cancelling, labeling, or supplying branch-summary behavior before tree navigation. */
export interface SessionBeforeTreeResult {
  cancel?: boolean;
  summary?: { summary: string; details?: unknown };
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

/** Typed return values expected from AgentHarness hook handlers by event type. */
export type AgentHarnessEventResultMap = {
  before_agent_start: BeforeAgentStartResult | undefined;
  context: ContextResult | undefined;
  before_provider_request: BeforeProviderRequestResult | undefined;
  before_provider_payload: BeforeProviderPayloadResult | undefined;
  after_provider_response: undefined;
  tool_call: ToolCallResult | undefined;
  tool_result: ToolResultPatch | undefined;
  session_before_compact: SessionBeforeCompactResult | undefined;
  session_compact: undefined;
  session_before_tree: SessionBeforeTreeResult | undefined;
  session_tree: undefined;
  model_select: undefined;
  thinking_level_select: undefined;
  resources_update: undefined;
  queue_update: undefined;
  save_point: undefined;
  abort: undefined;
  settled: undefined;
};

/** Options for a prompt submitted through AgentHarness. */
export interface AgentHarnessPromptOptions {
  images?: ImageContent[];
}

/** Queued messages removed by an abort operation. */
export interface AbortResult {
  clearedSteer: AgentMessage[];
  clearedFollowUp: AgentMessage[];
}

/** Compaction data supplied by hooks or returned from compaction preparation. */
export interface CompactResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

/** Result of moving the active session-tree leaf. */
export interface NavigateTreeResult {
  cancelled: boolean;
  editorText?: string;
  summaryEntry?: BranchSummaryEntry;
}

/** Settings that control automatic context compaction. */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** Prepared compaction inputs exposed to hooks before a summary is generated. */
export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}

/** File operations accumulated from summarized transcript ranges. */
export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/** Prepared branch navigation inputs exposed to hooks before a summary is generated. */
export interface TreePreparation {
  targetId: string;
  oldLeafId: string | null;
  commonAncestorId: string | null;
  entriesToSummarize: SessionTreeEntry[];
  userWantsSummary: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

/** Options for generating a branch summary. */
export interface GenerateBranchSummaryOptions {
  model: Model;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  runtime?: AgentCoreCompletionRuntimeDeps;
  streamFn?: StreamFn;
  customInstructions?: string;
  replaceInstructions?: boolean;
  reserveTokens?: number;
}

/** Generated branch summary text and file-operation metadata. */
export interface BranchSummaryResult {
  summary: string;
  readFiles: string[];
  modifiedFiles: string[];
}

/** Construction options for AgentHarness. */
export interface AgentHarnessOptions<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
  TTool extends AgentTool = AgentTool,
> {
  env: ExecutionEnv;
  session: Session;
  tools?: TTool[];
  /**
   * Concrete resources available to explicit invocation methods and system-prompt callbacks.
   * Applications own loading/reloading resources and should call `setResources()` with new values.
   */
  resources?: AgentHarnessResources<TSkill, TPromptTemplate>;
  systemPrompt?:
    | string
    | ((context: {
        env: ExecutionEnv;
        session: Session;
        model: Model;
        thinkingLevel: ThinkingLevel;
        activeTools: TTool[];
        resources: AgentHarnessResources<TSkill, TPromptTemplate>;
      }) => string | Promise<string>);
  getApiKeyAndHeaders?: (
    model: Model,
  ) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;
  runtime?: AgentCoreRuntimeDeps;
  /** Curated stream/provider request options. Snapshotted at turn start. */
  streamOptions?: AgentHarnessStreamOptions;
  model: Model;
  thinkingLevel?: ThinkingLevel;
  activeToolNames?: string[];
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
}

export type { CoreAgentHarness as AgentHarness } from "./agent-harness.js";

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
