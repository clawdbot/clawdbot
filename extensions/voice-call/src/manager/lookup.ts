import type { CallId, CallRecord } from "../types.js";

export function getCallByProviderCallId(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  providerCallId: string;
}): CallRecord | undefined {
  const callId = params.providerCallIdMap.get(params.providerCallId);
  if (callId) {
    return params.activeCalls.get(callId);
  }

  for (const call of params.activeCalls.values()) {
    if (call.providerCallId === params.providerCallId) {
      return call;
    }
  }
  return undefined;
}

export function findCall(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  callIdOrProviderCallId: string;
}): CallRecord | undefined {
  const directCall = params.activeCalls.get(params.callIdOrProviderCallId);
  if (directCall) return directCall;
  return getCallByProviderCallId({
    activeCalls: params.activeCalls,
    providerCallIdMap: params.providerCallIdMap,
    providerCallId: params.callIdOrProviderCallId,
  });
}
