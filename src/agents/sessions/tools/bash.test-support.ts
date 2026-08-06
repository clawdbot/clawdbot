import "./bash.js";

type BashToolTestApi = {
  resolveBashTimeoutMs(timeoutSeconds: unknown): number | undefined;
};

function getTestApi(): BashToolTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.bashToolTestApi")
  ] as BashToolTestApi;
}

export const resolveBashTimeoutMs: BashToolTestApi["resolveBashTimeoutMs"] = (timeoutSeconds) =>
  getTestApi().resolveBashTimeoutMs(timeoutSeconds);
