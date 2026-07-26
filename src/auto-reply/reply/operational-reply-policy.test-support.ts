import "./operational-reply-policy.js";
import type { ReplyPayload } from "../types.js";

type OperationalReplyPolicyTestApi = {
  clearOperationalReplyPolicyStateForTest(): void;
  formatOperationalReplyRedirectText(params: {
    payload: ReplyPayload;
    sourceChannel?: string;
    sourceEventKey?: string;
    sourceSessionKey?: string;
  }): string;
};

function getTestApi(): OperationalReplyPolicyTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.operationalReplyPolicyTestApi")
  ];
  if (!api) {
    throw new Error("operational reply policy test API is unavailable");
  }
  return api as OperationalReplyPolicyTestApi;
}

export function clearOperationalReplyPolicyStateForTest(): void {
  getTestApi().clearOperationalReplyPolicyStateForTest();
}

export function formatOperationalReplyRedirectTextForTest(params: {
  payload: ReplyPayload;
  sourceChannel?: string;
  sourceEventKey?: string;
  sourceSessionKey?: string;
}): string {
  return getTestApi().formatOperationalReplyRedirectText(params);
}
