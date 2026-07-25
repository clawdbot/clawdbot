import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export class CodexThreadStartRequestError extends Error {
  constructor(cause: unknown) {
    super(formatErrorMessage(cause), { cause });
    this.name = "CodexThreadStartRequestError";
  }
}

export class CodexThreadBindingConflictError extends Error {
  constructor(threadId: string, operation: string) {
    super(`Codex thread binding changed while ${operation}: ${threadId}`);
    this.name = "CodexThreadBindingConflictError";
  }
}

export class CodexRingZeroAttestationError extends Error {
  constructor(cause: unknown) {
    super("Codex ring-zero MCP attestation failed", { cause });
    this.name = "CodexRingZeroAttestationError";
  }
}

export class CodexThreadBindingConflictAfterCleanupError extends CodexThreadBindingConflictError {}

export class CodexAdoptedThreadActiveError extends Error {
  constructor() {
    super("Codex session became active in another runner; wait for it to finish before continuing");
    this.name = "CodexAdoptedThreadActiveError";
  }
}
