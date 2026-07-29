/** Bounded, sandboxed argv execution over the existing app-server connection. */
export type CodexCommandExecParams = {
  command: string[];
  env?: Record<string, string | null>;
  outputBytesCap?: number;
  timeoutMs?: number;
};

export type CodexCommandExecResponse = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
