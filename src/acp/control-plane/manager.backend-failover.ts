import type { AcpRuntimeErrorCode } from "../runtime/errors.js";
import { normalizeText } from "./runtime-options.js";

export type BackendAttempt = {
  backend: string;
  error: string;
  code: AcpRuntimeErrorCode;
  sawOutput: boolean;
};

export type BackendCandidatePlan = {
  candidateBackends: string[];
  describeBackendCandidate: (backend: string) => string;
};

export function resolveBackendCandidatePlan(params: {
  configuredPrimaryBackend?: string;
  resolvedPrimaryBackend?: string;
  fallbackBackends?: readonly unknown[];
}): BackendCandidatePlan {
  const configuredPrimaryBackend = normalizeText(params.configuredPrimaryBackend);
  const resolvedPrimaryBackend = normalizeText(params.resolvedPrimaryBackend);
  const fallbackBackends = Array.isArray(params.fallbackBackends)
    ? params.fallbackBackends
        .map((backend) => normalizeText(backend))
        .filter((backend): backend is string => backend != null)
    : [];
  return {
    candidateBackends: Array.from(
      new Set([configuredPrimaryBackend ?? resolvedPrimaryBackend ?? "", ...fallbackBackends]),
    ),
    describeBackendCandidate: (backend) =>
      backend || resolvedPrimaryBackend || configuredPrimaryBackend || "<auto>",
  };
}

export function isFailoverWorthyBackendError(attempt: BackendAttempt): boolean {
  return (
    !attempt.sawOutput &&
    (attempt.code === "ACP_TURN_FAILED" ||
      attempt.code === "ACP_SESSION_INIT_FAILED" ||
      attempt.code === "ACP_BACKEND_UNAVAILABLE") &&
    /\b(?:unavailable|rate[-\s]?limit(?:ed|ing)?|quota|exhausted|temporar(?:y|ily)|overloaded)\b/i.test(
      attempt.error,
    )
  );
}

export function shouldAttemptBackendFailover(params: {
  backendIndex: number;
  candidateBackends: readonly string[];
}): boolean {
  return params.backendIndex < params.candidateBackends.length - 1;
}
