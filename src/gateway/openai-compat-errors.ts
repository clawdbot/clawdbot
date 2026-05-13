import { describeFailoverError, resolveFailoverStatus } from "../agents/failover-error.js";
import type { FailoverReason } from "../agents/pi-embedded-helpers/types.js";

export type OpenAiCompatError = {
  status: number;
  error: {
    message: string;
    type: string;
    code?: string;
  };
};

const ERROR_TYPE_BY_REASON: Partial<Record<FailoverReason, string>> = {
  auth: "authentication_error",
  auth_permanent: "permission_error",
  billing: "insufficient_quota",
  format: "invalid_request_error",
  model_not_found: "invalid_request_error",
  overloaded: "api_error",
  rate_limit: "rate_limit_error",
  server_error: "api_error",
  session_expired: "invalid_request_error",
  timeout: "api_error",
};

function statusForReason(reason: FailoverReason, status: number | undefined): number {
  if (reason === "server_error") {
    return status && status >= 400 && status < 500 ? status : 502;
  }
  if (reason === "timeout") {
    return status && status >= 400 && status < 500 ? status : 504;
  }
  return status ?? resolveFailoverStatus(reason) ?? 500;
}

function messageForReason(params: {
  reason: FailoverReason;
  message: string;
  rawError?: string;
}): string {
  if (params.reason === "server_error") {
    return "upstream provider error";
  }
  if (params.reason === "timeout") {
    return "upstream provider timeout";
  }
  if (params.reason === "overloaded") {
    return "upstream provider overloaded";
  }
  return params.rawError?.trim() || params.message.trim() || "request failed";
}

export function resolveOpenAiCompatError(err: unknown): OpenAiCompatError | undefined {
  const described = describeFailoverError(err);
  const reason = described.reason;
  if (!reason) {
    return undefined;
  }
  const type = ERROR_TYPE_BY_REASON[reason];
  if (!type) {
    return undefined;
  }
  const status = statusForReason(reason, described.status);
  const message = messageForReason({
    reason,
    message: described.message,
    rawError: described.rawError,
  });
  return {
    status,
    error: {
      message,
      type,
      ...(described.code ? { code: described.code } : {}),
    },
  };
}

export function validateOpenAiSamplingParams(params: {
  temperature?: unknown;
  topP?: unknown;
}): string | undefined {
  if (params.temperature != null) {
    if (typeof params.temperature !== "number" || !Number.isFinite(params.temperature)) {
      return "`temperature` must be a finite number.";
    }
    if (params.temperature < 0 || params.temperature > 2) {
      return "`temperature` must be between 0 and 2.";
    }
  }
  if (params.topP != null) {
    if (typeof params.topP !== "number" || !Number.isFinite(params.topP)) {
      return "`top_p` must be a finite number.";
    }
    if (params.topP < 0 || params.topP > 1) {
      return "`top_p` must be between 0 and 1.";
    }
  }
  return undefined;
}
