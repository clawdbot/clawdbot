import "./commands-login.js";

type CommandsLoginTestApi = {
  clearActiveFlows(): void;
};

function getTestApi(): CommandsLoginTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.commandsLoginTestApi")
  ];
  if (!api) {
    throw new Error("commands login test API is unavailable");
  }
  return api as CommandsLoginTestApi;
}

export const testing = {
  clearActiveFlows(): void {
    getTestApi().clearActiveFlows();
  },
};
