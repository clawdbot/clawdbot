import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createEmbeddedAttemptPreparation } from "./attempt-preparation.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createTimelineEnv() {
  const dir = tempDirs.make("openclaw-agent-preparation-");
  return {
    env: {
      OPENCLAW_DIAGNOSTICS: "timeline",
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(dir, "timeline.jsonl"),
    } as NodeJS.ProcessEnv,
    path: join(dir, "timeline.jsonl"),
  };
}

async function readTimeline(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("embedded agent preparation timing", () => {
  it("emits the canonical span name with stage attribution", async () => {
    const { env, path } = await createTimelineEnv();

    await measureEmbeddedAgentPreparation("runtime", async () => "async", { env });
    expect(await measureEmbeddedAgentPreparation("attempt.tool-base", () => "sync", { env })).toBe(
      "sync",
    );

    const events = await readTimeline(path);
    expect(events.map((event) => event.name)).toEqual([
      "agent.prepare",
      "agent.prepare",
      "agent.prepare",
      "agent.prepare",
    ]);
    expect(events.map((event) => event.phase)).toEqual([
      "agent.prepare",
      "agent.prepare",
      "agent.prepare",
      "agent.prepare",
    ]);
    expect(events.map((event) => event.attributes)).toEqual([
      { stage: "runtime" },
      { stage: "runtime" },
      { stage: "attempt.tool-base" },
      { stage: "attempt.tool-base" },
    ]);
  });
});

const prepare = createEmbeddedAttemptPreparation({ assertCurrent: () => {} });

describe("embedded attempt preparation dispatch", () => {
  it("lets control callbacks advance before a burst of preparation stages finishes", async () => {
    const started: number[] = [];
    let observedStarts = -1;
    const controlCallback = createDeferred();
    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        prepare("attempt.tool-catalog", () => {
          started.push(index);
          if (index === 0) {
            setImmediate(() => {
              observedStarts = started.length;
              controlCallback.resolve();
            });
          }
        }),
      ),
    );
    await controlCallback.promise;
    expect(started).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(observedStarts).toBe(1);
  });

  it("preserves caller context and overlaps asynchronous preparation", async () => {
    const context = new AsyncLocalStorage<string>();
    const observed: Array<string | undefined> = [];
    const firstWait = createDeferred();
    const first = context.run("first", () =>
      prepare("attempt.bootstrap", async () => {
        observed.push(context.getStore());
        await firstWait.promise;
        observed.push(context.getStore());
      }),
    );
    const second = context.run("second", () =>
      prepare("attempt.bootstrap", async () => {
        observed.push(context.getStore());
        await yieldToEventLoop();
        firstWait.resolve();
      }),
    );
    await Promise.all([first, second]);
    expect(observed).toEqual(["first", "second", "first"]);
  });

  it("rejects stale queued work before acquisition without blocking other attempts", async () => {
    const controller = new AbortController();
    const cancelled = createEmbeddedAttemptPreparation({
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    const acquire = vi.fn();
    const pending = cancelled("attempt.bundle-tools", acquire);
    const failure = new Error("cancelled before acquisition");
    controller.abort(failure);
    await expect(pending).rejects.toBe(failure);
    expect(acquire).not.toHaveBeenCalled();
    await expect(prepare("attempt.tool-catalog", () => "next attempt")).resolves.toBe(
      "next attempt",
    );
    await expect(
      prepare("attempt.tool-catalog", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(prepare("attempt.tool-catalog", () => "after failure")).resolves.toBe(
      "after failure",
    );
  });
});
