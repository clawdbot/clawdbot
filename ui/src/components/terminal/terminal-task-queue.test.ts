import { describe, expect, it } from "vitest";
import { TerminalTaskQueue } from "./terminal-task-queue.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("TerminalTaskQueue", () => {
  it("drains superseded work before starting the next generation", async () => {
    const queue = new TerminalTaskQueue();
    const release = deferred();
    const events: string[] = [];
    const stale = queue.enqueue(async (isCurrent) => {
      events.push("stale:start");
      await release.promise;
      events.push(isCurrent() ? "stale:current" : "stale:cancelled");
    });
    await Promise.resolve();

    queue.reset();
    const current = queue.enqueue((isCurrent) => {
      events.push(isCurrent() ? "current:start" : "current:cancelled");
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(events).toEqual(["stale:start"]);

    release.resolve();
    await Promise.all([stale, current]);
    expect(events).toEqual(["stale:start", "stale:cancelled", "current:start"]);
  });
});
