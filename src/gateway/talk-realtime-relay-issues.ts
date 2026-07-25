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
