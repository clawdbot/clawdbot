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
  cancel: (reason?: TerminationReason) => void;
};

export type SpawnMode = "child" | "pty";

export type ManagedRunStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroy?: () => void;
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  writableFinished?: boolean;
};

export type SpawnProcessAdapter<WaitSignal = NodeJS.Signals | number | null> = {
  pid?: number;
  stdin?: ManagedRunStdin;
  onStdout: (listener: (chunk: string) => void) => void;
  onStderr: (listener: (chunk: string) => void) => void;
  wait: () => Promise<{ code: number | null; signal: WaitSignal }>;
  kill: (signal?: NodeJS.Signals) => void;
  dispose: () => void;
};

type SpawnBaseInput = {
  runId?: string;
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
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type SpawnChildInput = SpawnBaseInput & {
  mode: "child";
  argv: string[];
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
};

type SpawnPtyInput = SpawnBaseInput & {
  mode: "pty";
  ptyCommand: string;
};

export type SpawnInput = SpawnChildInput | SpawnPtyInput;

export interface ProcessSupervisor {
  spawn(input: SpawnInput): Promise<ManagedRun>;
  cancel(runId: string, reason?: TerminationReason): void;
  cancelScope(scopeKey: string, reason?: TerminationReason): void;
  reconcileOrphans(): Promise<void>;
  getRecord(runId: string): RunRecord | undefined;
}
