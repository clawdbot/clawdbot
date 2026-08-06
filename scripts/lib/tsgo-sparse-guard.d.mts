/**
 * Reports whether the caller explicitly opted out of sparse tsgo guard errors.
 */
export function shouldSkipSparseTsgoGuardError(env?: NodeJS.ProcessEnv): boolean;
/**
 * Creates an environment that suppresses recursive sparse tsgo guard checks.
 */
export function createSparseTsgoSkipEnv(baseEnv?: NodeJS.ProcessEnv): {
  OPENCLAW_TSGO_SPARSE_SKIP: string;
};
/**
 * Builds the sparse-checkout diagnostic for core tsgo projects, when needed.
 */
export function getSparseTsgoGuardError(
  args: unknown,
  {
    cwd,
    fileExists,
    isSparseCheckoutEnabled,
    sparseCheckoutPatterns,
  }?: {
    cwd?: string | undefined;
    fileExists?: typeof fs.existsSync | undefined;
    isSparseCheckoutEnabled?: (options: { cwd: string }) => boolean;
    sparseCheckoutPatterns?: string[];
  },
): string | null;
import fs from "node:fs";
