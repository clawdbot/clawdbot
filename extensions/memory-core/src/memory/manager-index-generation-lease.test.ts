// Memory Core tests published-index read and publication ordering.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireMemoryIndexReadGeneration,
  withMemoryIndexPublishGeneration,
} from "./manager-index-generation-lease.js";

const leaseChildSource = String.raw`
  import { once } from "node:events";
  import { DatabaseSync } from "node:sqlite";

  const [, mode, databasePath] = process.argv;
  let reportedContention = false;
  const acquire = async (location, leaseMode) => {
    while (true) {
      const database = new DatabaseSync(location);
      database.exec("PRAGMA busy_timeout = 0");
      try {
        if (leaseMode === "exclusive") {
          database.exec("BEGIN EXCLUSIVE");
        } else {
          database.exec("BEGIN");
          database.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
        }
        return database;
      } catch (error) {
        database.close();
        if (!/SQLITE_(?:BUSY|LOCKED)|database is locked/iu.test(String(error))) throw error;
        if (!reportedContention) {
          reportedContention = true;
          process.stdout.write("contended\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };

  const admission = await acquire(
    databasePath + ".generation-writer.sqlite",
    mode === "write" ? "exclusive" : "shared",
  );
  if (mode === "read-admission") {
    process.stdout.write("acquired\n");
    process.stdin.resume();
    await once(process.stdin, "end");
    admission.exec("ROLLBACK");
    admission.close();
    process.exit(0);
  }
  const generation = await acquire(
    databasePath + ".generation-lock.sqlite",
    mode === "read" ? "shared" : "exclusive",
  );
  if (mode === "read") {
    admission.exec("ROLLBACK");
    admission.close();
  }
  try {
    process.stdout.write("acquired\n");
    process.stdin.resume();
    await once(process.stdin, "end");
    generation.exec("ROLLBACK");
    if (mode === "write") {
      admission.exec("ROLLBACK");
    }
  } finally {
    generation.close();
    if (mode === "write") {
      admission.close();
    }
  }
`;

function spawnLeaseFixture(
  mode: "read" | "read-admission" | "write",
  databasePath: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--input-type=module", "--eval", leaseChildSource, mode, databasePath],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

async function readChildLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  const [chunk] = await once(child.stdout, "data");
  return String(chunk).trim();
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.stdin.end();
  await once(child, "exit");
}

let fixtureRoot = "";

beforeEach(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-generation-"));
});

