import "./swarm-scheduler.js";

type SwarmSchedulerTestApi = {
  testing: {
    reset(): void;
  };
};

function getTestApi(): SwarmSchedulerTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.swarmSchedulerTestApi")
  ] as SwarmSchedulerTestApi;
}

export const testing = getTestApi().testing;
