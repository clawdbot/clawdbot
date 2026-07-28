export interface AndroidSigningCommandOptions {
  cwd?: string | URL;
  encoding?: BufferEncoding | "buffer" | null;
  env?: NodeJS.ProcessEnv;
  stdio?: unknown;
  timeoutMs?: number;
}

export function runAndroidSigningCommandSync(
  command: string,
  args: readonly string[],
  options?: AndroidSigningCommandOptions,
): Buffer | string | null;
