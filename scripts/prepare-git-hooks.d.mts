/**
 * Installs the repo-local hooks path and returns a structured reason if skipped.
 */
export function configurePrepareGitHooks(params?: Record<string, unknown>): {
  configured: boolean;
  reason: string;
};
