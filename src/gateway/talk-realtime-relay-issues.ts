import { resolveFailoverReasonFromError } from "../agents/failover-error.js";

type TalkRealtimeRelayIssue = {
  code: "realtime_unavailable";
  message: string;
  provider: string;
  model?: string;
  transport: "gateway-relay";
  phase: string;
};

export function createTalkRealtimeRelayIssue(params: {
  message: string;
  provider: string;
  model?: string;
  phase: string;
}): TalkRealtimeRelayIssue {
  return {
    code: "realtime_unavailable",
    message: params.message,
    provider: params.provider,
    ...(params.model ? { model: params.model } : {}),
    transport: "gateway-relay",
    phase: params.phase,
  };
}

export function buildTalkRealtimeRelayIssuePayload(
  relaySessionId: string,
  issue: TalkRealtimeRelayIssue,
) {
  return {
    relaySessionId,
    type: "error" as const,
    message: issue.message,
    code: issue.code,
    provider: issue.provider,
    ...(issue.model ? { model: issue.model } : {}),
    transport: issue.transport,
    phase: issue.phase,
  };
}

export function projectTalkRealtimeRelayProviderError(
  provider: string,
  opaqueRoute: boolean,
  error: unknown,
): string {
  if (opaqueRoute) {
    return "Realtime provider error.";
  }
  switch (resolveFailoverReasonFromError(error, provider)) {
    case "auth":
    case "auth_permanent":
      return "Realtime provider authentication failed. Check the provider credentials and try again.";
    case "format":
    case "model_not_found":
      return "Realtime session configuration was rejected. Check the provider and model settings.";
    case "rate_limit":
    case "billing":
      return "Realtime provider cannot start this session right now. Try again later.";
    case "timeout":
    case "overloaded":
    case "server_error":
      return "Realtime provider is unavailable. Try again later.";
    default:
      return "Realtime provider error.";
  }
}
