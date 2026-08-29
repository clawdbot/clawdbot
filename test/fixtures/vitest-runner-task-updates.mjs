import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The runner captures Date.now and safe timers at import time. This fixture runs
// in its own process so its clock cannot leak into the enclosing Vitest worker.
let clock = 1_000;
const timers = new Set();
Date.now = () => clock;
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = { delay, callback: () => callback(...args) };
  timers.add(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => timers.delete(timer);

const { startTests, test } = await import("@vitest/runner");
const filepath = fileURLToPath(import.meta.url);
const firstFireAt = Number(process.argv[2]);
const names = new Map();
const batches = [];
const completed = [];
const checkpoints = [];
const snapshot = () =>
  structuredClone({ batches, completed, pendingDelays: [...timers].map((timer) => timer.delay) });
function fireTimers(elapsed) {
  clock = 1_000 + elapsed;
  for (const timer of [...timers]) {
    timers.delete(timer);
    timer.callback();
  }
}

const files = await startTests([filepath], {
  config: {
    root: dirname(filepath),
    setupFiles: [],
    name: "task-updates",
    passWithNoTests: false,
    testNamePattern: undefined,
    allowOnly: true,
    sequence: { hooks: "stack", setupFiles: "list", seed: 1 },
    chaiConfig: undefined,
    maxConcurrency: 1,
    testTimeout: 5_000,
    hookTimeout: 10_000,
    retry: 0,
    includeTaskLocation: false,
    tags: [],
    tagsFilter: undefined,
    strictTags: true,
  },
  importFile() {
    // Register ordinary passive tests through the public collector; neither
    // test's execution depends on the reporter observing its completion.
    test("completed case", () => {});
    test("independent next case", () => {});
  },
  onCollected(files) {
    for (const file of files) {
      names.set(file.id, file.name);
      for (const task of file.tasks) names.set(task.id, task.name);
    }
  },
  onAfterRunTask(task) {
    completed.push({ name: task.name, state: task.result.state });
  },
  onBeforeRunTask(task) {
    if (task.name !== "independent next case") return;
    // runTest has queued the previous test-finished, but has not produced the
    // next test-prepare. No later task event or file flush can rescue delivery.
    checkpoints.push(snapshot());
    assert.deepEqual(completed, [{ name: "completed case", state: "pass" }]);
    assert.deepEqual(
      [...timers].map((timer) => timer.delay),
      [100],
    );
    fireTimers(firstFireAt);
    checkpoints.push(snapshot());
    if (firstFireAt < 100) {
      fireTimers(firstFireAt + 100);
      checkpoints.push(snapshot());
    }
  },
  async onTaskUpdate(packs, events) {
    // Copy synchronously: the runner clears events and mutates task results.
    batches.push({
      results: packs.map(([id, result]) => ({ name: names.get(id), state: result?.state })),
      events: events.map(([id, event]) => ({ name: names.get(id), event })),
    });
  },
});
const final = snapshot();
fireTimers(firstFireAt + 200);
console.log(
  JSON.stringify({
    checkpoints,
    final,
    drained: snapshot(),
    fileStates: files.map((file) => file.result.state),
  }),
);
