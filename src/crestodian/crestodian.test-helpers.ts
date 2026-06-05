// Crestodian test helpers build runtime environments for rescue tests.
import type { RuntimeEnv } from "../runtime.js";

/**
 * Test helpers for capturing Crestodian runtime output.
 *
 * Tests use this lightweight runtime instead of the real CLI runtime so exits
 * become thrown errors and logs are easy to assert.
 */
/** Create a RuntimeEnv that records log/error lines for tests. */
export function createCrestodianTestRuntime(): { runtime: RuntimeEnv; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    runtime: {
      log: (...args) => lines.push(args.join(" ")),
      error: (...args) => lines.push(args.join(" ")),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  };
}
