// Memory Core tests cover publication worker lifecycle behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workerState = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  listeners: new Map<string, (value: unknown) => void>(),
  terminate: vi.fn(async () => 0),
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class {
      readonly stdout = { resume: vi.fn() };
      readonly stderr = { resume: vi.fn() };

      constructor(_url: URL, options: Record<string, unknown>) {
        workerState.options.push(options);
      }

      once(event: string, listener: (value: unknown) => void): this {
        workerState.listeners.set(event, listener);
        return this;
      }

      removeAllListeners(): this {
        workerState.listeners.clear();
        return this;
      }

      terminate(): Promise<number> {
        return workerState.terminate();
      }
    },
  };
});

import { publishMemoryDatabaseInWorker } from "./manager-publish-subprocess.js";

describe("memory publish worker lifecycle", () => {
  beforeEach(() => {
    workerState.options.length = 0;
    workerState.listeners.clear();
    workerState.terminate.mockReset().mockResolvedValue(0);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminates a nonresponsive worker before reporting its bounded timeout", async () => {
    const publication = publishMemoryDatabaseInWorker({
      databasePath: "/isolated/target.sqlite",
      sourcePath: "/isolated/shadow.sqlite",
      metaKey: "memory_index_meta",
      expectedRevision: 1,
      vectorIndexComplete: false,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.runAllTimersAsync();

    await expect(publication).resolves.toMatchObject({
      message: "memory publish worker timed out",
    });
    expect(workerState.terminate).toHaveBeenCalledOnce();
    expect(workerState.options).toHaveLength(1);
  });

  it("waits for worker termination before reporting a successful publication", async () => {
    let releaseTermination!: (code: number) => void;
    workerState.terminate.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        releaseTermination = resolve;
      }),
    );
    let settled = false;
    const publication = publishMemoryDatabaseInWorker({
      databasePath: "/isolated/target.sqlite",
      sourcePath: "/isolated/shadow.sqlite",
      metaKey: "memory_index_meta",
      expectedRevision: 1,
      vectorIndexComplete: false,
    });
    void publication.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    const deliverResult = workerState.listeners.get("message");
    expect(deliverResult).toBeDefined();
    deliverResult?.({ status: "ok", revision: 2 });

    expect(workerState.terminate).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(workerState.listeners.has("error")).toBe(true);
    releaseTermination(0);
    await expect(publication).resolves.toBe(2);
    expect(workerState.listeners.size).toBe(0);
  });
});
