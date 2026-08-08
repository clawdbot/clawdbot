import "./logger.js";
import type { LoggerTestApi } from "./logger.test-api.js";

function getTestApi(): LoggerTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.loggerTestApi")
  ] as LoggerTestApi;
}

export const testApi = new Proxy({} as LoggerTestApi, {
  get(_target, property) {
    const api = getTestApi();
    const value = api[property as keyof LoggerTestApi];
    return typeof value === "function" ? value.bind(api) : value;
  },
});
