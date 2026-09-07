import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { extractCliErrorMessage } from "../cli-output.js";
import {
  coerceToFailoverError,
  FailoverError,
  isFailoverError,
  resolveFailoverStatus,
} from "../failover-error.js";

type CliExitFailoverErrorParams = {
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">;
  // Spawn supplies stderr/stdout windows; live stdout is already structured, so it supplies stderr.
  candidates: readonly string[];
  fallbackMessage: string;
  // Only a clean premature live exit is protocol-level empty_response; other empty exits are unknown.
  emptyReason?: FailoverError["reason"];
  retryEmptyFailure: boolean;
  resumeAtArg?: string;
};

export function createCliFailoverError(
  message: string,
  reason: FailoverError["reason"],
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">,
  options?: Pick<FailoverError, "cause" | "cliTimeout" | "code" | "timeout">,
): FailoverError {
  return new FailoverError(message, {
    reason,
    ...context,
    status: resolveFailoverStatus(reason),
    ...options,
  });
}

export function resolveCliResumeAtError(
  error: unknown,
  resumeAtArg: string | undefined,
  context: CliExitFailoverErrorParams["context"],
): FailoverError | undefined {
  if (!resumeAtArg || isFailoverError(error) || isAbortError(error)) {
    return undefined;
  }
  const message = formatErrorMessage(error).toLowerCase();
  if (
    !message.includes(resumeAtArg.toLowerCase()) ||
    !/\b(?:unknown|unexpected|unrecognized)\b|\bnot\s+recognized\b/.test(message)
  ) {
    return undefined;
  }
  // A rejected local option is already a recovery fact; provider policy must
  // not materialize before the caller can use its remaining retry budget.
  return createCliFailoverError(
    "CLI backend cannot resume from the stored checkpoint.",
    "session_expired",
    context,
    { code: "cli_resume_at_unsupported", cause: error },
  );
}

export function createCliExitFailoverError(params: CliExitFailoverErrorParams): FailoverError {
  const candidates = params.candidates.map((candidate) => candidate.trim()).filter(Boolean);
  const structuredError =
    candidates.map((candidate) => extractCliErrorMessage(candidate)).find(Boolean) ?? null;
  const resumeAtError = resolveCliResumeAtError(
    structuredError || candidates[0] || params.fallbackMessage,
    params.resumeAtArg,
    params.context,
  );
  if (resumeAtError) {
    return resumeAtError;
  }
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
