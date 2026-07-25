/** Format generated source in a temporary file and return the formatter output. */
export function formatGeneratedModule(
  source: string,
  options: { repoRoot: string; outputPath: string; errorLabel: string },
  deps?: Record<string, unknown>,
): string;
export const GENERATED_MODULE_FORMAT_TIMEOUT_MS: 30000;
export const GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES: number;
