import { extractCliErrorMessage } from "../cli-output.js";
import { coerceToFailoverError, FailoverError, resolveFailoverStatus } from "../failover-error.js";

type CliExitFailoverErrorParams = {
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">;
  // Spawn supplies stderr/stdout windows; live stdout is already structured, so it supplies stderr.
  candidates: readonly string[];
  fallbackMessage: string;
  // Only a clean premature live exit is protocol-level empty_response; other empty exits are unknown.
  emptyReason?: FailoverError["reason"];
  retryEmptyFailure: boolean;
};

export function createCliFailoverError(
  message: string,
  reason: FailoverError["reason"],
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">,
  options?: { cause?: unknown; cliTimeout?: FailoverError["cliTimeout"]; code?: string },
): FailoverError {
  return new FailoverError(message, {
    reason,
    ...context,
    status: resolveFailoverStatus(reason),
    ...options,
  });
}

export function createCliExitFailoverError(params: CliExitFailoverErrorParams): FailoverError {
  const candidates = params.candidates.map((candidate) => candidate.trim()).filter(Boolean);
  const structuredError =
    candidates.map((candidate) => extractCliErrorMessage(candidate)).find(Boolean) ?? null;
  const classified = [structuredError, ...candidates]
    .flatMap((candidate) => (candidate ? [coerceToFailoverError(candidate, params.context)] : []))
    .find((error) => error !== null);
  const message = structuredError || classified?.message || candidates[0] || params.fallbackMessage;
  const reason =
    classified?.reason ?? (candidates.length === 0 ? params.emptyReason : undefined) ?? "unknown";
  const code =
    reason === "context_overflow"
      ? "cli_context_overflow"
      : candidates.length === 0 && params.retryEmptyFailure
        ? "cli_unknown_empty_failure"
        : undefined;
  return createCliFailoverError(message, reason, params.context, { code });
}
