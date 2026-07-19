export const GHSA_COMMAND_TIMEOUT_MS: number;

export function runGhCommand(
  args: string[],
  params?: {
    spawnSyncImpl?: (
      command: string,
      args: string[],
      options: {
        encoding: "utf8";
        killSignal: "SIGKILL";
        timeout: number;
      },
    ) => {
      error?: Error;
      status: number | null;
      stderr: string;
      stdout: string;
    };
    timeoutMs?: number;
  },
): string;
