// GitHub Copilot token exchange errors shared by runtime and fallback policy.
type CopilotTokenExchangeFailure =
  | { reason: "http_error"; status: number }
  | { reason: "timeout"; timeoutMs: number; cause?: unknown };

function buildCopilotTokenExchangeMessage(failure: CopilotTokenExchangeFailure): string {
  if (failure.reason === "timeout") {
    return `Copilot token exchange failed: timed out after ${failure.timeoutMs}ms`;
  }
  const message = `Copilot token exchange failed: HTTP ${failure.status}`;
  if (failure.status !== 403) {
    return message;
  }
  return (
    `${message}. Run \`openclaw models auth login-github-copilot\` in a terminal to ` +
    "authenticate again. If this still fails, verify that your GitHub account has Copilot " +
    "access and that your organization or enterprise policy permits it."
  );
}

export class CopilotTokenExchangeError extends Error {
  readonly code = "github_copilot_token_exchange_failed";
  readonly reason: CopilotTokenExchangeFailure["reason"];
  readonly status?: number;
  readonly timeoutMs?: number;

  constructor(failure: CopilotTokenExchangeFailure) {
    super(
      buildCopilotTokenExchangeMessage(failure),
      failure.reason === "timeout" ? { cause: failure.cause } : undefined,
    );
    this.name = "CopilotTokenExchangeError";
    this.reason = failure.reason;
    if (failure.reason === "http_error") {
      this.status = failure.status;
    } else {
      this.timeoutMs = failure.timeoutMs;
    }
  }
}
