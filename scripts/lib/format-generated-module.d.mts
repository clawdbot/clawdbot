/** Resolve the fastest available oxfmt command for a generated module path. */
export function resolveGeneratedModuleFormatter(params: {
  existsSync: (value: string) => boolean;
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  npmExecPath?: string;
  outputPath: string;
  platform: NodeJS.Platform;
  repoRoot: string;
}):
  | {
      args: string[];
      command: string;
      env?: NodeJS.ProcessEnv;
      shell: boolean;
      windowsVerbatimArguments?: boolean;
    }
  | {
      command: string;
      args: unknown[];
      shell: boolean;
    };
/** Format generated source in a temporary file and return the formatter output. */
export function formatGeneratedModule(
  source: unknown,
  {
    repoRoot,
    outputPath,
    errorLabel,
  }: {
    repoRoot: unknown;
    outputPath: unknown;
    errorLabel: unknown;
  },
  deps?: Record<string, unknown>,
): string;
export const GENERATED_MODULE_FORMAT_TIMEOUT_MS: 30000;
export const GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES: number;
