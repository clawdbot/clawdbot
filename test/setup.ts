import { installTestEnv } from "./test-env";
import { afterEach, vi } from "vitest";

const { cleanup } = installTestEnv();
process.on("exit", cleanup);

afterEach(() => {
  // Guard against leaked fake timers across test files/workers.
  vi.useRealTimers();
});
