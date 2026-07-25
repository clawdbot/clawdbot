export function parseArgs(argv: string[]): {
  mode: "main" | "runner";
  outputDir: string;
  vitestArgs: string[];
};
/**
 * Resolves or creates the directory used for profiler artifacts.
 */
export function resolveVitestProfileDir({
  mode,
  outputDir,
}: {
  mode: unknown;
  outputDir: unknown;
}): string;
/**
 * Builds a profiler command without additional Vitest args.
 */
export function buildVitestProfileCommand({
  mode,
  outputDir,
}: {
  mode: unknown;
  outputDir: unknown;
}): {
  command: string;
  args: unknown[];
};
/**
 * Builds the profiler command for either Vitest main or worker-runner profiling.
 */
export function buildVitestProfileCommandWithArgs({
  mode,
  outputDir,
  vitestArgs,
}: {
  mode: unknown;
  outputDir: unknown;
  vitestArgs: unknown;
}): {
  command: string;
  args: unknown[];
};
/**
 * Converts a profiler plan into a spawn spec, routing pnpm through the wrapper.
 */
export function buildVitestProfileSpawnSpec(
  plan: unknown,
  runnerOptions?: Record<string, unknown>,
):
  | {
      args: string[];
      command: string;
      options: import("node:child_process").SpawnOptions;
    }
  | {
      args: unknown;
      command: unknown;
      options: {
        env: NodeJS.ProcessEnv;
        stdio: string;
        shell: boolean;
        windowsVerbatimArguments?: boolean;
      };
    };
