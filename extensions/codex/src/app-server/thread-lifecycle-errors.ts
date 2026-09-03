import {
  AgentHarnessPreflightError,
  formatErrorMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export class CodexThreadStartRequestError extends Error {
  constructor(cause: unknown) {
    super(`thread/start: ${formatErrorMessage(cause)}`, { cause });
    this.name = "CodexThreadStartRequestError";
  }
}

export class CodexThreadBindingConflictError extends Error {
  constructor(threadId: string, operation: string) {
    super(`Codex thread binding changed while ${operation}: ${threadId}`);
    this.name = "CodexThreadBindingConflictError";
  }
}

export class CodexAdoptedThreadActiveError extends AgentHarnessPreflightError {
  constructor(
    message = "Codex session became active in another runner; wait for it to finish before continuing",
  ) {
    super(message);
    this.name = "CodexAdoptedThreadActiveError";
  }
}
