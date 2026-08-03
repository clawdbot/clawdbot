/**
 * Minimal shell execution interface injected into bash session tools.
 */

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      /**
       * stdout and stderr are independent pipes, so each needs its own decode
       * state; tag chunks to keep them apart. Untagged chunks share one lane,
       * preserving behavior for operations that cannot distinguish streams.
       */
      onData: (data: Buffer, stream?: "stdout" | "stderr") => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}
