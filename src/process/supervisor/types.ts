// Process supervisor types describe supervised runs, states, and termination reasons.
export type RunState = "starting" | "running" | "exiting" | "exited";

export type TerminationReason =
  | "manual-cancel"
  | "overall-timeout"
  | "no-output-timeout"
  | "spawn-error"
  | "signal"
  | "exit";

export type RunRecord = {
  runId: string;
  sessionId: string;
  backendId: string;
  scopeKey?: string;
  pid?: number;
  processGroupId?: number;
  startedAtMs: number;
  lastOutputAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  state: RunState;
  terminationReason?: TerminationReason;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
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
  runId: string;
  pid?: number;
  startedAtMs: number;
  stdin?: ManagedRunStdin;
  wait: () => Promise<RunExit>;
  /** The root result may settle before its independently owned descendants exit. */
  waitForExtinction?: () => Promise<void>;
  cancel: (reason?: TerminationReason) => void;
  /** Stop every decoded, raw, captured, and output-clock update for this run. */
  detachOutput?: () => void;
};

export type ManagedRunStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
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

export type SpawnProcessAdapter<WaitSignal = NodeJS.Signals | number | null> = {
  pid?: number;
  stdin?: ManagedRunStdin;
  oomScoreWrapperSelected?: boolean;
  /** Both output subscriptions observe bytes separately from decoded text. */
  supportsRawOutput: boolean;
  onStdout: (listener: (chunk: string) => void, onRaw?: (chunk: Buffer) => void) => void;
  onStderr: (listener: (chunk: string) => void, onRaw?: (chunk: Buffer) => void) => void;
  wait: () => Promise<{ code: number | null; signal: WaitSignal }>;
  waitForExtinction?: () => Promise<void>;
  kill: (signal?: NodeJS.Signals) => void;
  dispose: () => void;
};

type SpawnBaseInput = {
  runId?: string;
  /** Revalidate caller authority after queued startup and before each process launch. */
  assertCurrent?: () => void;
  sessionId: string;
  backendId: string;
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

export interface ProcessSupervisor {
  spawn(input: SpawnInput): Promise<ManagedRun>;
  cancel(runId: string, reason?: TerminationReason): void;
  cancelScope(scopeKey: string, reason?: TerminationReason): void;
  waitForScope?: (scopeKey: string) => Promise<void>;
  getRecord(runId: string): RunRecord | undefined;
}
