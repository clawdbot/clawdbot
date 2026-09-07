import assert from "node:assert/strict";
import fs from "node:fs";
import { TestRunner } from "vitest";

export default class TaskUpdatesRunner extends TestRunner {
  names = new Map();
  batches = [];
  completed = [];
  checkpoints = [];
  files = [];
  clock = globalThis[Symbol.for("vitest.task-update-clock")];

  constructor(config) {
    super(config);
    this.onCleanupWorkerContext(() => {
      // Worker cleanup follows startTests' final task flush, so observe the
      // complete stream and prove a stale callback cannot duplicate delivery.
      const final = this.snapshot();
      this.clock.fire(this.injectValue("firstFireAt") + 200);
      fs.writeFileSync(
        this.injectValue("observation"),
        JSON.stringify({
          checkpoints: this.checkpoints,
          final,
          drained: this.snapshot(),
          fileStates: this.files.map((file) => file.result.state),
        }),
      );
    });
  }

  snapshot() {
    return structuredClone({
      batches: this.batches,
      completed: this.completed,
      pendingDelays: this.clock.pendingDelays(),
    });
  }

  onCollected(files) {
    this.files = files;
    for (const file of files) {
      this.names.set(file.id, file.name);
      for (const task of file.tasks) this.names.set(task.id, task.name);
    }
  }

  onAfterRunTask(task) {
    super.onAfterRunTask(task);
    this.completed.push({ name: task.name, state: task.result.state });
  }

  async onBeforeRunTask(task) {
    await super.onBeforeRunTask(task);
    if (task.name !== "independent next case") return;
    // The previous test-finished is queued; the next test-prepare and file
    // flush have not happened. They cannot rescue this trailing delivery.
    this.checkpoints.push(this.snapshot());
    assert.deepEqual(this.completed, [{ name: "completed case", state: "pass" }]);
    assert.deepEqual(this.clock.pendingDelays(), [100]);
    const firstFireAt = this.injectValue("firstFireAt");
    this.clock.fire(firstFireAt);
    this.checkpoints.push(this.snapshot());
    if (firstFireAt < 100) {
      this.clock.fire(firstFireAt + 100);
      this.checkpoints.push(this.snapshot());
    }
  }

  onTaskUpdate(packs, events) {
    this.batches.push({
      results: packs.map(([id, result]) => ({ name: this.names.get(id), state: result?.state })),
      events: events.map(([id, event]) => ({ name: this.names.get(id), event })),
    });
  }
}
