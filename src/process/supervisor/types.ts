// Process supervisor types describe supervised runs and termination reasons.

export type TerminationReason =
  | "manual-cancel"
  | "overall-timeout"
  | "no-output-timeout"
  | "spawn-error"
  | "signal"
  | "exit";

/** Producer-owned activity; a settled result does not establish descendant extinction. */
export type ProcessRunActivity = {
  readonly resultSettled: boolean;
  readonly lastOutputAtMs: number;
};

export type RunExit = {
  reason: TerminationReason;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  oomScoreWrapperSelected?: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

export type ManagedRun = {
  readonly activity: ProcessRunActivity;
  runId: string;
  pid?: number;
  startedAtMs: number;
  stdin?: ManagedRunStdin;
  wait: () => Promise<RunExit>;
  /** Join the adapter's native ownership boundary; deliberately detached outsiders are excluded. */
  waitForExtinction?: () => Promise<void>;
  cancel: (reason?: TerminationReason) => void;
  /** Stop every decoded, raw, captured, and output-clock update for this run. */
  detachOutput?: () => void;
};

export type ManagedRunStdin = {
  write: (data: string | Buffer, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroy?: () => void;
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  writableFinished?: boolean;
};

export type SpawnSecretInput = {
  fd: number;
  createData: () => Buffer;
};

export type ProcessAdapterConstruction = {
  assertCurrent?: () => void;
  abortSignal?: AbortSignal;
  /** Publish resource cleanup before readiness or private-input delivery can fail. */
  onSpawnCleanup?: (cleanup: Promise<void>) => void;
};

export type SpawnProcessAdapter<WaitSignal = NodeJS.Signals | number | null> = {
  pid?: number;
  stdin?: ManagedRunStdin;
  oomScoreWrapperSelected?: boolean;
  /** Both output subscriptions observe bytes separately from decoded text. */
  supportsRawOutput: boolean;
  onStdout: (listener: (chunk: string) => void, onRaw?: (chunk: Buffer) => void) => void;
  onStderr: (listener: (chunk: string) => void, onRaw?: (chunk: Buffer) => void) => void;
  onExit?: (listener: (code: number | null, signal: WaitSignal) => void) => void;
  onError?: (
    listener: (error: Error, source: "process" | "stdin" | "stdout" | "stderr") => void,
  ) => void;
  wait: () => Promise<{ code: number | null; signal: WaitSignal }>;
  waitForExtinction?: () => Promise<void>;
  kill: (signal?: NodeJS.Signals) => void;
  dispose: () => void;
};

type SpawnBaseInput = {
  /** The local subprocess transports execution owned outside its local process tree. */
  cleanupOwnership?: "external";
  /** Revalidate the caller at deferred spawn and private-input delivery boundaries. */
  assertCurrent?: () => void;
  runId?: string;
  scopeKey?: string;
  replaceExistingScope?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  /**
   * When false, stdout/stderr are streamed via callbacks only and not retained in RunExit payload.
   */
  captureOutput?: boolean;
  /**
   * Maximum retained stdout/stderr characters per stream when captureOutput is enabled.
   * Streaming callbacks still receive full chunks.
   */
  maxCapturedOutputChars?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type SpawnChildInput = SpawnBaseInput & {
  mode: "child";
  argv: string[];
  /** Preserve a distinct invocation name while executing argv[0]. */
  argv0?: string;
  /** Preserve a caller-prepared environment without environment-mutating spawn wrappers. */
  exactEnv?: true;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
  secretInput?: SpawnSecretInput;
  onStdoutRaw?: (chunk: Buffer) => void;
  onStderrRaw?: (chunk: Buffer) => void;
};

type SpawnPtyInput = SpawnBaseInput & {
  mode: "pty";
  argv: string[];
};

type SpawnAnchoredShellInput = SpawnBaseInput & {
  mode: "anchored-shell";
  command: string;
};

export type SpawnInput = SpawnChildInput | SpawnPtyInput | SpawnAnchoredShellInput;

/**
 * required-all includes external execution; owned-only leaves explicit backend
 * lifetimes with that backend; transport-only makes no execution-tree claim.
 */
export type ProcessScopeCleanupPolicy = "required-all" | "owned-only" | "transport-only";

export interface ProcessSupervisor {
  /** Register before spawning; close caller admission before joining this exact cleanup owner. */
  acquireScopeCleanup(
    scopeKey: string,
    options: { processTree: ProcessScopeCleanupPolicy },
  ): () => Promise<void>;
  spawn(input: SpawnInput): Promise<ManagedRun>;
  cancel(runId: string, reason?: TerminationReason): void;
  cancelScope(scopeKey: string, reason?: TerminationReason): void;
}
