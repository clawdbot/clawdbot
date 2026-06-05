/**
 * Missing session cwd detection.
 *
 * Helps resume flows decide whether to stop, prompt, or continue in the current process cwd.
 */
import { existsSync } from "node:fs";

export interface SessionCwdIssue {
  sessionFile?: string;
  sessionCwd: string;
  fallbackCwd: string;
}

interface SessionCwdSource {
  getCwd(): string;
  getSessionFile(): string | undefined;
}

/** Returns a cwd issue for persisted sessions whose stored cwd has disappeared. */
export function getMissingSessionCwdIssue(
  sessionManager: SessionCwdSource,
  fallbackCwd: string,
): SessionCwdIssue | undefined {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    return undefined;
  }

  const sessionCwd = sessionManager.getCwd();
  if (!sessionCwd || existsSync(sessionCwd)) {
    return undefined;
  }

  return {
    sessionFile,
    sessionCwd,
    fallbackCwd,
  };
}

/** Formats the terminal error shown when resume cannot safely use the stored cwd. */
export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
  const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
  return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

/** Formats the compact prompt used when the user can choose the fallback cwd. */
export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
  return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

/** Error wrapper that preserves the missing-cwd facts for UI and recovery code. */
export class MissingSessionCwdError extends Error {
  readonly issue: SessionCwdIssue;

  constructor(issue: SessionCwdIssue) {
    super(formatMissingSessionCwdError(issue));
    this.name = "MissingSessionCwdError";
    this.issue = issue;
  }
}

/** Throws when a persisted session cwd is missing and the caller does not handle prompts. */
export function assertSessionCwdExists(
  sessionManager: SessionCwdSource,
  fallbackCwd: string,
): void {
  const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
  if (issue) {
    throw new MissingSessionCwdError(issue);
  }
}
