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

export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
  const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
  return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
  return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

export class MissingSessionCwdError extends Error {
  readonly issue: SessionCwdIssue;

  constructor(issue: SessionCwdIssue) {
    super(formatMissingSessionCwdError(issue));
    this.name = "MissingSessionCwdError";
    this.issue = issue;
  }
}

export function assertSessionCwdExists(
  sessionManager: SessionCwdSource,
  fallbackCwd: string,
): void {
  const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
  if (issue) {
    throw new MissingSessionCwdError(issue);
  }
}
