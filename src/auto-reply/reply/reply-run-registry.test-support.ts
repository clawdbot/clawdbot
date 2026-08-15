import "./reply-run-registry.js";

type ReplyRunRegistryTestApi = {
  resetReplyRunRegistry(): void;
};

function getTestApi(): ReplyRunRegistryTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.replyRunRegistryTestApi")
  ];
  if (!api) {
    throw new Error("reply run registry test API is unavailable");
  }
  return api as ReplyRunRegistryTestApi;
}

export const testing = {
  resetReplyRunRegistry(): void {
    getTestApi().resetReplyRunRegistry();
  },
};
