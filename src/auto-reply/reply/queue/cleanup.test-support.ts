import type { resolveEmbeddedSessionLane } from "../../../agents/embedded-agent-runner/lanes.js";
import type { clearCommandLane } from "../../../process/command-queue.js";
import "./cleanup.js";

type QueueCleanupTestDeps = {
  resolveEmbeddedSessionLane: typeof resolveEmbeddedSessionLane;
  clearCommandLane: typeof clearCommandLane;
};

type QueueCleanupTestApi = {
  setDepsForTests(deps: Partial<QueueCleanupTestDeps> | undefined): void;
  resetDepsForTests(): void;
};

function getTestApi(): QueueCleanupTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.queueCleanupTestApi")
  ];
  if (!api) {
    throw new Error("queue cleanup test API is unavailable");
  }
  return api as QueueCleanupTestApi;
}

export const testing = {
  setDepsForTests(deps: Partial<QueueCleanupTestDeps> | undefined): void {
    getTestApi().setDepsForTests(deps);
  },
  resetDepsForTests(): void {
    getTestApi().resetDepsForTests();
  },
};
