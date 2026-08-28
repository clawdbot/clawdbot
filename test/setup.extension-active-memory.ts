// Active-memory test setup drains background recalls between tests.
//
// active-memory's before_prompt_build hook (extensions/active-memory/index.ts)
// races its recall sub-agent against a deadline and returns on timeout WITHOUT
// awaiting or hard-cancelling the sub-agent promise. The recall path reaches
// runEmbeddedAgent only after an `await tempWorkspace(...)` with no abort check
// in between, and the test double for runEmbeddedAgent ignores the abort
// signal. So a timed-out test can leave an orphaned recall mid-flight; when it
// later resolves it calls runEmbeddedAgent inside a SUBSEQUENT test and steals
// that test's one-shot mock, surfacing as a stale recall leak (openclaw#1028).
//
// Flushing a few real-timer macrotasks after each test forces any orphaned
// recall to finish (consuming its own test's reset mock) before the next test
// arms a one-shot mock. This is test-harness isolation only; production runs
// rely on the real runEmbeddedAgent honoring the abort signal.
import { afterEach, vi } from "vitest";

afterEach(async () => {
  // Drain on the real clock: a fake-timer test that skipped cleanup would
  // otherwise leave the loop's setTimeout pending against a stopped clock and
  // hang teardown until the hook timeout.
  vi.useRealTimers();
  for (let tick = 0; tick < 8; tick += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
});
