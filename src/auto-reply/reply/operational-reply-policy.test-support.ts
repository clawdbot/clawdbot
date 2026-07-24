import "./operational-reply-policy.js";

type OperationalReplyPolicyTestApi = {
  clearOperationalReplyPolicyStateForTest(): void;
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
