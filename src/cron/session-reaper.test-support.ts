import "./session-reaper.js";

type CronSessionReaperTestApi = {
  resetReaperThrottle(): void;
};

function getTestApi(): CronSessionReaperTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cronSessionReaperTestApi")
  ] as CronSessionReaperTestApi;
}

export function resetReaperThrottle(): void {
  getTestApi().resetReaperThrottle();
}
