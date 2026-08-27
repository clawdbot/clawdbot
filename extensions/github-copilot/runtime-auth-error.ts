// GitHub Copilot runtime-auth errors shared by provider setup and fallback policy.
type CopilotRuntimeAuthFailure =
  | { reason: "http_error"; status: number }
  | { reason: "timeout"; timeoutMs: number; cause?: unknown };

function buildCopilotRuntimeAuthMessage(failure: CopilotRuntimeAuthFailure): string {
  if (failure.reason === "timeout") {
    return `Copilot authentication failed: timed out after ${failure.timeoutMs}ms`;
  }
  const message = `Copilot authentication failed: HTTP ${failure.status}`;
  if (failure.status !== 403) {
    return message;
  }
  return (
    `${message}. Run \`openclaw models auth login-github-copilot\` in a terminal to ` +
    "authenticate again. If this still fails, verify that your GitHub account has Copilot " +
    "access and that your organization or enterprise policy permits it."
  );
}

export class CopilotRuntimeAuthError extends Error {
  readonly code = "github_copilot_auth_failed";
  readonly reason: CopilotRuntimeAuthFailure["reason"];
  readonly status?: number;
  readonly timeoutMs?: number;

  constructor(failure: CopilotRuntimeAuthFailure) {
    super(
      buildCopilotRuntimeAuthMessage(failure),
      failure.reason === "timeout" ? { cause: failure.cause } : undefined,
    );
    this.name = "CopilotRuntimeAuthError";
    this.reason = failure.reason;
    if (failure.reason === "http_error") {
      this.status = failure.status;
    } else {
      this.timeoutMs = failure.timeoutMs;
    }
  }
}
