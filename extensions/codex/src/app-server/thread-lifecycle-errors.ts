import {
  AgentHarnessPreflightError,
  formatErrorMessage,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  assertCodexBindingMayBeReplaced,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

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

class CodexProjectInstructionsUnavailableError extends Error {
  constructor(threadId: string, operation: string) {
    super(
      `Cannot ${operation} Codex thread ${threadId}: its original project instructions belong to an unavailable environment. ` +
        "Continue it in the original execution environment or start a new session.",
    );
    this.name = "CodexProjectInstructionsUnavailableError";
  }
}

export function assertCodexProjectInstructionEnvironmentAvailable(
  binding: CodexAppServerThreadBinding,
  environmentSelectionFingerprint: string | undefined,
  operation: string,
): void {
  if (
    binding.projectInstructionsUnavailableToGateway === true &&
    binding.environmentSelectionFingerprint !== environmentSelectionFingerprint
  ) {
    throw new CodexProjectInstructionsUnavailableError(binding.threadId, operation);
  }
}

export function assertCodexBindingMayBeReplacedInEnvironment(
  binding: CodexAppServerThreadBinding | undefined,
  operation: string,
  expected?: EmbeddedRunAttemptParamsV2["expectedSessionRuntimeOwnership"],
): void {
  if (binding?.projectInstructionsUnavailableToGateway === true) {
    throw new CodexProjectInstructionsUnavailableError(binding.threadId, operation);
  }
  assertCodexBindingMayBeReplaced(binding, operation, expected);
}

export function assertCodexProjectInstructionColdResumeAllowed(
  binding: CodexAppServerThreadBinding,
): void {
  if (binding.projectInstructionsUnavailableToGateway === true) {
    throw new CodexProjectInstructionsUnavailableError(binding.threadId, "cold-resume");
  }
}
