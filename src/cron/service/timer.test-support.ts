import type { CronServiceState } from "./state.js";
import "./timer.js";

type CronTimerTestApi = {
  onTimer(state: CronServiceState): Promise<void>;
};

function getTestApi(): CronTimerTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cronTimerTestApi")
  ] as CronTimerTestApi;
}

export function onTimer(state: CronServiceState): Promise<void> {
  return getTestApi().onTimer(state);
}