afterEach(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function leasePath(name: string): string {
  return path.join(fixtureRoot, `${name}.sqlite`);
}

async function withReadGeneration<T>(key: string, run: () => Promise<T>): Promise<T> {
  const release = await acquireMemoryIndexReadGeneration(key);
  try {
    return await run();
  } finally {
    release();
  }
}

describe("memory index generation lease", () => {
  it("admits another reader into the active generation when no writer is queued", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];

    const generationPath = leasePath("shared-reader-generation");
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader");
      await firstReaderGate;
    });
    await vi.waitFor(() => expect(events).toContain("first-reader"));

    const nextReader = withReadGeneration(generationPath, async () => {
      events.push("next-reader");
    });
    await nextReader;
    expect(events).toEqual(["first-reader", "next-reader"]);

    releaseFirstReader();
    await firstReader;
  });

  it("lets readers continue while publication waits for the active generation", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];

    const generationPath = leasePath("reader-before-publish");
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader-start");
      await firstReaderGate;
      events.push("first-reader-end");
    });
    await vi.waitFor(() => expect(events).toContain("first-reader-start"));

    const publish = withMemoryIndexPublishGeneration(generationPath, async () => {
      events.push("publish");
    });
    await Promise.resolve();
    expect(events).not.toContain("publish");

    releaseFirstReader();
    await Promise.all([firstReader, publish]);
    expect(events).toEqual(["first-reader-start", "first-reader-end", "publish"]);
  });

  it("does not admit a new generation reader ahead of queued publication", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];

    const generationPath = leasePath("publish-before-reader");
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader");
      await firstReaderGate;
    });
    await vi.waitFor(() => expect(events).toContain("first-reader"));
    const publish = withMemoryIndexPublishGeneration(generationPath, async () => {
      events.push("publish");
    });
    const nextReader = withReadGeneration(generationPath, async () => {
      events.push("next-reader");
    });

    releaseFirstReader();
    await Promise.all([firstReader, publish, nextReader]);
    expect(events).toEqual(["first-reader", "publish", "next-reader"]);
  });

  it("keeps another process from publishing during an active read generation", async () => {
    const databasePath = leasePath("reader-cross-process");
    const release = await acquireMemoryIndexReadGeneration(databasePath);
    let released = false;
    const child = spawnLeaseFixture("write", databasePath);
    try {
      expect(await readChildLine(child)).toBe("contended");
      const acquired = readChildLine(child);
      release();
      released = true;
      expect(await acquired).toBe("acquired");
    } finally {
      if (!released) {
        release();
      }
      await stopChild(child);
    }
  });

  it("waits for another process reader before publishing a new generation", async () => {
    const databasePath = leasePath("publisher-cross-process");
    const child = spawnLeaseFixture("read", databasePath);
    try {
      expect(await readChildLine(child)).toBe("acquired");
      const events: string[] = [];
      const publication = withMemoryIndexPublishGeneration(databasePath, async () => {
        events.push("published");
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(events).toEqual([]);

      await stopChild(child);
      await publication;
      expect(events).toEqual(["published"]);
    } finally {
      await stopChild(child);
    }
  });

  it("keeps newly arriving process readers behind a waiting publication", async () => {
    const databasePath = leasePath("writer-intent-cross-process");
    const firstReader = spawnLeaseFixture("read-admission", databasePath);
    let nextReader: ChildProcessWithoutNullStreams | undefined;
    let publication: Promise<void> | undefined;
    try {
      expect(await readChildLine(firstReader)).toBe("acquired");
      const events: string[] = [];
      publication = withMemoryIndexPublishGeneration(databasePath, async () => {
        events.push("published");
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });

      nextReader = spawnLeaseFixture("read", databasePath);
      expect(await readChildLine(nextReader)).toBe("contended");
      const nextReaderAcquired = readChildLine(nextReader).then((line) => {
        expect(line).toBe("acquired");
        events.push("next-reader");
      });
      expect(events).toEqual([]);

      await stopChild(firstReader);
      // Publication releases its lease before resolving, so the reader may already be done.
      await publication;
      await nextReaderAcquired;
      expect(events).toEqual(["published", "next-reader"]);
    } finally {
      await stopChild(firstReader);
      if (nextReader) {
        await stopChild(nextReader);
      }
      await publication;
    }
  });

  it("removes an aborted reader while another process holds publication", async () => {
    const databasePath = leasePath("cancelled-reader-cross-process");
    const publisher = spawnLeaseFixture("write", databasePath);
    const controller = new AbortController();
    const abortError = new Error("memory search cancelled while waiting for publication");
    const acquireWithSignal = acquireMemoryIndexReadGeneration as (
      path: string,
      signal: AbortSignal,
    ) => Promise<() => void>;
    let pendingReader: Promise<() => void> | undefined;
    try {
      expect(await readChildLine(publisher)).toBe("acquired");
      pendingReader = acquireWithSignal(databasePath, controller.signal);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      controller.abort(abortError);
      const outcome = await Promise.race([
        pendingReader.then(
          () => "acquired" as const,
          (error: unknown) => error,
        ),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 250);
        }),
      ]);
      expect(outcome).toMatchObject({ cause: abortError });
    } finally {
      await stopChild(publisher);
      const release = await pendingReader?.catch(() => undefined);
      release?.();
    }
  });
});
