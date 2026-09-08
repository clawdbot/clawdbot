import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTaskUpdateFixture } from "../fixtures/vitest-runner-task-updates.mjs";

type TaskResult = { name: string; state: string };
type Batch = {
  results: TaskResult[];
  events: { name: string; event: string }[];
};
type Checkpoint = { batches: Batch[]; completed: TaskResult[]; pendingDelays: number[] };
type Observation = {
  checkpoints: [before: Checkpoint, afterFirstCallback: Checkpoint, afterRearm?: Checkpoint];
  final: Checkpoint;
  drained: Checkpoint;
  fileStates: string[];
};

const finished = { name: "completed case", event: "test-finished" };

describe("Vitest runner trailing task updates", () => {
  it.each([
    { timing: "at the exact 100 ms deadline", firstFireAt: 100 },
    { timing: "after an early 99 ms callback rearms", firstFireAt: 99 },
    { timing: "after a late 101 ms callback", firstFireAt: 101 },
  ])("delivers actual task completion $timing without later task events", ({ firstFireAt }) => {
    const fixture = createTaskUpdateFixture(firstFireAt);
    onTestFinished(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    // One native process owns its threads; a deadline cannot orphan a nested CLI.
    const child = spawnSync(process.execPath, fixture.args, {
      cwd: fixture.root,
      env: fixture.env,
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const observation: Observation = JSON.parse(fs.readFileSync(fixture.observation, "utf8"));
    const [before, firstCallback, afterRearm] = observation.checkpoints;
    const trailing = afterRearm ?? firstCallback;

    expect(before.completed).toEqual([{ name: "completed case", state: "pass" }]);
    expect(before.batches.flatMap((batch) => batch.events)).not.toContainEqual(finished);
    expect(trailing.completed).toEqual(before.completed);
    expect(trailing.batches.flatMap((batch) => batch.events)).toContainEqual(finished);
    expect(trailing.batches.flatMap((batch) => batch.results)).toContainEqual({
      name: "completed case",
      state: "pass",
    });
    expect(trailing.pendingDelays).toEqual([]);
    if (firstFireAt < 100) {
      expect(firstCallback.batches).toEqual(before.batches);
      expect(firstCallback.pendingDelays).toEqual([100]);
    }

    expect(observation.fileStates).toEqual(["pass"]);
    expect(observation.final.completed).toEqual([
      { name: "completed case", state: "pass" },
      { name: "independent next case", state: "pass" },
    ]);
    expect(
      observation.final.batches
        .flatMap((batch) => batch.events)
        .filter((event) => event.name === finished.name && event.event === finished.event),
    ).toEqual([finished]);
    expect(observation.drained.batches).toEqual(observation.final.batches);
    expect(observation.drained.pendingDelays).toEqual([]);
  });
});
