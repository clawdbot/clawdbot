import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as workerUrls from "./runtime-worker-url.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-readonly-location.js";
import { SQLITE_READONLY_CHILD_ARG } from "./sqlite-readonly-worker.js";

const processMocks = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  processMocks.execFile.mockImplementation(actual.execFile);
  Object.defineProperties(processMocks.execFile, Object.getOwnPropertyDescriptors(actual.execFile));
  return { ...actual, execFile: processMocks.execFile };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});
let cacheRoot: string;
beforeEach(() => {
  processMocks.execFile.mockClear();
  cacheRoot = tempDirs.make("openclaw-readonly-cancellation-cache-");
  vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
});

function createDatabase(): string {
  const pathname = path.join(tempDirs.make("openclaw-readonly-cancellation-"), "source.sqlite");
  const database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('preserved');");
  database.close();
  return pathname;
}

describe("SQLite read-only worker cancellation", () => {
  it("rejects stopped ownership before staging or spawning", async () => {
    const controller = new AbortController();
    const reason = new Error("startup stopped");
    controller.abort(reason);
    await expect(
      prepareSqliteReadOnlyLocation(path.join(cacheRoot, "unused.sqlite"), {
        preserveSourceArtifacts: true,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(processMocks.execFile).not.toHaveBeenCalled();
    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  // Windows terminates SIGTERM targets; POSIX can hold a signal handler open.
  it.runIf(process.platform !== "win32")(
    "joins a signalled child before rejecting and removes its unpublished partial snapshot",
    async () => {
      const fixture = tempDirs.make("openclaw-readonly-held-worker-");
      const worker = path.join(fixture, "worker.mjs");
      const signalled = path.join(fixture, "signalled");
      const release = path.join(fixture, "release");
      fs.writeFileSync(
        worker,
        `import fs from 'node:fs';
       import path from 'node:path';
       const root = process.argv[5];
       process.on('SIGTERM', () => {
         fs.writeFileSync(${JSON.stringify(signalled)}, 'received');
         const poll = setInterval(() => {
           if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(poll); process.exit(0); }
         }, 5);
       });
       fs.writeFileSync(path.join(root, 'partial.sqlite'), 'private partial snapshot');
       setTimeout(() => process.exit(2), 5000);`,
      );
      vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(worker));
      const controller = new AbortController();
      const reason = new Error("startup stopped");
      let settled = false;
      const operation = prepareSqliteReadOnlyLocation(path.join(fixture, "unused.sqlite"), {
        preserveSourceArtifacts: true,
        signal: controller.signal,
      });
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let childClosed: Promise<void> | undefined;
      try {
        const workerIndex = () =>
          processMocks.execFile.mock.calls.findIndex(
            (call) => Array.isArray(call[1]) && call[1].includes(SQLITE_READONLY_CHILD_ARG),
          );
        await vi.waitFor(() => expect(workerIndex()).toBeGreaterThanOrEqual(0));
        const callIndex = workerIndex();
        const child = processMocks.execFile.mock.results[callIndex]?.value;
        expect(child).toBeDefined();
        childClosed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        const argv = processMocks.execFile.mock.calls[callIndex]?.[1];
        if (!Array.isArray(argv)) {
          throw new Error("worker arguments missing");
        }
        const stagingRoot = argv.at(-1)!;
        await vi.waitFor(() =>
          expect(fs.existsSync(path.join(stagingRoot, "partial.sqlite"))).toBe(true),
        );
        controller.abort(reason);
        await vi.waitFor(() => expect(fs.existsSync(signalled)).toBe(true));
        expect(settled).toBe(false);
        expect(child.exitCode).toBeNull();
        expect(fs.existsSync(stagingRoot)).toBe(true);
        fs.writeFileSync(release, "release");
        await expect(operation).rejects.toBe(reason);
        await childClosed;
        expect(child.exitCode).toBe(0);
        expect(fs.existsSync(stagingRoot)).toBe(false);
        expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
      } finally {
        fs.writeFileSync(release, "release");
        controller.abort(reason);
        await Promise.allSettled([operation, childClosed]);
      }
    },
  );

  it("reports failed owned cleanup and keeps it retryable", async () => {
    const source = createDatabase();
    const before = fs.readFileSync(source);
    const prepared = await prepareSqliteReadOnlyLocation(source, {
      preserveSourceArtifacts: true,
      signal: new AbortController().signal,
    });
    const remove = fs.rmSync;
    const failure = Object.assign(new Error("private snapshot busy"), { code: "EBUSY" });
    const stub = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => prepared.cleanup()).toThrow("snapshot cleanup failed");
      expect(fs.existsSync(prepared.location)).toBe(true);
    } finally {
      stub.mockImplementation(remove);
      expect(prepared.cleanup()).toBe(true);
    }
    expect(fs.readFileSync(source)).toEqual(before);
    expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
  });
});
