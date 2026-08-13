import "./dispatch-from-config.js";

type DispatchFromConfigTestApi = {
  createReplyDispatchEvent(params: unknown): unknown;
};

function getTestApi(): DispatchFromConfigTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.dispatchFromConfigTestApi")
  ];
  if (!api) {
    throw new Error("dispatch-from-config test API is unavailable");
  }
  return api as DispatchFromConfigTestApi;
}

export const testing = {
  createReplyDispatchEvent(params: unknown): unknown {
    return getTestApi().createReplyDispatchEvent(params);
  },
};
