/** Bounded, sandboxed argv execution over the existing app-server connection. */
export type CodexCommandExecParams = {
  command: string[];
  env?: Partial<Record<string, string | null>> | null;
  outputBytesCap?: number | null;
  timeoutMs?: number | null;
};

export type CodexCommandExecResponse = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
